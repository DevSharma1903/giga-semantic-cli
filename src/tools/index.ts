import { simpleGit, SimpleGit } from 'simple-git';
import { Octokit } from 'octokit';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, execSync } from 'child_process';
import chalk from 'chalk';
import { confirm, isCancel, select, password, text, log as clackLog } from '@clack/prompts';

export async function askConfirmation(query: string): Promise<boolean> {
  const confirmed = await confirm({
    message: query,
    initialValue: true
  });
  if (isCancel(confirmed)) {
    return false;
  }
  return confirmed;
}

export async function executeCommandSecurely(command: string, cwd: string = process.cwd()): Promise<{ stdout: string; stderr: string; code: number }> {
  console.log(chalk.cyan(`\n[Security Check] Requested command to run:`));
  console.log(chalk.gray(`  Directory: ${cwd}`));
  console.log(chalk.bold.red(`  Command:   ${command}`));
  
  const confirmed = await askConfirmation(`Do you want to run this command?`);
  if (!confirmed) {
    throw new Error(`Command execution rejected by user: ${command}`);
  }

  return new Promise((resolve) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        code: error ? error.code || 1 : 0
      });
    });
  });
}

export async function getRepoInfo(cwd: string = process.cwd()): Promise<{ owner: string; repo: string }> {
  try {
    const git = getGitClient(cwd);
    const remotes = await executeGitOperation(() => git.getRemotes(true), 'Failed to retrieve git remotes');
    const origin = remotes.find(r => r.name === 'origin') || remotes[0];
    if (!origin) {
      throw new Error("No remote found");
    }
    const url = origin.refs.push || origin.refs.fetch;
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
    throw new Error(`Could not parse github repo/owner from remote url: ${url}`);
  } catch (err: any) {
    const owner = process.env.GITHUB_OWNER || '';
    const repo = process.env.GITHUB_REPO || '';
    if (owner && repo) {
      return { owner, repo };
    }
    throw new Error(`Could not determine repository owner/name from Git remotes: ${err.message}. Please configure process.env.GITHUB_OWNER and GITHUB_REPO.`);
  }
}

export async function fetchGithubIssue(issueNumber: number, owner: string, repo: string, token?: string): Promise<{ title: string; body: string; state: string; state_reason?: string | null }> {
  const octokit = new Octokit({
    auth: token || process.env.GITHUB_TOKEN,
    request: { headers: { 'X-GitHub-Api-Version': '2026-03-10' } }
  });
  const response = await octokit.rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber
  });
  return {
    title: response.data.title,
    body: response.data.body || '',
    state: response.data.state,
    state_reason: response.data.state_reason
  };
}

export function isIgnoredOrLockfile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  
  if (parts.includes('node_modules') || parts.includes('dist') || parts.includes('.git') || parts.includes('build')) {
    return true;
  }
  
  const fileName = parts[parts.length - 1];
  const lockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];
  if (lockfiles.includes(fileName)) {
    return true;
  }
  
  return false;
}

export function findRelevantFiles(cwd: string, keywords: string[]): string[] {
  let files: string[] = [];
  let isGit = false;

  try {
    const tracked = execSync('git ls-files', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .filter(Boolean);
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .filter(Boolean);
    files = [...tracked, ...untracked];
    isGit = true;
  } catch (e) {
    // Fail gracefully and fallback to manual traversal
  }

  if (!isGit) {
    const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.gemini', 'coverage'];
    function traverse(dir: string) {
      if (!fs.existsSync(dir)) return;
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        const relPath = path.relative(cwd, fullPath);
        
        if (stat.isDirectory()) {
          if (!ignoreDirs.includes(file)) {
            traverse(fullPath);
          }
        } else if (stat.isFile()) {
          files.push(relPath);
        }
      }
    }
    traverse(cwd);
  }

  // Under NO circumstances compile contents of node_modules/, dist/, or lockfiles
  files = files.filter(f => !isIgnoredOrLockfile(f));

  if (keywords.length === 0) {
    const codeExtensions = ['.ts', '.js', '.json', '.py', '.go', '.rs', '.java', '.cpp', '.h', '.c', '.cs', '.html', '.css', '.md'];
    return files.filter(f => codeExtensions.includes(path.extname(f)));
  }

  const scoredFiles = files.map(file => {
    let score = 0;
    const baseName = path.basename(file).toLowerCase();
    const relativePathLower = file.toLowerCase();
    
    for (const keyword of keywords) {
      const kw = keyword.toLowerCase();
      if (baseName.includes(kw)) {
        score += 10;
      } else if (relativePathLower.includes(kw)) {
        score += 5;
      }
      
      try {
        const content = fs.readFileSync(path.join(cwd, file), 'utf8');
        if (content.toLowerCase().includes(kw)) {
          score += 2;
        }
      } catch (_) {}
    }
    
    return { file, score };
  });
  
  return scoredFiles
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(f => f.file);
}

