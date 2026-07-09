import { GoogleGenAI, Type, FunctionCallingConfigMode } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import chalk from 'chalk';
import {
  applyPatch,
  isIgnoredOrLockfile,
  checkSyntax,
  auditFileSystemAndImports,
  extractKeywordsAndPaths,
  getRepoInfo,
  fetchGithubIssue,
  listCodeFiles,
  crawlWorkspace,
  closeIssueAsNotPlanned,
  getGitClient,
  executeGitOperation,
  runCompilation,
  parseCompilerErrors,
  applyUnifiedDiff,
  runTests,
  closeGithubIssue,
  createPullRequest,
  safeguardGitignore,
  safeStageFiles
} from './tools/index.js';

export let lastValidationState: 'healed' | 'stood_down' | 'untested' = 'untested';

export function setValidationState(state: 'healed' | 'stood_down' | 'untested') {
  lastValidationState = state;
}

export let sessionTokensInput = 0;
export let sessionTokensOutput = 0;
export let operationElapsedTimeMs = 0;

export function resetTelemetry() {
  operationElapsedTimeMs = 0;
}

export function getSessionCost(): number {
  return 0.0;
}

export interface CompilerFailure {
  filePath: string;
  line: number;
  message: string;
}

export interface SearchReplaceBlock {
  search: string;
  replace: string;
}

export type GigaState = 'TRIAGE' | 'PLANNING' | 'MODIFICATION' | 'AUDITING' | 'DISPATCH' | 'COMPLETED' | 'FAILED';

export interface GigaContext {
  state: GigaState;
  issueNumber?: number;
  issueTitle?: string;
  issueBody?: string;
  issueText?: string;
  relevantFiles: string[];
  plannedFiles: { filePath: string; strategy: string }[];
  failures: CompilerFailure[];
  failuresLog: string;
  diffSummary?: string;
  status?: string;
}

// Search-and-replace block parser
export function parseSearchReplaceBlocks(text: string): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  const searchMarker = '<<<<<<< SEARCH';
  const dividerMarker = '=======';
  const replaceMarker = '>>>>>>> REPLACE';

  let currentIndex = 0;
  while (true) {
    const searchStart = text.indexOf(searchMarker, currentIndex);
    if (searchStart === -1) break;

    const searchEnd = text.indexOf(dividerMarker, searchStart);
    if (searchEnd === -1) break;

    const replaceStart = searchEnd + dividerMarker.length;
    const replaceEnd = text.indexOf(replaceMarker, replaceStart);
    if (replaceEnd === -1) break;

    const searchContent = text.substring(searchStart + searchMarker.length, searchEnd).replace(/^\r?\n|\r?\n$/g, '');
    const replaceContent = text.substring(replaceStart, replaceEnd).replace(/^\r?\n|\r?\n$/g, '');

    blocks.push({
      search: searchContent,
      replace: replaceContent
    });

    currentIndex = replaceEnd + replaceMarker.length;
  }
  return blocks;
}

