#!/usr/bin/env node
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import chalk from 'chalk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {
  setValidationState,
  sessionTokensInput,
  sessionTokensOutput,
  getSessionCost,
  resetTelemetry,
  verifyIssueSanity,
  runSelfHealingIteration,
  identifyRelevantFiles,
  generatePullRequestDescription,
  GigaState
} from './agent.js';
import {
  fetchGithubIssue,
  listCodeFiles,
  createAndSwitchBranch,
  getGitClient,
  executeGitOperation,
  createPullRequest,
  safeStageFiles,
  closeGithubIssue,
  getRepoInfo
} from './tools/index.js';

dotenv.config();

function saveEnv(updates: Record<string, string>) {
  const envPath = path.join(process.cwd(), '.env');
  let currentEnv = '';
  if (fs.existsSync(envPath)) {
    currentEnv = fs.readFileSync(envPath, 'utf8');
  }
  
  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(currentEnv)) {
      currentEnv = currentEnv.replace(regex, `${key}=${val}`);
    } else {
      currentEnv += `\n${key}=${val}`;
    }
    process.env[key] = val;
  }
  
  fs.writeFileSync(envPath, currentEnv.trim() + '\n', 'utf8');
}

const GIGA_ASCII = chalk.ansi256(208)(`
  ██████╗ ██╗ ██████╗  █████╗ 
 ██╔════╝ ██║██╔════╝ ██╔══██╗
 ██║  ███╗██║██║  ███╗███████║
 ██║   ██║██║██║   ██║██╔══██║
 ╚██████╔╝██║╚██████╔╝██║  ██║
  ╚═════╝ ╚═╝ ╚═════╝ ╚═╝  ╚═╝
`);

const COMMAND_MENU = `
/connect    tether engine environment
/start      fork context issue branch
/heal       run self-healing sequence
/ship       safe-stage, filter & pr
/exit       terminate engine
`.trim();

const PROVIDERS = ['Google Gemini', 'OpenAI', 'Anthropic Claude', 'DeepSeek', 'Local Ollama'];
const MODELS: Record<string, string[]> = {
  'Google Gemini': ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash-thinking-exp-01-21'],
  'OpenAI': ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
  'Anthropic Claude': ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
  'DeepSeek': ['deepseek-chat', 'deepseek-coder'],
  'Local Ollama': ['llama3', 'mistral', 'codellama']
};

const Select = ({ options, onSelect }: { options: string[], onSelect: (val: string) => void }) => {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setIndex(Math.max(0, index - 1));
    if (key.downArrow) setIndex(Math.min(options.length - 1, index + 1));
    if (key.return) onSelect(options[index]);
  });
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor="#FF8700" width={50}>
      {options.map((opt, i) => (
        <Text key={opt} color={i === index ? '#FF8700' : undefined} bold={i === index}>
          {i === index ? '❯ ' : '  '} {opt}
        </Text>
      ))}
    </Box>
  );
};

interface LogEntry {
  id: number;
  text: string;
  status: 'loading' | 'success' | 'error' | 'none';
}

let nextLogId = 0;

