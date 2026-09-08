# Agent Choice (Claude / Cursor CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ▶ picker and the Tickets modal's Terminal path let the user start either Claude or Cursor CLI (`cursor-agent`) in the worktree, remember the choice per worktree, install/heal the Cursor harness (`.cursor/`) when Cursor CLI is chosen, and show which agent is running.

**Architecture:** `lib/terminal.mjs` grows one generic launcher (`launchAgentSession`) whose lock file is stamped `<pid> <agent>`; `/api/launch` takes `agent`, runs the pack `install.sh --harness cursor --no-kits` "Cursor axis" for Cursor launches and records it in `.claude/.forest-provision.json` under `cursor`; `/api/worktree/repair` replays that axis; `resolveCursorScope` reads `.cursor/hooks.json` so the picker and the launch response can say how many Cursor gates are active. The UI adds an Agent toggle (default **Cursor CLI**, persisted in `localStorage['forest-agent:<path>']`) to the picker and to the Tickets modal's Terminal target; pure string helpers live in `public/agent-choice.js` so they are unit-tested.

**Tech Stack:** Node ESM (`node --test`), vanilla browser JS (no bundler, no DOM test harness — UI wiring is verified by hand in Task 9), macOS `open`/Terminal, `cursor-agent` CLI, Hektor pack `install.sh`.

**Spec:** `docs/superpowers/specs/2026-09-07-agent-choice-design.md`

## Global Constraints

- **Never commit.** No task has a commit step; every task ends with a working tree the user commits themselves. Never add `Co-Authored-By`/Claude trailers anywhere.
- Files under `docs/` must be written with the Write/Edit tools — a hook blocks Bash writes there.
- `cursor-agent` is invoked **without `--trust`** (user decision). The initial prompt is passed positionally, single-quoted with `shQuote`.
- Agent identifiers are exactly `'claude'` and `'cursor'`; any other value is a 400 from the route and a thrown `unknown agent: <x>` from the launcher.
- UI label for the CLI is **"Cursor CLI"**; the Tickets modal's GUI target is relabelled **"Cursor app"** but keeps `data-target="cursor"` and the stored value `'cursor'` in `forest-launch-target:<repoPath>`.
- Default agent when nothing is saved for a worktree: **`cursor`**.
- One PID lock per worktree at `$TMPDIR/forest-sessions/<slug>.pid`, content `<pid> <agent>`; a bare `<pid>` (legacy) reads as `claude`.
- Config keys: `claudeCmd: 'claude'`, `cursorAgentCmd: 'cursor-agent'` (in `DEFAULTS` and `config.example.json`). Never reproduce the `jiraToken` value from `config.json` anywhere.
- Cursor-axis failures are non-blocking: journalled + returned as `cursorAdapter: { error }` (launch) / `cursor: { wired, error }` (repair); the session still launches.
- Run the whole suite with `node --test` from the repo root before declaring a task done.

---

### Task 1: `launchAgentSession` + agent-stamped lock (`lib/terminal.mjs`)

**Files:**
- Modify: `lib/terminal.mjs` (the `LOCK_DIR` / `sessionLock` / `sessionAlive` / `launchClaudeSession` block, lines ~40–90)
- Test: `lib/terminal.test.mjs`

**Interfaces:**
- Produces: `export function sessionLock(worktreePath): string`
- Produces: `export function readSessionLock(worktreePath): { pid: number, agent: 'claude'|'cursor' } | null` — read-only, never unlinks.
- Produces: `export async function launchAgentSession({ worktreePath, agent = 'claude', cmds = {}, app = 'Terminal', title, prompt = '', openImpl = null, focusImpl = null })` → `{ ok, action: 'launched', agent, error? }` or `{ ok, action: 'focused', agent }`; throws `Error('unknown agent: <x>')` before touching disk.
- Keeps: `export function launchClaudeSession(opts)` as `launchAgentSession({ ...opts, agent: 'claude' })` (the existing test still passes).

- [ ] **Step 1: Write the failing tests**

Replace the import line 3 of `lib/terminal.test.mjs` and add a helper + four tests after the existing `launchClaudeSession` test (before the `// ---- openCursorWorkspace ----` comment):

```js
import { readFile, rm, mkdtemp, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
```

```js
// Same uniqueness argument as the test above: a fixed worktree path could
// collide with a real leftover lock and take the focus branch.
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/terminal.test.mjs`
Expected: the four new tests FAIL (`launchAgentSession is not a function` / `sessionLock is not a function`); the existing `launchClaudeSession` test still passes.

- [ ] **Step 3: Implement in `lib/terminal.mjs`**

Replace the existing `sessionLock`, `sessionAlive` and `launchClaudeSession` definitions with:

```js
// Every agent forest can put in a Terminal window, keyed by the `agent`
// value the client sends. The command is what runs in the window; config
// (claudeCmd / cursorAgentCmd) can override it. The KEYS cannot grow at
// runtime: an unknown agent is refused before anything touches disk.
const DEFAULT_CMDS = { claude: 'claude', cursor: 'cursor-agent' };

export function sessionLock(worktreePath) {
  return join(LOCK_DIR, `${worktreePath.replace(/[^A-Za-z0-9]+/g, '-')}.pid`);
}

// "<pid> <agent>" — or a bare "<pid>" from a lock written before the agent
// stamp existed, which can only have been a Claude session.
function parseLockText(text) {
  const [pidText, agent] = String(text).trim().split(/\s+/);
  const pid = parseInt(pidText, 10);
  if (!pid) return null;
  return { pid, agent: agent || 'claude' };
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

// One Terminal window running `agent` in the worktree. The command is NOT
// shell-quoted on purpose: a configured `~/.local/bin/cursor-agent` or
// `npx cursor-agent` must keep working. The prompt IS quoted. `focusImpl`
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

export function launchClaudeSession(opts) {
  return launchAgentSession({ ...opts, agent: 'claude' });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/terminal.test.mjs`
Expected: all PASS (the original `launchClaudeSession` test included).

- [ ] **Step 5: Run the whole suite** — `node --test` — Expected: PASS. No commit (Global Constraints).

---

### Task 2: Config keys `claudeCmd` / `cursorAgentCmd`

**Files:**
- Modify: `lib/config.mjs` (`DEFAULTS`, after `terminalApp`)
- Modify: `config.example.json` (after `"terminalApp"`)
- Test: `lib/config.test.mjs`

**Interfaces:**
- Produces: `mergeConfig({}).claudeCmd === 'claude'`, `mergeConfig({}).cursorAgentCmd === 'cursor-agent'`. Task 6 reads `ctx.config.claudeCmd` / `ctx.config.cursorAgentCmd`.

- [ ] **Step 1: Write the failing test** (append to `lib/config.test.mjs`)

```js
test('DEFAULTS name both agent commands and config.example.json mirrors them', async () => {
  const c = mergeConfig({});
  assert.equal(c.claudeCmd, 'claude');
  assert.equal(c.cursorAgentCmd, 'cursor-agent');
  assert.equal(mergeConfig({ cursorAgentCmd: '/opt/bin/cursor-agent' }).cursorAgentCmd, '/opt/bin/cursor-agent');
  const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.equal(example.claudeCmd, 'claude');
  assert.equal(example.cursorAgentCmd, 'cursor-agent');
});
```

- [ ] **Step 2: Run** `node --test lib/config.test.mjs` — Expected: FAIL (`undefined !== 'claude'`).

- [ ] **Step 3: Implement**

In `lib/config.mjs` `DEFAULTS`, after `terminalApp: 'Terminal',` add:

```js
  // What the launcher runs in the Terminal window for each agent. Not
  // shell-quoted at launch, so `~/.local/bin/cursor-agent` works as-is.
  claudeCmd: 'claude',
  cursorAgentCmd: 'cursor-agent',
```

In `config.example.json`, after `"terminalApp": "Terminal",` add:

```json
  "claudeCmd": "claude",
  "cursorAgentCmd": "cursor-agent",
```

- [ ] **Step 4: Run** `node --test lib/config.test.mjs` — Expected: PASS. Then `node --test` — PASS. No commit.

---

### Task 3: `lib/agents.mjs` — pass the agent through, lock as a signal, configurable headless command

**Files:**
- Modify: `lib/agents.mjs`
- Test: `lib/agents.test.mjs`

**Interfaces:**
- Consumes (Task 1): `launchAgentSession`, `readSessionLock`, `sessionLock` from `./terminal.mjs`.
- Produces: `launchInteractive({ worktreePath, agent = 'claude', cmds, app = 'Terminal', title, prompt = '' })` → same return as `launchAgentSession`.
- Produces: `runHeadless({ worktreePath, prompt, registry, claudeCmd = 'claude', onOutput, onDone })`.
- Produces: `detectAgentState` returns `{ state: 'running', kind: <agent from lock>, source: 'lock', pid }` when a forest lock is alive — after the registry check, before the transcript scan.

- [ ] **Step 1: Write the failing tests** (append to `lib/agents.test.mjs`; extend the import line)

```js
import { sessionLock } from './terminal.mjs';
import { dirname } from 'node:path';
```

```js
test('detectAgentState: a live forest lock reports running with the agent it names, before the transcript scan', async () => {
  const wt = `/wt/lock-test-${process.pid}-${Date.now()}`;
  const lock = sessionLock(wt);
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, `${process.pid} cursor\n`);
  try {
    const r = await detectAgentState({ worktreePath: wt, claudeProjectsDir: '/nope', nowMs: 0, registry: new Map() });
    assert.deepEqual(r, { state: 'running', kind: 'cursor', source: 'lock', pid: process.pid });
  } finally {
    await rm(lock, { force: true });
  }
});

test('detectAgentState: a dead lock is ignored and left in place — the snapshot never cleans up after the launcher', async () => {
  const wt = `/wt/lock-dead-${process.pid}-${Date.now()}`;
  const lock = sessionLock(wt);
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, '999999 claude\n');
  try {
    const r = await detectAgentState({ worktreePath: wt, claudeProjectsDir: '/nope', nowMs: 0, registry: new Map() });
    assert.equal(r.state, 'unknown');
    await readFile(lock, 'utf8'); // still there
  } finally {
    await rm(lock, { force: true });
  }
});

test('detectAgentState: the registry still outranks the lock', async () => {
  const wt = `/wt/lock-reg-${process.pid}-${Date.now()}`;
  const lock = sessionLock(wt);
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, `${process.pid} cursor\n`);
  try {
    const registry = new Map([[wt, { pid: 42, kind: 'claude' }]]);
    const r = await detectAgentState({ worktreePath: wt, claudeProjectsDir: '/nope', nowMs: 0, registry });
    assert.equal(r.source, 'registry');
    assert.equal(r.kind, 'claude');
  } finally {
    await rm(lock, { force: true });
  }
});
```

Add `readFile` to the `node:fs/promises` import on line 3.

- [ ] **Step 2: Run** `node --test lib/agents.test.mjs` — Expected: the first test FAILS (`source: null` instead of `'lock'`).

- [ ] **Step 3: Implement in `lib/agents.mjs`**

Change the import:

```js
import { runInTerminal, launchAgentSession, readSessionLock } from './terminal.mjs';
```

In `detectAgentState`, immediately after the `if (reg) return ...` line add:

```js
  // The launcher's own lock (Task 1): the one signal that knows WHICH agent
  // is in the window. Read-only here — a stale lock is the launcher's to
  // clean, never the snapshot's.
  const lock = readSessionLock(worktreePath);
  if (lock) return { state: 'running', kind: lock.agent, source: 'lock', pid: lock.pid };
```

Replace `launchInteractive` and the `spawn` line of `runHeadless`:

```js
export function launchInteractive({ worktreePath, agent = 'claude', cmds, app = 'Terminal', title, prompt = '' }) {
  return launchAgentSession({ worktreePath, agent, cmds, app, title, prompt });
}

export function runHeadless({ worktreePath, prompt, registry, claudeCmd = 'claude', onOutput, onDone }) {
  const child = spawn(claudeCmd, ['-p', prompt], { cwd: worktreePath });
```

