import { execFile } from 'node:child_process';
import { writeFile, mkdir, stat } from 'node:fs/promises';
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

// Every agent forest can put in a Terminal window, keyed by the `agent`
// value the client sends. The command is what runs in the window; config
// (claudeCmd / cursorAgentCmd) can override it. The KEYS cannot grow at
// runtime: an unknown agent is refused before anything touches disk.
const DEFAULT_CMDS = { claude: 'claude', cursor: 'cursor-agent' };

export function sessionLock(worktreePath) {
  return join(LOCK_DIR, `${worktreePath.replace(/[^A-Za-z0-9]+/g, '-')}.pid`);
}

// "<pid> <agent>" — or a bare "<pid>" from a lock written before the agent
// stamp existed, which can only have been a Claude session. A stamp naming an
// agent this build does not know reads as Claude too: the Agent column
// renders the value verbatim, and a lock is only ever forest's own.
function parseLockText(text) {
  const [pidText, agent] = String(text).trim().split(/\s+/);
  const pid = parseInt(pidText, 10);
  if (!pid) return null;
  return { pid, agent: Object.hasOwn(DEFAULT_CMDS, agent) ? agent : 'claude' };
}

// Read-only: what is running here, or null. Never unlinks — the Agent
// column calls this on every snapshot and must not race the launcher.
function liveLock(lock) {
  let parsed;
  try { parsed = parseLockText(readFileSync(lock, 'utf8')); } catch { return null; }
  if (!parsed) return null;
  try { process.kill(parsed.pid, 0); } catch { return null; }
  return parsed;
}

export function readSessionLock(worktreePath) {
  return liveLock(sessionLock(worktreePath));
}

// Launcher-side check: the same read, plus cleaning up a lock whose process
// is gone (a window closed with the script still holding the file).
function sessionAlive(lock) {
  const live = liveLock(lock);
  if (!live) { try { unlinkSync(lock); } catch { /* nothing to clean */ } }
  return live;
}

// Launch `body` in a new Terminal window via a self-deleting .command file.
// `title` names the .command file (Terminal uses it as the tab title) and is
// also set as the window title via an OSC escape, so plain-shell/git tabs read
// as the task too. Defaults to the worktree directory name. Each launch gets
// its own temp subdir so readable names never collide across sessions.
// `openImpl`, when given, replaces the real `open -a Terminal` call — tests
// use it to read the script back instead of launching a window. Taking that
// branch also skips the script's own `rm -rf` self-delete, which only runs
// when the script itself is executed by Terminal.
async function launchScriptFile({ cwd, body, app = 'Terminal', title, openImpl = null }) {
  try {
    const label = title || basename(cwd);
    const dir = join(tmpdir(), 'forest-launch', `${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${safeName(label)}.command`);
    const setTitle = `printf '\\033]0;%s\\007' ${shQuote(label)}`;
    const script = `#!/bin/zsh\ncd ${shQuote(cwd)}\nrm -rf ${shQuote(dir)}\n${setTitle}\n${body}\n`;
    await writeFile(file, script, { mode: 0o755 });
    if (openImpl) return openImpl(file);
    return await new Promise((resolve) => {
      execFile('open', ['-a', app, file], (err) => resolve({ ok: !err, error: err ? String(err) : null }));
    });
  } catch (e) { return { ok: false, error: String(e) }; }
}

function bringAppFront(app) {
  return new Promise((resolve) => execFile('open', ['-a', app], (err) => resolve(!err)));
}

// One agent session per worktree. If a session is already alive, bring the
// terminal to the front instead of starting a duplicate; otherwise launch one
// that holds a liveness lock for exactly as long as the agent runs.
// Returns { ok, action: 'focused' | 'launched', agent, error? }.
// `prompt`, when given, becomes the agent's first message: the session opens
// already knowing why it was opened. Quoted, never interpolated raw — a
// ticket summary can contain anything. A focused session (one already alive)
// never sees it: the caller must not claim a prompt was delivered there. The
// command is NOT shell-quoted on purpose: a configured `~/.local/bin/cursor-agent`
// or `npx cursor-agent` must keep working. The prompt IS quoted. `focusImpl`
// mirrors `openImpl` — it lets a test take the already-running branch
// without really calling `open -a Terminal`.
export async function launchAgentSession({ worktreePath, agent = 'claude', cmds = {}, app = 'Terminal', title, prompt = '', openImpl = null, focusImpl = null }) {
  if (!Object.hasOwn(DEFAULT_CMDS, agent)) throw new Error(`unknown agent: ${agent}`);
  const cmd = cmds[agent] || DEFAULT_CMDS[agent];
  mkdirSync(LOCK_DIR, { recursive: true });
  const lock = sessionLock(worktreePath);
  const live = sessionAlive(lock);
  if (live) {
    const ok = focusImpl ? await focusImpl(app) : await bringAppFront(app);
    return { ok, action: 'focused', agent: live.agent };
  }
  const invocation = prompt ? `${cmd} ${shQuote(prompt)}` : cmd;
  const body = `echo "$$ ${agent}" > ${shQuote(lock)}\n${invocation}\nrm -f ${shQuote(lock)}`;
  const r = await launchScriptFile({ cwd: worktreePath, body, app, title, openImpl });
  return { ok: r.ok, action: 'launched', agent, error: r.error };
}

// `launchClaudeSession` is kept as a thin wrapper for its one remaining
// caller, the legacy test below it — the only place that pins the `claude`
// invocation shape directly. lib/agents.mjs calls launchAgentSession now.
export function launchClaudeSession(opts) {
  return launchAgentSession({ ...opts, agent: 'claude' });
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

// Cursor's own bundled CLI, if present. Preferred over `openEditorCmd`
// because it can open a `.code-workspace` file directly — the mechanic
// openCursorWorkspace() below needs and a plain `open -a Cursor <path>`
// cannot do (it only ever opens one plain folder).
const CURSOR_CLI = '/Applications/Cursor.app/Contents/Resources/app/bin/cursor';

function execP(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, (err) => resolve(!err)));
}