const GigaApp = () => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout.columns);
  const [rows, setRows] = useState(stdout.rows);

  const [input, setInput] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [agentState, setAgentState] = useState<GigaState>('TRIAGE');
  const [tokens, setTokens] = useState(0);

  type WizardStep = 'none' | 'provider' | 'model' | 'api_key' | 'github_token';
  const [wizardStep, setWizardStep] = useState<WizardStep>('none');
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
  const [wizardInput, setWizardInput] = useState('');

  // Polling Telemetry
  useEffect(() => {
    const timer = setInterval(() => {
      setTokens(sessionTokensInput + sessionTokensOutput);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setCols(stdout.columns);
      setRows(stdout.rows);
    };
    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [stdout]);

  const addLog = (msg: string | { text: string, status?: 'loading' | 'success' | 'error' | 'none' }) => {
    let sanitizedText = (typeof msg === 'string' ? msg : msg.text).replace(/\r?\n|\r/g, ' ');
    const entry: LogEntry = {
      id: nextLogId++,
      text: sanitizedText,
      status: typeof msg === 'string' ? 'none' : (msg.status || 'none')
    };
    
    setLogs((prev) => {
      // update any previous 'loading' logs to 'success'
      const updated = prev.map(l => l.status === 'loading' ? { ...l, status: 'success' as const } : l);
      return [...updated, entry].slice(-10);
    });
  };

  const completeActiveLogs = () => {
    setLogs(prev => prev.map(l => l.status === 'loading' ? { ...l, status: 'success' as const } : l));
  };

  const errorActiveLogs = () => {
    setLogs(prev => prev.map(l => l.status === 'loading' ? { ...l, status: 'error' as const } : l));
  };

  useEffect(() => {
    const ogLog = console.log;
    console.log = (...args: any[]) => {
      addLog(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    };
    return () => {
      console.log = ogLog;
    };
  }, []);

  const handleWizardInput = (value: string) => {
    const val = value.trim();
    if (!val) return;
    
    if (wizardStep === 'api_key') {
      const keyName = configDraft['LLM_PROVIDER'] === 'Google Gemini' ? 'GEMINI_API_KEY' : 
                      configDraft['LLM_PROVIDER'] === 'OpenAI' ? 'OPENAI_API_KEY' :
                      configDraft['LLM_PROVIDER'] === 'DeepSeek' ? 'DEEPSEEK_API_KEY' :
                      configDraft['LLM_PROVIDER'] === 'Anthropic Claude' ? 'ANTHROPIC_API_KEY' : 'API_KEY';
      
      setConfigDraft(prev => ({ ...prev, [keyName]: val }));
      setWizardInput('');
      setWizardStep('github_token');
    } else if (wizardStep === 'github_token') {
      const finalConfig = { ...configDraft, GITHUB_TOKEN: val };
      saveEnv(finalConfig);
      addLog({ text: chalk.green(`[giga] Configuration secured to .env file.`), status: 'success' });
      setWizardStep('none');
      setIsProcessing(false);
    }
  };

  const handleSubmit = async (value: string) => {
    const cmd = value.trim();
    if (!cmd) return;
    setInput('');
    
    if (cmd === '/exit') {
      exit();
      return;
    }

    if (isProcessing) {
      addLog(chalk.yellow('[giga] Engine is currently occupied.'));
      return;
    }

    setIsProcessing(true);
    addLog({ text: chalk.ansi256(208)('❯ ') + cmd, status: 'none' });

    try {
      if (cmd.startsWith('/connect')) {
        setWizardStep('provider');
        setConfigDraft({});
        return;
      } else if (cmd.startsWith('/start')) {
        setAgentState('TRIAGE');
        const parts = cmd.split(' ');
        if (parts.length < 2) {
          addLog(chalk.red('[giga] Please provide an issue number.'));
          setIsProcessing(false);
          return;
        }
        const issueNum = parseInt(parts[1], 10);
        if (isNaN(issueNum)) {
          addLog(chalk.red('[giga] Invalid issue number.'));
          setIsProcessing(false);
          return;
        }
        
        addLog({ text: chalk.cyan(`[giga] Pulling issue #${issueNum}...`), status: 'loading' });
        const { owner, repo } = await getRepoInfo(process.cwd());
        const issue = await fetchGithubIssue(issueNum, owner, repo);
        
        const allFiles = listCodeFiles(process.cwd());
        const relFiles = await identifyRelevantFiles(issue.title, issue.body, allFiles);
        addLog({ text: chalk.cyan(`[giga] Branching context for issue #${issueNum}`), status: 'loading' });
        await createAndSwitchBranch(`fix/issue-${issueNum}`);
        completeActiveLogs();
        addLog({ text: chalk.green(`[giga] Fork complete. Ready for /heal.`), status: 'success' });

      } else if (cmd.startsWith('/heal')) {
        addLog({ text: chalk.cyan(`[giga] Initiating Self-Healing...`), status: 'loading' });
        const { owner, repo } = await getRepoInfo(process.cwd());
        const git = getGitClient(process.cwd());
        const status = await executeGitOperation(() => git.status(), 'Failed git status');
        
        if (!status.current || !status.current.startsWith('fix/issue-')) {
          addLog(chalk.red(`[giga] Not on an active issue branch.`));
          setIsProcessing(false);
          return;
        }
        const issueNum = parseInt(status.current.replace('fix/issue-', ''), 10);
        const issue = await fetchGithubIssue(issueNum, owner, repo);
        const issueText = issue.title + '\n' + issue.body;
        const allFiles = listCodeFiles(process.cwd());
        
        const res = await runSelfHealingIteration(issueText, allFiles.slice(0, 5), process.cwd());
        completeActiveLogs();
        
        if (res.applied) {
          addLog({ text: chalk.green(`[giga] Healing complete. Ready for /ship.`), status: 'success' });
        } else if (res.diffText === 'NO_ISSUE') {
          addLog({ text: chalk.green(`✨ Codebase matches target state. No engineering actions required.`), status: 'success' });
          setAgentState('COMPLETED');
        } else {
          addLog(chalk.yellow(`[giga] No patches applied.`));
        }

      } else if (cmd.startsWith('/ship')) {
        setAgentState('DISPATCH');
        addLog({ text: `[giga] Staging local workspace files...`, status: 'loading' });
        
        const git = getGitClient(process.cwd());
        const status = await executeGitOperation(() => git.status(), 'Failed git status');
        if (!status.current || !status.current.startsWith('fix/issue-')) {
            addLog(chalk.red(`[giga] Not on an active issue branch.`));
            setIsProcessing(false);
            return;
        }
        
        const issueNum = parseInt(status.current.replace('fix/issue-', ''), 10);
        const { owner, repo } = await getRepoInfo(process.cwd());
        
        await safeStageFiles(git, process.cwd());
        const gitDiff = await executeGitOperation(() => git.diff(['--cached']), 'Failed git diff');
        if (!gitDiff) {
            completeActiveLogs();
            addLog(chalk.yellow(`[giga] No changes to stage.`));
        } else {
            addLog({ text: `[giga] Running push protection scanning filters...`, status: 'loading' });
            const prData = await generatePullRequestDescription(gitDiff);
            await executeGitOperation(() => git.commit(prData.title), 'Failed to commit');
            await executeGitOperation(() => git.push(['origin', status.current!, '--force']), 'Failed push');
            const prUrl = await createPullRequest(prData.title, prData.body, status.current, 'main', owner, repo);
            completeActiveLogs();
            addLog({ text: chalk.green(`[success] PR successfully dispatched upstream to GitHub: ${prUrl}`), status: 'success' });
            await closeGithubIssue(issueNum, owner, repo);
        }
        setAgentState('COMPLETED');

      } else {
        addLog(chalk.yellow(`Unknown command. Check directory menu.`));
      }
    } catch (e: any) {
      errorActiveLogs();
      addLog(chalk.red(`[Error] ${e.message}`));
      setAgentState('FAILED');
    }
    
    setIsProcessing(false);
  };

  const currentProvider = process.env.LLM_PROVIDER || 'Google Gemini';
  const currentModel = process.env.LLM_MODEL || 'gemini-2.5-pro';
  let activeKey = '';
  if (currentProvider === 'Google Gemini') activeKey = process.env.GEMINI_API_KEY || '';
  else if (currentProvider === 'OpenAI') activeKey = process.env.OPENAI_API_KEY || '';
  else if (currentProvider === 'Anthropic Claude') activeKey = process.env.ANTHROPIC_API_KEY || '';
  else if (currentProvider === 'DeepSeek') activeKey = process.env.DEEPSEEK_API_KEY || '';
  const apiKeyHidden = activeKey ? `[sk-...${activeKey.slice(-4)}]` : '[NO-KEY]';
  
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="row" borderStyle="single" borderColor="gray" justifyContent="center">
        <Text dimColor>
          giga v1.0.4 | {currentModel} | {apiKeyHidden} | Tokens: {tokens} | Cost: ~$0.000 | State: {agentState}
        </Text>
      </Box>

      <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
        <Text>{GIGA_ASCII}</Text>
        <Text dimColor>v1.0.4</Text>
        
        {wizardStep === 'none' && (
          <>
            <Box marginTop={1} marginBottom={1} borderStyle="round" borderColor="gray" paddingX={2}>
              <Text>{COMMAND_MENU}</Text>
            </Box>
            
            <Box flexDirection="column" width={60} minHeight={12}>
                {logs.map((l) => (
                    <Box key={l.id} flexDirection="row">
                        {l.status === 'loading' && <Text color="cyan"><Spinner type="dots" /> </Text>}
                        {l.status === 'success' && <Text color="green">✓ </Text>}
                        {l.status === 'error' && <Text color="red">✗ </Text>}
                        <Text wrap="truncate-end">{l.text}</Text>
                    </Box>
                ))}
            </Box>

            <Box borderStyle="round" width={50} borderColor={isProcessing ? 'gray' : '#FF8700'}>
              <Box marginRight={1}>
                <Text color={isProcessing ? 'gray' : '#FF8700'}>
                  {isProcessing ? 'processing ❯' : 'giga ❯'}
                </Text>
              </Box>
              <TextInput
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
              />
            </Box>
          </>
        )}

        {wizardStep === 'provider' && (
          <Box flexDirection="column" alignItems="center" marginTop={2}>
            <Text bold color="#FF8700">Select Provider</Text>
            <Select 
              options={PROVIDERS} 
              onSelect={(p) => {
                setConfigDraft({ LLM_PROVIDER: p });
                setWizardStep('model');
              }} 
            />
          </Box>
        )}

        {wizardStep === 'model' && (
          <Box flexDirection="column" alignItems="center" marginTop={2}>
            <Text bold color="#FF8700">Select Model</Text>
            <Select 
              options={MODELS[configDraft['LLM_PROVIDER'] || 'Google Gemini']} 
              onSelect={(m) => {
                setConfigDraft(prev => ({ ...prev, LLM_MODEL: m }));
                if (configDraft['LLM_PROVIDER'] === 'Local Ollama') {
                  setWizardStep('github_token');
                } else {
                  setWizardStep('api_key');
                }
              }} 
            />
          </Box>
        )}

        {wizardStep === 'api_key' && (
          <Box flexDirection="column" alignItems="center" marginTop={2}>
            <Text bold color="#FF8700">Enter API Key for {configDraft['LLM_PROVIDER']}</Text>
            <Box borderStyle="round" width={50} borderColor="#FF8700">
              <TextInput
                value={wizardInput}
                onChange={setWizardInput}
                onSubmit={handleWizardInput}
                mask="*"
              />
            </Box>
          </Box>
        )}

        {wizardStep === 'github_token' && (
          <Box flexDirection="column" alignItems="center" marginTop={2}>
            <Text bold color="#FF8700">Enter GitHub Token (PAT)</Text>
            <Box borderStyle="round" width={50} borderColor="#FF8700">
              <TextInput
                value={wizardInput}
                onChange={setWizardInput}
                onSubmit={handleWizardInput}
                mask="*"
              />
            </Box>
          </Box>
        )}

      </Box>
    </Box>
  );
};

process.stdout.write("\x1Bc");
render(<GigaApp />);
