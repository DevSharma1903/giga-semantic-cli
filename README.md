# Giga-Semantic-CLI 🚀

**Giga** is a git-grounded autonomous AI self-healing coding agent designed to run 100% locally on your workspace. Giga utilizes local repository parsing, filesystem auditing, and semantic reasoning to evaluate, debug, and auto-repair issues in your codebase.

Unlike traditional agents, Giga is a **Pure Semantic Code Agent**—meaning it does not require running test runners (like Vitest, Jest, or npm test) to patch logic. Instead, Giga analyzes issues semantically and evaluates compile-time safety and syntax structure to guarantee high-quality repairs.

---

## 💡 Why Giga?

- **Model-Agnostic Engine:** Choose from Gemini, Claude, OpenAI, or Groq to power your local repairs.
- **Pure Semantic Reasoning:** Evaluates issues using static logic checks rather than dependency-heavy test runs.
- **Autonomous Git Flow:** Fetches GitHub issue details, isolates file footprints via repository crawling, creates local git branches, and ships PRs automatically.
- **Pre-Flight Safety Audits:** Identifies missing imports, broken paths, and syntax validation errors locally before making API requests, optimizing token safety.
- **Real-Time Telemetry:** Tracks session tokens and elapsed processing latency live on the terminal.

---

## 📦 Installation

Install Giga globally via NPM:

```bash
npm install -g giga-semantic-cli
```

---

## ⚡ Quick Start

Launch the interactive Giga CLI shell loop from your project directory:

```bash
giga shell
```

Inside the interactive shell, run through the complete workflow:

### 1. Connect Your Model (`/connect`)
Configure your preferred LLM provider, API keys, and GitHub access tokens securely:
```text
Message Giga (main) › /connect
```
*Your configuration will be saved securely to global `~/.gigarc` and local `.env.local`.*

### 2. Start Work on an Issue (`/start <number>`)
Initialize context from a GitHub tracking issue:
```text
Message Giga (main) › /start 42
```
*Giga automatically fetches the issue, crawls your codebase to map target files, and switches to a new local branch `fix/issue-42`.*

### 3. Heal the Codebase (`/heal`)
Run the autonomous static validation and semantic healing loop:
```text
Message Giga (fix/issue-42) › /heal
```
*Giga inspects codebase syntax, validates structural integrity, and applies line-specific patches to heal the codebase.*

### 4. Ship the Resolution (`/ship`)
Stage, commit, push, and open the Pull Request on GitHub:
```text
Message Giga (fix/issue-42) › /ship
```
*Giga drafts a detailed PR description from the Git diff, creates the Pull Request, automatically closes the target issue on GitHub, and deletes the local issue branch.*

---

## 📝 Commands

| Command | Action |
| :--- | :--- |
| `/connect` | Configure LLM provider & access credentials |
| `/start <id>` | Fetch issue, identify relevant files, and check out new branch |
| `/heal` | Run pre-flight checks, perform logic validation, and repair codebase |
| `/ship` | Stage, commit, push, create GitHub PR, and close issue |
| `/diff` | View active modifications in the workspace |
| `/status` | Show Git branch details and modified tracking status |
| `/exit` | Exit the active terminal session |

---

## ⚖️ License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.
Copyright © 2026 Dev Sharma.
