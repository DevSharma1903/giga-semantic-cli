import { GoogleGenAI, Type, FunctionCallingConfigMode } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { applyPatch, isIgnoredOrLockfile, checkSyntax, auditFileSystemAndImports, extractKeywordsAndPaths, getRepoInfo, fetchGithubIssue, listCodeFiles, crawlWorkspace, closeIssueAsNotPlanned, getGitClient, executeGitOperation } from './tools/index.js';

export let lastValidationState: 'healed' | 'stood_down' | 'untested' = 'untested';

export function setValidationState(state: 'healed' | 'stood_down' | 'untested') {
  lastValidationState = state;
}

const log = {
  info: (msg: string) => {
    console.log(`  ${chalk.dim(msg)}`);
  },
  success: (msg: string) => {
    console.log(`  ${chalk.bold.green('✓')} ${chalk.bold.white(msg)}`);
  }
};

export let sessionTokensTally = 0;
export let operationElapsedTimeMs = 0;

export function resetTelemetry() {
  operationElapsedTimeMs = 0;
}

export async function generateChatCompletion(
  prompt: string,
  systemInstruction?: string,
  jsonMode?: boolean,
  tools?: any[]
): Promise<string> {
  const provider = process.env.LLM_PROVIDER || 'Gemini (Google)';
  const model = process.env.GEMINI_MODEL || (
    provider === 'OpenAI' ? 'gpt-4o' :
    provider === 'Claude (Anthropic)' ? 'claude-3-5-sonnet-20241022' :
    provider === 'Groq' ? 'llama3-70b-8192' : 'gemini-2.5-flash'
  );

  const apiKey = process.env.API_KEY || (
    provider === 'OpenAI' ? process.env.OPENAI_API_KEY :
    provider === 'Claude (Anthropic)' ? process.env.ANTHROPIC_API_KEY :
    provider === 'Groq' ? process.env.GROQ_API_KEY : process.env.GEMINI_API_KEY
  );

  if (!apiKey) {
    throw new Error(`API key for provider ${provider} is not configured. Please run /connect.`);
  }

  const startTime = Date.now();

  try {
    if (provider === 'Gemini (Google)') {
      const client = new GoogleGenAI({ apiKey });
      const response = await client.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: jsonMode ? 'application/json' : undefined,
          tools,
          toolConfig: tools ? {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: tools[0]?.functionDeclarations?.map((fd: any) => fd.name)
            }
          } : undefined
        }
      });

      const inputTokens = response.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
      sessionTokensTally += inputTokens + outputTokens;
      operationElapsedTimeMs = Date.now() - startTime;

      if (tools) {
        if (response.functionCalls && response.functionCalls.length > 0) {
          return JSON.stringify({ functionCalls: response.functionCalls });
        }
      }
      return response.text || '';
    }

    let endpoint = '';
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let body: any = {};

    if (provider === 'OpenAI' || provider === 'Groq') {
      endpoint = provider === 'OpenAI' 
        ? 'https://api.openai.com/v1/chat/completions'
        : 'https://api.groq.com/openai/v1/chat/completions';
      headers['Authorization'] = `Bearer ${apiKey}`;
      
      const messages: any[] = [];
      if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
      }
      messages.push({ role: 'user', content: prompt });

      body = {
        model,
        messages,
        response_format: jsonMode ? { type: 'json_object' } : undefined
      };

      if (tools) {
        body.tools = tools.map((t: any) => {
          return t.functionDeclarations.map((fd: any) => {
            return {
              type: 'function',
              function: {
                name: fd.name,
                description: fd.description,
                parameters: {
                  type: 'object',
                  properties: fd.parameters.properties,
                  required: fd.parameters.required
                }
              }
            };
          });
        }).flat();
        body.tool_choice = 'required';
      }
    } else if (provider === 'Claude (Anthropic)') {
      endpoint = 'https://api.anthropic.com/v1/messages';
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';

      body = {
        model,
        max_tokens: 4000,
        system: systemInstruction,
        messages: [{ role: 'user', content: prompt }]
      };

      if (tools) {
        body.tools = tools.map((t: any) => {
          return t.functionDeclarations.map((fd: any) => {
            return {
              name: fd.name,
              description: fd.description,
              input_schema: {
                type: 'object',
                properties: fd.parameters.properties,
                required: fd.parameters.required
              }
            };
          });
        }).flat();
        body.tool_choice = { type: 'any' };
      }
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM provider ${provider} returned error: ${errText}`);
    }

    const data: any = await res.json();
    operationElapsedTimeMs = Date.now() - startTime;

    const usage = data.usage;
    if (usage) {
      const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
      const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
      sessionTokensTally += inputTokens + outputTokens;
    }

    if (provider === 'OpenAI' || provider === 'Groq') {
      const choice = data.choices[0];
      if (tools && choice.message.tool_calls) {
        const tc = choice.message.tool_calls[0];
        const parsedArgs = typeof tc.function.arguments === 'string' 
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
        return JSON.stringify({
          functionCalls: [{
            name: tc.function.name,
            args: parsedArgs
          }]
        });
      }
      return choice.message.content || '';
    } else if (provider === 'Claude (Anthropic)') {
      if (tools) {
        const toolContent = data.content.find((c: any) => c.type === 'tool_use');
        if (toolContent) {
          return JSON.stringify({
            functionCalls: [{
              name: toolContent.name,
              args: toolContent.input
            }]
          });
        }
      }
      const textContent = data.content.find((c: any) => c.type === 'text');
      return textContent ? textContent.text : '';
    }

    return '';
  } catch (error: any) {
    operationElapsedTimeMs = Date.now() - startTime;
    throw error;
  }
}

/**
 * Uses Gemini to identify relevant files for an issue from the list of all files in the project.
 */
export async function identifyRelevantFiles(
  issueTitle: string,
  issueBody: string,
  allFiles: string[]
): Promise<string[]> {
  const provider = process.env.LLM_PROVIDER || 'Gemini (Google)';
  const spinner = ora(`${provider} analyzing issue & repo files...`).start();
  
  const filteredFiles = allFiles.filter(f => !isIgnoredOrLockfile(f));

  const systemInstruction = `You are a codebase navigator. Given a GitHub issue description and a list of files in the repository, identify the files most likely relevant to fixing this issue. Return your answer as a JSON object containing a "files" key which is an array of file paths. For example: {"files": ["src/utils.ts", "package.json"]}. Do not include any other explanation or markdown formatting.`;
  
  const prompt = `
Issue Title: ${issueTitle}
Issue Body:
${issueBody}

Available Files:
${filteredFiles.map(f => `- ${f}`).join('\n')}

Select the most relevant files (up to 5-10 files max). Return ONLY the JSON object.
`;

  try {
    const text = await generateChatCompletion(prompt, systemInstruction, true);
    spinner.succeed(`Identified relevant files via ${provider}`);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.files)) {
      return parsed.files.map((f: any) => String(f));
    }
    return [];
  } catch (error: any) {
    spinner.fail(`Failed to identify files via ${provider}: ${error.message}`);
    return [];
  }
}

/**
 * Executes the self-healing cycle.
 * Takes the test failures and relevant files, feeds them to Gemini, gets a patch tool call, applies it.
 */
export async function runSelfHealingIteration(
  testFailureLog: string,
  relevantFiles: string[],
  cwd: string = process.cwd()
): Promise<{ filePath: string; startLine: number; endLine: number; replacementContent: string }> {
  const provider = process.env.LLM_PROVIDER || 'Gemini (Google)';
  const spinner = ora(`${provider} formulating code patch...`).start();

  // Run codebase crawler to isolate the files containing the issue footprint
  let targetedFiles = crawlWorkspace(cwd, testFailureLog).filter(file => !isIgnoredOrLockfile(file));

  // Fallback to filteredFiles if no files were matched by the crawl
  if (targetedFiles.length === 0) {
    targetedFiles = relevantFiles.filter(file => !isIgnoredOrLockfile(file));
  }

  // Pre-flight check: File System & Import Audit
  const auditResult = auditFileSystemAndImports(cwd, targetedFiles, testFailureLog);
  const syntaxErrors: { file: string; error: string }[] = [];

  for (const file of targetedFiles) {
    const absolutePath = path.join(cwd, file);
    if (fs.existsSync(absolutePath)) {
      const content = fs.readFileSync(absolutePath, 'utf8');
      const err = checkSyntax(content, absolutePath);
      if (err) {
        syntaxErrors.push({ file, error: err });
      }
    }
  }

  const localFailures: string[] = [];
  let targetedFilesForGemini = targetedFiles;

  if (auditResult.missingFiles.length > 0) {
    for (const missing of auditResult.missingFiles) {
      localFailures.push(`Local File System Audit Error: Referenced file "${missing.file}" is missing. (Referenced by: ${missing.referencedBy})`);
    }
  }

  if (syntaxErrors.length > 0) {
    for (const syn of syntaxErrors) {
      localFailures.push(`Local Syntax Validation Error in "${syn.file}": ${syn.error}`);
    }
  }

  const hasLocalErrors = localFailures.length > 0;
  
  if (hasLocalErrors) {
    console.log(chalk.bold.red('\n[Pre-Flight Analysis] Local Validation Failed!'));
    for (const failure of localFailures) {
      console.log(chalk.red(`  ! ${failure}`));
    }
    console.log(chalk.yellow(`Targeting ${provider} invocation with a minimized context window...`));

    // Bundle *only* the specific files that failed or referenced the failures
    const failedFilesSet = new Set<string>();
    for (const syn of syntaxErrors) {
      failedFilesSet.add(syn.file);
    }
    for (const missing of auditResult.missingFiles) {
      if (missing.referencedBy && missing.referencedBy !== 'Issue/Trace Context' && missing.referencedBy !== 'Target list') {
        failedFilesSet.add(missing.referencedBy);
      }
    }

    if (failedFilesSet.size > 0) {
      targetedFilesForGemini = Array.from(failedFilesSet);
    }
  } else {
    log.info(`Local structural checks clear. Escalating semantic logic review to ${provider}...`);
  }

  // Read file contents to supply as context
  const fileContexts = targetedFilesForGemini.map(file => {
    const absolutePath = path.join(cwd, file);
    if (fs.existsSync(absolutePath)) {
      const content = fs.readFileSync(absolutePath, 'utf8');
      const linesWithNumbers = content
        .split(/\r?\n/)
        .map((line, idx) => `${idx + 1}: ${line}`)
        .join('\n');
      return `--- File: ${file} ---\n${linesWithNumbers}`;
    }
    return `--- File: ${file} ---\n(File empty or not found)`;
  }).join('\n\n');

  const prompt = hasLocalErrors
    ? `
The repository local pre-flight checks failed with the following errors:

[LOCAL ERRORS START]
${localFailures.join('\n')}
[LOCAL ERRORS END]

Here is the source code of the relevant targeted files with 1-based line numbers prefixing each line:

${fileContexts}

Please propose a line-specific patch to fix the local validation errors by calling the 'applyPatch' tool.
`
    : `
We crawled the repository and found the issue context located inside these specific files. Formulate a code patch to resolve the user's issue based purely on this local file code.

[TEST FAILURE START]
${testFailureLog}
[TEST FAILURE END]

Here is the source code of the relevant files with 1-based line numbers prefixing each line:

${fileContexts}

Please propose a line-specific patch to fix the failure by calling the 'applyPatch' tool.
`;

  const tools = [
    {
      functionDeclarations: [
        {
          name: 'applyPatch',
          description: 'Replace a block of lines in a file with new replacement content.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              filePath: {
                type: Type.STRING,
                description: 'The relative or absolute path of the file to modify.'
              },
              startLine: {
                type: Type.INTEGER,
                description: 'The 1-based starting line number of the block to replace.'
              },
              endLine: {
                type: Type.INTEGER,
                description: 'The 1-based ending line number (inclusive) of the block to replace.'
              },
              replacementContent: {
                type: Type.STRING,
                description: 'The new text content to replace the target block with.'
              }
            },
            required: ['filePath', 'startLine', 'endLine', 'replacementContent']
          }
        }
      ]
    }
  ];

  try {
    const resultText = await generateChatCompletion(
      prompt,
      'You are an elite automated developer who heals broken unit tests by applying line-specific patches. You must propose a fix by calling the applyPatch tool.',
      false,
      tools
    );

    const parsed = JSON.parse(resultText);
    const functionCalls = parsed.functionCalls;
    if (!functionCalls || functionCalls.length === 0) {
      throw new Error(`${provider} failed to return a patch tool call.`);
    }

    const call = functionCalls[0];
    const args = call.args as { filePath: any; startLine: any; endLine: any; replacementContent: any };
    
    if (args.filePath === undefined || args.startLine === undefined || args.endLine === undefined || args.replacementContent === undefined) {
      throw new Error(`Invalid arguments returned from ${provider}: ${JSON.stringify(args)}`);
    }

    const filePath = String(args.filePath);
    const startLine = Number(args.startLine);
    const endLine = Number(args.endLine);
    const replacementContent = String(args.replacementContent);

    // Apply the patch locally
    const targetPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    spinner.succeed(`Formulated patch for ${filePath} (Lines ${startLine}-${endLine})`);
    
    applyPatch(targetPath, startLine, endLine, replacementContent);
    return { filePath, startLine, endLine, replacementContent };
  } catch (error: any) {
    spinner.fail(`Failed to formulate patch via ${provider}: ${error.message}`);
    throw error;
  }
}

/**
 * Generates Pull Request title and Markdown body based on git diff.
 */
export async function generatePullRequestDescription(
  gitDiff: string
): Promise<{ title: string; body: string }> {
  const provider = process.env.LLM_PROVIDER || 'Gemini (Google)';
  const spinner = ora(`${provider} drafting Pull Request details...`).start();

  const prompt = `
We are preparing a Pull Request. Below is the git diff of the changes made:

\`\`\`diff
${gitDiff}
\`\`\`

Generate a comprehensive Pull Request description in markdown.
Return your response as a JSON object with two keys: "title" (a semantic title for the PR) and "body" (the full markdown body describing the changes, motivation, and verification).
Do not include any other text besides the JSON.
`;

  try {
    const text = await generateChatCompletion(
      prompt,
      'You are an elite code reviewer. Create detailed, clear, and comprehensive pull request titles and descriptions based on git diffs.',
      true
    );
    spinner.succeed('Pull Request details formulated');
    
    try {
      const parsed = JSON.parse(text);
      return {
        title: parsed.title || 'fix: implement issue resolution',
        body: parsed.body || 'Implemented changes to address issue requirements.'
      };
    } catch (_) {
      return {
        title: 'fix: implement issue resolution',
        body: text
      };
    }
  } catch (error: any) {
    spinner.fail(`Failed to generate PR description: ${error.message}`);
    throw error;
  }
}

