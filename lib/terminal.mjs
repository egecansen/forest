import { execFile } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Open a new Terminal window that runs `body` in `cwd`, via a self-deleting
// temp .command script launched with `open`. This deliberately avoids
// `osascript ... do script`, which requires macOS Apple-events "Automation"
// permission — that permission is never granted to a detached/background
// server process, so `do script` fails silently and the window never appears.
// `open`-ing a .command needs no such permission. Returns { ok, error }.
async function launchScript({ cwd, body, app = 'Terminal' }) {
  try {
    const dir = join(tmpdir(), 'forest-launch');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `forest-${Date.now()}-${Math.floor(Math.random() * 1e6)}.command`);
    const script = `#!/bin/zsh\ncd ${shQuote(cwd)}\nrm -f ${shQuote(file)}\n${body}\n`;
    await writeFile(file, script, { mode: 0o755 });
    return await new Promise((resolve) => {
      execFile('open', ['-a', app, file], (err) => resolve({ ok: !err, error: err ? String(err) : null }));
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// `command` is an already-quoted shell fragment (the caller's contract).
export function runInTerminal({ command, cwd, app = 'Terminal' }) {
  return launchScript({ cwd, body: command, app });
}

// Open an interactive shell sitting in `cwd`.
export function openTerminalAt({ cwd, app = 'Terminal' }) {
  return launchScript({ cwd, body: 'exec ${SHELL:-/bin/zsh} -il', app });
}

export function openWith({ path, target, openEditorCmd = 'open -a Cursor', app = 'Terminal' }) {
  if (target === 'finder') { execFile('open', [path], () => {}); return; }
  if (target === 'terminal') { return openTerminalAt({ cwd: path, app }); }
  if (target === 'cursor') {
    const parts = openEditorCmd.split(' ');
    execFile(parts[0], [...parts.slice(1), path], () => {});
  }
}