export function listCodeFiles(cwd: string): string[] {
  return findRelevantFiles(cwd, []);
}

export function applyPatch(filePath: string, startLine: number, endLine: number, replacementContent: string): void {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  const content = fs.readFileSync(absolutePath, 'utf8');
  // Handle carriage return issues elegantly
  const lines = content.split(/\r?\n/);
  
  const zeroBasedStart = Math.max(0, startLine - 1);
  const zeroBasedEnd = Math.min(lines.length, endLine);
  
  const replacementLines = replacementContent.split(/\r?\n/);
  
  lines.splice(zeroBasedStart, zeroBasedEnd - zeroBasedStart, ...replacementLines);
  
  fs.writeFileSync(absolutePath, lines.join('\n'), 'utf8');
}

export function getGitClient(cwd: string = process.cwd()): SimpleGit {
  return simpleGit({
    baseDir: cwd,
    timeout: {
      block: 15000 // 15 seconds
    }
  });
}

export async function executeGitOperation<T>(
  operation: () => Promise<T>,
  errorMessage: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error("Timeout: Git operation took longer than 15 seconds."));
    }, 15000);
  });
  
  try {
    return await Promise.race([operation(), timeoutPromise]);
  } catch (error: any) {
    const rawStderr = error.git?.stderr || error.stderr || error.message || String(error);
    clackLog.error(`Git Error: ${errorMessage}`);
    clackLog.error(`Details (stderr): ${rawStderr}`);
    throw error;
  }
}

export async function safeguardGitignore(cwd: string = process.cwd()): Promise<void> {
  const gitignorePath = path.join(cwd, '.gitignore');
  const envFilesToCheck = ['.env', '.env.local', '.env.production', '.gigarc'];
  
  for (const envFile of envFilesToCheck) {
    const filePath = path.join(cwd, envFile);
    if (fs.existsSync(filePath)) {
      let isIgnored = false;
      try {
        const git = getGitClient(cwd);
        await git.checkIgnore(envFile);
        isIgnored = true;
      } catch (e) {
        isIgnored = false;
      }
      
      if (!isIgnored) {
        let gitignoreContent = '';
        if (fs.existsSync(gitignorePath)) {
          gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
        }
        const suffix = gitignoreContent.endsWith('\n') ? '' : '\n';
        fs.writeFileSync(gitignorePath, `${gitignoreContent}${suffix}${envFile}\n`, 'utf8');
        clackLog.warn(`Added ${envFile} to .gitignore for security.`);
      }
    }
  }
}

export async function safeStageFiles(git: SimpleGit, cwd: string = process.cwd()): Promise<void> {
  const status = await git.status();
  const filesToStage = [
    ...status.modified,
    ...status.not_added,
    ...status.deleted,
    ...status.renamed.map(r => r.to)
  ].filter(file => {
    const basename = path.basename(file);
    return !['.env', '.env.local', '.env.production', '.gigarc'].includes(basename);
  });
  
  if (filesToStage.length > 0) {
    await git.add(filesToStage);
  }
}