// Local JSON Auto-Fixer
export function tryLocalFixJson(filePath: string, errorMessage: string): boolean {
  if (!filePath.endsWith('.json')) return false;
  const lowercaseErr = errorMessage.toLowerCase();
  if (
    lowercaseErr.includes('json parse error') ||
    lowercaseErr.includes('unexpected non-whitespace character') ||
    lowercaseErr.includes('unexpected token')
  ) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lastBraceIdx = Math.max(content.lastIndexOf('}'), content.lastIndexOf(']'));
      if (lastBraceIdx !== -1) {
        const truncated = content.substring(0, lastBraceIdx + 1);
        try {
          JSON.parse(truncated);
          fs.writeFileSync(filePath, truncated, 'utf8');
          console.log(chalk.bold.green(`[giga] Locally sanitized trailing characters in JSON file '${filePath}'.`));
          return true;
        } catch (_) {
          const cleaned = truncated.replace(/,(\s*[}\]])/g, '$1');
          try {
            JSON.parse(cleaned);
            fs.writeFileSync(filePath, cleaned, 'utf8');
            console.log(chalk.bold.green(`[giga] Locally repaired trailing commas/characters in JSON file '${filePath}'.`));
            return true;
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return false;
}

// Stateless Single-Shot LLM generation without Chat history
export async function generateChatCompletion(
  prompt: string,
  systemInstruction?: string,
  jsonMode: boolean = false,
  tools?: any[]
): Promise<string> {
  const provider = process.env.LLM_PROVIDER || 'Google Gemini';
  const model = process.env.LLM_MODEL || 'gemini-2.5-flash';

  const apiKey = process.env.API_KEY || (
    provider === 'OpenAI' ? process.env.OPENAI_API_KEY :
    provider === 'Anthropic Claude' ? process.env.ANTHROPIC_API_KEY :
    provider === 'DeepSeek' ? process.env.DEEPSEEK_API_KEY : process.env.GEMINI_API_KEY
  );

  if (!apiKey && provider !== 'Local Ollama') {
    throw new Error(`API key for provider ${provider} is not configured. Please run /connect.`);
  }

  const startTime = Date.now();
  console.log(chalk.ansi256(208)('→ ') + `[giga] LLM engine processing...`);

  try {
    if (provider === 'Google Gemini') {
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
      sessionTokensInput += inputTokens;
      sessionTokensOutput += outputTokens;
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

    if (provider === 'OpenAI' || provider === 'DeepSeek' || provider === 'Local Ollama') {
      if (provider === 'OpenAI') endpoint = 'https://api.openai.com/v1/chat/completions';
      else if (provider === 'DeepSeek') endpoint = 'https://api.deepseek.com/chat/completions';
      else endpoint = 'http://localhost:11434/v1/chat/completions';

      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      
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
    } else if (provider === 'Anthropic Claude') {
      endpoint = 'https://api.anthropic.com/v1/messages';
      headers['x-api-key'] = apiKey || '';
      headers['anthropic-version'] = '2023-06-01';

      body = {
        model,
        max_tokens: 4000,
        system: systemInstruction,
        messages: [{ role: 'user', content: prompt }]
      };
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
      sessionTokensInput += inputTokens;
      sessionTokensOutput += outputTokens;
    }

    if (provider === 'OpenAI' || provider === 'DeepSeek' || provider === 'Local Ollama') {
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
    } else if (provider === 'Anthropic Claude') {
      return data.content[0]?.text || '';
    }

    return '';
  } catch (error: any) {
    console.log(chalk.bold.red('✗ ') + `Failed to formulate response via ${provider}: ${error.message}`);
    throw error;
  }
}

// Phase 1 verification checker
export async function verifyCodebaseHealth(
  cwd: string = process.cwd(),
  issueText: string = '',
  relevantFiles: string[] = []
): Promise<{ healthy: boolean; failures: CompilerFailure[]; rawLog: string }> {
  // Check A: The Compiler / Linter
  const compileRes = await runCompilation(cwd);
  const failures = parseCompilerErrors(compileRes.stdout, compileRes.stderr, cwd);
  
  const syntaxErrors: CompilerFailure[] = [];
  for (const file of relevantFiles) {
    const absolutePath = path.join(cwd, file);
    if (fs.existsSync(absolutePath)) {
      const content = fs.readFileSync(absolutePath, 'utf8');
      const err = checkSyntax(content, absolutePath);
      if (err) {
        syntaxErrors.push({
          filePath: file,
          line: 1,
          message: err
        });
      }
    }
  }

  const combinedFailures = [...failures, ...syntaxErrors];
  if (combinedFailures.length > 0) {
    const rawLog = combinedFailures.map(f => `${f.filePath}:${f.line}: ${f.message}`).join('\n');
    return { healthy: false, failures: combinedFailures, rawLog };
  }

  // Check B: The Semantic Auditor
  console.log(chalk.ansi256(208)('→ ') + 'Executing Semantic Auditor pass...');
  
  const targetedFiles = relevantFiles.filter(file => !isIgnoredOrLockfile(file));
  const fileContexts = targetedFiles.map(file => {
    const absolutePath = path.join(cwd, file);
    if (fs.existsSync(absolutePath)) {
      const content = fs.readFileSync(absolutePath, 'utf8');
      return `--- File: ${file} ---\n${content}`;
    }
    return '';
  }).filter(Boolean).join('\n\n');

  if (!fileContexts) {
    return { healthy: true, failures: [], rawLog: '' };
  }

  const auditPrompt = `
You are a strict code quality auditor. Review the following code files carefully. Look for hidden runtime errors, syntax bugs (such as missing colons, bad formatting), logical flaws (such as infinite recursion, out-of-bounds indexing), or unhandled exceptions.

[FILES CONTENT]
${fileContexts}
[/FILES CONTENT]

Goal/Context of the issue:
${issueText}

If you find any bugs, output a structured list detailing the anomalies (file name, approximate line number, description of the bug). If the code is genuinely flawless and production-stable, return exactly one word: 'NO_ISSUE'.
`;

  const auditResponse = await generateChatCompletion(auditPrompt, "Output the bugs list or return 'NO_ISSUE'.", false);
  if (auditResponse.trim().toUpperCase().includes('NO_ISSUE')) {
    return { healthy: true, failures: [], rawLog: '' };
  }

  const semanticFailures: CompilerFailure[] = [
    {
      filePath: targetedFiles[0] || 'unknown',
      line: 1,
      message: `Semantic Audit Failure: ${auditResponse}`
    }
  ];
  return { healthy: false, failures: semanticFailures, rawLog: auditResponse };
}

// Phase 1 Ingestion and reproducible check
export async function verifyIssueSanity(cwd: string = process.cwd()): Promise<boolean> {
  console.log(chalk.ansi256(208)('→ ') + 'Giga initiating State Machine Phase 1 Ingestion & Verification...');
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
        } catch (_) {}
      }
    }
  } catch (_) {}

  const allFiles = listCodeFiles(cwd);
  const health = await verifyCodebaseHealth(cwd, issueText, allFiles);

  if (health.healthy) {
    console.log(chalk.bold.green('✓ ') + 'No active codebase failures detected. Standing down.');
    lastValidationState = 'stood_down';
    return false;
  }

  console.log(chalk.bold.red('✗ ') + 'Reproducible codebase failure verified.');
  lastValidationState = 'untested';
  return true;
}

