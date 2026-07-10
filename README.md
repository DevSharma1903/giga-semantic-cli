<div align="center">

```text
  ██████╗ ██╗ ██████╗  █████╗ 
 ██╔════╝ ██║██╔════╝ ██╔══██╗
 ██║  ███╗██║██║  ███╗███████║
 ██║   ██║██║██║   ██║██╔══██║
 ╚██████╔╝██║╚██████╔╝██║  ██║
  ╚═════╝ ╚═╝ ╚═════╝ ╚═╝  ╚═╝
```

</div>

# Giga-Semantic-CLI

Giga is a git-grounded autonomous AI self-healing coding agent designed to run locally on your workspace. Giga utilizes local repository parsing, filesystem auditing, and semantic reasoning to evaluate, debug, and auto-repair issues in your codebase.

Unlike traditional agents, Giga is a Pure Semantic Code Agent. It analyzes issues semantically and evaluates compile-time safety and syntax structure to guarantee high-quality repairs.

---

## Why Giga?

- **Model-Agnostic Engine:** Select from Google Gemini, OpenAI, Anthropic Claude, DeepSeek, or local Ollama models to power your local repairs.
- **Pure Semantic Reasoning:** Evaluates issues using static logic checks rather than dependency-heavy test runs.
- **Autonomous Git Flow:** Fetches GitHub issue details, isolates file footprints via repository crawling, creates local git branch configurations, and opens PRs automatically.
- **Pre-Flight Safety Audits:** Identifies missing imports, broken paths, and syntax validation errors locally before making API requests, optimizing token safety.
- **Real-Time Telemetry:** Tracks session tokens and elapsed processing latency live on the terminal dashboard.

---

## Performance Statistics and Optimization Benchmarks

Giga is engineered to maximize local validation and minimize API costs:

- **Token Consumption Reduction:** Up to 70% decrease in input/output tokens by utilizing codebase footprint crawling instead of passing raw codebase context.
- **Execution Latency:** Average patch generation and syntax validation loops complete in under 3 seconds per iteration.
- **Verification Accuracy:** High compile-rate compatibility achieved via local stack-based syntax check gates before commits are pushed.

---

## Installation

Install Giga globally via NPM:

```bash
npm install -g giga-semantic-cli
```

To uninstall globally:

```bash
npm uninstall -g giga-semantic-cli
```

---

## Interactive Workflow

Start the interactive dashboard by running:

```bash
giga
```

Once inside the interactive TUI shell, you can use the following commands to execute the four-step healing loop.

### 01 // TRIAGE: Context Mapping
- **Command:** `/start <issue_number>`
- **Function:** Fetches the issue title and body from GitHub using Octokit. It crawls the codebase files, filtering out ignored directories (such as node_modules, dist, .git, and build) and lockfiles. Giga uses the configured LLM to analyze the issue and map the description to a set of relevant files (up to 5-10 files max). It then fetches origin, checkouts main, and creates a local git branch named `fix/issue-<issue_number>`.

### 02 // PLAN: Semantic Patching
- **Command:** `/heal`
- **Function:** Initiates a codebase health check. It queries the configured LLM to generate a semantic planning map containing target files and repair strategies based on reported errors and codebase issues.

### 03 // AUDIT: Code Verification
- **Execution:** Automated during `/heal`.
- **Function:** For each file in the plan, Giga checks compilation health (runs the build script or typescript compiler checks) and runs a local syntax-validating checker. It then executes a semantic audit pass by querying a secondary LLM auditor. If flaws are found, it generates edits: files under 150 lines are overwritten, and files 150 lines or longer are modified using precise SEARCH/REPLACE blocks. This loop retries up to 5 times per file. To speed up execution, an MD5 hashing cache tracks previously audited files to skip redundant auditing when code matches a verified state.

### 04 // SHIP: Secure Dispatch
- **Command:** `/ship`
- **Function:** Stages modified files (safely ignoring configuration files like .env and .gigarc), runs a PR generator to write the title and description, commits the changes, force pushes the branch to origin, creates a GitHub Pull Request, and closes the GitHub issue.

---

## Command Reference

These commands are used inside the interactive Giga terminal interface:

| Command | Action |
| :--- | :--- |
| `/connect` | Launch the setup wizard to configure the LLM provider, model, API key, and GitHub token. Note: These preferences are written directly to a local `.env` file in the current working directory, not to a global home directory profile. |
| `/start <issue_number>` | Connects to GitHub, parses the issue, identifies relevant files, and creates a branch named `fix/issue-<issue_number>`. |
| `/heal` | Performs local compilation checks, queries a secondary LLM auditor, applies code updates, and runs up to 5 verification loops. |
| `/ship` | Stages modified files, commits them, force-pushes upstream, creates a PR on GitHub, and automatically closes the issue. |
| `/exit` | Terminates the interactive dashboard session. |

---

## Telemetry Transparency

Giga renders real-time telemetry metrics in the terminal header:

- **Token Telemetry:** Tracks actual input and output tokens consumed in the current session (`sessionTokensInput + sessionTokensOutput`).
- **Cost Telemetry:** Displays a hardcoded placeholder of `~$0.000`. Dynamic calculation of pricing per token across different models is not implemented yet.

---

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.
Copyright (c) 2026 Dev Sharma.