export async function createAndSwitchBranch(branchName: string, cwd: string = process.cwd()): Promise<void> {
  const git = getGitClient(cwd);
  
  // Local Repository Tracking Resilience
  await executeGitOperation(() => git.fetch('origin'), 'Failed to fetch origin').catch(() => {});
  await executeGitOperation(() => git.checkout('main'), 'Failed to checkout main').catch(() => {});
  await executeGitOperation(() => git.branch(['-D', branchName]), 'Failed to delete old branch').catch(() => {});
  
  await executeGitOperation(() => git.checkoutLocalBranch(branchName), `Failed to create/checkout branch '${branchName}'`);
}

export async function getGitDiffSummary(cwd: string = process.cwd()): Promise<string> {
  const git = getGitClient(cwd);
  await safeguardGitignore(cwd);
  await executeGitOperation(() => safeStageFiles(git, cwd), 'Failed to stage files for diff');
  return await executeGitOperation(() => git.diff([
    'HEAD',
    '--',
    ':(exclude)package-lock.json',
    ':(exclude)yarn.lock',
    ':(exclude)pnpm-lock.yaml',
    ':(exclude)bun.lockb',
    ':(exclude)node_modules',
    ':(exclude)dist'
  ]), 'Failed to generate git diff');
}

export async function stageCommitPush(branchName: string, commitMessage: string, cwd: string = process.cwd()): Promise<void> {
  const git = getGitClient(cwd);
  await safeguardGitignore(cwd);
  await executeGitOperation(() => safeStageFiles(git, cwd), 'Failed to stage files');
  await executeGitOperation(() => git.commit(commitMessage), `Failed to commit changes: "${commitMessage}"`);
  await executeGitOperation(() => git.push('origin', branchName, { '--set-upstream': null }), `Failed to push branch '${branchName}'`);
}

export async function createPullRequest(
  title: string,
  body: string,
  head: string,
  base: string = 'main',
  owner: string,
  repo: string,
  token?: string
): Promise<string> {
  const octokit = new Octokit({
    auth: token || process.env.GITHUB_TOKEN,
    request: { headers: { 'X-GitHub-Api-Version': '2026-03-10' } }
  });
  const response = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    body,
    head,
    base
  });
  return response.data.html_url;
}

export function getTestCommand(cwd: string): string {
  const packageJsonPath = path.join(cwd, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.test) {
        return 'npm test';
      }
    } catch (_) {}
  }
  return 'npm test';
}

export function sanitizeErrorTrace(trace: string): string {
  if (trace.length > 1500) {
    return trace.slice(0, 500) + '[... verbose test logs truncated for token safety ...]' + trace.slice(-1000);
  }
  return trace;
}

export async function runTests(cwd: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const testCommand = getTestCommand(cwd);
  return new Promise((resolve) => {
    exec(testCommand, { cwd }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        stdout: sanitizeErrorTrace(stdout),
        stderr: sanitizeErrorTrace(stderr)
      });
    });
  });
}

export interface CompilerFailure {
  filePath: string;
  line: number;
  column?: number;
  message: string;
}

export async function runCompilation(cwd: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  let command = 'npm run build';
  const packageJsonPath = path.join(cwd, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.build) {
        command = 'npm run build';
      } else if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
        command = 'npx tsc --noEmit';
      }
    } catch (_) {}
  } else if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    command = 'npx tsc --noEmit';
  }

  return new Promise((resolve) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        stdout,
        stderr
      });
    });
  });
}

