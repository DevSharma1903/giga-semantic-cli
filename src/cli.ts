#!/usr/bin/env node
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load .env from workspace CWD (local) and binary folder (global) if packaged
const localEnv = path.join(process.cwd(), '.env');
const globalEnv = (process as any).pkg ? path.join(path.dirname(process.execPath), '.env') : null;

if (fs.existsSync(localEnv)) {
  dotenv.config({ path: localEnv });
}
if (globalEnv && fs.existsSync(globalEnv)) {
  dotenv.config({ path: globalEnv, override: false });
}

import { Command } from 'commander';
import chalk from 'chalk';
import { intro as clackIntro, outro as clackOutro, log as clackLog, spinner as clackSpinner } from '@clack/prompts';
import {
  getRepoInfo,
  fetchGithubIssue,
  findRelevantFiles,
  createAndSwitchBranch,
  getGitDiffSummary,
  stageCommitPush,
  createPullRequest,
  runTests,
  listCodeFiles,
  executeCommandSecurely,
  checkSyntax,
  closeGithubIssue,
  loadRCConfig,
  connectProvider,
  getGitClient,
  executeGitOperation,
  safeguardGitignore,
  safeStageFiles
} from './tools/index.js';
import {
  identifyRelevantFiles,
  runSelfHealingIteration,
  generatePullRequestDescription,
  verifyIssueSanity,
  lastValidationState,
  setValidationState,
  sessionTokensTally,
  operationElapsedTimeMs,
  resetTelemetry
} from './agent.js';
import * as readline from 'readline';

const program = new Command();

program
  .name('giga')
  .description('Git-Grounded AI Assistant (Giga) - CLI Developer Agent')
  .version('1.0.0');

// Statistics trackers
const startTime = Date.now();
let commandCount = 0;

function getTerminalWidth() {
  return process.stdout.columns || 80;
}