// Opens ONE Cursor window containing every worktree in `worktrees` as a
// workspace folder — the primary checkout is deliberately NOT one of them,
// see below — so one controller chat can act across all of them, the same
// shape as the Hektor primary-session / subagent-driven pattern already in
// use. This matters technically, not just aesthetically: forest places
// worktrees OUTSIDE the repo tree (worktreeRoot defaults to ~/.forest/wt/…,
// deliberately, so a session does not inherit the parent repo's
// .claude/settings.json), and Cursor's agent is workspace-scoped — a chat
// rooted only at one checkout can refuse file operations on paths outside
// it. Adding each worktree as a workspace folder is what makes one
// controller chat actually able to work in all of them.
//
// The PRIMARY checkout is left out of the `folders` list on purpose, as of
// this round — two concrete problems, both observed on a real run: Cursor's
// Changes view defaulted to the primary checkout's own branch instead of
// any ticket's work, and including it let an agent edit the main checkout
// directly, which the multi-ticket discipline forbids (work belongs in the
// per-ticket worktrees, never the shared primary). If EVERY ticket failed
// to get a worktree, there is nothing to show — this falls back to opening
// the primary alone (a plain folder open, not a workspace) rather than
// writing and opening an empty `{"folders":[]}`.
//
// A multi-root `.code-workspace` FILE, opened with one `cursor <file>` call
// — not `cursor -a <path>` per worktree. A first version used `-a` ("add to
// the LAST ACTIVE window") and it failed exactly where a comment right here
// predicted it might: `-a` depends on Cursor's own GUI having already
// registered the first window as active by the time the next call fires,
// which is a race no `settleMs` delay reliably wins (confirmed against a
// real Cursor install — the worktrees never landed, only the primary
// checkout did). A workspace file sidesteps the race entirely: Cursor reads
// the whole folder list from disk and opens all of them as one window in a
// single call, deterministically, with no ordering and no readiness signal
// needed.
//
// The file is written under `worktreeRoot` (forest's own state, e.g.
// ~/.forest/wt/), named after the repo — NOT inside any checkout, where a
// stray `.code-workspace` would show up as an untracked file in the user's
// `git status`. Re-launching the same repo overwrites the same file rather
// than accumulating one per launch.
//
// `briefPaths`, when given, are appended to the SAME open call — Cursor's
// CLI takes `[paths...]` after the workspace file, so one invocation opens
// the workspace AND each brief as its own editor tab. UNVERIFIED against a
// real Cursor install (no GUI in this environment) — if the combined
// invocation turns out not to open the files as tabs, that is for the next
// real run to reveal, not something confirmed here.
//
// Falls back to `openEditorCmd` (typically `open -a Cursor`) when the
// bundled CLI is absent, so this never hard-fails on a machine without
// Cursor installed there — but the fallback can only open `primaryPath`. A
// plain `open -a Cursor <path>` has no workspace-file support, so composing
// a multi-folder workspace this way is not possible; opening each worktree
// separately would fragment into N SEPARATE windows, which defeats the
// entire point. Callers should tell the user this happened (`cli: false` in
// the return value, `foldersAdded: 0`, `workspaceFile: null`).
//
// `cliAvailable`/`exec`/`writeFileImpl`/`mkdirImpl` are injectable so tests
// can assert the exact folder list written (and that nothing is written
// inside a repo) without touching a real process, the real filesystem
// outside a temp dir, or a real Cursor.
export async function openCursorWorkspace({
  primaryPath, worktrees = [], worktreeRoot, briefPaths = [], openEditorCmd = 'open -a Cursor',
  cliPath = CURSOR_CLI,
  cliAvailable = () => stat(cliPath).then(() => true, () => false),
  exec = execP, writeFileImpl = writeFile, mkdirImpl = mkdir,
} = {}) {
  const hasCli = await cliAvailable();
  if (!hasCli) {
    const parts = openEditorCmd.split(' ');
    await exec(parts[0], [...parts.slice(1), primaryPath]);
    return { ok: true, cli: false, foldersAdded: 0, workspaceFile: null, briefsOpened: 0 };
  }
  if (!worktrees.length) {
    // Nothing to show as a workspace — open the primary alone rather than
    // write (and open) an empty folder list.
    const launched = await exec(cliPath, [primaryPath]);
    return { ok: launched, cli: true, foldersAdded: 0, workspaceFile: null, briefsOpened: 0 };
  }
  // Each worktree folder gets a `name`: the ticket key a caller passes reads
  // far better in Cursor's file tree than the branch-slugged directory
  // name, and is cheap to supply since the route creating these worktrees
  // already has it. Falls back to the folder's own basename if not given.
  const folders = worktrees.map((w) => ({ path: w.path, name: w.name || basename(w.path) }));
  const workspaceFile = join(worktreeRoot, `${basename(primaryPath)}.code-workspace`);
  await mkdirImpl(worktreeRoot, { recursive: true });
  await writeFileImpl(workspaceFile, JSON.stringify({ folders }, null, 2));
  // The file is written either way by this point — `ok` here is specifically
  // about whether the launch itself worked, so a caller (and its journal
  // line) does not claim success when Cursor's own process failed to start.
  const launched = await exec(cliPath, [workspaceFile, ...briefPaths]);
  return { ok: launched, cli: true, foldersAdded: worktrees.length, workspaceFile, briefsOpened: briefPaths.length };
}