(the rest of `runHeadless` is unchanged).

- [ ] **Step 4: Run** `node --test lib/agents.test.mjs` — Expected: PASS. Then `node --test` — PASS. No commit.

---

### Task 4: `resolveCursorScope` (`lib/session-scope.mjs`)

**Files:**
- Modify: `lib/session-scope.mjs` (append after `resolveSessionScope`)
- Test: `lib/session-scope.test.mjs`

**Interfaces:**
- Produces: `export async function resolveCursorScope(worktreePath)` → `{ active: [{ event, command, file }], missing: [{ event, command, file }], file: string | null }`. `file` is the absolute path of `.cursor/hooks.json` or `null` when it does not exist / is not JSON. A command whose first token starts with `./` resolves against the worktree and is `stat`'ed; any other command (absolute path, bare PATH name) counts as active with `file: null`. Never throws.

- [ ] **Step 1: Write the failing tests** (append to `lib/session-scope.test.mjs`; add `resolveCursorScope` to the import on line 6)

```js
test('resolveCursorScope: no .cursor/hooks.json → empty, file null, never throws', async () => {
  const wt = await tmp('forest-cscope-');
  try {
    assert.deepEqual(await resolveCursorScope(wt), { active: [], missing: [], file: null });
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('resolveCursorScope: relative ./ commands are stat-ed, others count as active', async () => {
  const wt = await tmp('forest-cscope-');
  try {
    await mkdir(join(wt, '.cursor', 'hooks'), { recursive: true });
    await writeFile(join(wt, '.cursor', 'hooks', 'present.sh'), '#!/bin/sh\n');
    await writeFile(join(wt, '.cursor', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        beforeShellExecution: [
          { command: './.cursor/hooks/present.sh', timeout: 10 },
          { command: './.cursor/hooks/gone.sh --strict', timeout: 10 },
        ],
        subagentStart: { command: 'hektor-registry', timeout: 5 },
        afterFileEdit: 'not-an-object',
      },
    }));
    const s = await resolveCursorScope(wt);
    assert.equal(s.file, join(wt, '.cursor', 'hooks.json'));
    assert.deepEqual(s.active.map((h) => [h.event, h.command]), [
      ['beforeShellExecution', './.cursor/hooks/present.sh'],
      ['subagentStart', 'hektor-registry'],
    ]);
    assert.equal(s.active[0].file, join(wt, '.cursor', 'hooks', 'present.sh'));
    assert.equal(s.active[1].file, null);
    assert.deepEqual(s.missing, [
      { event: 'beforeShellExecution', command: './.cursor/hooks/gone.sh --strict', file: join(wt, '.cursor', 'hooks', 'gone.sh') },
    ]);
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('resolveCursorScope: a hooks.json that is not JSON reads as absent', async () => {
  const wt = await tmp('forest-cscope-');
  try {
    await mkdir(join(wt, '.cursor'), { recursive: true });
    await writeFile(join(wt, '.cursor', 'hooks.json'), '{ nope');
    assert.deepEqual(await resolveCursorScope(wt), { active: [], missing: [], file: null });
  } finally { await rm(wt, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test lib/session-scope.test.mjs` — Expected: FAIL (`resolveCursorScope` is not exported).

- [ ] **Step 3: Implement** (append to `lib/session-scope.mjs`)

```js
// The Cursor harness's own registry: .cursor/hooks.json, written whole by
// the pack's install.sh. Same question resolveSessionScope answers for
// .claude/ — "which registered gate scripts are actually on disk?" — but
// there is exactly one file and no inheritance, so no sources/inline split.
// A `./`-relative command is resolved against the worktree and stat-ed;
// anything else (absolute, or a bare name on PATH) is taken as active:
// forest cannot judge it and must not report a working gate as missing.
export async function resolveCursorScope(worktreePath) {
  const file = join(worktreePath, '.cursor', 'hooks.json');
  const cfg = await readJson(file);
  if (!cfg || typeof cfg !== 'object') return { active: [], missing: [], file: null };
  const hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
  const active = [], missing = [];
  for (const [event, entries] of Object.entries(hooks)) {
    for (const h of Array.isArray(entries) ? entries : [entries]) {
      const command = h && typeof h === 'object' && typeof h.command === 'string' ? h.command.trim() : '';
      if (!command) continue;
      const first = command.split(/\s+/)[0];
      if (!first.startsWith('./')) { active.push({ event, command, file: null }); continue; }
      const target = resolve(worktreePath, first);
      let present = false;
      try { await stat(target); present = true; } catch { /* registered but not on disk */ }
      (present ? active : missing).push({ event, command, file: target });
    }
  }
  return { active, missing, file };
}
```

(`readJson`, `stat`, `join`, `resolve` are already imported/defined in this module.)

- [ ] **Step 4: Run** `node --test lib/session-scope.test.mjs` — Expected: PASS. Then `node --test` — PASS. No commit.

---

### Task 5: `writeProvisionRecord` carries a `cursor` slot (`lib/packs.mjs`)

**Files:**
- Modify: `lib/packs.mjs` (`writeProvisionRecord`)
- Test: `lib/packs.test.mjs`

**Interfaces:**
- Produces: `writeProvisionRecord(worktreePath, selections, inventory = null, at = null, cursor = null)`; the record gains `cursor: { packs: string[], at: string }` only when the argument is given. `readProvisionRecord` is unchanged and returns it.

- [ ] **Step 1: Write the failing tests** (append to `lib/packs.test.mjs`, next to the two inventory tests at ~437–460)

```js
test('writeProvisionRecord persists the Cursor axis when given, omits the key when not', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-inv-'));
  try {
    await writeProvisionRecord(wt, [{ pack: 'hektor', skills: ['hektor-verify'] }], null, null,
      { packs: ['hektor'], at: '2026-09-07T10:00:00.000Z' });
    const rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.cursor, { packs: ['hektor'], at: '2026-09-07T10:00:00.000Z' });
    assert.equal(rec.inventory, undefined);

    await writeProvisionRecord(wt, [{ pack: 'hektor' }]);
    const raw = await readFile(join(wt, '.claude', '.forest-provision.json'), 'utf8');
    assert.ok(!raw.includes('cursor'), 'a record with no Cursor axis must not claim one');
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run** `node --test lib/packs.test.mjs` — Expected: FAIL (`rec.cursor` is `undefined`).

- [ ] **Step 3: Implement** — replace `writeProvisionRecord` in `lib/packs.mjs`:

```js
// `cursor` — `{ packs, at }` — is the Cursor axis (Task 6's wireCursorAxis):
// which packs had their install.sh --harness cursor run here, and when.
// Written only when given, for the same reason `inventory` is: a record
// that never had one must not start claiming an empty one.
export async function writeProvisionRecord(worktreePath, selections, inventory = null, at = null, cursor = null) {
  const file = join(worktreePath, '.claude', PROVISION_FILE);
  await mkdir(dirname(file), { recursive: true });
  const rec = { at: typeof at === 'string' && at ? at : new Date().toISOString(), selections };
  if (inventory) rec.inventory = inventory;
  if (cursor) rec.cursor = cursor;
  await writeFile(file, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}
```

- [ ] **Step 4: Run** `node --test lib/packs.test.mjs` — Expected: PASS. Then `node --test` — PASS. No commit.

---

### Task 6: `wireCursorAxis` — adapter runner gains `--no-kits` + timeout; ticket-worktrees route and `recordWithout` use the Cursor slot (`lib/actions.mjs`)

**Files:**
- Modify: `lib/actions.mjs` — `recordWithout` (~167–188), `runCursorAdapterInstallDefault` (~254–272), inside `createActionHandler` after `const tickets = createTicketCache();` (~295), the adapter block in `ensureTicketWorktree` (~576–585), the tail of `/api/worktree/remove-units`
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes (Task 5): `writeProvisionRecord(path, selections, inventory, at, cursor)`.
- Produces: `runCursorAdapterInstall({ packsDir, pack, worktreePath, noKits })` (injectable; default appends `--no-kits` when `noKits` is true and runs with `timeout: 180000`).
- Produces (closure inside `createActionHandler`, used by Tasks 7 and 8): `async function packsWithInstaller(packsDir, names) → string[]` and `async function wireCursorAxis({ ctx, path, packs, mode, label }) → { wired: string[], error: string | null }`.
- Produces: `recordWithout(record, units)` returns `{ selections, inventory, at, cursor }` where `cursor` is `record.cursor ?? null`.

- [ ] **Step 1: Write the failing tests**

(a) Add `recordWithout` to the `./actions.mjs` import on line 6 of `lib/actions.test.mjs`, then append:

```js
test('recordWithout carries the Cursor axis through untouched — a unit removal must not forget what install.sh wired', () => {
  const cursor = { packs: ['hektor'], at: '2026-09-07T10:00:00.000Z' };
  const next = recordWithout({ at: '2026-09-01T00:00:00.000Z', selections: [{ pack: 'hektor', kits: ['k1', 'k2'] }], cursor }, [{ kind: 'kit', id: 'k1' }]);
  assert.deepEqual(next.selections, [{ pack: 'hektor', kits: ['k2'] }]);
  assert.deepEqual(next.cursor, cursor);
  assert.equal(recordWithout({ selections: [] }, []).cursor, null);
});
```

(b) In the test at ~2098 (`provisions the merged selection and wires the Cursor adapter…`), change the `deepEqual` on `adapterCalls` and add a record assertion:

```js
    assert.deepEqual(adapterCalls, [{ packsDir: packs, pack: 'hektor', worktreePath: wtPath, noKits: true }]);
    assert.ok(ctx.journal.entries.some((e) => /cursor adapter wired for tech\/WEBT-1/.test(e.cmd)));
    const rec = await readProvisionRecord(wtPath);
    assert.deepEqual(rec.selections, selections, 'the provision record must be written, same as /api/launch');
    assert.deepEqual(rec.cursor.packs, ['hektor'], 'the Cursor axis is recorded so repair can replay it');
    assert.match(rec.cursor.at, /^\d{4}-\d{2}-\d{2}T/);
```

(c) Append a test that drives the DEFAULT runner against a fake `install.sh`:

```js
test('/api/tickets/worktrees: the default adapter runner calls the pack\'s install.sh with --harness cursor --project <wt> --no-kits', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  const packs = await mkdtemp(join(tmpdir(), 'forest-tix-packs3-'));
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-from-jira'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-from-jira', 'SKILL.md'), '# from-jira\n');
  await writeFile(join(packs, 'hektor', 'install.sh'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(packs, 'args.txt'))}\n`);
  await chmod(join(packs, 'hektor', 'install.sh'), 0o755);
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot, packs });
    const handle = createActionHandler({ inferBranchPrefix: async () => 'tech/WEBT-', openCursorWorkspace: async () => ({ ok: true }) });
    const selections = [{ pack: 'hektor', skills: ['hektor-from-jira'], kits: [], hooks: false }];
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-1'], selections }));
    const body = JSON.parse(res.body);
    assert.equal(body.results[0].cursorAdapterError, undefined);
    const args = (await readFile(join(packs, 'args.txt'), 'utf8')).trim().split('\n');
    assert.deepEqual(args, ['--harness', 'cursor', '--project', body.results[0].path, '--no-kits']);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run** `node --test lib/actions.test.mjs` — Expected: the `recordWithout` test FAILS (`cursor` undefined), the `deepEqual` at (b) FAILS (`noKits` missing), (c) FAILS (`--no-kits` missing).

- [ ] **Step 3: Implement**

(a) `recordWithout` — add one property to the returned object, after `at:`:

```js
    at: typeof record?.at === 'string' ? record.at : null,
    // The Cursor axis is per-pack, not per-unit: removing a kit from .claude/
    // does not un-install .cursor/, so the record keeps saying it is there.
    cursor: record?.cursor ?? null,
