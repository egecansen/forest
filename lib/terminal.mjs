import { execFile } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Filesystem-safe basename for the .command file. Terminal shows this filename
// as the tab title, so we make it readable (the worktree/branch name) rather
// than a random number. Collapse anything not alphanumeric/dot/underscore to a
// dash (same shape as the branch slug used elsewhere) and trim dashes/dots.
function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._]+/g, '-').replace(/^[-.]+/, '').replace(/-+$/, '') || 'forest';
}

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
// `title` names the .command file (Terminal uses it as the tab title) and is
// also set as the window title via an OSC escape, so plain-shell/git tabs read
// as the task too. Defaults to the worktree directory name. Each launch gets
// its own temp subdir so readable names never collide across sessions.
async function launchScriptFile({ cwd, body, app = 'Terminal', title }) {
  try {
    const label = title || basename(cwd);
    const dir = join(tmpdir(), 'forest-launch', `${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${safeName(label)}.command`);
    const setTitle = `printf '\\033]0;%s\\007' ${shQuote(label)}`;
    const script = `#!/bin/zsh\ncd ${shQuote(cwd)}\nrm -rf ${shQuote(dir)}\n${setTitle}\n${body}\n`;
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
export async function launchClaudeSession({ worktreePath, app = 'Terminal', title }) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lock = sessionLock(worktreePath);
  if (sessionAlive(lock)) {
    const ok = await bringAppFront(app);
    return { ok, action: 'focused' };
  }
  const body = `echo $$ > ${shQuote(lock)}\nclaude\nrm -f ${shQuote(lock)}`;
  const r = await launchScriptFile({ cwd: worktreePath, body, app, title });
  return { ok: r.ok, action: 'launched', error: r.error };
}

// `command` is an already-quoted shell fragment (caller contract).
export function runInTerminal({ command, cwd, app = 'Terminal', title }) {
  return launchScriptFile({ cwd, body: command, app, title });
}

export function openTerminalAt({ cwd, app = 'Terminal', title }) {
  return launchScriptFile({ cwd, body: 'exec ${SHELL:-/bin/zsh} -il', app, title });
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
