import express from 'express';
import * as path from 'path';
import { simpleGit } from 'simple-git';
import { getGitDiffSummary } from './tools/index.js';
import { exec } from 'child_process';
import dotenv from 'dotenv';
import * as fs from 'fs';

// Load .env
const localEnv = path.join(process.cwd(), '.env');
if (fs.existsSync(localEnv)) {
  dotenv.config({ path: localEnv });
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/stats', async (req, res) => {
  try {
    const git = simpleGit();
    const status = await git.status();
    const branch = status.current || 'detached';
    const modifiedCount = status.modified.length + status.staged.length + status.not_added.length;
    res.json({ branch, modifiedCount });
  } catch (err: any) {
    res.json({ branch: 'unknown', modifiedCount: 0 });
  }
});

app.post('/api/run', (req, res) => {
  const { command } = req.body;
  if (!command) {
    return res.status(400).json({ error: 'Command missing' });
  }

  // Intercept special slash commands
  if (command.startsWith('/start ')) {
    const issueNum = command.substring(7).trim();
    exec(`npx tsx src/cli.ts start ${issueNum}`, (error, stdout, stderr) => {
      res.json({ output: stdout + '\n' + stderr });
    });
    return;
  }

  if (command === '/heal') {
    exec(`npx tsx src/cli.ts heal`, (error, stdout, stderr) => {
      res.json({ output: stdout + '\n' + stderr });
    });
    return;
  }

  if (command === '/ship') {
    exec(`npx tsx src/cli.ts ship`, (error, stdout, stderr) => {
      res.json({ output: stdout + '\n' + stderr });
    });
    return;
  }

  if (command === '/diff') {
    exec(`git diff`, (error, stdout, stderr) => {
      res.json({ output: stdout || 'No changes detected.' });
    });
    return;
  }

  if (command === '/status') {
    exec('git status', (error, stdout, stderr) => {
      res.json({ output: stdout + '\n' + stderr });
    });
    return;
  }

  // Execute terminal command
  exec(command, (error, stdout, stderr) => {
    res.json({ output: stdout + '\n' + stderr });
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Giga UI Dashboard active at http://localhost:${PORT}`);
});
