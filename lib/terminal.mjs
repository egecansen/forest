import { execFile } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

const LOCK_DIR = join(tmpdir(), 'forest-sessions');

function sessionLock(worktreePath) {
  return join(LOCK_DIR, `${worktreePath.replace(/[^A-Za-z0-9]+/g, '-')}.pid`);
}

// A session is "alive" if its lock file holds a PID that's still running.
// Stale locks (process gone, e.g. window closed) are cleaned and treated dead.
function sessionAlive(lock) {
  try {
    const pid = parseInt(readFileSync(lock, 'utf8').trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0); // throws if the process no longer exists
    return true;
  } catch {
    try { unlinkSync(lock); } catch { /* ignore */ }
    return false;
  }
}

// Launch `body` in a new Terminal window via a self-deleting .command file.
async function launchScriptFile({ cwd, body, app = 'Terminal' }) {
  try {
    const dir = join(tmpdir(), 'forest-launch');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `forest-${Date.now()}-${Math.floor(Math.random() * 1e6)}.command`);
    const script = `#!/bin/zsh\ncd ${shQuote(cwd)}\nrm -f ${shQuote(file)}\n${body}\n`;
    await writeFile(file, script, { mode: 0o755 });
    return await new Promise((resolve) => {
      execFile('open', ['-a', app, file], (err) => resolve({ ok: !err, error: err ? String(err) : null }));
    });
  } catch (e) { return { ok: false, error: String(e) }; }
}

function bringAppFront(app) {
  return new Promise((resolve) => execFile('open', ['-a', app], (err) => resolve(!err)));
}

// One Claude session per worktree. If a session is already alive, bring the
// terminal to the front instead of starting a duplicate; otherwise launch one
// that holds a liveness lock for exactly as long as Claude runs.
// Returns { ok, action: 'focused' | 'launched', error? }.
export async function launchClaudeSession({ worktreePath, app = 'Terminal' }) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lock = sessionLock(worktreePath);
  if (sessionAlive(lock)) {
    const ok = await bringAppFront(app);
    return { ok, action: 'focused' };
  }
  const body = `echo $$ > ${shQuote(lock)}\nclaude\nrm -f ${shQuote(lock)}`;
  const r = await launchScriptFile({ cwd: worktreePath, body, app });
  return { ok: r.ok, action: 'launched', error: r.error };
}

// `command` is an already-quoted shell fragment (caller contract).
export function runInTerminal({ command, cwd, app = 'Terminal' }) {
  return launchScriptFile({ cwd, body: command, app });
}

export function openTerminalAt({ cwd, app = 'Terminal' }) {
  return launchScriptFile({ cwd, body: 'exec ${SHELL:-/bin/zsh} -il', app });
}

export function openWith({ path, target, openEditorCmd = 'open -a Cursor', app = 'Terminal' }) {
  if (target === 'finder') { execFile('open', [path], () => {}); return; }
  if (target === 'terminal') { return openTerminalAt({ cwd: path, app }); }
  if (target === 'cursor') {
    // Cursor/VSCode focuses an existing window when the folder is already open,
    // so it inherently navigates to the existing session rather than duplicating.
    const parts = openEditorCmd.split(' ');
    execFile(parts[0], [...parts.slice(1), path], () => {});
  }
}