export function parseCompilerErrors(stdout: string, stderr: string, cwd: string): CompilerFailure[] {
  const failures: CompilerFailure[] = [];
  const combined = stdout + '\n' + stderr;
  const lines = combined.split(/\r?\n/);

  const pattern1 = /([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9]+)\((\d+),(\d+)\):\s*(.*)/;
  const pattern2 = /([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9]+):(\d+):(\d+)\s*-\s*(.*)/;
  const pattern3 = /([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9]+):(\d+):(\d+):\s*(.*)/;
  const pattern4 = /([a-zA-Z0-9_\-\.\/\\:]+\.[a-zA-Z0-9]+):(\d+)\s*-\s*(error.*)/;

  for (const lineText of lines) {
    let match = lineText.match(pattern1);
    if (match) {
      const file = match[1].trim();
      if (!isIgnoredOrLockfile(file) && fs.existsSync(path.resolve(cwd, file))) {
        failures.push({
          filePath: file,
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          message: match[4].trim()
        });
        continue;
      }
    }

    match = lineText.match(pattern2);
    if (match) {
      const file = match[1].trim();
      if (!isIgnoredOrLockfile(file) && fs.existsSync(path.resolve(cwd, file))) {
        failures.push({
          filePath: file,
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          message: match[4].trim()
        });
        continue;
      }
    }

    match = lineText.match(pattern3);
    if (match) {
      const file = match[1].trim();
      if (!isIgnoredOrLockfile(file) && fs.existsSync(path.resolve(cwd, file))) {
        failures.push({
          filePath: file,
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          message: match[4].trim()
        });
        continue;
      }
    }

    match = lineText.match(pattern4);
    if (match) {
      const file = match[1].trim();
      if (!isIgnoredOrLockfile(file) && fs.existsSync(path.resolve(cwd, file))) {
        failures.push({
          filePath: file,
          line: parseInt(match[2], 10),
          message: match[3].trim()
        });
        continue;
      }
    }
  }

  const seen = new Set<string>();
  return failures.filter(f => {
    const key = `${f.filePath}:${f.line}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function applyUnifiedDiff(diffText: string, cwd: string = process.cwd()): void {
  const lines = diffText.split(/\r?\n/);
  let currentFile: string | null = null;
  let fileLines: string[] = [];
  let fileChanged = false;
  let offset = 0;

  const saveCurrentFile = () => {
    if (currentFile && fileChanged) {
      const absolutePath = path.isAbsolute(currentFile) ? currentFile : path.join(cwd, currentFile);
      fs.writeFileSync(absolutePath, fileLines.join('\n'), 'utf8');
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('--- ')) {
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.startsWith('+++ ')) {
        saveCurrentFile();

        let filePath = nextLine.substring(4).trim();
        if (filePath.startsWith('b/')) {
          filePath = filePath.substring(2);
        }
        currentFile = filePath;

        const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
        if (fs.existsSync(absolutePath)) {
          fileLines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
        } else {
          fileLines = [];
        }
        fileChanged = true;
        offset = 0;
        i += 2;
        continue;
      }
    }

    if (line.startsWith('@@ ')) {
      const match = line.match(/^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
      if (match && currentFile) {
        const oldStart = parseInt(match[1], 10);
        let oldIdx = Math.max(0, oldStart - 1) + offset;
        i++;

        while (i < lines.length) {
          const chunkLine = lines[i];
          if (chunkLine.startsWith('@@ ') || chunkLine.startsWith('--- ')) {
            i--;
            break;
          }

          if (chunkLine.startsWith('-')) {
            fileLines.splice(oldIdx, 1);
            offset--;
          } else if (chunkLine.startsWith('+')) {
            fileLines.splice(oldIdx, 0, chunkLine.substring(1));
            oldIdx++;
            offset++;
          } else {
            oldIdx++;
          }
          i++;
        }
      }
    }
    i++;
  }
  saveCurrentFile();
}


/**
 * Resolves a path relative to the execution root or binary location.
 */
export function resolveExecutionPath(relativePath: string): string {
  if ((process as any).pkg) {
    return path.join(path.dirname(process.execPath), relativePath);
  }
  return path.join(process.cwd(), relativePath);
}

export function extractKeywordsAndPaths(text: string): { keywords: string[]; paths: string[] } {
  const keywords: string[] = [];
  const paths: string[] = [];

  let match;
  // Match words inside backticks (often functions or file paths)
  const backtickRegex = /`([^`]+)`/g;
  while ((match = backtickRegex.exec(text)) !== null) {
    const val = match[1].trim();
    if (val.includes('.') || val.includes('/') || val.includes('\\')) {
      paths.push(val);
    } else {
      keywords.push(val);
    }
  }

  // Split general text to get keywords
  const rawWords = text.split(/\s+/);
  for (const word of rawWords) {
    const cleaned = word.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (cleaned.length > 3) {
      keywords.push(cleaned);
    }
  }

  return {
    keywords: Array.from(new Set(keywords)),
    paths: Array.from(new Set(paths))
  };
}

export function checkSyntax(content: string, filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(content);
      return null;
    } catch (err: any) {
      return `JSON parse error: ${err.message}`;
    }
  }

  if (ext === '.ts' || ext === '.js' || ext === '.json' || ext === '.tsx' || ext === '.jsx') {
    const stack: { char: string; line: number; col: number }[] = [];
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateLiteral = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    let line = 1;
    let col = 0;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if (char === '\n') {
        line++;
        col = 0;
      } else {
        col++;
      }

      if (escaped) {
        escaped = false;
        continue;
      }

      if (inLineComment) {
        if (char === '\n') {
          inLineComment = false;
        }
        continue;
      }

      if (inBlockComment) {
        if (char === '*' && content[i + 1] === '/') {
          inBlockComment = false;
          i++;
          col++;
        }
        continue;
      }

      if (inSingleQuote) {
        if (char === '\\') {
          escaped = true;
        } else if (char === "'") {
          inSingleQuote = false;
        }
        continue;
      }

      if (inDoubleQuote) {
        if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inDoubleQuote = false;
        }
        continue;
      }

      if (inTemplateLiteral) {
        if (char === '\\') {
          escaped = true;
        } else if (char === '`') {
          inTemplateLiteral = false;
        }
        continue;
      }

      // Check comments
      if (char === '/' && content[i + 1] === '/') {
        inLineComment = true;
        i++;
        col++;
        continue;
      }
      if (char === '/' && content[i + 1] === '*') {
        inBlockComment = true;
        i++;
        col++;
        continue;
      }

      // Check quotes
      if (char === "'") {
        inSingleQuote = true;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = true;
        continue;
      }
      if (char === '`') {
        inTemplateLiteral = true;
        continue;
      }

      // Brackets
      if (char === '(' || char === '{' || char === '[') {
        stack.push({ char, line, col });
      } else if (char === ')' || char === '}' || char === ']') {
        if (stack.length === 0) {
          return `Unmatched closing bracket '${char}' at line ${line}, col ${col}`;
        }
        const top = stack.pop()!;
        if (
          (char === ')' && top.char !== '(') ||
          (char === '}' && top.char !== '{') ||
          (char === ']' && top.char !== '[')
        ) {
          return `Mismatched bracket: closed '${char}' at line ${line}, col ${col} but expected closing match for '${top.char}' from line ${top.line}, col ${top.col}`;
        }
      }
    }

    if (stack.length > 0) {
      const top = stack.pop()!;
      return `Unclosed bracket '${top.char}' from line ${top.line}, col ${top.col} (reached end of file)`;
    }
  }

  return null;
}