// Phase 2: Semantic Planning Map Builder
export async function generatePlanningMap(
  issueText: string,
  failuresLog: string,
  filesList: string[]
): Promise<{ filePath: string; strategy: string }[]> {
  const planningPrompt = `
You are a senior software architect. Analyze the reported issue and failure log to identify which files need to be modified and outline the target repair strategy.

Goal:
${issueText}

Failures:
${failuresLog}

All available files:
${filesList.join('\n')}

Output a JSON array containing objects with keys "filePath" and "strategy".
Example:
[
  { "filePath": "src/utils.ts", "strategy": "Add null check to parseUser" }
]
Do not include any other markdown packaging or text.
`;
  try {
    const response = await generateChatCompletion(planningPrompt, 'You generate strict structural JSON planning maps.', true);
    const parsed = JSON.parse(response);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [];
  } catch (_) {
    return [];
  }
}

// Phase 3 & 4 Overhaul: Precision Search-and-Replace + Auditing Auto-Retry Loop
export async function runSelfHealingIteration(
  issueText: string,
  relevantFiles: string[],
  cwd: string = process.cwd()
): Promise<{ applied: boolean; diffText: string; failuresCount: number }> {
  // Phase 1: Verification
  const health = await verifyCodebaseHealth(cwd, issueText, relevantFiles);
  if (health.healthy) {
    return { applied: false, diffText: 'NO_ISSUE', failuresCount: 0 };
  }

  // Phase 2: Semantic Planning Map
  const allFilesList = listCodeFiles(cwd);
  const plannedFiles = await generatePlanningMap(issueText, health.rawLog, allFilesList);
  
  if (plannedFiles.length === 0) {
    console.log(chalk.yellow('[giga] Planning map empty. Falling back to default relevant files.'));
    relevantFiles.forEach(f => plannedFiles.push({ filePath: f, strategy: 'General repair' }));
  }

  let appliedAny = false;
  let lastDiff = '';
  const auditedHashes = new Set<string>();

  // Phase 3 & 4: Parallel Processing
  await Promise.all(plannedFiles.map(async (plan) => {
    const file = plan.filePath;
    const absolutePath = path.join(cwd, file);
    if (!fs.existsSync(absolutePath)) return;

    let retryCount = 1;
    const maxRetries = 5;
    let fileFixed = false;
    let localLog = health.rawLog;

    // Pre-Flight Short-Circuiting
    const fileErrors = health.failures.filter(f => f.filePath === file);
    if (fileErrors.length === 0) {
      console.log(`[giga] Phase 1 showed no anomalies for '${file}'. Short-circuiting directly to Phase 4 Auditor.`);
      const content = fs.readFileSync(absolutePath, 'utf8');
      const fileHash = crypto.createHash('md5').update(content).digest('hex');
      
      if (!auditedHashes.has(fileHash)) {
        const semanticPrompt = `You are a strict code quality auditor. Review the following code segment from file ${file}. Look for hidden runtime errors, logical flaws, infinite loops, or unhandled exceptions.

[PATCHED CONTENT]
${content}
[/PATCHED CONTENT]

If you find any bugs, output details of the anomalies. If flawless, return exactly one word: 'NO_ISSUE'.`;
        const auditResponse = await generateChatCompletion(semanticPrompt, 'You perform final post-flight semantic checks.', false);
        if (auditResponse.trim().toUpperCase().includes('NO_ISSUE')) {
          console.log(chalk.bold.green(`✓ `) + `'${file}' passed semantic audit.`);
          auditedHashes.add(fileHash);
          return;
        } else {
          console.log(chalk.yellow(`[giga] Semantic auditor flagged anomalies: ${auditResponse}`));
          localLog = auditResponse;
        }
      } else {
        return;
      }
    }

    while (retryCount <= maxRetries && !fileFixed) {
      console.log(`[giga] Phase 3 Modifying '${file}' (Attempt ${retryCount}/${maxRetries})...`);
      const content = fs.readFileSync(absolutePath, 'utf8');
      const lines = content.split(/\\r?\\n/);
      let newContent = '';

      if (lines.length < 150) {
        const overwritePrompt = `You are correcting the following small file: ${file}.
Please output the ENTIRE updated file content from scratch. 
Do not use SEARCH/REPLACE blocks.
Do not wrap your output in markdown code blocks.

[CURRENT FILE CONTENT]
${content}
[/CURRENT FILE CONTENT]

Anomalies/Failures to fix:
${localLog}
Strategy: ${plan.strategy}`;
        const result = await generateChatCompletion(overwritePrompt, 'You output absolute file overwrites.');
        newContent = result.trim();
        if (newContent.startsWith('\`\`\`')) {
          newContent = newContent.replace(/^\`\`\`[a-zA-Z]*\\n/, '').replace(/\\n\`\`\`$/, '').trim();
        }
      } else {
        const replacePrompt = `You are correcting the following file: ${file}.
Please output search-and-replace blocks using this exact format:

<<<<<<< SEARCH
[The exact broken code segment as it exists in the source file]
=======
[The exact corrected code block to take its place]
>>>>>>> REPLACE

Do not output any other text or markdown packaging.

[CURRENT FILE CONTENT]
${content}
[/CURRENT FILE CONTENT]

Anomalies/Failures to fix:
${localLog}
Strategy: ${plan.strategy}`;
        const result = await generateChatCompletion(replacePrompt, 'You output precise SEARCH/REPLACE blocks.');
        const blocks = parseSearchReplaceBlocks(result);
        
        let tempContent = content;
        try {
          for (const block of blocks) {
            if (!tempContent.includes(block.search)) {
              throw new Error(`SEARCH segment not found in target file: ${block.search}`);
            }
            tempContent = tempContent.replace(block.search, block.replace);
          }
          newContent = tempContent;
        } catch (err: any) {
          console.log(chalk.red(`[giga] Block parsing failed: ${err.message}`));
          retryCount++;
          continue;
        }
      }

      if (newContent) {
        fs.writeFileSync(absolutePath, newContent, 'utf8');
        appliedAny = true;

        console.log(`[giga] Phase 4 Auditing updates in '${file}'...`);
        const syntaxErr = checkSyntax(newContent, absolutePath);
        if (syntaxErr) {
          console.log(chalk.yellow(`[giga] Static syntax check failed: ${syntaxErr}`));
          localLog = syntaxErr;
          retryCount++;
          continue;
        }

        const fileHash = crypto.createHash('md5').update(newContent).digest('hex');
        if (auditedHashes.has(fileHash)) {
          console.log(chalk.bold.green(`✓ `) + `'${file}' matches previously audited flawless state.`);
          fileFixed = true;
          break; // The State Transition Fix: explicitly break loop
        }

        const semanticPrompt = `You are a strict code quality auditor. Review the following code segment from file ${file}. Look for hidden runtime errors, logical flaws, infinite loops, or unhandled exceptions.

[PATCHED CONTENT]
${newContent}
[/PATCHED CONTENT]

If you find any bugs, output details of the anomalies. If flawless, return exactly one word: 'NO_ISSUE'.`;
        const auditResponse = await generateChatCompletion(semanticPrompt, 'You perform final post-flight semantic checks.', false);
        if (auditResponse.trim().toUpperCase().includes('NO_ISSUE')) {
          console.log(chalk.bold.green(`✓ `) + `'${file}' passed all structural and semantic audits.`);
          auditedHashes.add(fileHash);
          fileFixed = true;
          break; // The State Transition Fix: explicitly break loop
        } else {
          console.log(chalk.yellow(`[giga] Semantic auditor flagged anomalies: ${auditResponse}`));
          localLog = auditResponse;
          retryCount++;
        }
      }
    }
  }));

  if (appliedAny) {
    setValidationState('healed');
  }
  return { applied: appliedAny, diffText: lastDiff, failuresCount: health.failures.length };
}

// PR body details reasoning builder
export async function generatePullRequestDescription(
  gitDiff: string
): Promise<{ title: string; body: string }> {
  const draftingPrompt = `
You are preparing a pull request body.
Below is the git diff:
${gitDiff}

Generate a comprehensive PR description in markdown covering:
1. Symptoms caught.
2. Root cause diagnosed.
3. Patch strategies applied.

Return response as JSON object with keys "title" and "body". Do not write markdown wrapping.
`;
  try {
    const text = await generateChatCompletion(draftingPrompt, 'You draft enterprise-grade pull requests.', true);
    const parsed = JSON.parse(text);
    return {
      title: parsed.title || 'fix: resolve codebase anomalies',
      body: parsed.body || 'Implemented codebase improvements.'
    };
  } catch (_) {
    return {
      title: 'fix: resolve codebase anomalies',
      body: 'Implemented codebase improvements.'
    };
  }
}

export async function identifyRelevantFiles(
  issueTitle: string,
  issueBody: string,
  allFiles: string[]
): Promise<string[]> {
  const provider = process.env.LLM_PROVIDER || 'Google Gemini';
  console.log(chalk.ansi256(208)('→ ') + `${provider} analyzing issue & repo files...`);
  
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
    console.log(chalk.bold.green('✓ ') + `Identified relevant files via ${provider}`);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.files)) {
      return parsed.files.map((f: any) => String(f));
    }
    return [];
  } catch (error: any) {
    console.log(chalk.bold.red('✗ ') + `Failed to identify files via ${provider}: ${error.message}`);
    return [];
  }
}