```

(b) `runCursorAdapterInstallDefault` — new signature and `execFile` call:

```js
async function runCursorAdapterInstallDefault({ packsDir, pack, worktreePath, noKits = false }) {
  if (!safeId(pack)) return { error: `invalid pack id: ${pack}` };
  const installPath = join(packsDir, pack, 'install.sh');
  try { await stat(installPath); } catch {
    return { error: `${pack}/install.sh not found under ${packsDir} — the Cursor adapter (.cursor/rules, .cursor/hooks.json) was not wired` };
  }
  // --no-kits: forest provisions kits itself (runSelections) — letting the
  // pack's installer run every bundled kit again would double-install them.
  // The timeout is the hard stop for an installer that hangs on a prompt:
  // without one a launch would wait forever with nothing on screen.
  const args = ['--harness', 'cursor', '--project', worktreePath, ...(noKits ? ['--no-kits'] : [])];
  return new Promise((resolveInstall) => {
    execFile(installPath, args, { maxBuffer: 8 * 1024 * 1024, timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || '').trim().slice(0, 500) || 'no output';
        const how = err.killed ? ' (killed after 180s)' : err.code ? ` (exit ${err.code})` : '';
        resolveInstall({ error: `${pack}/install.sh --harness cursor failed${how}: ${detail}` });
        return;
      }
      resolveInstall({ ok: true, stdout: String(stdout || '').trim() });
    });
  });
}
```

(c) Inside `createActionHandler`, right after `const tickets = createTicketCache();`, add:

```js
  // Which of `names` (pack ids) can be wired for Cursor at all: the pack must
  // ship its own install.sh. Packs without one are skipped silently — there
  // is nothing to run, and a launch must not fail over a pack that never
  // offered a Cursor axis.
  async function packsWithInstaller(packsDir, names) {
    if (!packsDir) return [];
    const out = [];
    for (const pack of [...new Set(names)]) {
      if (!safeId(pack)) continue;
      try { await stat(join(packsDir, pack, 'install.sh')); out.push(pack); } catch { /* no installer: nothing to wire */ }
    }
    return out;
  }

  // The Cursor axis of a provisioned worktree: each pack's OWN install.sh
  // (--harness cursor --no-kits) writes .cursor/ whole — skills, agents,
  // rules, hooks and hooks.json. Shared by /api/launch (agent: cursor),
  // /api/worktree/repair and the ticket-worktrees route so all three
  // journal, record and exclude identically. Never throws. Returns the packs
  // that landed and the first error; a partial result is still recorded so
  // repair replays what did work.
  async function wireCursorAxis({ ctx, path, packs, mode, label }) {
    const wired = [];
    let error = null;
    for (const pack of packs) {
      const install = await runCursorAdapterInstall({ packsDir: ctx.config.packsDir, pack, worktreePath: path, noKits: true });
      if (install.error) {
        error ??= install.error;
        ctx.journal.add({ cmd: `cursor adapter NOT wired for ${label}: ${install.error}`, cwd: path, mode });
      } else {
        wired.push(pack);
        ctx.journal.add({ cmd: `cursor adapter wired for ${label} (${pack}/install.sh --harness cursor --no-kits → .cursor/)`, cwd: path, mode });
      }
    }
    if (wired.length) {
      const rec = await readProvisionRecord(path);
      if (rec && Array.isArray(rec.selections)) {
        // Union with what was recorded before: a pack whose replay failed is
        // still installed under .cursor/ at its old version, and the next
        // repair must keep trying it rather than forget it.
        const prior = Array.isArray(rec.cursor?.packs) ? rec.cursor.packs : [];
        const packsNow = [...new Set([...prior, ...wired])];
        await writeProvisionRecord(path, rec.selections, rec.inventory ?? null, rec.at ?? null, { packs: packsNow, at: new Date().toISOString() });
      }
      // install.sh's own .gitignore block covers docs/hektor/ only, never
      // .cursor/ — without this the whole harness shows up as untracked.
      const excluded = await ensureExcluded(path, { checkPath: '.cursor/hooks.json', pattern: '/.cursor/' });
      if (!excluded) ctx.journal.add({ cmd: `WARNING: .cursor/ is not git-excluded in ${label} — the Cursor harness will show up in git status`, cwd: path, mode });
    }
    return { wired, error };
  }
```

(d) In `ensureTicketWorktree`, replace the `if (packName) { ... }` block with:

```js
      const packName = hektorAdapterPack(selections);
      if (packName) {
        const { error } = await wireCursorAxis({ ctx, path: wtPath, packs: [packName], mode: 'auto', label: branch });
        if (error) out.cursorAdapterError = error;
      }
```

(e) In `/api/worktree/remove-units`, the record rewrite becomes:

```js
        const next = recordWithout(rec, gone);
        await writeProvisionRecord(path, next.selections, next.inventory, next.at, next.cursor);
```

- [ ] **Step 4: Run** `node --test lib/actions.test.mjs` — Expected: PASS (including the two existing adapter tests at ~2098 and ~2130). Then `node --test` — PASS. No commit.

---

### Task 7: `/api/launch` and `/api/task` take `agent`; Cursor launches wire the Cursor axis (`lib/actions.mjs`)

**Files:**
- Modify: `lib/actions.mjs` — imports, a module-level `agentCmds` helper (next to `hektorAdapterPack`), the `/api/launch` route (~1222–1311), the `/api/task` route (~1324–1340)
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes (Task 3): `launch({ worktreePath, agent, cmds, app, title, prompt })` returning `{ ok, action, agent, error? }`; `runHeadless({ ..., claudeCmd })`.
- Consumes (Task 4): `resolveCursorScope(path)`.
- Consumes (Task 6): `packsWithInstaller`, `wireCursorAxis`.
- Produces: `POST /api/launch` body `agent?: 'claude' | 'cursor'` (absent → `'claude'`; other → 400 `{ error: "agent must be 'claude' or 'cursor'" }`). Response `{ ok, action, agent, provisioned, promptSent, scope: { active: number, missing: [{ command, source }] }, cursorAdapter?: { error } }`.
- Produces: `POST /api/task` body `agent?` with the same validation; guided → `{ mode: 'guided', agent }`.
- Produces: `function agentCmds(config) → { claude, cursor }`.

- [ ] **Step 1: Write the failing tests** (append to `lib/actions.test.mjs`)

```js
// A real worktree dir + packs root for the Cursor-axis launch tests: unlike
// WT_PATH, provisioning has to actually write .claude/ here.
async function cursorLaunchFixture() {
  const wt = await tmp('forest-clx-wt-');
  const packs = await tmp('forest-clx-packs-');
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-verify'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-verify', 'SKILL.md'), '# verify\n');
  await writeFile(join(packs, 'hektor', 'install.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(packs, 'hektor', 'install.sh'), 0o755);
  await mkdir(join(packs, 'plain', 'skills', 'tidy'), { recursive: true });
  await writeFile(join(packs, 'plain', 'skills', 'tidy', 'SKILL.md'), '# tidy\n');
  const ctx = {
    config: { packsDir: packs, defaultMode: 'auto', terminalApp: 'Terminal', claudeCmd: 'claude', cursorAgentCmd: '/opt/bin/cursor-agent' },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => ({ repos: [] }),
    cachedSnapshot: async () => ({ repos: [] }),
  };
  const cleanup = () => Promise.all([rm(wt, { recursive: true, force: true }), rm(packs, { recursive: true, force: true })]);
  return { wt, packs, ctx, cleanup };
}
const BOTH = [
  { pack: 'hektor', skills: ['hektor-verify'], kits: [], hooks: false },
  { pack: 'plain', skills: ['tidy'], kits: [], hooks: false },
];
const oneMissingGate = async () => ({ active: [], missing: [{ command: '/x/gone.sh', source: '/x/settings.json', file: '/x/gone.sh' }], inline: [], sources: [] });

test('/api/launch: agent must be claude or cursor — anything else is a 400 that mutates nothing', async () => {
  const seen = [];
  const res = fakeRes();
  const ctx = submitCtx();
  await createActionHandler({ launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; }, resolveScope: noRealHome })(
    { url: '/api/launch' }, res, ctx, async () => ({ path: WT_PATH, selections: [], agent: 'gemini' }));
  assert.equal(res.code, 400);
  assert.equal(JSON.parse(res.body).error, "agent must be 'claude' or 'cursor'");
  assert.equal(seen.length, 0);
  assert.equal(ctx.journal.entries.length, 0);
});

test('/api/launch: agent absent means claude, and the response echoes what the launcher actually ran', async () => {
  const seen = [];
  let res = fakeRes();
  await createActionHandler({ launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; }, resolveScope: noRealHome })(
    { url: '/api/launch' }, res, submitCtx(), async () => ({ path: WT_PATH, selections: [] }));
  assert.equal(seen[0].agent, 'claude');
  assert.deepEqual(seen[0].cmds, { claude: 'claude', cursor: 'cursor-agent' }, 'a ctx without the config keys still names a command per agent');
  assert.equal(JSON.parse(res.body).agent, 'claude');
  // Focused: the lock says cursor even though the request said claude — the
  // response names the session that is really there.
  res = fakeRes();
  await createActionHandler({ launch: async () => ({ ok: true, action: 'focused', agent: 'cursor' }), resolveScope: noRealHome })(
    { url: '/api/launch' }, res, submitCtx(), async () => ({ path: WT_PATH, selections: [], agent: 'claude' }));
  assert.equal(JSON.parse(res.body).agent, 'cursor');
});

test('/api/launch: agent cursor wires every selected pack that ships install.sh, skips the Claude gate check, launches the configured cursor command, and journals it', async () => {
  const { wt, packs, ctx, cleanup } = await cursorLaunchFixture();
  try {
    const seen = [], adapterCalls = [];
    const handle = createActionHandler({
      launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; },
      resolveScope: oneMissingGate,
      runCursorAdapterInstall: async (args) => { adapterCalls.push(args); return { ok: true, stdout: '' }; },
    });
    let res = fakeRes();
    await handle({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: BOTH, agent: 'cursor', prompt: 'work A-1' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.agent, 'cursor');
    assert.equal(body.promptSent, true);
    assert.equal(body.cursorAdapter, undefined);
    assert.deepEqual(body.scope, { active: 0, missing: [] }, 'Cursor scope comes from .cursor/hooks.json, not settings.json');
    assert.equal(seen[0].agent, 'cursor');
    assert.equal(seen[0].prompt, 'work A-1');
    assert.deepEqual(seen[0].cmds, { claude: 'claude', cursor: '/opt/bin/cursor-agent' });
    assert.deepEqual(adapterCalls, [{ packsDir: packs, pack: 'hektor', worktreePath: wt, noKits: true }], 'plain ships no install.sh and is skipped silently');
    assert.deepEqual((await readProvisionRecord(wt)).cursor.packs, ['hektor']);
    assert.ok(ctx.journal.entries.some((e) => e.cmd === "/opt/bin/cursor-agent 'work A-1'"), JSON.stringify(ctx.journal.entries));
    assert.ok(ctx.journal.entries.some((e) => /cursor adapter wired for /.test(e.cmd)));

    // The same worktree, same resolver, agent claude: the missing Claude
    // gate DOES block — proving the skip above is per-agent, not removed.
    res = fakeRes();
    await handle({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: BOTH, agent: 'claude' }));
    assert.equal(JSON.parse(res.body).blocked, 'missing-hooks');
  } finally { await cleanup(); }
});

