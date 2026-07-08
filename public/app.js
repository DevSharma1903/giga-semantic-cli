document.addEventListener('DOMContentLoaded', () => {
  const cmdInput = document.getElementById('cmdInput');
  const sendBtn = document.getElementById('sendBtn');
  const consoleBody = document.getElementById('consoleBody');
  
  const statBranch = document.getElementById('statBranch');
  const statChanges = document.getElementById('statChanges');
  const statUptime = document.getElementById('statUptime');
  const statCommands = document.getElementById('statCommands');

  let commandCounter = 0;
  const startTime = Date.now();

  // Uptime Timer
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const hrs = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    statUptime.textContent = `${hrs}:${mins}:${secs}`;
  }, 1000);

  // Fetch Git stats from server API
  async function fetchStats() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      statBranch.textContent = data.branch || 'unknown';
      statChanges.textContent = `${data.modifiedCount} files`;
    } catch (_) {
      statBranch.textContent = 'detached';
      statChanges.textContent = '0 files';
    }
  }

  // Append a message block to the web console
  function appendMessage(type, text) {
    const div = document.createElement('div');
    div.className = `log-item ${type}`;

    if (type === 'log-command') {
      div.textContent = `> ${text}`;
    } else {
      div.className += ' log-response';
      // Detect error class
      if (text.includes('[Error]') || text.includes('failed') || text.includes('rejected')) {
        div.classList.add('error');
      }
      div.textContent = text;
    }

    consoleBody.appendChild(div);
    consoleBody.scrollTop = consoleBody.scrollHeight;
  }

  // Execute command
  async function executeCmd() {
    const command = cmdInput.value.trim();
    if (!command) return;

    cmdInput.value = '';
    commandCounter++;
    statCommands.textContent = commandCounter;

    appendMessage('log-command', command);

    if (command === '/help') {
      appendMessage('log-response', 
        `Available Console Commands:\n` +
        `  /start <issueNumber> - Fetch issue, find files, and switch branch\n` +
        `  /heal               - Run repository self-healing iteration\n` +
        `  /ship               - Package diff and open a Pull Request\n` +
        `  /diff               - View current unstaged changes\n` +
        `  /status             - Show git tracking status\n` +
        `  /clear              - Clear web console output`
      );
      return;
    }

    if (command === '/clear') {
      consoleBody.innerHTML = '';
      return;
    }

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
      const data = await res.json();

      if (data.error) {
        appendMessage('log-response error', data.error);
      } else {
        appendMessage('log-response', data.output || '(No stdout)');
      }
    } catch (err) {
      appendMessage('log-response error', `Network Error: ${err.message}`);
    }

    // Refresh stats
    await fetchStats();
  }

  sendBtn.addEventListener('click', executeCmd);
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      executeCmd();
    }
  });

  // Initial load
  fetchStats();
});
