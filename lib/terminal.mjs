import { execFile } from 'node:child_process';

function osascript(lines) {
  const args = [];
  for (const l of lines) { args.push('-e', l); }
  execFile('osascript', args, () => {});
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function runInTerminal({ command, cwd, app = 'Terminal' }) {
  const full = `cd ${shQuote(cwd)} && ${command}`;
  osascript([
    `tell application ${JSON.stringify(app)} to do script ${JSON.stringify(full)}`,
    `tell application ${JSON.stringify(app)} to activate`,
  ]);
}

export function openTerminalAt({ cwd, app = 'Terminal' }) {
  osascript([
    `tell application ${JSON.stringify(app)} to do script ${JSON.stringify(`cd ${shQuote(cwd)}`)}`,
    `tell application ${JSON.stringify(app)} to activate`,
  ]);
}

export function openWith({ path, target, openEditorCmd = 'open -a Cursor', app = 'Terminal' }) {
  if (target === 'finder') { execFile('open', [path], () => {}); return; }
  if (target === 'terminal') { openTerminalAt({ cwd: path, app }); return; }
  if (target === 'cursor') {
    const parts = openEditorCmd.split(' ');
    execFile(parts[0], [...parts.slice(1), path], () => {});
  }
}