test('/api/launch: a failing Cursor axis is journalled and reported, and the session still launches', async () => {
  const { wt, ctx, cleanup } = await cursorLaunchFixture();
  try {
    const seen = [];
    const res = fakeRes();
    await createActionHandler({
      launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; },
      resolveScope: noRealHome,
      runCursorAdapterInstall: async () => ({ error: 'hektor/install.sh --harness cursor failed (exit 69): jq is required' }),
    })({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: BOTH, agent: 'cursor' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.match(body.cursorAdapter.error, /jq is required/);
    assert.equal(seen.length, 1, 'the window still opens — the user asked for a session, not a gate');
    assert.ok(ctx.journal.entries.some((e) => /cursor adapter NOT wired for /.test(e.cmd)));
    assert.equal((await readProvisionRecord(wt)).cursor, undefined, 'nothing landed, so nothing is recorded');
  } finally { await cleanup(); }
});

test('/api/launch: agent cursor with an empty selection runs no installer, and the scope names the missing Cursor gates', async () => {
  const { wt, ctx, cleanup } = await cursorLaunchFixture();
  try {
    await mkdir(join(wt, '.cursor'), { recursive: true });
    await writeFile(join(wt, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: './.cursor/hooks/gone.sh', timeout: 10 }] } }));
    const adapterCalls = [];
    const res = fakeRes();
    await createActionHandler({
      launch: async (a) => ({ ok: true, action: 'launched', agent: a.agent }),
      resolveScope: noRealHome,
      runCursorAdapterInstall: async (args) => { adapterCalls.push(args); return { ok: true, stdout: '' }; },
    })({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: [], agent: 'cursor' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual(adapterCalls, []);
    assert.deepEqual(body.scope, { active: 0, missing: [{ command: './.cursor/hooks/gone.sh', source: join(wt, '.cursor', 'hooks.json') }] });
    assert.ok(ctx.journal.entries.some((e) => /scope: 1 Cursor gate script\(s\) registered but missing/.test(e.cmd)));
  } finally { await cleanup(); }
});

test('/api/task guided: opens the chosen agent in a Terminal and journals its command; a bad agent is a 400', async () => {
  const seen = [];
  let res = fakeRes();
  const ctx = submitCtx();
  const handle = createActionHandler({ launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; } });
  await handle({ url: '/api/task' }, res, ctx, async () => ({ path: WT_PATH, mode: 'guided', agent: 'cursor' }));
  assert.deepEqual(JSON.parse(res.body), { mode: 'guided', agent: 'cursor' });
  assert.equal(seen[0].agent, 'cursor');
  assert.deepEqual(seen[0].cmds, { claude: 'claude', cursor: 'cursor-agent' });
  assert.equal(ctx.journal.entries.at(-1).cmd, 'cursor-agent');
  res = fakeRes();
  await handle({ url: '/api/task' }, res, ctx, async () => ({ path: WT_PATH, mode: 'guided', agent: 'nope' }));
  assert.equal(res.code, 400);
  assert.equal(seen.length, 1);
});
```

- [ ] **Step 2: Run** `node --test lib/actions.test.mjs` — Expected: the six new tests FAIL (no 400; `seen[0].agent` undefined; `body.agent` undefined; adapter never called for `/api/launch`; `/api/task` response lacks `agent`).

- [ ] **Step 3: Implement**

(a) Imports at the top of `lib/actions.mjs`: add `resolveCursorScope` to the `./session-scope.mjs` import:

```js
import { resolveSessionScope, resolveCursorScope } from './session-scope.mjs';
```

(b) Module-level helper, placed right after `hektorAdapterPack`:

```js
// The command per agent, config-overridable (claudeCmd / cursorAgentCmd).
// Falls back per key so a ctx built without those keys — every route test —
// still names a command; the launcher refuses anything but these two keys.
function agentCmds(config = {}) {
  return { claude: config.claudeCmd || 'claude', cursor: config.cursorAgentCmd || 'cursor-agent' };
}

const AGENT_ERROR = "agent must be 'claude' or 'cursor'";
function requestedAgent(body) {
  return body.agent === undefined ? 'claude' : body.agent;
}
```

(c) Replace the `/api/launch` route body with (the orphan block and the `if (sel.length)` provisioning block are unchanged and elided here as `/* … unchanged … */`; keep them verbatim):

```js
      if (url === '/api/launch') {
        const { path, selections = [] } = body;
        // Validated before anything is read or written — a 400 must mutate
        // nothing, exactly like the orphan block below. Absent means Claude:
        // the shape every pre-existing caller sends.
        const agent = requestedAgent(body);
        if (agent !== 'claude' && agent !== 'cursor') return sendJson(res, { error: AGENT_ERROR }, 400);
        const sel = selections.filter((s) => s && s.pack && ((s.skills?.length) || (s.kits?.length) || s.hooks));

        /* … orphan guard: unchanged … */

        let provisioned = null;
        if (sel.length) {
          /* … runSelections + writeProvisionRecord + journal: unchanged … */
        }

        // The Cursor axis: cursor-agent reads .cursor/ only, and nothing
        // above writes there. Each selected pack that ships an install.sh is
        // installed whole (the checkboxes shape .claude/ only). Gated on
        // sel.length like provisioning: an empty selection wires nothing.
        // Non-blocking — the error rides the response and the journal, and
        // the window still opens: the user asked for a session, not a gate.
        let cursorAdapter = null;
        if (agent === 'cursor' && sel.length) {
          const packs = await packsWithInstaller(ctx.config.packsDir, sel.map((s) => s.pack));
          if (packs.length) {
            const w = await wireCursorAxis({ ctx, path, packs, mode, label: worktreeTitle(path) });
            if (w.error) cursorAdapter = { error: w.error };
          }
        }

        // Claude only: launchDecision reads settings.json hook registrations,
        // which cursor-agent never loads — blocking a Cursor launch on a
        // missing Claude gate would be a gate that guards nothing.
        if (agent === 'claude') {
          const decision = await launchDecision({ path, force: !!body.force, packsDir: ctx.config.packsDir, resolveScope });
          if (!decision.launch) {
            ctx.journal.add({ cmd: `launch blocked: ${decision.missing.length} hook script(s) registered but missing`, cwd: path, mode });
            return sendJson(res, { ok: false, ...decision, provisioned });
          }
        }

        // Left undefined (never coerced to '') when absent: `launch` is a test
        // double in `actions.test.mjs`, and the no-prompt case asserts the
        // launcher sees `prompt: undefined` — byte-identical to the call
        // before this feature existed.
        const prompt = body.prompt ? String(body.prompt) : undefined;
        const cmds = agentCmds(ctx.config);
        const r = await launch({ worktreePath: path, agent, cmds, app: ctx.config.terminalApp, title: worktreeTitle(path), prompt });
        // Journalled AFTER launch returns, and keyed on what actually
        // happened rather than what was asked for: a focused (already-alive)
        // session never receives the prompt, so a bare command line is the
        // truth for it — journalling the quoted prompt there would record a
        // delivery that never occurred.
        ctx.journal.add({
          cmd: prompt && r?.action === 'launched' ? `${cmds[agent]} ${shQuote(prompt)}` : cmds[agent],
          cwd: path, mode: 'guided',
        });
        // Same shape for both agents so the client reports them identically;
        // for Cursor the "source" is the one file the registrations live in.
        let scope;
        if (agent === 'cursor') {
          const cs = await resolveCursorScope(path);
          scope = { active: cs.active.length, missing: cs.missing.map((h) => ({ command: h.command, source: cs.file })) };
          if (cs.missing.length) ctx.journal.add({ cmd: `scope: ${cs.missing.length} Cursor gate script(s) registered but missing`, cwd: path, mode });
        } else {
          // The injected resolver, like `launchDecision` above: the
          // module-level one made a route test read the developer's real
          // ~/.claude/settings.json.
          const s = await resolveScope(path);
          scope = { active: s.active.length, missing: s.missing.map((h) => ({ command: h.command, source: h.source })) };
          if (s.missing.length) ctx.journal.add({ cmd: `scope: ${s.missing.length} hook script(s) registered but missing`, cwd: path, mode });
        }
        // A focused (already-alive) session never receives the prompt — it
        // was not delivered, and the response must say so. `agent` is the
        // launcher's answer: on focus it is whatever the lock says is
        // running, which may not be what was asked for.
        return r && r.ok
          ? sendJson(res, {
            ok: true, action: r.action, agent: r.agent || agent, provisioned,
            promptSent: Boolean(prompt) && r.action === 'launched',
            scope,
            ...(cursorAdapter ? { cursorAdapter } : {}),
          })
          : sendJson(res, { error: (r && r.error) || 'failed to open Terminal' }, 500);
      }
```

(d) Replace the `/api/task` route with:

```js
      if (url === '/api/task') {
        const { path, prompt } = body;
        const agent = requestedAgent(body);
        if (agent !== 'claude' && agent !== 'cursor') return sendJson(res, { error: AGENT_ERROR }, 400);
        const cmds = agentCmds(ctx.config);
        if (mode === 'guided') {
          // Stay fluent: open a terminal so the user runs the agent themselves.
          ctx.journal.add({ cmd: cmds[agent], cwd: path, mode: 'guided' });
          launch({ worktreePath: path, agent, cmds, app: ctx.config.terminalApp, title: worktreeTitle(path) });
          return sendJson(res, { mode: 'guided', agent });
        }
        // Headless stays Claude-only: `claude -p` is the streaming contract
        // the drawer renders; cursor-agent's print mode is not wired here.
        ctx.journal.add({ cmd: `${cmds.claude} -p ${shQuote(prompt)}`, cwd: path, mode: 'auto' });
        runHeadless({
          worktreePath: path, prompt, registry: ctx.registry, claudeCmd: cmds.claude,
          onOutput: (chunk) => ctx.broadcast('task', { path, chunk }),
          onDone: (code) => ctx.broadcast('task', { path, done: true, code }),
        });
        return sendJson(res, { mode: 'auto', started: true });
      }