function centerText(text: string): string {
  const width = getTerminalWidth();
  return text.split('\n').map(line => {
    const cleanLine = line.replace(/\u001b\[[0-9;]*m/g, '');
    const paddingLength = Math.max(0, Math.floor((width - cleanLine.length) / 2));
    return ' '.repeat(paddingLength) + line;
  }).join('\n');
}

function printCentered(text: string) {
  console.log(text.split('\n').map(line => '  ' + line).join('\n'));
}

async function animateTypewriter(text: string, speed = 0) {
  const lines = text.split('\n');
  for (const line of lines) {
    const formattedLine = '  ' + line;
    for (let i = 0; i < formattedLine.length; i++) {
      process.stdout.write(formattedLine[i]);
      if (speed > 0) {
        await sleep(speed);
      }
    }
    process.stdout.write('\n');
  }
}

function printTelemetryPanel() {
  const provider = process.env.LLM_PROVIDER || 'Gemini (Google)';
  const model = process.env.GEMINI_MODEL || (
    provider === 'OpenAI' ? 'gpt-4o' :
    provider === 'Claude (Anthropic)' ? 'claude-3-5-sonnet-20241022' :
    provider === 'Groq' ? 'llama3-70b-8192' : 'gemini-2.5-flash'
  );
  console.log('\n' + chalk.bold.cyan('┌────────────────────────────────────────────────────────┐'));
  console.log(chalk.bold.cyan('│                   TELEMETRY ANALYTICS                  │'));
  console.log(chalk.bold.cyan('├────────────────────────────────────────────────────────┤'));
  console.log(`│  Model in Use:              ${chalk.white(model.padEnd(25))} │`);
  console.log(`│  Accumulated Session Tokens: ${chalk.white(String(sessionTokensTally).padEnd(25))} │`);
  console.log(`│  Operation Elapsed Time:     ${chalk.white((String(operationElapsedTimeMs / 1000) + 's').padEnd(25))} │`);
  console.log(chalk.bold.cyan('└────────────────────────────────────────────────────────┘\n'));
}

// Custom wrapper to keep logs clean and centralized
const uiLog = {
  info: async (msg: string) => await animateTypewriter(chalk.dim(msg)),
  success: async (msg: string) => await animateTypewriter(chalk.bold.white(`✓ ${msg}`)),
  step: async (msg: string) => await animateTypewriter(chalk.bold.white(`→ ${msg}`)),
  error: async (msg: string) => await animateTypewriter(chalk.bold.black.bgWhite(` ERROR `) + ' ' + chalk.bold.white(msg)),
  warn: async (msg: string) => await animateTypewriter(chalk.bold.white(`! ${msg}`))
};

const log = {
  warn: async (msg: string) => await uiLog.warn(msg),
  success: async (msg: string) => await uiLog.success(msg),
  info: async (msg: string) => await uiLog.info(msg)
};

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runStartCommand(issueNumber: number) {
  printCentered('\n' + chalk.bold.black.bgWhite('  GIGA START  ') + '\n');
  const s = clackSpinner();
  try {
    s.start('Resolving Git repository owner and name');
    const { owner, repo } = await getRepoInfo();
    s.stop(chalk.bold.white(`Target repository: ${owner}/${repo}`));

    s.start(`Fetching issue #${issueNumber} from GitHub`);
    const issue = await fetchGithubIssue(issueNumber, owner, repo);
    s.stop(chalk.bold.white(`Fetched issue #${issueNumber}`));

    if (issue.state === 'closed') {
      await log.warn("Aborted: Issue #" + issueNumber + " is already CLOSED on GitHub.");
      await log.info("Reason: " + (issue.state_reason || "Completed"));

      const git = getGitClient();
      const status = await executeGitOperation(() => git.status(), 'Failed to get status');
      const currentBranch = status.current;
      const targetBranch = `fix/issue-${issueNumber}`;

      if (currentBranch === targetBranch) {
        s.start('Switching to fallback branch');
        const branches = await executeGitOperation(() => git.branchLocal(), 'Failed to get branch list');
        const fallbackBranch = branches.all.includes('main') ? 'main' : 'master';
        await executeGitOperation(() => git.checkout(fallbackBranch), `Failed to checkout fallback branch '${fallbackBranch}'`);
        s.stop(chalk.bold.white(`Switched to fallback branch '${fallbackBranch}'`));
      }

      const branches = await executeGitOperation(() => git.branchLocal(), 'Failed to get branch list');
      if (branches.all.includes(targetBranch)) {
        s.start(`Deleting local branch '${targetBranch}'`);
        await executeGitOperation(() => git.deleteLocalBranch(targetBranch, true), `Failed to delete local branch '${targetBranch}'`);
        s.stop(chalk.bold.white(`Deleted local branch '${targetBranch}'`));
      }

      return;
    }

    await uiLog.step(`Title: ${issue.title}`);
    await uiLog.info(issue.body.slice(0, 300) + '...');

    s.start('Scanning local directory structure');
    const allFiles = listCodeFiles(process.cwd());
    s.stop(chalk.bold.white(`Scanned ${allFiles.length} project source files`));

    let relevantFiles = await identifyRelevantFiles(issue.title, issue.body, allFiles);
    if (relevantFiles.length === 0) {
      const keywords = issue.title.split(/\s+/).concat(issue.body.split(/\s+/))
        .map(w => w.replace(/[^a-zA-Z0-9_-]/g, ''))
        .filter(w => w.length > 3);
      relevantFiles = findRelevantFiles(process.cwd(), keywords).slice(0, 5);
    }

    await uiLog.success('Relevant Files Target List:');
    relevantFiles.forEach(file => printCentered(chalk.bold.white(`  • ${file}`)));

    const branchName = `fix/issue-${issueNumber}`;
    s.start(`Creating local git branch '${branchName}'`);
    await createAndSwitchBranch(branchName);
    s.stop(chalk.bold.white(`Switched to branch '${branchName}'`));

    printCentered('\n' + chalk.bold.black.bgWhite('  READY TO CODE  ') + '\n');
    printCentered(chalk.dim('Run `giga heal` to evaluate test status.'));
  } catch (error: any) {
    s.stop('Action failed');
    await uiLog.error(`Start failed: ${error.message}`);
  }
}

async function runHealCommand() {
  printCentered('\n' + chalk.bold.black.bgWhite('  GIGA SELF-HEAL  ') + '\n');
  resetTelemetry();

  const shouldProceed = await verifyIssueSanity(process.cwd());
  if (!shouldProceed) {
    printTelemetryPanel();
    return;
  }

  const s = clackSpinner();
  try {
    let issueText = 'General healing request';
    try {
      const git = getGitClient();
      const status = await executeGitOperation(() => git.status(), 'Failed to get status');
      const currentBranch = status.current;
      if (currentBranch && currentBranch.startsWith('fix/issue-')) {
        const issueNumberStr = currentBranch.replace('fix/issue-', '');
        const issueNumber = parseInt(issueNumberStr, 10);
        if (!isNaN(issueNumber)) {
          const { owner, repo } = await getRepoInfo();
          const issue = await fetchGithubIssue(issueNumber, owner, repo);
          issueText = `${issue.title}\n${issue.body}`;
        }
      }
    } catch (_) {}

    const maxIterations = 5;
    let iteration = 1;
    
    while (iteration <= maxIterations) {
      await uiLog.step(`Healing Attempt ${iteration}/${maxIterations}`);
      
      const relevantFiles = listCodeFiles(process.cwd());
      
      try {
        const patchArgs = await runSelfHealingIteration(issueText, relevantFiles, process.cwd());
        await uiLog.success(`Applied patch to '${patchArgs.filePath}' (Lines ${patchArgs.startLine}-${patchArgs.endLine})`);
      } catch (healError: any) {
        await uiLog.error(`Patch formulation aborted: ${healError.message}`);
        break;
      }

      s.start('Executing static syntax validation pass');
      
      let syntaxPass = true;
      const allFiles = listCodeFiles(process.cwd());
      for (const file of allFiles) {
        const absolutePath = path.join(process.cwd(), file);
        if (fs.existsSync(absolutePath)) {
          const content = fs.readFileSync(absolutePath, 'utf8');
          const syntaxErr = checkSyntax(content, absolutePath);
          if (syntaxErr) {
            syntaxPass = false;
            await uiLog.error(`Syntax anomaly detected in '${file}': ${syntaxErr}`);
            break;
          }
        }
      }

      if (syntaxPass) {
        s.stop(chalk.bold.white('Static syntax check passed! Codebase is stable.'));
        printCentered('\n' + chalk.bold.black.bgWhite('  HEALING COMPLETE  ') + '\n');
        setValidationState('healed');
        return;
      }

      s.stop(chalk.bold.white('Syntax checks failed after patch!'));
      iteration++;
    }

    printCentered('\n' + chalk.bold.black.bgWhite('  HEALING LIMIT REACHED  ') + '\n');
  } catch (error: any) {
    await uiLog.error(`Heal failed: ${error.message}`);
  } finally {
    printTelemetryPanel();
  }
}

let isShipCommandRunning = false;

async function runShipCommand() {
  if (isShipCommandRunning) {
    await uiLog.warn("A shipment operation is already in progress.");
    return;
  }
  isShipCommandRunning = true;

  printCentered('\n' + chalk.bold.black.bgWhite('  GIGA SHIP  ') + '\n');
  resetTelemetry();

  if (lastValidationState === 'stood_down') {
    await log.warn("Shipment Aborted: No active code modifications were validated for this issue context.");
    printCentered('\n' + chalk.bold.black.bgWhite('  SHIP ABORTED  ') + '\n');
    printTelemetryPanel();
    isShipCommandRunning = false;
    return;
  }

  const s = clackSpinner();
  try {
    s.start('Generating git diff');
    const diff = await getGitDiffSummary();
    s.stop(chalk.bold.white('Git diff generated'));

    if (!diff || diff.trim() === '') {
      await uiLog.warn('No changes detected in workspace. Nothing to ship.');
      printCentered('\n' + chalk.bold.black.bgWhite('  SHIP SKIPPED  ') + '\n');
      isShipCommandRunning = false;
      return;
    }

    const diffLineCount = diff.split('\n').length;
    if (diffLineCount > 30 || diff.length > 1500) {
      await uiLog.info('Analyzing local repository changes...');
    } else {
      printCentered(chalk.bold.white('\n--- Git Diff Summary ---'));
      printCentered(diff);
      printCentered(chalk.bold.white('------------------------\n'));
    }

    const prDetails = await generatePullRequestDescription(diff);

    await uiLog.step(`Proposed PR Title: ${prDetails.title}`);
    await uiLog.info(prDetails.body);

    s.start('Resolving Git repository owner and name');
    const { owner, repo } = await getRepoInfo();
    s.stop(chalk.bold.white('Target repository: ' + owner + '/' + repo));

    const git = getGitClient();
    const status = await executeGitOperation(() => git.status(), 'Failed to get status');
    const currentBranch = status.current;

    if (!currentBranch) {
      throw new Error('Could not identify current git branch name.');
    }

    s.start(`Staging and committing changes: "${prDetails.title}"`);
    let commitSuccess = false;
    let isCommitMidFlight = false;

    while (!commitSuccess) {
      if (isCommitMidFlight) {
        break;
      }
      isCommitMidFlight = true;

      try {
        await safeguardGitignore(process.cwd());

        s.message("Staging files...");
        await executeGitOperation(() => safeStageFiles(git, process.cwd()), 'Staging changes failed');

        s.message(`Committing changes: "${prDetails.title}"`);
        await executeGitOperation(() => git.commit(prDetails.title), 'Committing changes failed');

        commitSuccess = true;
      } catch (commitError: any) {
        s.stop(chalk.bold.red('Commit failed'));
        throw commitError;
      } finally {
        isCommitMidFlight = false;
      }

      if (commitSuccess) {
        break;
      }
    }

    s.message("Pushing code to remote...");
    await executeGitOperation(() => git.push('origin', currentBranch, { '--set-upstream': null }), `Failed to push branch '${currentBranch}'`);
    s.stop(chalk.bold.white(`Committed and pushed branch '${currentBranch}'`));

    s.start('Creating GitHub Pull Request');
    const prUrl = await createPullRequest(
      prDetails.title,
      prDetails.body,
      currentBranch,
      'main',
      owner,
      repo
    );
    s.stop(chalk.bold.white(`PR successfully opened!`));

    if (currentBranch && currentBranch.startsWith('fix/issue-')) {
      const issueNumberStr = currentBranch.replace('fix/issue-', '');
      const currentIssueNumber = parseInt(issueNumberStr, 10);
      if (!isNaN(currentIssueNumber)) {
        s.start(`Closing issue #${currentIssueNumber}`);
        await closeGithubIssue(currentIssueNumber, owner, repo);
        s.stop(chalk.bold.white(`Issue #${currentIssueNumber} closed`));
        await log.success(`Issue #${currentIssueNumber} successfully closed via GitHub API.`);

        s.start('Switching to fallback branch');
        const branches = await executeGitOperation(() => git.branchLocal(), 'Failed to get branch list');
        const fallbackBranch = branches.all.includes('main') ? 'main' : 'master';
        await executeGitOperation(() => git.checkout(fallbackBranch), `Failed to checkout fallback branch '${fallbackBranch}'`);
        s.stop(chalk.bold.white(`Switched to fallback branch '${fallbackBranch}'`));

        s.start(`Deleting local branch '${currentBranch}'`);
        await executeGitOperation(() => git.deleteLocalBranch(currentBranch, true), `Failed to delete local branch '${currentBranch}'`);
        s.stop(chalk.bold.white(`Deleted local branch '${currentBranch}'`));
      }
    }

    printCentered('\n' + chalk.bold.black.bgWhite('  SHIP COMPLETE  '));
    printCentered(chalk.bold.white(`Pull Request URL: ${prUrl}\n`));
  } catch (error: any) {
    await uiLog.error(`Ship failed: ${error.message}`);
  } finally {
    isShipCommandRunning = false;
    printTelemetryPanel();
  }
}

// Interactive REPL Shell Loop
async function launchInteractiveShell() {
  const provider = process.env.LLM_PROVIDER || 'Gemini (Google)';
  const modelName = process.env.GEMINI_MODEL || (
    provider === 'OpenAI' ? 'gpt-4o' :
    provider === 'Claude (Anthropic)' ? 'claude-3-5-sonnet-20241022' :
    provider === 'Groq' ? 'llama3-70b-8192' : 'gemini-2.5-flash'
  );
  const contentWidth = 60;
  const contentHeight = 22;

  function drawDashboard(branch: string) {
    console.clear();
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;

    const verticalPadding = Math.max(0, Math.floor((rows - contentHeight) / 2));
    const horizontalPadding = ' '.repeat(Math.max(0, Math.floor((cols - contentWidth) / 2)));

    // Vertical alignment offset spacing
    console.log('\n'.repeat(verticalPadding));

    // Logo
    const logo = [
      " ██████╗ ██╗ ██████╗  █████╗ ",
      "██╔════╝ ██║██╔════╝ ██╔══██╗",
      "██║  ███╗██║██║  ███╗███████║",
      "██║   ██║██║██║   ██║██╔══██║",
      "╚██████╔╝██║╚██████╔╝██║  ██║",
      " ╚═════╝ ╚═╝ ╚═════╝ ╚═╝  ╚═╝"
    ];
    logo.forEach(line => {
      const logoOffset = ' '.repeat(Math.max(0, Math.floor((contentWidth - line.length) / 2)));
      console.log(horizontalPadding + logoOffset + chalk.bold.white(line));
    });

    console.log('');

    // Sub-header details
    const subHeader = `GIGA [v1.0.0] │ ${provider} (${modelName})`;
    const subHeaderOffset = ' '.repeat(Math.max(0, Math.floor((contentWidth - subHeader.length) / 2)));
    console.log(horizontalPadding + subHeaderOffset + chalk.bold.white(subHeader));

    // Thin light Divider line
    console.log(horizontalPadding + chalk.dim('─'.repeat(contentWidth)));
    console.log('');

    // Command matrix
    const commands = [
      "/connect        Configure LLM provider & access tokens",
      "/start <id>     Initialize a workspace issue context",
      "/heal           Execute autonomous testing & loop repairs",
      "/ship           Commit, push, and programmatically open PR",
      "/diff           View active file modifications",
      "/status         Show current git tracking branch state",
      "/exit           Terminate the active terminal session"
    ];
    commands.forEach(line => {
      const cmdOffset = ' '.repeat(Math.max(0, Math.floor((contentWidth - 58) / 2)));
      console.log(horizontalPadding + cmdOffset + chalk.white(line));
    });

    console.log('\n');
  }

  const prompt = async () => {
    let branch = 'unknown';
    try {
      const git = getGitClient();
      const status = await executeGitOperation(() => git.status(), 'Failed to get status');
      branch = status.current || 'detached';
    } catch (_) {}

    const cols = process.stdout.columns || 80;
    const horizontalPadding = ' '.repeat(Math.max(0, Math.floor((cols - contentWidth) / 2)));

    // Box top line
    console.log(horizontalPadding + `┌${'─'.repeat(contentWidth - 2)}┐`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.on('SIGINT', () => {
      console.log('\nUse /exit to close the shell.');
      rl.close();
      prompt();
    });

    rl.question(horizontalPadding + `│ Message Giga (${branch}) › ▋ `, async (line) => {
      rl.close();
      
      // Box bottom line
      console.log(horizontalPadding + `└${'─'.repeat(contentWidth - 2)}┘\n`);

      const input = line.trim();
      commandCount++;

      if (!input) {
        prompt();
        return;
      }

      if (input === '/connect') {
        await connectProvider();
        console.log('');
        prompt();
        return;
      }

      if (input === '/exit' || input === '/quit') {
        printCentered(chalk.bold.black.bgWhite('  GOODBYE FROM GIGA  '));
        process.exit(0);
      }

      if (input === '/help') {
        await animateTypewriter(chalk.bold.white('Available Commands:'));
        await animateTypewriter(`  ${chalk.bold('/connect')}            - Configure LLM provider & access tokens`);
        await animateTypewriter(`  ${chalk.bold('/start <issueNumber>')} - Fetch issue, identify files, branch`);
        await animateTypewriter(`  ${chalk.bold('/heal')}               - Run tests and heal failures`);
        await animateTypewriter(`  ${chalk.bold('/ship')}               - Run diff, generate PR, commit & push`);
        await animateTypewriter(`  ${chalk.bold('/diff')}               - View workspace changes`);
        await animateTypewriter(`  ${chalk.bold('/status')}             - Show Git status`);
        await animateTypewriter(`  ${chalk.bold('/exit')} or ${chalk.bold('/quit')}   - Exit shell`);
        console.log('');
        prompt();
        return;
      }

      if (input.startsWith('/start') || input === '/start') {
        const parts = input.split(/\s+/);
        const arg = parts[1];
        const issueNumber = arg ? parseInt(arg, 10) : NaN;
        if (isNaN(issueNumber)) {
          await uiLog.error('Usage: /start <issueNumber>');
        } else {
          await runStartCommand(issueNumber);
        }
        console.log('');
        prompt();
        return;
      }

      if (input === '/heal') {
        await runHealCommand();
        console.log('');
        prompt();
        return;
      }

      if (input === '/ship') {
        await runShipCommand();
        console.log('');
        prompt();
        return;
      }

      if (input === '/diff') {
        try {
          const diff = await getGitDiffSummary();
          if (!diff) {
            await uiLog.info('No changes detected in workspace.');
          } else {
            printCentered(chalk.bold.white('\n--- Git Diff Summary ---'));
            printCentered(diff);
            printCentered(chalk.bold.white('------------------------\n'));
          }
        } catch (e: any) {
          await uiLog.error(`Failed to get diff: ${e.message}`);
        }
        console.log('');
        prompt();
        return;
      }

      if (input === '/status') {
        try {
          const git = getGitClient();
          const status = await executeGitOperation(() => git.status(), 'Failed to check status');
          await animateTypewriter(chalk.bold.white('Git Status:'));
          await animateTypewriter(`  Branch: ${status.current}`);
          await animateTypewriter(`  Staged files: ${status.staged.length}`);
          await animateTypewriter(`  Modified files: ${status.modified.length}`);
          await animateTypewriter(`  Untracked files: ${status.not_added.length}`);
        } catch (e: any) {
          await uiLog.error(`Failed to check git status: ${e.message}`);
        }
        console.log('');
        prompt();
        return;
      }

      // Default: execute raw command securely
      try {
        const result = await executeCommandSecurely(input);
        if (result.stdout) console.log(result.stdout);
        if (result.stderr) console.error(result.stderr);
      } catch (e: any) {
        await uiLog.error(`Execution error: ${e.message}`);
      }
      console.log('');
      prompt();
    });
  };

  let initialBranch = 'unknown';
  try {
    const git = getGitClient();
    const status = await executeGitOperation(() => git.status(), 'Failed to get initial status');
    initialBranch = status.current || 'detached';
  } catch (_) {}
  drawDashboard(initialBranch);

  prompt();
}

loadRCConfig();

program
  .command('connect')
  .description('Configure preferred LLM provider and access credentials')
  .action(async () => {
    await connectProvider();
  });

program
  .command('start <issueNumber>')
  .description('Start working on a GitHub issue: fetch metadata, find relevant files, and branch')
  .action(async (issueNumberStr) => {
    const issueNumber = parseInt(issueNumberStr, 10);
    if (isNaN(issueNumber)) {
      uiLog.error('Issue number must be a valid integer.');
      process.exit(1);
    }
    await runStartCommand(issueNumber);
  });

program
  .command('heal')
  .description('Run tests and enter a self-healing loop using Gemini to patch failures')
  .action(async () => {
    await runHealCommand();
  });

program
  .command('ship')
  .description('Stage, commit, push, and open a GitHub PR with an AI-generated description')
  .action(async () => {
    await runShipCommand();
  });

program
  .command('shell')
  .description('Launch the interactive GIGA CLI console shell')
  .action(async () => {
    await launchInteractiveShell();
  });

if (process.argv.length <= 2) {
  launchInteractiveShell();
} else {
  program.parse(process.argv);
}