/**
 * Verifies if the raised issue is actually reproducible before attempting to formulate any patches.
 * Returns true if there is a reproducible issue, false if it's healthy and we should stand down.
 */
export async function verifyIssueSanity(cwd: string = process.cwd()): Promise<boolean> {
  const spinner = ora('Giga initiating Issue Sanity Verification...').start();
  let issueText = '';
  let currentIssueNumber: number | null = null;
  let repoOwner = '';
  let repoName = '';

  try {
    const git = getGitClient(cwd);
    const status = await executeGitOperation(() => git.status(), 'Failed to get git status');
    const currentBranch = status.current;
    if (currentBranch && currentBranch.startsWith('fix/issue-')) {
      const issueNumberStr = currentBranch.replace('fix/issue-', '');
      const issueNumber = parseInt(issueNumberStr, 10);
      if (!isNaN(issueNumber)) {
        currentIssueNumber = issueNumber;
        try {
          const { owner, repo } = await getRepoInfo(cwd);
          repoOwner = owner;
          repoName = repo;
          const issue = await fetchGithubIssue(issueNumber, owner, repo);
          issueText = `${issue.title}\n${issue.body}`;
        } catch (_) {
          // Fallback gracefully
        }
      }
    }
  } catch (_) {
    // Fallback gracefully
  }

  const allFiles = listCodeFiles(cwd);
  const auditResult = auditFileSystemAndImports(cwd, allFiles, issueText);

  const syntaxErrors: { file: string; error: string }[] = [];
  for (const file of allFiles) {
    const absolutePath = path.join(cwd, file);
    if (fs.existsSync(absolutePath)) {
      const content = fs.readFileSync(absolutePath, 'utf8');
      const err = checkSyntax(content, absolutePath);
      if (err) {
        syntaxErrors.push({ file, error: err });
      }
    }
  }

  const complainsAboutDeps = issueText.toLowerCase().includes('dependency') ||
                             issueText.toLowerCase().includes('npm install') ||
                             issueText.toLowerCase().includes('node_modules') ||
                             issueText.toLowerCase().includes('missing package');
  
  const nodeModulesExist = fs.existsSync(path.join(cwd, 'node_modules'));
  const depFailure = complainsAboutDeps && !nodeModulesExist;

  // If there are explicit syntax or audit issues, we proceed directly
  if (auditResult.missingFiles.length > 0 || syntaxErrors.length > 0 || depFailure) {
    spinner.fail('Explicit local structural failures verified');
    lastValidationState = 'untested';
    return true;
  }

  if (!issueText) {
    spinner.succeed('Issue Verification Complete');
    log.success("Issue Verification Complete: Base workspace is fully operational and healthy.");
    log.info("No actionable codebase failures detected locally. Standing down to prevent false-positive alterations.");
    lastValidationState = 'stood_down';
    return false; // Stand down
  }

  const provider = process.env.LLM_PROVIDER || 'Gemini (Google)';
  
  const crawledFiles = crawlWorkspace(cwd, issueText);
  let targetedFiles = crawledFiles.filter(file => !isIgnoredOrLockfile(file));
  if (targetedFiles.length === 0) {
    targetedFiles = allFiles.slice(0, 10);
  }

  const fileContexts = targetedFiles.map(file => {
    const absolutePath = path.join(cwd, file);
    if (fs.existsSync(absolutePath)) {
      const content = fs.readFileSync(absolutePath, 'utf8');
      return `--- File: ${file} ---\n${content}`;
    }
    return `--- File: ${file} ---\n(File empty or not found)`;
  }).join('\n\n');

  const verificationPrompt = `
You are analyzing a codebase to verify if a reported user issue is a valid bug, configuration error, or missing logic path in this repository, or if it is a false alarm.

Issue Description:
${issueText}

Here is the source code of the relevant files in the repository:
${fileContexts}

Based on these repository source files, is the user's raised issue actually a valid bug, configuration error, or missing logic path in this codebase? If it is a false alarm or doesn't match the code realities, specify why.

Return your response as a JSON object with two keys:
1. "isValid": a boolean (true if the issue is a real bug/error/missing logic path, false if it is a false alarm or invalid issue).
2. "reason": a string describing your static analysis rationale.
Do not include any explanation or markdown markup outside of the JSON object.
`;

  try {
    const text = await generateChatCompletion(verificationPrompt, undefined, true);
    const result = JSON.parse(text);

    if (result && result.isValid === false) {
      spinner.succeed('Issue Verification Complete');
      log.success("Issue Verification Complete: Base workspace is fully operational and healthy.");
      log.info(`Reason: ${result.reason}`);

      if (currentIssueNumber && repoOwner && repoName) {
        try {
          spinner.start(`Closing issue #${currentIssueNumber} as Not Planned`);
          await closeIssueAsNotPlanned(currentIssueNumber, repoOwner, repoName, result.reason);
          spinner.succeed(chalk.bold.white(`Issue #${currentIssueNumber} closed`));
          log.success(`Issue #${currentIssueNumber} closed as Not Planned (False Alarm).`);
        } catch (err: any) {
          log.info(`Failed to auto-close issue: ${err.message}`);
        }
      }

      log.info("No actionable codebase failures detected locally. Standing down to prevent false-positive alterations.");
      lastValidationState = 'stood_down';
      return false; // Stand down
    }
  } catch (error: any) {
    // If provider fails, proceed to be safe
  }

  spinner.fail('Reproducible codebase failure verified');
  lastValidationState = 'untested';
  return true; // Proceed
}