```

- [ ] **Step 4: Run** `node --test lib/actions.test.mjs` — Expected: PASS, including the pre-existing launch tests at ~337, ~901–1160 and ~1396–1441 (their journal assertion `cmd === 'claude'` still holds because `agentCmds({})` falls back to `'claude'`). Then `node --test` — PASS. No commit.

---

### Task 8: `/api/worktree/scope` reports the Cursor axis; `/api/worktree/repair` replays it (`lib/actions.mjs`)

**Files:**
- Modify: `lib/actions.mjs` — the `/api/worktree/scope` route (~985) and `/api/worktree/repair` route (~996)
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes (Task 4): `resolveCursorScope`. Consumes (Task 6): `packsWithInstaller`, `wireCursorAxis`.
- Produces: `/api/worktree/scope` response gains `cursor: { active: number, missing: [{ event, command, file }], file: string | null }`.
- Produces: `/api/worktree/repair` response gains `cursor: { wired: number, error?: string } | null` (`null` = no Cursor axis to replay).

- [ ] **Step 1: Write the failing tests** (append to `lib/actions.test.mjs`)

```js
async function repairFixture({ cursorPacks = null, hooksJson = false } = {}) {
  const wt = await tmp('forest-rep-wt-');
  const packs = await tmp('forest-rep-packs-');
  for (const pack of ['hektor', 'other']) {
    await mkdir(join(packs, pack, 'skills', `${pack}-skill`), { recursive: true });
    await writeFile(join(packs, pack, 'skills', `${pack}-skill`, 'SKILL.md'), `# ${pack}\n`);
    await writeFile(join(packs, pack, 'install.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(packs, pack, 'install.sh'), 0o755);
  }
  await mkdir(join(packs, 'plain', 'skills', 'tidy'), { recursive: true });
  await writeFile(join(packs, 'plain', 'skills', 'tidy', 'SKILL.md'), '# tidy\n');
  const selections = [
    { pack: 'hektor', skills: ['hektor-skill'], kits: [], hooks: false },
    { pack: 'other', skills: ['other-skill'], kits: [], hooks: false },
    { pack: 'plain', skills: ['tidy'], kits: [], hooks: false },
  ];
  await writeProvisionRecord(wt, selections, { kits: [], skills: [] }, null,
    cursorPacks ? { packs: cursorPacks, at: '2026-09-01T00:00:00.000Z' } : null);
  if (hooksJson) {
    await mkdir(join(wt, '.cursor'), { recursive: true });
    await writeFile(join(wt, '.cursor', 'hooks.json'), '{"version":1,"hooks":{}}\n');
  }
  const ctx = {
    config: { packsDir: packs, defaultMode: 'auto' },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => ({ repos: [] }),
    cachedSnapshot: async () => ({ repos: [] }),
  };
  const cleanup = () => Promise.all([rm(wt, { recursive: true, force: true }), rm(packs, { recursive: true, force: true })]);
  return { wt, packs, ctx, cleanup };
}
const repairWith = (runCursorAdapterInstall) => createActionHandler({ resolveScope: noRealHome, runCursorAdapterInstall });

test('/api/worktree/repair: replays every recorded Cursor pack with --no-kits and reports the count', async () => {
  const { wt, packs, ctx, cleanup } = await repairFixture({ cursorPacks: ['hektor', 'other'] });
  try {
    const adapterCalls = [];
    const res = fakeRes();
    await repairWith(async (a) => { adapterCalls.push(a); return { ok: true, stdout: '' }; })(
      { url: '/api/worktree/repair' }, res, ctx, async () => ({ path: wt }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.deepEqual(body.cursor, { wired: 2 });
    assert.deepEqual(adapterCalls, [
      { packsDir: packs, pack: 'hektor', worktreePath: wt, noKits: true },
      { packsDir: packs, pack: 'other', worktreePath: wt, noKits: true },
    ]);
    assert.deepEqual((await readProvisionRecord(wt)).cursor.packs, ['hektor', 'other']);
    assert.ok(ctx.journal.entries.some((e) => /repair: .*cursor axis: 2\/2 pack\(s\) re-wired/.test(e.cmd)), JSON.stringify(ctx.journal.entries));
  } finally { await cleanup(); }
});

test('/api/worktree/repair: no Cursor axis recorded and no .cursor/hooks.json → cursor null, no installer runs', async () => {
  const { wt, ctx, cleanup } = await repairFixture();
  try {
    const adapterCalls = [];
    const res = fakeRes();
    await repairWith(async (a) => { adapterCalls.push(a); return { ok: true, stdout: '' }; })(
      { url: '/api/worktree/repair' }, res, ctx, async () => ({ path: wt }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.cursor, null);
    assert.deepEqual(adapterCalls, []);
  } finally { await cleanup(); }
});

test('/api/worktree/repair: legacy — .cursor/hooks.json present but no record slot → replays every recorded pack that ships install.sh and backfills the slot', async () => {
  const { wt, ctx, cleanup } = await repairFixture({ hooksJson: true });
  try {
    const adapterCalls = [];
    const res = fakeRes();
    await repairWith(async (a) => { adapterCalls.push(a); return { ok: true, stdout: '' }; })(
      { url: '/api/worktree/repair' }, res, ctx, async () => ({ path: wt }));
    const body = JSON.parse(res.body);
    assert.deepEqual(body.cursor, { wired: 2 });
    assert.deepEqual(adapterCalls.map((a) => a.pack), ['hektor', 'other'], 'plain has no install.sh — nothing to replay');
    assert.deepEqual((await readProvisionRecord(wt)).cursor.packs, ['hektor', 'other']);
  } finally { await cleanup(); }
});

test('/api/worktree/repair: one installer failing is reported, the other still lands, and the record keeps every pack ever wired', async () => {
  const { wt, ctx, cleanup } = await repairFixture({ cursorPacks: ['hektor', 'other'] });
  try {
    const res = fakeRes();
    await repairWith(async (a) => (a.pack === 'other' ? { error: 'other/install.sh --harness cursor failed (exit 1): boom' } : { ok: true, stdout: '' }))(
      { url: '/api/worktree/repair' }, res, ctx, async () => ({ path: wt }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.cursor.wired, 1);
    assert.match(body.cursor.error, /other\/install\.sh/);
    assert.deepEqual((await readProvisionRecord(wt)).cursor.packs, ['hektor', 'other'], 'a pack whose replay failed is still installed at its old version — do not forget it');
    assert.ok(ctx.journal.entries.some((e) => /cursor adapter NOT wired for /.test(e.cmd)));
  } finally { await cleanup(); }
});

test('/api/worktree/scope: reports the Cursor axis next to the Claude one', async () => {
  const wt = await tmp('forest-scope-');
  try {
    let res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/scope' }, res, submitCtx(), async () => ({ path: wt }));
    assert.deepEqual(JSON.parse(res.body).cursor, { active: 0, missing: [], file: null });
    await mkdir(join(wt, '.cursor'), { recursive: true });
    await writeFile(join(wt, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: './.cursor/hooks/gone.sh', timeout: 10 }] } }));
    res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/scope' }, res, submitCtx(), async () => ({ path: wt }));
    const body = JSON.parse(res.body);
    assert.equal(typeof body.active, 'number', 'the Claude fields are untouched');
    assert.deepEqual(body.cursor, {
      active: 0,
      missing: [{ event: 'beforeShellExecution', command: './.cursor/hooks/gone.sh', file: join(wt, '.cursor', 'hooks', 'gone.sh') }],
      file: join(wt, '.cursor', 'hooks.json'),
    });
  } finally { await rm(wt, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run** `node --test lib/actions.test.mjs` — Expected: the five new tests FAIL (`body.cursor` undefined).

- [ ] **Step 3: Implement**

(a) `/api/worktree/scope`:

```js
      if (url === '/api/worktree/scope') {
        const { path } = body;
        const s = await resolveSessionScope(path);
        const cs = await resolveCursorScope(path);
        return sendJson(res, {
          active: s.active.length,
          inline: s.inline.length,
          sources: s.sources,
          missing: s.missing.map((h) => ({ command: h.command, source: h.source, file: h.file })),
          // The Cursor axis, for the picker's Cursor CLI mode. `file: null`
          // means there is no .cursor/hooks.json at all — Start installs it.
          cursor: { active: cs.active.length, missing: cs.missing.map((h) => ({ event: h.event, command: h.command, file: h.file })), file: cs.file },
        });
      }
```

(b) `/api/worktree/repair`:

```js
      if (url === '/api/worktree/repair') {
        const { path } = body;
        const rec = await readProvisionRecord(path);
        if (!rec || !Array.isArray(rec.selections) || !rec.selections.length) {
          return sendJson(res, { error: 'no provision record' }, 409);
        }
        // refresh: a repair replay means "bring this worktree up to date with
        // the current pack sources" — stale vendored copies are updated, not
        // reported as conflicts on every click (same-run cross-kit collisions
        // still are; see copyTree's overwrite contract).
        const provisioned = await runSelections({ ctx, path, selections: rec.selections, mode, refresh: true });
        // The Cursor axis replays from the record's own `cursor.packs`. A
        // worktree wired before that slot existed has a .cursor/hooks.json
        // and no record of it: replay every recorded pack that ships an
        // install.sh, and the record write inside wireCursorAxis backfills
        // the slot for next time.
        let cursorPacks = Array.isArray(rec.cursor?.packs) ? rec.cursor.packs.filter((p) => safeId(p)) : [];
        if (!cursorPacks.length && await stat(join(path, '.cursor', 'hooks.json')).then(() => true, () => false)) {
          cursorPacks = await packsWithInstaller(ctx.config.packsDir, rec.selections.map((s) => s.pack));
        }
        let cursor = null;
        if (cursorPacks.length) {
          const w = await wireCursorAxis({ ctx, path, packs: cursorPacks, mode, label: worktreeTitle(path) });
          cursor = { wired: w.wired.length, ...(w.error ? { error: w.error } : {}) };
        }
        const scope = await resolveSessionScope(path);
        ctx.journal.add({
          cmd: `repair: re-provisioned ${provisioned.kits.length} kit(s); missing ${scope.missing.length}`
            + (cursor ? `; cursor axis: ${cursor.wired}/${cursorPacks.length} pack(s) re-wired` : ''),
          cwd: path, mode,
        });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { ok: true, provisioned, scope: { active: scope.active.length, missing: scope.missing.length }, cursor });
      }
```

- [ ] **Step 4: Run** `node --test lib/actions.test.mjs` — Expected: PASS. Then `node --test` — PASS. No commit.

---

### Task 9: `public/agent-choice.js` — the pure half of the UI

The two toggles, the Start labels, the scope line and the launch/repair toasts
are all string logic keyed on `agent`. Keeping them in a DOM-free module means
`node --test` covers them (the spec listed the UI as manual-only; this pulls
the string half under test — the click wiring in Tasks 10–11 stays manual).
Same shape as `public/prompt.js` + `public/prompt.test.mjs`, which `node --test`
already discovers.

**Files:**
- Create: `public/agent-choice.js`
- Test: `public/agent-choice.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks. Toast helpers read the `/api/launch`
  response of Task 7 (`{ ok, action, agent, provisioned, scope: { active, missing: [] }, cursorAdapter?: { error } }`)
  and the `/api/worktree/repair` response of Task 8 (`{ scope: { active: n, missing: n }, cursor: { wired, error? } | null }`),
  and the `/api/worktree/scope` response of Task 8 (`{ active, missing: [], sources: [], cursor: { active, missing: [], file } }`).
- Produces (all named exports, used by Tasks 10 and 11):
  - `DEFAULT_AGENT = 'cursor'`
  - `coerceAgent(value) → 'claude' | 'cursor'` — `'claude'` only for the exact string, everything else (null, garbage) → `'cursor'`.
  - `agentLabel(agent) → 'Cursor CLI' | 'Claude'` — `'cursor'` → `'Cursor CLI'`, anything else → `'Claude'`. (Opposite default on purpose: `coerceAgent` names a *preference* whose default is Cursor; `agentLabel` names what a server response *said*, and a response without `agent` is a Claude one.)
  - `agentKey(path) → 'forest-agent:<path>'`
  - `loadAgent(storage, path) → 'claude' | 'cursor'`; `saveAgent(storage, path, agent)` — both swallow storage exceptions.
  - `scopeLine(agent, scope) → { text, warn }`
  - `startLabel(agent, selectedCount) → string`
  - `ticketStartLabel({ launchTarget, agent, ticketCount }) → string`
  - `launchToast(r, lead = '') → string`
  - `repairToast(r) → string`

- [ ] **Step 1: Write the failing tests** — create `public/agent-choice.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENT, coerceAgent, agentLabel, agentKey, loadAgent, saveAgent,
  scopeLine, startLabel, ticketStartLabel, launchToast, repairToast,
} from './agent-choice.js';

// A localStorage stand-in: the same two methods, nothing else.
function memStorage(items = {}) {
  return {
    items,
    getItem(k) { return Object.hasOwn(items, k) ? items[k] : null; },
    setItem(k, v) { items[k] = String(v); },
  };
}
const throwing = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('SecurityError'); },
};

test('coerceAgent: only the exact string "claude" is Claude; the default is cursor', () => {
  assert.equal(DEFAULT_AGENT, 'cursor');
  assert.equal(coerceAgent('claude'), 'claude');
  assert.equal(coerceAgent('cursor'), 'cursor');
  assert.equal(coerceAgent(null), 'cursor');
  assert.equal(coerceAgent('gemini'), 'cursor');
  assert.equal(coerceAgent('Claude'), 'cursor');
});

test('agentLabel: cursor → "Cursor CLI", everything else (including a missing field) → Claude', () => {
  assert.equal(agentLabel('cursor'), 'Cursor CLI');
  assert.equal(agentLabel('claude'), 'Claude');
  assert.equal(agentLabel(undefined), 'Claude');
});

test('loadAgent/saveAgent: one key per worktree path, restore defaults to cursor, storage errors are swallowed', () => {
  const s = memStorage();
  assert.equal(agentKey('/wt/a'), 'forest-agent:/wt/a');
  assert.equal(loadAgent(s, '/wt/a'), 'cursor');
  saveAgent(s, '/wt/a', 'claude');
  assert.equal(s.items['forest-agent:/wt/a'], 'claude');
  assert.equal(loadAgent(s, '/wt/a'), 'claude');
  assert.equal(loadAgent(s, '/wt/b'), 'cursor');
  saveAgent(s, '/wt/b', 'nonsense');
  assert.equal(s.items['forest-agent:/wt/b'], 'cursor');
  assert.equal(loadAgent(throwing, '/wt/a'), 'cursor');
  assert.doesNotThrow(() => saveAgent(throwing, '/wt/a', 'claude'));
});

test('scopeLine: Claude keeps the settings-source wording, missing hooks warn', () => {
  const clean = { active: 5, missing: [], sources: ['a', 'b'], cursor: { active: 0, missing: [], file: null } };
  assert.deepEqual(scopeLine('claude', clean), { text: '5 hooks active · 2 settings source(s)', warn: false });
  const broken = { ...clean, missing: [{ command: 'x' }] };
  assert.deepEqual(scopeLine('claude', broken), { text: '5 hooks active · 1 missing', warn: true });
});

test('scopeLine: Cursor reads the cursor block; no hooks.json says Start installs it', () => {
  const none = { active: 5, missing: [], sources: ['a'], cursor: { active: 0, missing: [], file: null } };
  assert.deepEqual(scopeLine('cursor', none), { text: 'no .cursor/ yet — Start installs it', warn: false });
  const wired = { ...none, cursor: { active: 18, missing: [], file: '/wt/.cursor/hooks.json' } };
  assert.deepEqual(scopeLine('cursor', wired), { text: '18 Cursor gates active', warn: false });
  const gap = { ...none, cursor: { active: 17, missing: [{ event: 'preToolUse', command: './.cursor/hooks/x.sh', file: '/wt/.cursor/hooks/x.sh' }], file: '/wt/.cursor/hooks.json' } };
  assert.deepEqual(scopeLine('cursor', gap), { text: '17 Cursor gates active · 1 missing', warn: true });
  // A scope response from before the cursor block existed must not throw.
  assert.deepEqual(scopeLine('cursor', { active: 5, missing: [], sources: [] }), { text: 'no .cursor/ yet — Start installs it', warn: false });
});

test('startLabel and ticketStartLabel name the agent; the Cursor-app target keeps its worktree wording', () => {
  assert.equal(startLabel('cursor', 0), 'Start Cursor CLI');
  assert.equal(startLabel('cursor', 3), 'Provision & start Cursor CLI');
  assert.equal(startLabel('claude', 1), 'Provision & start Claude');
  assert.equal(ticketStartLabel({ launchTarget: 'terminal', agent: 'cursor', ticketCount: 1 }), 'Start ticket session (Cursor CLI)');
  assert.equal(ticketStartLabel({ launchTarget: 'terminal', agent: 'claude', ticketCount: 2 }), 'Start multi-ticket session (Claude)');
  assert.equal(ticketStartLabel({ launchTarget: 'cursor', agent: 'claude', ticketCount: 1 }), 'Create worktree + open Cursor');
  assert.equal(ticketStartLabel({ launchTarget: 'cursor', agent: 'cursor', ticketCount: 3 }), 'Create 3 worktrees + open Cursor');
});

test('launchToast: keyed on r.agent, keeps the provisioning prefix and the lead', () => {
  const base = { ok: true, action: 'launched', agent: 'cursor', provisioned: { skills: [], kits: [], hooks: false, conflicts: [] }, scope: { active: 18, missing: [] } };
  assert.equal(launchToast(base), 'Launching Cursor CLI…');
  assert.equal(launchToast({ ...base, agent: 'claude' }), 'Launching Claude…');
  assert.equal(launchToast(base, '2 ticket(s) · '), '2 ticket(s) · Launching Cursor CLI…');
  const prov = { ...base, provisioned: { skills: ['a', 'b'], kits: ['k'], hooks: true, conflicts: [] } };
  assert.equal(launchToast(prov), '2 skill(s), 1 kit(s), gates · Launching Cursor CLI…');
  assert.equal(launchToast({ ...base, provisioned: null }), 'Launching Cursor CLI…');
});

test('launchToast: focused names the agent that is actually running; missing gates use the agent\'s noun', () => {
  const base = { ok: true, action: 'launched', agent: 'cursor', provisioned: null, scope: { active: 1, missing: [] } };
  assert.equal(launchToast({ ...base, action: 'focused', agent: 'claude' }), 'Claude already running — Terminal brought to front');
  assert.equal(launchToast({ ...base, action: 'focused' }), 'Cursor CLI already running — Terminal brought to front');
  assert.equal(
    launchToast({ ...base, scope: { active: 1, missing: [{ command: 'x' }, { command: 'y' }] } }),
    'Launching Cursor CLI — 2 Cursor gate script(s) missing',
  );
  assert.equal(
    launchToast({ ...base, agent: 'claude', scope: { active: 1, missing: [{ command: 'x' }] } }),
    'Launching Claude — 1 registered hook script(s) missing',
  );
});

test('launchToast: a failed Cursor axis is appended, never silent', () => {
  const r = { ok: true, action: 'launched', agent: 'cursor', provisioned: null, scope: { active: 0, missing: [] }, cursorAdapter: { error: 'hektor: install.sh exited 1' } };
  assert.equal(launchToast(r), 'Launching Cursor CLI… — Cursor gates NOT wired: hektor: install.sh exited 1');
  assert.equal(launchToast({ ...r, cursorAdapter: { error: null } }), 'Launching Cursor CLI…');
});

test('repairToast: the Cursor axis is reported when it ran, in either direction', () => {
  const scope = { active: 5, missing: 1 };
  assert.equal(repairToast({ scope, cursor: null }), 'Refreshed · 5 hooks active, 1 missing — restart any session already running here');
  assert.equal(repairToast({ scope, cursor: { wired: 2 } }), 'Refreshed · 5 hooks active, 1 missing · Cursor gates re-wired (2 pack(s)) — restart any session already running here');
  assert.equal(repairToast({ scope, cursor: { wired: 0, error: 'hektor: install.sh timed out' } }), 'Refreshed · 5 hooks active, 1 missing · Cursor axis NOT re-wired: hektor: install.sh timed out — restart any session already running here');
});
```

- [ ] **Step 2: Run** `node --test public/agent-choice.test.mjs` — Expected: FAIL, `Cannot find module './agent-choice.js'`.

- [ ] **Step 3: Implement** — create `public/agent-choice.js`:

```js
// public/agent-choice.js — the pure half of the Claude / Cursor CLI choice:
// the stored preference, and every string the picker, the Tickets modal and
// the toasts derive from an agent. No DOM here, so agent-choice.test.mjs
// runs it under node the way prompt.test.mjs runs prompt.js.
//
// Two different defaults, on purpose:
//   coerceAgent  names a PREFERENCE — nothing saved yet means Cursor CLI,
//                the harness the team moved to.
//   agentLabel   names what a server RESPONSE said — a response with no
//                `agent` field predates this feature and was a Claude launch.

export const DEFAULT_AGENT = 'cursor';

export function coerceAgent(value) { return value === 'claude' ? 'claude' : 'cursor'; }
export function agentLabel(agent) { return agent === 'cursor' ? 'Cursor CLI' : 'Claude'; }
export const agentKey = (path) => `forest-agent:${path}`;

// `storage` is passed in (localStorage in the browser) rather than read from
// a global, so the tests hand in a plain object and a throwing one.
export function loadAgent(storage, path) {
  try { return coerceAgent(storage.getItem(agentKey(path))); } catch { return DEFAULT_AGENT; }
}
export function saveAgent(storage, path, agent) {
  try { storage.setItem(agentKey(path), coerceAgent(agent)); } catch { /* storage unavailable: the choice just does not persist */ }
}

// The picker's scope line, keyed on the agent that will run: the Claude
// numbers come from settings.json, the Cursor numbers from .cursor/hooks.json.
// `scope` is the /api/worktree/scope response; its `cursor` block may be
// absent on a server that predates it.
export function scopeLine(agent, scope) {
  if (agent === 'cursor') {
    const c = scope.cursor || { active: 0, missing: [], file: null };
    if (!c.file) return { text: 'no .cursor/ yet — Start installs it', warn: false };
    const missing = (c.missing || []).length;
    return { text: `${c.active} Cursor gates active${missing ? ` · ${missing} missing` : ''}`, warn: missing > 0 };
  }
  const missing = (scope.missing || []).length;
  return {
    text: missing
      ? `${scope.active} hooks active · ${missing} missing`
      : `${scope.active} hooks active · ${(scope.sources || []).length} settings source(s)`,
    warn: missing > 0,
  };
}

export function startLabel(agent, selectedCount) {
  return selectedCount ? `Provision & start ${agentLabel(agent)}` : `Start ${agentLabel(agent)}`;
}

// The Tickets modal's Start button. The Cursor-app target creates git
// worktrees and branches, so its label keeps saying so; the Terminal target
// names the agent it will run in the primary checkout.
export function ticketStartLabel({ launchTarget, agent, ticketCount }) {
  if (launchTarget === 'cursor') {
    return ticketCount > 1 ? `Create ${ticketCount} worktrees + open Cursor` : 'Create worktree + open Cursor';
  }
  const who = agentLabel(agent);
  return ticketCount > 1 ? `Start multi-ticket session (${who})` : `Start ticket session (${who})`;
}

// Everything a launch response carries that is worth saying: what was
// provisioned, what gates are still missing, and — Cursor only — whether the
// pack's install.sh failed to land the gates. `lead` is an optional prefix
// for callers with more context than the picker (the Tickets modal names how
// many tickets went into the prompt).
export function launchToast(r, lead = '') {
  const name = agentLabel(r.agent);
  if (r.action === 'focused') return `${name} already running — Terminal brought to front`;
  const prov = r.provisioned;
  const provMsg = prov && (prov.skills.length || prov.kits.length || prov.hooks)
    ? `${prov.skills.length} skill(s)${prov.kits.length ? `, ${prov.kits.length} kit(s)` : ''}${prov.hooks ? ', gates' : ''} · ` : '';
  const adapter = r.cursorAdapter && r.cursorAdapter.error ? ` — Cursor gates NOT wired: ${r.cursorAdapter.error}` : '';
  const miss = r.scope && r.scope.missing ? r.scope.missing.length : 0;
  if (!miss) return `${lead}${provMsg}Launching ${name}…${adapter}`;
  const noun = r.agent === 'cursor' ? 'Cursor gate script(s)' : 'registered hook script(s)';
  return `${lead}${provMsg}Launching ${name} — ${miss} ${noun} missing${adapter}`;
}

// The ↻ toast. The restart reminder is part of the result, not decoration:
// hook config is snapshotted at session start, so a session already running
// here keeps exec'ing whatever it loaded.
export function repairToast(r) {
  const cur = !r.cursor ? ''
    : r.cursor.error ? ` · Cursor axis NOT re-wired: ${r.cursor.error}`
      : ` · Cursor gates re-wired (${r.cursor.wired} pack(s))`;
  return `Refreshed · ${r.scope.active} hooks active, ${r.scope.missing} missing${cur} — restart any session already running here`;
}
```

Note one deliberate change from today's `reportLaunched`: a `focused`
response wins over a non-empty `scope.missing`. Today's code says "Launching
Claude — N missing" for a launch that did not happen; nothing was launched,
so the focused sentence is the true one.

- [ ] **Step 4: Run** `node --test public/agent-choice.test.mjs` — Expected: PASS (10 tests). Then `node --test` — PASS. No commit.

---

### Task 10: The picker — toggle, note, labels, scope line, and every launch call site in `app.js`

DOM code; this repo has no browser test harness, so the wiring is checked by
hand in Task 12. Every string decision already lives in Task 9's module —
this task only wires clicks and responses to it.

**Files:**
- Modify: `public/index.html:101-112` (the `#picker` card)
- Modify: `public/style.css:534-536` (share the toggle styles) and append two rules
- Modify: `public/app.js:1` (import), `:109` (▶ title), `:511` (continue-int), `:548` (repair toast), `:556` (⚡ task), `:738-760` (picker state), `:826-859` (openPicker / updatePickerCount / refreshPickerScope), `:898-906` (reportLaunched), `:916`, `:937`, `:998` (the three `/api/launch` calls), `:1126-1132` (wireEvents)

**Interfaces:**
- Consumes: Task 9's exports; Task 7's `/api/launch` (`agent` in the body) and `/api/task` (`agent` in the body); Task 8's `/api/worktree/scope` (`cursor` block) and `/api/worktree/repair` (`cursor` field).
- Produces: `openPicker(path)` now restores the saved agent (unchanged signature — `tickets.js` calls it via `D.openPicker`); `reportLaunched(r, lead)` unchanged signature (still handed to `initTickets`); `initTickets` deps gain nothing — Task 11 imports `agent-choice.js` directly, the seam stays one-way.

- [ ] **Step 1: Markup** — in `public/index.html`, replace the picker card's heading and add the agent row between `#pk-sub` and `#pk-body`:

```html
  <div id="picker" class="modal hidden">
    <div class="modal-card picker-card">
      <h3>Start a session</h3>
      <p class="picker-sub" id="pk-sub"></p>
      <div class="pk-agent-row">
        <span class="tk-dim">Agent:</span>
        <div class="pk-agent" role="group" aria-label="Agent">
          <button id="pk-agent-claude" class="pk-agent-btn" type="button" data-agent="claude">Claude</button>
          <button id="pk-agent-cursor" class="pk-agent-btn on" type="button" data-agent="cursor">Cursor CLI</button>
        </div>
        <p id="pk-agent-note" class="tk-dim pk-agent-note">Cursor CLI installs each selected pack whole under <code>.cursor/</code> (via its own install.sh) — the checkboxes below shape <code>.claude/</code> only, which cursor-agent does not read.</p>
      </div>
      <div id="pk-body" class="pk-body"></div>
      <div class="modal-actions">
        <span id="pk-count" class="pk-count"></span>
        <span id="pk-scope" class="pk-scope"></span>
        <button id="pk-cancel" class="btn-ghost">Cancel</button>
        <button id="pk-start" class="btn-accent">Start Cursor CLI</button>
      </div>
    </div>
  </div>
```

(`Cursor CLI` starts `.on` and `#pk-start` starts as `Start Cursor CLI` so the
static markup matches the default `setPickerAgent` will restore; both are
overwritten on every open anyway.)

- [ ] **Step 2: Styles** — in `public/style.css`, widen the two toggle rules so all three button groups share them, and add the picker row rules right after `.tk-target-note`:

```css
.tk-target-btn, .tk-agent-btn, .pk-agent-btn { padding: 5px 11px; border: 1px solid var(--line); background: var(--bg); color: var(--muted); border-radius: 8px; cursor: pointer; font: 12px var(--font-ui); }
.tk-target-btn.on, .tk-agent-btn.on, .pk-agent-btn.on { border-color: var(--accent); color: var(--accent); background: var(--accent-weak); }
.tk-target-note { margin: 0; flex: 1 1 260px; font-size: 11.5px; }
.tk-agent { display: flex; gap: 6px; flex: none; }
.pk-agent-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 12px; }
.pk-agent { display: flex; gap: 6px; flex: none; }
.pk-agent-note { margin: 0; flex: 1 1 260px; font-size: 11.5px; }
```

(`.tk-agent` is used by Task 11; declaring it here keeps all the toggle CSS in one edit.)

- [ ] **Step 3: Import and the two one-line call sites** — in `public/app.js`:

Line 1:
```js
import { initTickets, openTickets, closeTickets } from './tickets.js';
import { loadAgent, saveAgent, scopeLine, startLabel, launchToast, repairToast } from './agent-choice.js';
```

Line 109 — the ▶ button's title:
```js
      <button title="Launch a session" data-act="launch" data-path="${enc}">▶</button>
```

Line 511 — "Continue interactively" sends the remembered agent (today it sends `{ path }` only, which would always be Claude):
```js
  if (c) c.onclick = () => api('/api/launch', { path, agent: loadAgent(localStorage, path) });
```

Line 548 — the repair toast (replace the whole `toast(...)` line; the comment above it stays):
```js
      toast(repairToast(r));
```

Line 556 — the ⚡ task sends the agent (guided mode launches interactively; auto mode is Claude-only server-side and ignores it):
```js
    await api('/api/task', { path, prompt, mode: state.mode, agent: loadAgent(localStorage, path) });
```

- [ ] **Step 4: Picker state and the agent toggle** — replace the picker header block at `app.js:739-740` and the three functions `openPicker` / `updatePickerCount` / `refreshPickerScope` (`:826-859`) with:

```js
// ---- skill/kit picker (shown before launching a session) ----
let pickerPath = null;
// Which agent Start launches. Restored per worktree on open from
// forest-agent:<path> (Task 9's loadAgent), written on click.
let pickerAgent = 'cursor';
// refreshPickerScope is async and the toggle can be clicked (or the picker
// re-opened on another row) while a fetch is in flight; the token lets the
// stale response drop instead of painting the previous agent's line.
let scopeToken = 0;
```

(keep the existing `skillKey` / `loadSel` / `saveSel` / `groupLabel` lines that follow)

```js
function openPicker(path) {
  const w = findWorktree(path);
  if (!w) return;
  pickerPath = path;
  $('#pk-sub').textContent = `${w.repo} · ${w.branch || '(detached)'}`;
  const sel = loadSel(path);
  $('#pk-body').innerHTML = state.packs.length
    ? state.packs.map((p) => renderPack(p, sel[p.pack] || {})).join('')
    : `<p class="pk-empty">No skill packs found in <code>SKLS/</code>. The session will start with no extra skills.</p>`;
  $('#picker').classList.remove('hidden');
  syncMasters();
  // Restores the saved agent, relabels Start and fetches the scope line for
  // that agent — the same three things a toggle click does. persist: false —
  // reading what was last chosen must not immediately write it back.
  setPickerAgent(loadAgent(localStorage, path), { persist: false });
}
function closePicker() { $('#picker').classList.add('hidden'); pickerPath = null; }
function setPickerAgent(agent, { persist = true } = {}) {
  pickerAgent = agent === 'claude' ? 'claude' : 'cursor';
  document.querySelectorAll('.pk-agent-btn').forEach((b) => b.classList.toggle('on', b.dataset.agent === pickerAgent));
  // The note only matters when the checkboxes will NOT be what the session
  // reads — i.e. Cursor CLI.
  $('#pk-agent-note').classList.toggle('hidden', pickerAgent !== 'cursor');
  if (persist && pickerPath) saveAgent(localStorage, pickerPath, pickerAgent);
  updatePickerCount();
  if (pickerPath) refreshPickerScope(pickerPath);
}
function updatePickerCount() {
  const n = document.querySelectorAll('#pk-body .pk-cb:checked').length;
  $('#pk-count').textContent = n ? `${n} selected` : 'none selected';
  $('#pk-start').textContent = startLabel(pickerAgent, n);
}
// What the session will load today — before provisioning anything. Makes the
// remaining ~/.claude inheritance visible instead of implicit; for Cursor CLI
// it reads the .cursor/hooks.json block instead.
async function refreshPickerScope(path) {
  const el = $('#pk-scope');
  el.textContent = '';
  el.classList.remove('warn');
  const token = ++scopeToken;
  const s = await api('/api/worktree/scope', { path });
  if (token !== scopeToken || pickerPath !== path) return;
  if (!s || s.error || !s.sources) return;
  const line = scopeLine(pickerAgent, s);
  el.textContent = line.text;
  if (line.warn) el.classList.add('warn');
}
```

- [ ] **Step 5: `reportLaunched` and the three launch calls** — replace the body of `reportLaunched` (`app.js:898-906`; keep its comment block):

```js
function reportLaunched(r, lead = '') {
  toast(launchToast(r, lead));
  reportConflicts(r.provisioned);
}
```

Then add `agent: pickerAgent` to all three `/api/launch` calls in `startSession`:

`:916`
```js
  const r = await api('/api/launch', { path, selections, mode: state.mode, agent: pickerAgent });
```
`:937` (the missing-hooks forced retry — Claude-only path, but the agent still travels so the server's validation and journal line stay uniform)
```js
    const forced = await api('/api/launch', { path, selections: [], mode: state.mode, agent: pickerAgent, force: true });
```
`:998` (the orphaned-units forced retry)
```js
      const forced = await api('/api/launch', { path, selections, mode: state.mode, agent: pickerAgent, force: true });
```

The missing-hooks `confirm` text at `:930` (`Launch Claude with …`) stays as is — the server only returns `blocked: 'missing-hooks'` for `agent: 'claude'` (Task 7), so the string is correct.

- [ ] **Step 6: Wire the toggle** — in `wireEvents` right after `$('#pk-start').onclick = startSession;` (`app.js:1127`):

```js
  document.querySelectorAll('.pk-agent-btn').forEach((b) => { b.onclick = () => setPickerAgent(b.dataset.agent); });
```

- [ ] **Step 7: Syntax check and the suite** — `node --check public/app.js` — Expected: no output. `node --test` — Expected: PASS (nothing here is under test, so this only proves the import graph still loads for `prompt.test.mjs` / `agent-choice.test.mjs`). Then a quick browser check: `node server.mjs`, open the app, click ▶ on any row — heading reads "Start a session", the toggle shows Cursor CLI on with the note visible, `#pk-start` reads "Start Cursor CLI", the scope line reads "no .cursor/ yet — Start installs it" (or the gate count if that worktree already has one); click Claude — note hides, button reads "Start Claude", scope line switches to the hooks wording; close and re-open the same row — Claude is still selected; open a different row — Cursor CLI again. Do NOT click Start yet; that is Task 12. No commit.

---

### Task 11: The Tickets modal — agent sub-toggle, "Cursor app" relabel, agent in the launch calls

**Files:**
- Modify: `public/index.html:134-140` (the `.tk-target-row`)
- Modify: `public/tickets.js:8` (import), `:24-29` (state), `:48` (init wiring), `:89-91` (restore on open), `:460-492` (`setLaunchTarget` / `renderFooter`), `:518-523` (`startTerminal`), `:603` (confirm text), `:641-643` (`forceLaunch`)

**Interfaces:**
- Consumes: Task 9's `loadAgent`, `saveAgent`, `agentLabel`, `ticketStartLabel`; Task 7's `/api/launch` `agent` field. Task 10's CSS (`.tk-agent`, `.tk-agent-btn`, `.tk-agent-btn.on`).
- Produces: nothing new for later tasks.

Why a separate `.tk-agent-btn` class rather than reusing `.tk-target-btn`:
`initTickets` wires every `.tk-target-btn` click to `setLaunchTarget(b.dataset.target)`,
and `setLaunchTarget` toggles `.on` across all `.tk-target-btn`. Reusing the
class would make the agent buttons flip the launch target.

- [ ] **Step 1: Markup** — replace the `.tk-target-row` block in `public/index.html`:

```html
      <div class="tk-target-row">
        <div class="tk-target" role="group" aria-label="Launch target">
          <button id="tk-target-terminal" class="tk-target-btn on" type="button" data-target="terminal">Terminal</button>
          <button id="tk-target-cursor" class="tk-target-btn" type="button" data-target="cursor">Cursor app</button>
        </div>
        <div id="tk-agent" class="tk-agent" role="group" aria-label="Agent">
          <button class="tk-agent-btn" type="button" data-agent="claude">Claude</button>
          <button class="tk-agent-btn on" type="button" data-agent="cursor">Cursor CLI</button>
        </div>
        <p class="tk-dim tk-target-note">Terminal: one session in the primary checkout, seeded with the prompt — Claude reads the ticked skills under .claude/; Cursor CLI installs the selected packs under .cursor/ and reads those. Cursor app: one worktree + branch per ticket, then one Cursor window; Hektor skills + the PR-rules gate come across, multi-ticket fan-out and the Agent-matcher gates (reviewer-brief, dispatch-ordering, schema-preread, attestation, return-schema) do not — tickets run one at a time.</p>
      </div>
```

`data-target="cursor"` and the stored `forest-launch-target:<repoPath>` value are
untouched — only the visible label changes. Renaming the value would reset
every repo's remembered target to Terminal (`setLaunchTarget` coerces unknowns).
The note does not claim the Agent-matcher gates come across on the CLI:
whether `cursor-agent` fires `subagentStart` hooks is unverified.

- [ ] **Step 2: Import and state** — `public/tickets.js`:

Line 8:
```js
import { composeTicketPrompt } from './prompt.js';
import { loadAgent, saveAgent, agentLabel, ticketStartLabel } from './agent-choice.js';
```

After line 24 (`let launchTarget = 'terminal';`):
```js
let agent = 'cursor';                           // 'claude' | 'cursor' — Terminal target only; persisted per primary checkout, see setAgent()
```

- [ ] **Step 3: Wire the buttons and restore on open** — after line 48 (the `.tk-target-btn` wiring in `initTickets`):

```js
  document.querySelectorAll('.tk-agent-btn').forEach((b) => { b.onclick = () => setAgent(b.dataset.agent); });
```

In `openTickets`, right after the `setLaunchTarget(savedTarget, { persist: false });` line (`:91`):

```js
  // The picker's key, on purpose: forest-agent:<primaryPath> is exactly the
  // path startTerminal() launches in, the same way savedSelections() shares
  // the picker's forest-skills:<primaryPath>. One preference, two surfaces.
  setAgent(loadAgent(localStorage, t.primaryPath), { persist: false });
```

- [ ] **Step 4: `setLaunchTarget`, `setAgent`, `renderFooter`** — replace `setLaunchTarget` and `renderFooter` (`tickets.js:460-492`) with:

```js
function setLaunchTarget(value, { persist = true } = {}) {
  launchTarget = value === 'cursor' ? 'cursor' : 'terminal';
  document.querySelectorAll('.tk-target-btn').forEach((b) => b.classList.toggle('on', b.dataset.target === launchTarget));
  // The agent sub-toggle only means something for Terminal — the Cursor-app
  // target opens the GUI, which runs neither CLI.
  $('#tk-agent').classList.toggle('hidden', launchTarget === 'cursor');
  if (persist && target) localStorage.setItem(launchTargetKey(target.repoPath), launchTarget);
  renderFooter();
}

// Same contract as setLaunchTarget: `persist: false` is the restore-on-open
// path and must not re-write the value it just read.
function setAgent(value, { persist = true } = {}) {
  agent = value === 'claude' ? 'claude' : 'cursor';
  document.querySelectorAll('.tk-agent-btn').forEach((b) => b.classList.toggle('on', b.dataset.agent === agent));
  if (persist && target) saveAgent(localStorage, target.primaryPath, agent);
  renderFooter();
}

function renderFooter() {
  const tickets = [...pickedTickets];
  const boxes = [...pickedBoxes];
  renderSkills();
  // Composed only while the textarea is still forest's to write. Once the user
  // has corrected it — the box label boxLabel() deliberately passes through
  // uncorrected is exactly what they would be correcting — the next checkbox
  // click must not silently throw that away. start() launches the textarea
  // either way.
  if (!promptDirty) {
    $('#tk-prompt').value = composeTicketPrompt({ tickets, boxes, jiraBaseUrl: D.state.config && D.state.config.jiraBaseUrl });
  }
  const ready = tickets.length > 0 && boxes.length > 0;
  $('#tk-start').disabled = !ready;
  // The label itself has to make the difference obvious before the click —
  // the Cursor-app path creates git worktrees and branches, the Terminal
  // path does not touch git at all and names the agent it will run.
  $('#tk-start').textContent = ticketStartLabel({ launchTarget, agent, ticketCount: tickets.length });
  $('#tk-count').textContent = !tickets.length ? 'pick at least one ticket'
    : !boxes.length ? 'pick at least one testbox'
      : launchTarget === 'cursor'
        ? `${tickets.length} ticket(s) · ${boxes.length} box(es) · creates ${tickets.length} git worktree(s) + branch(es) in ${target ? target.repo : 'this repo'}`
        : `${tickets.length} ticket(s) · ${boxes.length} box(es) · ${agentLabel(agent)}`;
}
```

- [ ] **Step 5: Send the agent** — `startTerminal` (`tickets.js:518-523`):

```js
  const r = await D.api('/api/launch', {
    path: target.primaryPath,
    selections,
    prompt,
    mode: D.state.mode,
    agent,
  });
```

`forceLaunch` (`:641-643`):
```js
  const forced = await D.api('/api/launch', {
    path: target.primaryPath, selections, prompt, mode: D.state.mode, agent, force: true,
  });
```

The missing-hooks confirm in `resolveBlock` (`:603`) — reachable for Claude only (Task 7), but key it anyway so the string can never lie if that changes:
```js
      `Launch ${agentLabel(agent)} in ${target.repo} with ${(r.missing || []).length} hook script(s) missing?\n\n`
```

Also update the comment above `startTerminal` (`:509-510`) — it says "one Claude session":
```js
// One session — Claude or Cursor CLI, per the agent sub-toggle — launched in
// a Terminal window in the primary checkout.
```

- [ ] **Step 6: Syntax check** — `node --check public/tickets.js` — Expected: no output. `node --test` — PASS. Browser: open the Tickets modal (🎫 on a repo) — the Terminal target shows the agent sub-toggle with Cursor CLI on; the count line (once a ticket and a box are picked) ends in "· Cursor CLI" and Start reads "Start ticket session (Cursor CLI)"; click Claude → "(Claude)"; click "Cursor app" → sub-toggle hides, Start reads "Create worktree + open Cursor"; back to Terminal → Claude still selected; close, open ▶ on that repo's primary checkout row → the picker also shows Claude (shared key). No commit.

---

### Task 12: Hand check end to end

No code. The spec's build-order item 8, plus the Tickets path. Do this on a
worktree of a repo that does **not** yet exclude `.cursor/` (check with
`grep -n cursor <repo>/.git/info/exclude` — for a linked worktree the shared
file is under the main checkout's `.git/`, e.g. `git -C <wt> rev-parse --git-common-dir`).
`cursor-agent` must be on PATH (`which cursor-agent`), or set `cursorAgentCmd`
in `config.json` to its absolute path.

- [ ] **Step 1: Cursor CLI from ▶** — `node server.mjs`, click ▶ on the worktree, leave Cursor CLI selected, tick the hektor pack (or leave the default ticks), click "Start Cursor CLI". Expected: a Terminal window opens running `cursor-agent` (no `--trust`; answer its own workspace-trust prompt if it shows one); toast reads "N skill(s), … · Launching Cursor CLI…"; `ls <wt>/.cursor` shows `hooks.json hooks/ skills/ agents/ rules/ schemas/`; `git -C <wt> status --short` does NOT list `.cursor/`; `grep -n '/.cursor/' $(git -C <wt> rev-parse --git-common-dir)/info/exclude` finds the line; `cat <wt>/.claude/.forest-provision.json` has `"cursor": { "packs": ["hektor"], "at": … }`; the journal (⌘ drawer / journal panel) has `cursor adapter wired for …`; the worktree row's Agent column shows `cursor`; `cat $TMPDIR/forest-sessions/<slug>.pid` is `<pid> cursor`.

- [ ] **Step 2: Focus, not a second launch** — click ▶ → "Start Cursor CLI" again. Expected: toast "Cursor CLI already running — Terminal brought to front", no second Terminal window. Switch the toggle to Claude and Start: same focused toast, still naming Cursor CLI (the lock's agent, not the requested one). Quit the cursor-agent session (Ctrl-C / exit); the lock file is gone.

- [ ] **Step 3: Scope + repair** — click ▶ again: scope line reads "18 Cursor gates active" (whatever the count is). Cancel. `rm <wt>/.cursor/hooks/<one gate>.sh`. ▶ again: scope line reads "… · 1 missing" in amber. Cancel. Click ↻ on the row. Expected: toast "Refreshed · A hooks active, M missing · Cursor gates re-wired (1 pack(s)) — restart …"; the deleted script is back; the journal has `cursor adapter wired for … (repair)`. ▶ again: "1 missing" gone.

- [ ] **Step 4: Claude still works** — ▶ → Claude → "Start Claude". Expected: Terminal runs `claude`; Agent column shows `claude`; lock file is `<pid> claude`; toast "Launching Claude…". Exit it.

- [ ] **Step 5: Nothing ticked** — ▶ → Cursor CLI → untick everything → "Start Cursor CLI". Expected: launches with no provisioning and no install.sh run (journal has no `cursor adapter` line for this launch). Exit it.

- [ ] **Step 6: Tickets modal** — 🎫 on the repo → Terminal target, Cursor CLI agent, pick one ticket + one box → "Start ticket session (Cursor CLI)". Expected: Terminal runs `cursor-agent '<the prompt>'` with the composed prompt visible in the session's first turn; toast "1 ticket(s) · … · Launching Cursor CLI…". Exit it. Repeat with Claude selected → `claude '<prompt>'`.

- [ ] **Step 7: Guided ⚡ and continue-interactively** — with Mode = guided, ⚡ on the row: Expected: the remembered agent (Cursor CLI if that is what the picker last saved for this path) opens in Terminal; journal line names `cursor-agent`. Exit. With Mode = auto, ⚡ with a trivial prompt runs headless Claude (`claude -p`) regardless of the agent — the drawer's "Continue interactively" then opens the remembered agent.

- [ ] **Step 8: Final** — `node --test` — PASS. `git status` — every change is uncommitted; hand the working tree back. No commit.

---

## Self-review

**Spec coverage** — every spec section has a task: Launcher → 1; Config → 2;
Agent column → 3; `resolveCursorScope` → 4; Provision record → 5; Route
`/api/launch` and `/api/task` → 7 (with `runCursorAdapterInstallDefault`,
`wireCursorAxis`, `recordWithout`, ticket-worktrees route → 6); Repair and the
scope `cursor` block → 8; Surface — the picker → 9 + 10; Surface — the
Tickets modal → 9 + 11; Failure modes → 400 (7), focused cross-agent (1, 7,
12.2), install failure non-blocking (6, 7), `ensureExcluded` failure
journalled (6), empty `sel` (7 test "empty selection + hooks.json"), missing
gate not blocking Cursor (7), `remove-units` carries `cursor` (6), bare-pid
lock (1); Build order 8 → 12. Non-goals untouched (no `--trust`, no auto
mode for Cursor, no `.claude/` changes for Cursor).

**Placeholder scan** — no TBD/TODO; every code step has its code; no "similar
to Task N" — Task 10 and 11 repeat the `{ persist }` contract in full.

**Type consistency** — `launchAgentSession({ worktreePath, agent, cmds, app, title, prompt, openImpl, focusImpl })` in Task 1 is what Task 3's `launchInteractive` and Task 7's route call; `readSessionLock(worktreePath)` → `{ pid, agent } | null` used by Task 3. `resolveCursorScope(worktreePath)` → `{ active, missing, file }` (Task 4) consumed by Tasks 7 and 8 and, via the scope route's `cursor` block, by Task 9's `scopeLine`. `wireCursorAxis({ ctx, path, packs, mode, label })` → `{ wired, error }` and `packsWithInstaller(packsDir, names)` → `string[]` (Task 6) used by Tasks 7 and 8. `agentCmds(config)` → `{ claude, cursor }`, `requestedAgent(body)`, `AGENT_ERROR` live in Task 7 only. Response fields: launch `{ ok, action, agent, provisioned, promptSent, scope, cursorAdapter? }` (7) ↔ `launchToast` (9); repair `{ ok, provisioned, scope: { active: n, missing: n }, cursor }` (8) ↔ `repairToast` (9); scope `{ …, cursor: { active, missing, file } }` (8) ↔ `scopeLine` (9). Storage key `forest-agent:<path>` is written by `saveAgent` only (9), read in 10 (`pickerPath`) and 11 (`target.primaryPath`).