function resolveImportPath(dirPath: string, importPath: string): string | null {
  const absolutePath = path.resolve(dirPath, importPath);
  
  // Try exact path
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
    return absolutePath;
  }

  // Try common extensions
  const extensions = ['.ts', '.js', '.json', '.tsx', '.jsx'];
  for (const ext of extensions) {
    const withExt = absolutePath + ext;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  // Try /index with extensions
  for (const ext of extensions) {
    const indexWithExt = path.join(absolutePath, 'index' + ext);
    if (fs.existsSync(indexWithExt) && fs.statSync(indexWithExt).isFile()) {
      return indexWithExt;
    }
  }

  return null;
}

export function auditFileSystemAndImports(
  cwd: string,
  targetFiles: string[],
  issueText: string
): { missingFiles: { file: string; referencedBy: string }[] } {
  const missingFiles: { file: string; referencedBy: string }[] = [];

  const addMissingFile = (candidate: string, referencedBy: string) => {
    if (!candidate.includes('/') && !candidate.includes('\\') && !candidate.includes('.')) {
      // Ignore plain numeric strings, versions, or words completely
      return;
    }
    // Explicitly filter out version numbers (e.g. 1.0.1 or 0.0.1)
    if (/^\d+(\.\d+)+$/.test(candidate) || /^v?\d+\.\d+\.\d+/.test(candidate)) {
      return;
    }
    missingFiles.push({ file: candidate, referencedBy });
  };

  for (const file of targetFiles) {
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    // Align Pre-Flight Audit to Crawled/Existing Files Only
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    if (isIgnoredOrLockfile(file)) continue;

    try {
      const content = fs.readFileSync(absolutePath, 'utf8');
      const dirPath = path.dirname(absolutePath);

      // Parse imports/requires
      const importRegex = /(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|(?:import\s+[^;]*?\s+from\s+|import\s+)['"`]([^'"`]+)['"`]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1] || match[2];
        if (importPath.startsWith('.') || importPath.startsWith('/') || importPath.startsWith('\\')) {
          const resolved = resolveImportPath(dirPath, importPath);
          if (!resolved) {
            addMissingFile(importPath, file);
          }
        }
      }

      // Check for file-like strings in fs.readFileSync, fs.readFile, etc., or general string literals ending with extensions
      const stringLiteralRegex = /['"`]([^'"`\r\n]+)['"`]/g;
      while ((match = stringLiteralRegex.exec(content)) !== null) {
        const str = match[1];
        if (/\.[a-zA-Z0-9]{1,6}$/.test(str) && !str.startsWith('http') && !str.startsWith('//')) {
          const potentialPath = path.isAbsolute(str) ? str : path.resolve(cwd, str);
          if (potentialPath.startsWith(cwd)) {
            const rel = path.relative(cwd, potentialPath);
            if (isIgnoredOrLockfile(rel)) continue;
            if (str.includes('/') || str.includes('\\') || str.toLowerCase() === 'readme.md' || str.toLowerCase() === 'package.json') {
              if (!fs.existsSync(potentialPath)) {
                addMissingFile(str, file);
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  // Deduplicate missing files
  const uniqueMissing: typeof missingFiles = [];
  const seen = new Set<string>();
  for (const m of missingFiles) {
    const key = `${m.file}::${m.referencedBy}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueMissing.push(m);
    }
  }

  return { missingFiles: uniqueMissing };
}

export function crawlWorkspace(cwd: string, issueText: string): string[] {
  const { keywords, paths } = extractKeywordsAndPaths(issueText);
  const searchTerms = new Set<string>();

  for (const kw of keywords) {
    if (kw.length > 2) {
      searchTerms.add(kw.toLowerCase());
    }
  }
  for (const p of paths) {
    searchTerms.add(p.toLowerCase());
    const base = path.basename(p);
    if (base.length > 2) {
      searchTerms.add(base.toLowerCase());
    }
  }

  const lowerIssueText = issueText.toLowerCase();
  if (lowerIssueText.includes('read') || lowerIssueText.includes('file')) {
    searchTerms.add('fs.read');
    searchTerms.add('fs.readfilesync');
    searchTerms.add('fs.readfile');
    searchTerms.add('readfilesync');
    searchTerms.add('readfile');
  }
  if (lowerIssueText.includes('write')) {
    searchTerms.add('fs.write');
    searchTerms.add('fs.writefilesync');
    searchTerms.add('fs.writefile');
    searchTerms.add('writefilesync');
    searchTerms.add('writefile');
  }

  const allFiles = listCodeFiles(cwd);
  const matchedFiles: string[] = [];

  for (const file of allFiles) {
    const absolutePath = path.resolve(cwd, file);
    if (!fs.existsSync(absolutePath)) continue;

    try {
      const content = fs.readFileSync(absolutePath, 'utf8');

      // 1. If a file throws a syntax anomaly during the crawl, isolate it
      const syntaxError = checkSyntax(content, absolutePath);
      if (syntaxError) {
        matchedFiles.push(file);
        continue;
      }

      // 2. Check if file content references broken entity / search terms
      const lowerContent = content.toLowerCase();
      let hasMatch = false;

      for (const term of searchTerms) {
        if (lowerContent.includes(term)) {
          hasMatch = true;
          break;
        }
      }

      if (hasMatch) {
        matchedFiles.push(file);
      }
    } catch (_) {}
  }

  return matchedFiles;
}

export async function closeGithubIssue(
  issueNumber: number,
  owner: string,
  repo: string,
  token?: string
): Promise<void> {
  const octokit = new Octokit({
    auth: token || process.env.GITHUB_TOKEN,
    request: { headers: { 'X-GitHub-Api-Version': '2026-03-10' } }
  });
  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: 'closed',
    state_reason: 'completed'
  });
}

export async function closeIssueAsNotPlanned(
  issueNumber: number,
  owner: string,
  repo: string,
  reason: string,
  token?: string
): Promise<void> {
  const octokit = new Octokit({
    auth: token || process.env.GITHUB_TOKEN,
    request: { headers: { 'X-GitHub-Api-Version': '2026-03-10' } }
  });
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: `Giga has validated the workspace and determined this issue is a false alarm or invalid.\n\n**Reason:** ${reason}`
  });
  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: 'closed',
    state_reason: 'not_planned'
  });
}

export function loadRCConfig(cwd: string = process.cwd()): void {
  const localRC = path.join(cwd, '.env.local');
  if (fs.existsSync(localRC)) {
    const content = fs.readFileSync(localRC, 'utf8');
    parseEnvContent(content);
  }
  const globalRC = path.join(os.homedir(), '.gigarc');
  if (fs.existsSync(globalRC)) {
    try {
      const config = JSON.parse(fs.readFileSync(globalRC, 'utf8'));
      if (config.LLM_PROVIDER) process.env.LLM_PROVIDER = config.LLM_PROVIDER;
      if (config.LLM_MODEL) process.env.LLM_MODEL = config.LLM_MODEL;
      if (config.API_KEY) {
        process.env.API_KEY = config.API_KEY;
        if (config.LLM_PROVIDER === 'Google Gemini') process.env.GEMINI_API_KEY = config.API_KEY;
        if (config.LLM_PROVIDER === 'Anthropic Claude') process.env.ANTHROPIC_API_KEY = config.API_KEY;
        if (config.LLM_PROVIDER === 'OpenAI') process.env.OPENAI_API_KEY = config.API_KEY;
        if (config.LLM_PROVIDER === 'DeepSeek') process.env.DEEPSEEK_API_KEY = config.API_KEY;
      }
      if (config.GITHUB_TOKEN) process.env.GITHUB_TOKEN = config.GITHUB_TOKEN;
    } catch (_) {}
  }
}

function parseEnvContent(content: string): void {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let val = match[2] || '';
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      process.env[key] = val;
      if (key === 'API_KEY') {
        if (process.env.LLM_PROVIDER === 'Google Gemini') process.env.GEMINI_API_KEY = val;
        if (process.env.LLM_PROVIDER === 'Anthropic Claude') process.env.ANTHROPIC_API_KEY = val;
        if (process.env.LLM_PROVIDER === 'OpenAI') process.env.OPENAI_API_KEY = val;
        if (process.env.LLM_PROVIDER === 'DeepSeek') process.env.DEEPSEEK_API_KEY = val;
      }
    }
  }
}

export function saveRCConfig(
  config: { provider: string; model: string; apiKey: string; githubToken: string },
  cwd: string = process.cwd()
): void {
  const rcData = {
    LLM_PROVIDER: config.provider,
    LLM_MODEL: config.model,
    API_KEY: config.apiKey,
    GITHUB_TOKEN: config.githubToken
  };

  const globalRC = path.join(os.homedir(), '.gigarc');
  fs.writeFileSync(globalRC, JSON.stringify(rcData, null, 2), 'utf8');

  const localRC = path.join(cwd, '.env.local');
  const envLines = [
    `LLM_PROVIDER="${config.provider}"`,
    `LLM_MODEL="${config.model}"`,
    `API_KEY="${config.apiKey}"`,
    `GITHUB_TOKEN="${config.githubToken}"`
  ];
  fs.writeFileSync(localRC, envLines.join('\n'), 'utf8');

  process.env.LLM_PROVIDER = config.provider;
  process.env.LLM_MODEL = config.model;
  process.env.API_KEY = config.apiKey;
  process.env.GITHUB_TOKEN = config.githubToken;
  if (config.provider === 'Google Gemini') process.env.GEMINI_API_KEY = config.apiKey;
  if (config.provider === 'Anthropic Claude') process.env.ANTHROPIC_API_KEY = config.apiKey;
  if (config.provider === 'OpenAI') process.env.OPENAI_API_KEY = config.apiKey;
  if (config.provider === 'DeepSeek') process.env.DEEPSEEK_API_KEY = config.apiKey;
  if (config.provider === 'Groq') process.env.GROQ_API_KEY = config.apiKey;
}

export async function connectProvider(cwd: string = process.cwd()): Promise<void> {
  console.log(chalk.bold.cyan('\n--- Giga Connection Config Setup ---'));

  const provider = await select({
    message: 'Select your preferred LLM provider:',
    options: [
      { value: 'Google Gemini', label: 'Google Gemini' },
      { value: 'Anthropic Claude', label: 'Anthropic Claude' },
      { value: 'OpenAI', label: 'OpenAI' },
      { value: 'DeepSeek', label: 'DeepSeek' },
      { value: 'Groq', label: 'Groq' },
      { value: 'Local Ollama', label: 'Local Ollama (Offline)' }
    ]
  });

  if (isCancel(provider)) {
    console.log(chalk.yellow('Setup cancelled.'));
    return;
  }

  let modelOptions: { value: string; label: string }[] = [];
  if (provider === 'Google Gemini') {
    modelOptions = [
      { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
      { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
      { value: 'gemini-1.5-pro', label: 'gemini-1.5-pro' },
      { value: 'gemini-ultra', label: 'gemini-ultra' }
    ];
  } else if (provider === 'Anthropic Claude') {
    modelOptions = [
      { value: 'claude-3-5-sonnet', label: 'claude-3-5-sonnet' },
      { value: 'claude-3-5-haiku', label: 'claude-3-5-haiku' },
      { value: 'claude-3-opus', label: 'claude-3-opus' }
    ];
  } else if (provider === 'OpenAI') {
    modelOptions = [
      { value: 'gpt-4o', label: 'gpt-4o' },
      { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
      { value: 'o1-preview', label: 'o1-preview' },
      { value: 'o1-mini', label: 'o1-mini' }
    ];
  } else if (provider === 'DeepSeek') {
    modelOptions = [
      { value: 'deepseek-v3', label: 'deepseek-v3' },
      { value: 'deepseek-r1', label: 'deepseek-r1' }
    ];
  } else if (provider === 'Local Ollama') {
    modelOptions = [
      { value: 'deepseek-coder:7b', label: 'deepseek-coder:7b' },
      { value: 'llama3.1:8b', label: 'llama3.1:8b' },
      { value: 'qwen2.5-coder:7b', label: 'qwen2.5-coder:7b' },
      { value: 'mistral', label: 'mistral' }
    ];
  } else if (provider === 'Groq') {
    modelOptions = [
      { value: 'llama3-8b-8192', label: 'llama3-8b-8192' },
      { value: 'llama3-70b-8192', label: 'llama3-70b-8192' },
      { value: 'mixtral-8x7b-32768', label: 'mixtral-8x7b-32768' },
      { value: 'gemma2-9b-it', label: 'gemma2-9b-it' }
    ];
  }

  const model = await select({
    message: 'Select the model engine:',
    options: modelOptions
  });

  if (isCancel(model)) {
    console.log(chalk.yellow('Setup cancelled.'));
    return;
  }

  let apiKey = '';
  if (provider !== 'Local Ollama') {
    const keyInput = await password({
      message: `Enter your API Key for ${provider}:`
    });
    if (isCancel(keyInput)) {
      console.log(chalk.yellow('Setup cancelled.'));
      return;
    }
    apiKey = String(keyInput);
  }

  const githubToken = await password({
    message: 'Enter your GitHub Personal Access Token (GITHUB_TOKEN):'
  });

  if (isCancel(githubToken)) {
    console.log(chalk.yellow('Setup cancelled.'));
    return;
  }

  saveRCConfig({
    provider: String(provider),
    model: String(model),
    apiKey: apiKey,
    githubToken: String(githubToken)
  }, cwd);

  console.log(chalk.bold.green('\n✓ Configuration successfully saved to global ~/.gigarc and local .env.local!'));
}
