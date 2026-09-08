import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// The launcher writes a .command file and hands it to `open`. We cannot run
// Terminal in a test, so assert on the script it writes.
test('launchClaudeSession quotes the prompt into the claude invocation', async () => {
  const { launchClaudeSession } = await import('./terminal.mjs');

  // A worktree path unique to this run: `launchClaudeSession` treats a
  // matching, still-live lock file as "session already open" and takes the
  // `sessionAlive` → `bringAppFront` branch instead — which is NOT gated by
  // `openImpl` and really shells out to `open -a Terminal`. See
  // freshWorktree().
  const { worktreePath, lockFile } = freshWorktree();
  await rm(lockFile, { force: true });

  let written = null;
  const r = await launchClaudeSession({
    worktreePath,
    prompt: "Hektor, work A-1 — box x:161's pool",
    openImpl: (file) => { written = file; return { ok: true }; },
  });
  try {
    assert.equal(r.action, 'launched');
    const script = await readFile(written, 'utf8');
    assert.match(script, /claude 'Hektor, work A-1 — box x:161'\\''s pool'/);
  } finally {
    // `openImpl` short-circuits before the script's own `rm -rf` self-delete
    // (that line only runs when the script is actually executed by Terminal),
    // so this run's temp dir would otherwise never be cleaned up.
    await rm(dirname(written), { recursive: true, force: true });
    await rm(lockFile, { force: true });
  }
});

// One unique worktree path per test: a fixed path could collide with a real
// leftover lock and take the focus branch (it did, once, during this suite's
// own development).
function freshWorktree() {
  const worktreePath = join(tmpdir(), `forest-test-wt-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const lockFile = join(tmpdir(), 'forest-sessions', `${worktreePath.replace(/[^A-Za-z0-9]+/g, '-')}.pid`);
  return { worktreePath, lockFile };
}

test('launchAgentSession: agent cursor runs the configured cursor command with the quoted prompt and stamps the lock with the agent', async () => {
  const { launchAgentSession } = await import('./terminal.mjs');
  const { worktreePath, lockFile } = freshWorktree();
  await rm(lockFile, { force: true });
  let written = null;
  const r = await launchAgentSession({
    worktreePath, agent: 'cursor', prompt: "work A-1 — box x:161's pool",
    cmds: { claude: 'claude', cursor: '/opt/bin/cursor-agent' },
    openImpl: (file) => { written = file; return { ok: true }; },
  });
  try {
    assert.equal(r.action, 'launched');
    assert.equal(r.agent, 'cursor');
    const script = await readFile(written, 'utf8');
    assert.match(script, /\/opt\/bin\/cursor-agent 'work A-1 — box x:161'\\''s pool'/);
    assert.match(script, /echo "\$\$ cursor" > /, 'the lock must carry the agent so the Agent column can name it');
    assert.doesNotMatch(script, /--trust/, 'the user chose to keep the cursor-agent trust prompt');
  } finally {
    if (written) await rm(dirname(written), { recursive: true, force: true });
    await rm(lockFile, { force: true });
  }
});

test('launchAgentSession: an unknown agent is refused before anything is written', async () => {
  const { launchAgentSession } = await import('./terminal.mjs');
  const { worktreePath, lockFile } = freshWorktree();
  let opened = 0;
  await assert.rejects(
    launchAgentSession({ worktreePath, agent: 'gemini', openImpl: () => { opened++; return { ok: true }; } }),
    /unknown agent: gemini/,
  );
  assert.equal(opened, 0);
  await rm(lockFile, { force: true });
});

test('launchAgentSession: a live lock focuses instead of launching and names the agent FROM THE LOCK, not the request', async () => {
  const { launchAgentSession, sessionLock } = await import('./terminal.mjs');
  const { worktreePath } = freshWorktree();
  const lockFile = sessionLock(worktreePath);
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(lockFile, `${process.pid} cursor\n`);
  let opened = 0, focused = null;
  try {
    const r = await launchAgentSession({
      worktreePath, agent: 'claude', prompt: 'hello',
      openImpl: () => { opened++; return { ok: true }; },
      focusImpl: (app) => { focused = app; return true; },
    });
    assert.deepEqual(r, { ok: true, action: 'focused', agent: 'cursor' });
    assert.equal(opened, 0);
    assert.equal(focused, 'Terminal');
  } finally {
    await rm(lockFile, { force: true });
  }
});

test('readSessionLock: live lock with agent, legacy bare pid, dead pid (file kept), no file', async () => {
  const { readSessionLock, sessionLock } = await import('./terminal.mjs');
  const { worktreePath } = freshWorktree();
  const lockFile = sessionLock(worktreePath);
  await mkdir(dirname(lockFile), { recursive: true });
  try {
    await writeFile(lockFile, `${process.pid} cursor\n`);
    assert.deepEqual(readSessionLock(worktreePath), { pid: process.pid, agent: 'cursor' });
    await writeFile(lockFile, `${process.pid}\n`);
    assert.deepEqual(readSessionLock(worktreePath), { pid: process.pid, agent: 'claude' },
      'a lock written before the agent stamp existed can only be a Claude session');
    await writeFile(lockFile, `${process.pid} gemini\n`);
    assert.deepEqual(readSessionLock(worktreePath), { pid: process.pid, agent: 'claude' },
      'an agent stamp this build does not know is never rendered verbatim');
    // 999999 is above macOS's pid ceiling (99998), so it is never alive.
    await writeFile(lockFile, '999999 cursor\n');
    assert.equal(readSessionLock(worktreePath), null);
    await stat(lockFile); // read-only: the reader must NOT unlink a stale lock (that is the launcher's job)
    await rm(lockFile, { force: true });
    assert.equal(readSessionLock(worktreePath), null);
  } finally {
    await rm(lockFile, { force: true });
  }
});

// ---- openCursorWorkspace ----
//
// A first version used `cursor -a <path>` per worktree — "add to the last
// active window" — sequenced with a settle delay. It failed against a real
// Cursor install exactly as its own doc comment predicted: only the primary
// checkout landed, none of the worktrees did, because `-a` depends on GUI
// state a delay cannot reliably wait out. A second version replaced it with
// a `.code-workspace` file, one open call, deterministic — that part
// worked, confirmed against a real Cursor install (its own
// `workspaceStorage` recorded the file as a real multi-root workspace). A
// real run then surfaced two more problems this round fixes: the PRIMARY
// checkout in `folders` made Cursor's Changes view default to whatever
// branch the primary happened to be on, and let an agent edit the primary
// directly — both wrong for the multi-ticket discipline — so the primary is
// no longer in the list at all; and the briefs (round 8) need to open as
// tabs in the SAME call.

test('openCursorWorkspace: writes a workspace file of ONLY the worktrees (primary excluded) and opens it with ONE call', async () => {
  const { openCursorWorkspace } = await import('./terminal.mjs');
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'forest-cursor-ws-'));
  try {
    const calls = [];
    const r = await openCursorWorkspace({
      primaryPath: '/repo/web-test',
      worktrees: [
        { path: '/wt/tech-WEBT-1', name: 'SHBDN-232781' },
        { path: '/wt/tech-WEBT-2', name: 'SHBDN-241011' },
      ],
      worktreeRoot,
      cliAvailable: async () => true,
      exec: async (cmd, args) => { calls.push([cmd, args]); return true; },
    });
    assert.equal(calls.length, 1, 'exactly one open call, not one per folder');
    assert.deepEqual(calls[0], ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', [r.workspaceFile]]);
    assert.equal(r.workspaceFile, join(worktreeRoot, 'web-test.code-workspace'));
    assert.ok(!r.workspaceFile.startsWith('/repo'), 'must not be written inside the repo/checkout');
    const written = JSON.parse(await readFile(r.workspaceFile, 'utf8'));
    assert.deepEqual(written, {
      folders: [
        { path: '/wt/tech-WEBT-1', name: 'SHBDN-232781' },
        { path: '/wt/tech-WEBT-2', name: 'SHBDN-241011' },
      ],
    });
    assert.ok(!written.folders.some((f) => f.path === '/repo/web-test'), 'the primary checkout must NOT be a workspace folder');
    assert.deepEqual(r, { ok: true, cli: true, foldersAdded: 2, workspaceFile: join(worktreeRoot, 'web-test.code-workspace'), briefsOpened: 0 });
  } finally {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
});

test('openCursorWorkspace: brief paths are appended to the SAME open call, after the workspace file', async () => {
  const { openCursorWorkspace } = await import('./terminal.mjs');
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'forest-cursor-ws-'));
  try {
    const calls = [];
    const r = await openCursorWorkspace({
      primaryPath: '/repo/web-test',
      worktrees: [{ path: '/wt/a', name: 'SHBDN-1' }, { path: '/wt/b', name: 'SHBDN-2' }],
      briefPaths: ['/wt/a/docs/hektor/tickets/SHBDN-1.md', '/wt/b/docs/hektor/tickets/SHBDN-2.md'],
      worktreeRoot,
      cliAvailable: async () => true,
      exec: async (cmd, args) => { calls.push([cmd, args]); return true; },
    });
    assert.equal(calls.length, 1, 'still one call — the briefs ride along, not a second invocation');
    assert.deepEqual(calls[0], [
      '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      [r.workspaceFile, '/wt/a/docs/hektor/tickets/SHBDN-1.md', '/wt/b/docs/hektor/tickets/SHBDN-2.md'],
    ]);
    assert.equal(r.briefsOpened, 2);
  } finally {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
});

test('openCursorWorkspace: a worktree without a name falls back to its own basename', async () => {
  const { openCursorWorkspace } = await import('./terminal.mjs');
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'forest-cursor-ws-'));
  try {
    const r = await openCursorWorkspace({
      primaryPath: '/repo/web-test',
      worktrees: [{ path: '/wt/tech-WEBT-1' }],
      worktreeRoot,
      cliAvailable: async () => true,
      exec: async () => true,
    });
    const written = JSON.parse(await readFile(r.workspaceFile, 'utf8'));
    assert.deepEqual(written.folders[0], { path: '/wt/tech-WEBT-1', name: 'tech-WEBT-1' });
  } finally {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
});

test('openCursorWorkspace: re-launching the same repo overwrites the same file, not one per launch', async () => {
  const { openCursorWorkspace } = await import('./terminal.mjs');
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'forest-cursor-ws-'));
  try {
    const first = await openCursorWorkspace({
      primaryPath: '/repo/web-test', worktrees: [{ path: '/wt/a', name: 'A-1' }],
      worktreeRoot, cliAvailable: async () => true, exec: async () => true,
    });
    const second = await openCursorWorkspace({
      primaryPath: '/repo/web-test', worktrees: [{ path: '/wt/b', name: 'B-1' }],
      worktreeRoot, cliAvailable: async () => true, exec: async () => true,
    });
    assert.equal(first.workspaceFile, second.workspaceFile);
    const written = JSON.parse(await readFile(second.workspaceFile, 'utf8'));
    assert.deepEqual(written.folders, [{ path: '/wt/b', name: 'B-1' }],
      'the SECOND launch\'s content, not an accumulation of both');
  } finally {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
});

test('openCursorWorkspace: every ticket failing (no worktrees) falls back to opening the primary alone — no empty workspace file', async () => {
  const { openCursorWorkspace } = await import('./terminal.mjs');
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'forest-cursor-ws-'));
  try {
    const calls = [];
    const r = await openCursorWorkspace({
      primaryPath: '/repo/web-test', worktrees: [], worktreeRoot,
      cliAvailable: async () => true,
      exec: async (cmd, args) => { calls.push([cmd, args]); return true; },
    });
    assert.deepEqual(calls, [['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', ['/repo/web-test']]]);
    assert.deepEqual(r, { ok: true, cli: true, foldersAdded: 0, workspaceFile: null, briefsOpened: 0 });
    const entries = await readdir(worktreeRoot).catch(() => []);
    assert.deepEqual(entries, [], 'nothing should be written when there is nothing to put in a workspace');
  } finally {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
});

test('openCursorWorkspace: the open call itself failing is reported honestly, not silently claimed as success', async () => {
  const { openCursorWorkspace } = await import('./terminal.mjs');
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'forest-cursor-ws-'));
  try {
    const r = await openCursorWorkspace({
      primaryPath: '/repo/web-test', worktrees: [{ path: '/wt/a', name: 'A-1' }], worktreeRoot,
      cliAvailable: async () => true, exec: async () => false, // the CLI call itself failed
    });
    assert.equal(r.ok, false);
    assert.equal(r.cli, true, 'the CLI WAS available and attempted — this is a launch failure, not a missing-binary fallback');
  } finally {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
});

test('openCursorWorkspace: no bundled CLI falls back to openEditorCmd, opening ONLY the primary checkout — no workspace file written', async () => {
  const { openCursorWorkspace } = await import('./terminal.mjs');
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'forest-cursor-ws-'));
  try {
    const calls = [];
    const r = await openCursorWorkspace({
      primaryPath: '/repo/web-test',
      worktrees: [{ path: '/wt/a', name: 'A-1' }, { path: '/wt/b', name: 'B-1' }],
      worktreeRoot,
      openEditorCmd: 'open -a Cursor',
      cliAvailable: async () => false,
      exec: async (cmd, args) => { calls.push([cmd, args]); return true; },
    });
    assert.deepEqual(calls, [['open', ['-a', 'Cursor', '/repo/web-test']]]);
    assert.deepEqual(r, { ok: true, cli: false, foldersAdded: 0, workspaceFile: null, briefsOpened: 0 });
    const entries = await readdir(worktreeRoot).catch(() => []);
    assert.deepEqual(entries, [], 'the fallback path must not write anything under worktreeRoot');
  } finally {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
});
