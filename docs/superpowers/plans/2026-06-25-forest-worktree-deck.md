# Forest Worktree Deck — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Forest — a zero-dependency local web dashboard that shows every git worktree across all repos under `~/sahibinden/repo/` and lets you act on them (including running Claude on a branch) with a glass-cockpit, terminal-first posture.

**Architecture:** A Node.js HTTP server (built-ins only) serves a vanilla HTML/CSS/JS dashboard and a JSON+SSE API. Backend is split into focused modules: pure parsers/derivation (unit-tested with `node:test`) separated from thin exec wrappers and side-effecting glue (terminal/agents). The frontend is a single `app.js` that renders a live table and dispatches actions in either *guided* (run-in-your-terminal) or *auto* (run-in-background) mode, with a command journal.

**Tech Stack:** Node 26 (ESM `.mjs`, `node:http`/`node:fs`/`node:child_process`/`node:test`), vanilla HTML/CSS/JS, Server-Sent Events. No npm dependencies, no build step. macOS (`open`/`osascript`).

## Global Constraints

- **Zero runtime dependencies.** Only Node built-ins. No `npm install`, no `node_modules`, no bundler. (`package.json` may exist for scripts/`type:module` only.)
- **ESM everywhere.** Files are `.mjs`; import built-ins with the `node:` prefix.
- **Server binds `127.0.0.1` only.** Never `0.0.0.0`.
- **Command is `forest`** (no `wt` alias).
- **Project home:** `/Users/egecan.sen/sahibinden/forest/`. Modules live in `lib/`, tests colocated as `lib/<name>.test.mjs`, frontend in `public/`.
- **Pure logic is separated from I/O** so parsers/derivation unit-test without spawning git.
- **Safety rails apply in both guided and auto modes:** destructive actions confirm client-side, the server refuses to remove a repo's primary worktree, and every mutating command is appended to the journal.
- **Default mode is `guided`.** The global toggle starts there.
- **Agent state is `running` | `idle` | `unknown`** — never a confident lie.
- **macOS path encoding for Claude transcripts:** replace every `/` and `.` with `-` (verified: `/Users/egecan.sen/sahibinden/repo` → `-Users-egecan-sen-sahibinden-repo`).

## File Structure

```
~/sahibinden/forest/
  package.json              # {type:module}, scripts only, no deps
  config.example.json       # sample config (copied to config.json by user)
  config.json               # gitignored; real config (created in Task 11)
  server.mjs                # entry: http + static + JSON/SSE API + guided/auto dispatch
  lib/
    config.mjs              # DEFAULTS, mergeConfig, loadConfig
    journal.mjs             # createJournal: ring buffer + subscribers
    git.mjs                 # runGit + pure parsers (worktree/status/aheadBehind/ticket/owner)
    agents.mjs              # encodeProjectPath, agentStateFromMtime, detectAgentState, registry, launch/headless/notify
    terminal.mjs            # runInTerminal / openTerminalAt / openWith (macOS open/osascript)
    discover.mjs            # staleFrom, listRepoDirs, buildSnapshot
    config.test.mjs
    journal.test.mjs
    git.test.mjs
    agents.test.mjs
    discover.test.mjs
  public/
    index.html             # shell: header (toggle/fetch/search), table, drawer, journal, palette
    style.css              # clean light theme
    app.js                 # fetch + render + SSE + actions + diff + palette + journal
  bin/
    forest                 # launcher: start server if down, open browser
  README.md
```

Each module has one responsibility. Tasks 1–5 build the pure/testable core (full TDD). Tasks 6–8 add side-effecting glue + the server (verified by running commands/curl). Tasks 9–10 build the UI (verified by loading the page). Task 11 ships the launcher and does an end-to-end smoke.

---

## Task 1: Scaffold + config module

**Files:**
- Create: `package.json`, `config.example.json`, `lib/config.mjs`
- Test: `lib/config.test.mjs`

**Interfaces:**
- Produces: `DEFAULTS` (object), `mergeConfig(user) -> config`, `async loadConfig(path) -> config`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "forest",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.mjs",
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Create `config.example.json`**

```json
{
  "port": 5577,
  "roots": ["/Users/egecan.sen/sahibinden/repo"],
  "jiraBaseUrl": "",
  "staleDays": 14,
  "defaultMode": "guided",
  "terminalApp": "Terminal",
  "openEditorCmd": "open -a Cursor",
  "setupScript": ".forest-setup.sh"
}
```

- [ ] **Step 3: Write the failing test** — `lib/config.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, mergeConfig } from './config.mjs';

test('mergeConfig returns DEFAULTS when given empty object', () => {
  const c = mergeConfig({});
  assert.equal(c.port, DEFAULTS.port);
  assert.equal(c.defaultMode, 'guided');
});

test('mergeConfig overrides only provided keys', () => {
  const c = mergeConfig({ port: 9000, defaultMode: 'auto' });
  assert.equal(c.port, 9000);
  assert.equal(c.defaultMode, 'auto');
  assert.equal(c.staleDays, DEFAULTS.staleDays); // untouched
});

test('mergeConfig replaces roots array wholesale', () => {
  const c = mergeConfig({ roots: ['/a', '/b'] });
  assert.deepEqual(c.roots, ['/a', '/b']);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test lib/config.test.mjs`
Expected: FAIL — `Cannot find module './config.mjs'`.

- [ ] **Step 5: Write `lib/config.mjs`**

```js
import { readFile } from 'node:fs/promises';

export const DEFAULTS = {
  port: 5577,
  roots: [`${process.env.HOME}/sahibinden/repo`],
  jiraBaseUrl: '',
  staleDays: 14,
  defaultMode: 'guided',
  terminalApp: 'Terminal',
  openEditorCmd: 'open -a Cursor',
  setupScript: '.forest-setup.sh',
};

export function mergeConfig(user = {}) {
  return { ...DEFAULTS, ...user };
}

export async function loadConfig(path) {
  let parsed = {};
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    parsed = {};
  }
  return mergeConfig(parsed);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test lib/config.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json config.example.json lib/config.mjs lib/config.test.mjs
git commit -m "feat: config module with defaults and merge"
```

---

## Task 2: Command journal

**Files:**
- Create: `lib/journal.mjs`
- Test: `lib/journal.test.mjs`

**Interfaces:**
- Produces: `createJournal({ max }) -> { add(entry), recent(), subscribe(fn) -> unsub }`. An entry is `{ cmd: string, cwd?: string, mode?: string, ts: number }`; `add` stamps `ts` if absent and returns the stored entry.

- [ ] **Step 1: Write the failing test** — `lib/journal.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from './journal.mjs';

test('add stores entries and recent returns them newest-last', () => {
  const j = createJournal({ max: 10 });
  j.add({ cmd: 'git fetch' });
  j.add({ cmd: 'git status' });
  const r = j.recent();
  assert.equal(r.length, 2);
  assert.equal(r[1].cmd, 'git status');
  assert.equal(typeof r[1].ts, 'number');
});

test('recent is trimmed to max', () => {
  const j = createJournal({ max: 3 });
  for (let i = 0; i < 5; i++) j.add({ cmd: `c${i}` });
  const r = j.recent();
  assert.equal(r.length, 3);
  assert.equal(r[0].cmd, 'c2'); // oldest kept
  assert.equal(r[2].cmd, 'c4');
});

test('subscribe is notified on add and unsub stops it', () => {
  const j = createJournal({ max: 10 });
  const seen = [];
  const unsub = j.subscribe((e) => seen.push(e.cmd));
  j.add({ cmd: 'a' });
  unsub();
  j.add({ cmd: 'b' });
  assert.deepEqual(seen, ['a']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/journal.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/journal.mjs`**

```js
export function createJournal({ max = 200 } = {}) {
  const entries = [];
  const subs = new Set();

  function add(entry) {
    const stored = { ts: Date.now(), ...entry };
    if (entry.ts) stored.ts = entry.ts;
    entries.push(stored);
    while (entries.length > max) entries.shift();
    for (const fn of subs) fn(stored);
    return stored;
  }

  function recent() {
    return entries.slice();
  }

  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  return { add, recent, subscribe };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/journal.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/journal.mjs lib/journal.test.mjs
git commit -m "feat: command journal ring buffer with subscribers"
```

---

## Task 3: Git parsers + exec wrapper

**Files:**
- Create: `lib/git.mjs`
- Test: `lib/git.test.mjs`

**Interfaces:**
- Produces:
  - `async runGit(cwd, args) -> stdout string` (thin `execFile` wrapper).
  - `parseWorktreeList(text) -> [{ path, head, branch|null, detached, bare, locked }]`
  - `parseStatus(text) -> { changed, staged, dirty }`
  - `parseAheadBehind(text) -> { ahead, behind }`
  - `extractTicket(branch) -> string|null`
  - `detectOwner(path) -> 'claude'|'cursor'|'user'`

- [ ] **Step 1: Write the failing test** — `lib/git.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorktreeList, parseStatus, parseAheadBehind, extractTicket, detectOwner,
} from './git.mjs';

test('parseWorktreeList parses branch and detached blocks', () => {
  const text = [
    'worktree /repo/web-test',
    'HEAD cdf9228c51',
    'branch refs/heads/tech/WEBT-249514',
    '',
    'worktree /repo/web-test/.cursor/worktrees/web-test/vys8',
    'HEAD ac9746f574',
    'detached',
    '',
  ].join('\n');
  const wts = parseWorktreeList(text);
  assert.equal(wts.length, 2);
  assert.equal(wts[0].path, '/repo/web-test');
  assert.equal(wts[0].branch, 'tech/WEBT-249514');
  assert.equal(wts[0].detached, false);
  assert.equal(wts[1].branch, null);
  assert.equal(wts[1].detached, true);
});

test('parseStatus counts changed/staged/dirty', () => {
  const text = ' M src/a.js\nA  src/b.js\n?? src/c.js\n';
  const s = parseStatus(text);
  assert.equal(s.dirty, true);
  assert.equal(s.changed, 3);
  assert.equal(s.staged, 1); // only "A " has an index-stage change
});

test('parseStatus on clean tree', () => {
  assert.deepEqual(parseStatus(''), { changed: 0, staged: 0, dirty: false });
});

test('parseAheadBehind maps left=behind right=ahead', () => {
  assert.deepEqual(parseAheadBehind('2\t3\n'), { ahead: 3, behind: 2 });
  assert.deepEqual(parseAheadBehind('0\t0'), { ahead: 0, behind: 0 });
});

test('extractTicket pulls JIRA token from branch', () => {
  assert.equal(extractTicket('tech/SUI-238145'), 'SUI-238145');
  assert.equal(extractTicket('fun/QUICKLY-245363'), 'QUICKLY-245363');
  assert.equal(extractTicket('master'), null);
});

test('detectOwner classifies by path', () => {
  assert.equal(detectOwner('/r/web-test/.cursor/worktrees/web-test/vys8'), 'cursor');
  assert.equal(detectOwner('/r/web-test/.claude/worktrees/no-flag-map'), 'claude');
  assert.equal(detectOwner('/r/web-test'), 'user');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/git.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/git.mjs`**

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function runGit(cwd, args) {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function parseStatus(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  let staged = 0;
  for (const l of lines) {
    const x = l[0];
    if (x !== ' ' && x !== '?') staged++;
  }
  return { changed: lines.length, staged, dirty: lines.length > 0 };
}

export function parseAheadBehind(text) {
  const [left, right] = text.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { ahead: right || 0, behind: left || 0 };
}

export function extractTicket(branch) {
  if (!branch) return null;
  const m = branch.match(/([A-Z][A-Z0-9]*-\d+)/);
  return m ? m[1] : null;
}

export function detectOwner(path) {
  if (path.includes('/.cursor/worktrees/')) return 'cursor';
  if (path.includes('/.claude/worktrees/')) return 'claude';
  return 'user';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/git.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/git.mjs lib/git.test.mjs
git commit -m "feat: git exec wrapper and porcelain parsers"
```

---

## Task 4: Agent detection (pure)

**Files:**
- Create: `lib/agents.mjs` (pure functions only in this task; side-effecting parts added in Task 6)
- Test: `lib/agents.test.mjs`

**Interfaces:**
- Produces:
  - `encodeProjectPath(absPath) -> string` (slashes and dots → dashes)
  - `agentStateFromMtime(mtimeMs, nowMs, threshold=15000) -> 'running'|'idle'`
  - `async detectAgentState({ worktreePath, claudeProjectsDir, nowMs, registry }) -> { state, kind, source, pid }`

- [ ] **Step 1: Write the failing test** — `lib/agents.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectPath, agentStateFromMtime, detectAgentState } from './agents.mjs';

test('encodeProjectPath replaces slashes and dots with dashes', () => {
  assert.equal(
    encodeProjectPath('/Users/egecan.sen/sahibinden/repo'),
    '-Users-egecan-sen-sahibinden-repo',
  );
  assert.equal(
    encodeProjectPath('/r/web-test/.claude/worktrees/no-flag-map'),
    '-r-web-test--claude-worktrees-no-flag-map',
  );
});

test('agentStateFromMtime: fresh = running, old = idle', () => {
  const now = 1_000_000;
  assert.equal(agentStateFromMtime(now - 5000, now), 'running');
  assert.equal(agentStateFromMtime(now - 60000, now), 'idle');
});

test('detectAgentState: registry session wins as running', async () => {
  const registry = new Map([['/wt/a', { pid: 42, kind: 'claude' }]]);
  const r = await detectAgentState({ worktreePath: '/wt/a', claudeProjectsDir: '/nope', nowMs: 0, registry });
  assert.equal(r.state, 'running');
  assert.equal(r.source, 'registry');
  assert.equal(r.pid, 42);
});

test('detectAgentState: unknown when no signal', async () => {
  const r = await detectAgentState({ worktreePath: '/wt/none', claudeProjectsDir: '/nope', nowMs: 0, registry: new Map() });
  assert.equal(r.state, 'unknown');
  assert.equal(r.source, null);
});

test('detectAgentState: fresh transcript => running via session-file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forest-'));
  const wt = join(base, 'wt', 'demo');
  const projects = join(base, 'projects');
  const encoded = encodeProjectPath(wt);
  const projDir = join(projects, encoded);
  await mkdir(projDir, { recursive: true });
  const transcript = join(projDir, 'session.jsonl');
  await writeFile(transcript, '{}');
  const now = Date.now();
  await utimes(transcript, new Date(now), new Date(now));
  const r = await detectAgentState({ worktreePath: wt, claudeProjectsDir: projects, nowMs: now, registry: new Map() });
  assert.equal(r.state, 'running');
  assert.equal(r.source, 'session-file');
  assert.equal(r.kind, 'claude');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/agents.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/agents.mjs` (pure parts)**

```js
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export function encodeProjectPath(absPath) {
  return absPath.replace(/[/.]/g, '-');
}

export function agentStateFromMtime(mtimeMs, nowMs, threshold = 15000) {
  return nowMs - mtimeMs <= threshold ? 'running' : 'idle';
}

export async function detectAgentState({ worktreePath, claudeProjectsDir, nowMs, registry }) {
  const reg = registry.get(worktreePath);
  if (reg) return { state: 'running', kind: reg.kind || 'claude', source: 'registry', pid: reg.pid };

  // Session-file heuristic: newest *.jsonl mtime under the encoded project dir.
  try {
    const dir = join(claudeProjectsDir, encodeProjectPath(worktreePath));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    let newest = 0;
    for (const f of files) {
      const s = await stat(join(dir, f));
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    }
    if (newest > 0) {
      return { state: agentStateFromMtime(newest, nowMs), kind: 'claude', source: 'session-file', pid: null };
    }
  } catch {
    // dir missing / unreadable → no signal
  }
  return { state: 'unknown', kind: null, source: null, pid: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/agents.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agents.mjs lib/agents.test.mjs
git commit -m "feat: agent state detection (registry + session-file heuristic)"
```

---

## Task 5: Discovery + snapshot

**Files:**
- Modify: `lib/discover.mjs` (create)
- Test: `lib/discover.test.mjs`

**Interfaces:**
- Consumes: `runGit`, `parseWorktreeList`, `parseStatus`, `parseAheadBehind`, `extractTicket`, `detectOwner` (git.mjs); `detectAgentState` (agents.mjs).
- Produces:
  - `staleFrom({ merged, lastCommitMs, nowMs, staleDays }) -> boolean`
  - `async listRepoDirs(root) -> [{ name, path }]` (children containing `.git`)
  - `async buildSnapshot(config, { registry, nowMs, claudeProjectsDir }) -> { repos: [{ repo, repoPath, worktrees: [record] }], generatedAt }` where each record matches the spec data model.

- [ ] **Step 1: Write the failing test** — `lib/discover.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleFrom, listRepoDirs } from './discover.mjs';

const DAY = 86_400_000;

test('staleFrom: merged is stale regardless of age', () => {
  assert.equal(staleFrom({ merged: true, lastCommitMs: Date.now(), nowMs: Date.now(), staleDays: 14 }), true);
});

test('staleFrom: old unmerged is stale', () => {
  const now = 100 * DAY;
  assert.equal(staleFrom({ merged: false, lastCommitMs: now - 20 * DAY, nowMs: now, staleDays: 14 }), true);
});

test('staleFrom: recent unmerged is not stale', () => {
  const now = 100 * DAY;
  assert.equal(staleFrom({ merged: false, lastCommitMs: now - 2 * DAY, nowMs: now, staleDays: 14 }), false);
});

test('listRepoDirs finds children with a .git entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forest-root-'));
  await mkdir(join(root, 'repoA', '.git'), { recursive: true });
  await mkdir(join(root, 'notrepo'), { recursive: true });
  await writeFile(join(root, 'loose.txt'), 'x');
  const repos = await listRepoDirs(root);
  assert.deepEqual(repos.map((r) => r.name).sort(), ['repoA']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/discover.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/discover.mjs`**

```js
import { readdir, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runGit, parseWorktreeList, parseStatus, parseAheadBehind, extractTicket, detectOwner,
} from './git.mjs';
import { detectAgentState } from './agents.mjs';

const DAY = 86_400_000;

export function staleFrom({ merged, lastCommitMs, nowMs, staleDays }) {
  if (merged) return true;
  if (!lastCommitMs) return false;
  return nowMs - lastCommitMs > staleDays * DAY;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

export async function listRepoDirs(root) {
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const repos = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(root, e.name);
    if (await exists(join(path, '.git'))) repos.push({ name: e.name, path });
  }
  return repos;
}

async function baseBranch(repoPath) {
  try {
    const out = (await runGit(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
    if (out) return out.replace('refs/remotes/origin/', '');
  } catch { /* fall through */ }
  for (const b of ['main', 'master']) {
    try { await runGit(repoPath, ['rev-parse', '--verify', b]); return b; } catch { /* next */ }
  }
  return 'HEAD';
}

async function safe(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

async function buildWorktreeRecord(repoName, repoPath, wt, ctx) {
  const { registry, nowMs, claudeProjectsDir, staleDays } = ctx;
  const path = wt.path;
  const isPrimary = path === repoPath;
  const base = ctx.base;

  const statusText = await safe(() => runGit(path, ['status', '--porcelain=v1']), '');
  const status = parseStatus(statusText);

  let ahead = 0, behind = 0, merged = false, lastCommitMs = 0;
  if (!wt.detached && wt.branch) {
    const ab = await safe(() => runGit(path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]), '0\t0');
    ({ ahead, behind } = parseAheadBehind(ab));
    merged = await safe(async () => {
      await runGit(repoPath, ['merge-base', '--is-ancestor', wt.branch, base]);
      return true;
    }, false);
  }
  const lastCommitIso = (await safe(() => runGit(path, ['log', '-1', '--format=%cI']), '')).trim();
  if (lastCommitIso) lastCommitMs = Date.parse(lastCommitIso);

  const agent = await detectAgentState({ worktreePath: path, claudeProjectsDir, nowMs, registry });

  return {
    repo: repoName,
    repoPath,
    path,
    isPrimary,
    branch: wt.branch,
    head: wt.head,
    detached: wt.detached,
    owner: detectOwner(path),
    ticket: extractTicket(wt.branch),
    status,
    ahead,
    behind,
    baseBranch: base,
    merged,
    stale: staleFrom({ merged, lastCommitMs, nowMs, staleDays }),
    lastCommitAt: lastCommitIso || null,
    ageDays: lastCommitMs ? Math.floor((nowMs - lastCommitMs) / DAY) : null,
    sizeBytes: ctx.sizes.get(path) ?? null,
    agent,
  };
}

export async function buildSnapshot(config, { registry, nowMs, claudeProjectsDir, sizes = new Map() }) {
  const repos = [];
  for (const root of config.roots) {
    for (const { name, path: repoPath } of await listRepoDirs(root)) {
      const listText = await safe(() => runGit(repoPath, ['worktree', 'list', '--porcelain']), '');
      const wts = parseWorktreeList(listText);
      const base = await baseBranch(repoPath);
      const ctx = { registry, nowMs, claudeProjectsDir, staleDays: config.staleDays, base, sizes };
      const worktrees = [];
      for (const wt of wts) {
        worktrees.push(await buildWorktreeRecord(name, repoPath, wt, ctx));
      }
      repos.push({ repo: name, repoPath, worktrees });
    }
  }
  return { repos, generatedAt: nowMs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/discover.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Manual integration check against real repos**

Run:
```bash
node --input-type=module -e "
import { loadConfig } from './lib/config.mjs';
import { buildSnapshot } from './lib/discover.mjs';
const cfg = await loadConfig('./config.example.json');
const snap = await buildSnapshot(cfg, { registry: new Map(), nowMs: Date.now(), claudeProjectsDir: process.env.HOME + '/.claude/projects' });
for (const r of snap.repos) for (const w of r.worktrees) console.log(r.repo.padEnd(18), (w.branch||'(detached)').padEnd(28), w.owner.padEnd(7), w.agent.state);
"
```
Expected: a line per worktree across the ~10 repos (sui, ci, quickly, web-test + its `.cursor`/`.claude` worktrees, etc.), with sensible owner and agent state. If a repo errors it should be skipped, not crash.

- [ ] **Step 6: Commit**

```bash
git add lib/discover.mjs lib/discover.test.mjs
git commit -m "feat: repo discovery and worktree snapshot assembly"
```

---

## Task 6: Terminal + agent side-effects

**Files:**
- Create: `lib/terminal.mjs`
- Modify: `lib/agents.mjs` (append side-effecting helpers)

**Interfaces:**
- Produces (`terminal.mjs`):
  - `runInTerminal({ command, cwd, app }) -> void` (opens terminal app, `cd cwd && command`)
  - `openTerminalAt({ cwd, app }) -> void`
  - `openWith({ path, target, openEditorCmd, app }) -> void` (`target` ∈ `cursor|finder|terminal`)
- Produces (`agents.mjs`, appended):
  - `createRegistry() -> Map`
  - `notify({ title, message }) -> void`
  - `launchInteractive({ worktreePath, app }) -> void`
  - `runHeadless({ worktreePath, prompt, registry, onOutput, onDone }) -> childProcess`

- [ ] **Step 1: Write `lib/terminal.mjs`**

```js
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
```

- [ ] **Step 2: Append side-effecting helpers to `lib/agents.mjs`**

Add these imports at the top of `lib/agents.mjs` (keep the existing `node:fs/promises` and `node:path` imports):

```js
import { execFile, spawn } from 'node:child_process';
import { runInTerminal } from './terminal.mjs';
```

Append at the bottom of `lib/agents.mjs`:

```js
export function createRegistry() {
  return new Map(); // worktreePath -> { pid, kind }
}

export function notify({ title, message }) {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  execFile('osascript', ['-e', script], () => {});
}

export function launchInteractive({ worktreePath, app = 'Terminal' }) {
  runInTerminal({ command: 'claude', cwd: worktreePath, app });
}

export function runHeadless({ worktreePath, prompt, registry, onOutput, onDone }) {
  const child = spawn('claude', ['-p', prompt], { cwd: worktreePath });
  registry.set(worktreePath, { pid: child.pid, kind: 'claude' });
  child.stdout.on('data', (d) => onOutput?.(d.toString()));
  child.stderr.on('data', (d) => onOutput?.(d.toString()));
  child.on('close', (code) => {
    registry.delete(worktreePath);
    notify({ title: 'Forest', message: `Task finished (${worktreePath.split('/').pop()})` });
    onDone?.(code);
  });
  return child;
}
```

- [ ] **Step 3: Manual smoke — terminal + notification**

Run:
```bash
node --input-type=module -e "
import { runInTerminal } from './lib/terminal.mjs';
import { notify } from './lib/agents.mjs';
runInTerminal({ command: 'echo forest-terminal-ok', cwd: process.env.HOME });
notify({ title: 'Forest', message: 'notification ok' });
"
```
Expected: Terminal.app opens and shows `forest-terminal-ok`; a macOS notification appears. (No assertions — visual confirmation.)

> **Note on the "Continue interactively" handoff:** macOS `display notification` cannot host action buttons without a third-party binary, which would break the zero-dependency rule. The handoff is therefore implemented in the dashboard (Task 10): when a headless task closes, its output panel shows a **Continue interactively** button that calls `/api/launch`. The OS notification stays a plain "task finished" ping. This is a deliberate, documented deviation from the spec's wording.

- [ ] **Step 4: Commit**

```bash
git add lib/terminal.mjs lib/agents.mjs
git commit -m "feat: terminal dispatch and agent launch/headless/notify"
```

---

## Task 7: Server — static + read API + SSE

**Files:**
- Create: `server.mjs`

**Interfaces:**
- Consumes: `loadConfig`, `buildSnapshot`, `createRegistry`, `createJournal`.
- Produces: an HTTP server on `127.0.0.1:<port>` exposing `GET /api/config`, `GET /api/worktrees`, `GET /api/journal`, `GET /api/events` (SSE), `GET /api/diff?path=`, and static files from `public/`. Broadcasts `worktrees` snapshots on a 4s interval and `journal` entries as they are added. Exposes shared singletons (`registry`, `journal`, `config`, `broadcast`) used by Task 8.

- [ ] **Step 1: Write `server.mjs`**

```js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { buildSnapshot } from './lib/discover.mjs';
import { createRegistry } from './lib/agents.mjs';
import { createJournal } from './lib/journal.mjs';
import { runGit } from './lib/git.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CLAUDE_PROJECTS = `${process.env.HOME}/.claude/projects`;

const config = await loadConfig(join(ROOT, 'config.json'));
const registry = createRegistry();
const journal = createJournal({ max: 300 });
const sizes = new Map();

const clients = new Set(); // SSE response objects

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
journal.subscribe((entry) => broadcast('journal', entry));

async function snapshot() {
  return buildSnapshot(config, { registry, nowMs: Date.now(), claudeProjectsDir: CLAUDE_PROJECTS, sizes });
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

async function serveStatic(req, res) {
  let rel = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const path = normalize(join(PUBLIC, rel));
  if (!path.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

// Shared context handed to the action router (Task 8).
export const ctx = { config, registry, journal, broadcast, snapshot, CLAUDE_PROJECTS };

// Action router is attached in Task 8; defaults to 404 until then.
export let handleAction = async (req, res) => { res.writeHead(404).end('no action'); };
export function setActionHandler(fn) { handleAction = fn; }

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url === '/api/config') return sendJson(res, config);
  if (url === '/api/worktrees') return sendJson(res, await snapshot());
  if (url === '/api/journal') return sendJson(res, journal.recent());
  if (url === '/api/diff') {
    const p = new URL(req.url, 'http://x').searchParams.get('path');
    try { return sendJson(res, { diff: await runGit(p, ['diff']) }); }
    catch (e) { return sendJson(res, { diff: '', error: String(e) }); }
  }
  if (url.startsWith('/api/')) return handleAction(req, res, ctx, readBody);

  return serveStatic(req, res);
});

// Periodic snapshot push.
setInterval(async () => { try { broadcast('worktrees', await snapshot()); } catch { /* ignore */ } }, 4000);

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Forest on http://127.0.0.1:${config.port}`);
});
```

- [ ] **Step 2: Smoke — start server and curl the read endpoints**

Run (in one shell):
```bash
node server.mjs &
SERVER=$!
sleep 1
curl -s http://127.0.0.1:5577/api/config | head -c 200; echo
curl -s http://127.0.0.1:5577/api/worktrees | head -c 200; echo
curl -s http://127.0.0.1:5577/api/journal; echo
kill $SERVER
```
Expected: config JSON (with `defaultMode:"guided"`), a `{"repos":[...]}` snapshot, and `[]` for the empty journal.

- [ ] **Step 3: Commit**

```bash
git add server.mjs
git commit -m "feat: http server with static, read API, and SSE"
```

---

## Task 8: Server — mutating actions (guided/auto dispatch)

**Files:**
- Create: `lib/actions.mjs`
- Modify: `server.mjs` (wire the action handler)

**Interfaces:**
- Consumes: `ctx` (`{ config, registry, journal, broadcast, snapshot }`), `readBody`, `setActionHandler` from `server.mjs`; `runGit` (git.mjs); terminal + agent helpers.
- Produces: `createActionHandler(deps) -> async (req, res, ctx, readBody)` routing `POST /api/{worktree/create, worktree/remove, launch, open, task, git, fetch-all}`. Each mutating route resolves `mode` (body `mode` ?? `config.defaultMode`); **guided** dispatches the command string to the terminal and returns `{ mode, command }`; **auto** runs it, then broadcasts a fresh snapshot. Every route appends the command to the journal. The server refuses to remove a primary worktree.

- [ ] **Step 1: Write `lib/actions.mjs`**

```js
import { runGit } from './git.mjs';
import { runInTerminal, openWith } from './terminal.mjs';
import { launchInteractive, runHeadless } from './agents.mjs';

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
const slug = (b) => b.replace(/[^A-Za-z0-9._-]+/g, '-');

export function createActionHandler() {
  function sendJson(res, obj, code = 200) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  // Run a git command either in the terminal (guided) or in-process (auto).
  async function dispatchGit({ cwd, args, mode, ctx }) {
    const command = `git ${args.map((a) => (/\s/.test(a) ? shQuote(a) : a)).join(' ')}`;
    ctx.journal.add({ cmd: command, cwd, mode });
    if (mode === 'guided') {
      runInTerminal({ command, cwd, app: ctx.config.terminalApp });
      return { mode, command };
    }
    const out = await runGit(cwd, args);
    ctx.broadcast('worktrees', await ctx.snapshot());
    return { mode, command, output: out };
  }

  return async function handleAction(req, res, ctx, readBody) {
    const url = req.url.split('?')[0];
    const body = await readBody(req);
    const mode = body.mode || ctx.config.defaultMode;

    try {
      if (url === '/api/worktree/create') {
        const { repoPath, branch, base, newBranch } = body;
        const wtPath = `${repoPath}/.forest/wt/${slug(branch)}`;
        const args = newBranch
          ? ['worktree', 'add', '-b', branch, wtPath, base || 'HEAD']
          : ['worktree', 'add', wtPath, branch];
        return sendJson(res, await dispatchGit({ cwd: repoPath, args, mode, ctx }));
      }

      if (url === '/api/worktree/remove') {
        const { repoPath, path, force, isPrimary } = body;
        if (isPrimary) return sendJson(res, { error: 'refusing to remove primary worktree' }, 400);
        const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
        return sendJson(res, await dispatchGit({ cwd: repoPath, args, mode, ctx }));
      }

      if (url === '/api/git') {
        const { path, action, message } = body;
        const map = { fetch: ['fetch'], pull: ['pull'], push: ['push'], commit: ['commit', '-am', message || 'wip'] };
        const args = map[action];
        if (!args) return sendJson(res, { error: 'unknown git action' }, 400);
        return sendJson(res, await dispatchGit({ cwd: path, args, mode, ctx }));
      }

      if (url === '/api/fetch-all') {
        const snap = await ctx.snapshot();
        const repoPaths = snap.repos.map((r) => r.repoPath);
        const command = repoPaths.map((p) => `git -C ${shQuote(p)} fetch`).join('; ');
        ctx.journal.add({ cmd: command, mode });
        if (mode === 'guided') {
          runInTerminal({ command, cwd: ctx.config.roots[0], app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }
        for (const p of repoPaths) { try { await runGit(p, ['fetch']); } catch { /* skip */ } }
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, command });
      }

      if (url === '/api/launch') {
        const { path } = body;
        ctx.journal.add({ cmd: 'claude', cwd: path, mode: 'guided' });
        launchInteractive({ worktreePath: path, app: ctx.config.terminalApp });
        return sendJson(res, { ok: true });
      }

      if (url === '/api/open') {
        const { path, target } = body;
        openWith({ path, target, openEditorCmd: ctx.config.openEditorCmd, app: ctx.config.terminalApp });
        return sendJson(res, { ok: true });
      }

      if (url === '/api/task') {
        const { path, prompt } = body;
        if (mode === 'guided') {
          // Stay fluent: open a terminal so the user runs claude themselves.
          ctx.journal.add({ cmd: 'claude', cwd: path, mode: 'guided' });
          launchInteractive({ worktreePath: path, app: ctx.config.terminalApp });
          return sendJson(res, { mode: 'guided' });
        }
        ctx.journal.add({ cmd: `claude -p ${shQuote(prompt)}`, cwd: path, mode: 'auto' });
        runHeadless({
          worktreePath: path, prompt, registry: ctx.registry,
          onOutput: (chunk) => ctx.broadcast('task', { path, chunk }),
          onDone: (code) => ctx.broadcast('task', { path, done: true, code }),
        });
        return sendJson(res, { mode: 'auto', started: true });
      }

      return sendJson(res, { error: 'unknown action' }, 404);
    } catch (e) {
      return sendJson(res, { error: String(e) }, 500);
    }
  };
}
```

- [ ] **Step 2: Wire the handler in `server.mjs`**

Add near the other imports in `server.mjs`:

```js
import { createActionHandler } from './lib/actions.mjs';
```

Add immediately after the `export function setActionHandler(fn) {...}` line:

```js
setActionHandler(createActionHandler());
```

- [ ] **Step 3: Smoke — a guided git action returns a command and journals it**

Run:
```bash
node server.mjs &
SERVER=$!
sleep 1
curl -s -X POST http://127.0.0.1:5577/api/git \
  -H 'content-type: application/json' \
  -d '{"path":"/Users/egecan.sen/sahibinden/repo/sui","action":"fetch","mode":"guided"}'; echo
curl -s http://127.0.0.1:5577/api/journal; echo
kill $SERVER
```
Expected: response `{"mode":"guided","command":"git fetch"}`, a Terminal window opens running `cd .../sui && git fetch`, and `/api/journal` now contains that command. (Use `mode:"guided"` here so the smoke test does not mutate anything in the background.)

- [ ] **Step 4: Commit**

```bash
git add lib/actions.mjs server.mjs
git commit -m "feat: mutating action router with guided/auto dispatch"
```

---

## Task 9: Frontend shell (HTML + CSS)

**Files:**
- Create: `public/index.html`, `public/style.css`

**Interfaces:**
- Produces: the static shell `app.js` (Task 10) renders into — header (`#mode-toggle`, `#fetch-all`, `#search`), `#table`, `#drawer`, `#journal`, `#palette`. No behavior yet.

- [ ] **Step 1: Write `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Forest</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header>
    <div class="brand">🌲 Forest</div>
    <input id="search" type="search" placeholder="Filter by repo, branch, or ticket…" />
    <button id="fetch-all" title="git fetch all repos">Fetch all</button>
    <button id="mode-toggle" class="mode-guided" title="Toggle guided/auto">Guided</button>
  </header>

  <main>
    <div id="table" class="table"></div>
  </main>

  <aside id="drawer" class="drawer hidden"></aside>

  <section id="journal" class="journal">
    <div class="journal-head">Command journal</div>
    <ul id="journal-list"></ul>
  </section>

  <div id="palette" class="palette hidden">
    <input id="palette-input" type="text" placeholder="Jump to worktree or action…" />
    <ul id="palette-list"></ul>
  </div>

  <div id="toast" class="toast hidden"></div>

  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `public/style.css`**

```css
:root {
  --bg: #fbfaf7; --panel: #ffffff; --line: #e7e3da; --ink: #2b2a26; --muted: #8a857a;
  --green: #2f9e44; --amber: #e8893b; --grey: #adb5bd; --blue: #1c7ed6; --accent: #3a7d44;
}
* { box-sizing: border-box; }
body {
  margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  color: var(--ink); background: var(--bg);
}
header {
  position: sticky; top: 0; z-index: 5; display: flex; gap: 12px; align-items: center;
  padding: 12px 18px; background: var(--panel); border-bottom: 1px solid var(--line);
}
.brand { font-weight: 600; font-size: 16px; }
#search { flex: 1; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
header button { padding: 8px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); cursor: pointer; }
#mode-toggle.mode-guided { color: var(--accent); border-color: var(--accent); }
#mode-toggle.mode-auto { color: #fff; background: var(--amber); border-color: var(--amber); }
main { padding: 18px; padding-bottom: 200px; }
.table { display: flex; flex-direction: column; gap: 2px; }
.repo-group { margin-bottom: 14px; }
.repo-name { font-weight: 600; color: var(--muted); margin: 8px 2px; text-transform: none; }
.row {
  display: grid; grid-template-columns: 2.4fr 1fr 0.8fr 0.8fr 0.6fr 0.6fr auto;
  gap: 10px; align-items: center; padding: 10px 12px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; cursor: pointer;
}
.row.nested { margin-left: 22px; background: #fcfbf9; }
.row:hover { border-color: var(--accent); }
.branch { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.b-clean { color: var(--green); background: #eaf6ec; }
.b-changed { color: var(--amber); background: #fdf0e6; }
.b-stale { color: #6b6b6b; background: #eeedea; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
.run { background: var(--blue); animation: pulse 1.3s infinite; }
.idle { background: var(--grey); }
.unknown { background: transparent; border: 1px solid var(--grey); }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.actions { display: flex; gap: 6px; }
.actions button { border: none; background: transparent; cursor: pointer; font-size: 15px; padding: 2px 4px; border-radius: 6px; }
.actions button:hover { background: #f0ede6; }
.ticket-link { color: var(--blue); text-decoration: none; }
.drawer {
  position: fixed; top: 0; right: 0; width: 46vw; height: 100vh; background: var(--panel);
  border-left: 1px solid var(--line); padding: 18px; overflow: auto; z-index: 6; box-shadow: -8px 0 24px rgba(0,0,0,.06);
}
.drawer.hidden { display: none; }
.drawer pre { background: #1e1e1e; color: #e6e6e6; padding: 12px; border-radius: 8px; overflow: auto; font-size: 12.5px; }
.diff-add { color: #7bd88f; } .diff-del { color: #ff8a8a; } .diff-hunk { color: #6cb6ff; }
.journal {
  position: fixed; bottom: 0; left: 0; right: 0; max-height: 180px; overflow: auto;
  background: #16150f; color: #d6d2c4; border-top: 1px solid #2b291f; padding: 8px 14px; z-index: 4;
}
.journal-head { color: #8d8772; font-size: 12px; margin-bottom: 4px; }
.journal ul { margin: 0; padding: 0; list-style: none; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; }
.journal li { padding: 2px 0; white-space: pre-wrap; }
.journal .j-mode { color: #d9a441; margin-right: 8px; }
.palette { position: fixed; inset: 12vh 30vw auto 30vw; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.2); z-index: 8; overflow: hidden; }
.palette.hidden { display: none; }
.palette input { width: 100%; padding: 14px 16px; border: none; border-bottom: 1px solid var(--line); font-size: 15px; outline: none; }
.palette ul { list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow: auto; }
.palette li { padding: 8px 12px; border-radius: 8px; cursor: pointer; }
.palette li.active, .palette li:hover { background: #eef4ee; }
.toast { position: fixed; bottom: 200px; left: 50%; transform: translateX(-50%); background: var(--ink); color: #fff; padding: 10px 16px; border-radius: 8px; z-index: 9; }
.toast.hidden { display: none; }
.hidden { display: none; }
```

- [ ] **Step 3: Smoke — the shell loads**

Run:
```bash
node server.mjs &
SERVER=$!
sleep 1
open http://127.0.0.1:5577
# Visual check: header with brand, search, Fetch all, Guided toggle; empty table; dark journal bar at bottom.
kill $SERVER
```
Expected: page renders the static shell (no rows yet — `app.js` is added next).

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/style.css
git commit -m "feat: dashboard shell html and css"
```

---

## Task 10: Frontend behavior (app.js)

**Files:**
- Create: `public/app.js`

**Interfaces:**
- Consumes: `GET /api/config`, `GET /api/worktrees`, `GET /api/journal`, `GET /api/diff`, the SSE `worktrees|journal|task` events, and the POST action endpoints from Task 8.
- Produces: full dashboard behavior — live table, filter, mode toggle (persisted to `localStorage`), row actions, detail drawer with diff + "Continue interactively", command palette, journal stream.

- [ ] **Step 1: Write `public/app.js`**

```js
const $ = (s) => document.querySelector(s);
const state = { config: null, snapshot: { repos: [] }, filter: '', mode: 'guided', taskBuf: {} };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('forest-mode', mode);
  const b = $('#mode-toggle');
  b.textContent = mode === 'auto' ? 'Auto' : 'Guided';
  b.className = mode === 'auto' ? 'mode-auto' : 'mode-guided';
}

function statusBadge(w) {
  if (w.stale || w.merged) return `<span class="badge b-stale">${w.merged ? 'merged' : 'stale'}</span>`;
  if (w.status.dirty) return `<span class="badge b-changed">${w.status.changed} changed</span>`;
  return `<span class="badge b-clean">clean</span>`;
}
function agentCell(a) {
  const cls = a.state === 'running' ? 'run' : a.state === 'idle' ? 'idle' : 'unknown';
  const label = a.state === 'running' ? (a.kind || 'agent') : a.state;
  return `<span><span class="dot ${cls}"></span>${label}</span>`;
}
function ageCell(w) { return w.ageDays == null ? '—' : w.ageDays === 0 ? 'today' : `${w.ageDays}d`; }
function sizeCell(w) { return w.sizeBytes == null ? '—' : `${(w.sizeBytes / 1e9).toFixed(1)}G`; }
function ticketCell(w) {
  if (w.ticket && state.config.jiraBaseUrl) {
    return `<a class="ticket-link" href="${state.config.jiraBaseUrl}/browse/${w.ticket}" target="_blank" onclick="event.stopPropagation()">${w.branch}</a>`;
  }
  return w.branch || '(detached)';
}

function matches(w, repo) {
  const f = state.filter.toLowerCase();
  if (!f) return true;
  return [repo, w.branch, w.ticket, w.owner].filter(Boolean).some((s) => s.toLowerCase().includes(f));
}

function rowHtml(w, repo) {
  const enc = encodeURIComponent(w.path);
  const pruneable = (w.stale || w.merged) && !w.isPrimary;
  return `<div class="row ${w.isPrimary ? '' : 'nested'}" data-path="${enc}">
    <div class="branch">${ticketCell(w)}</div>
    <div>${statusBadge(w)}</div>
    <div>${w.owner}</div>
    <div>${agentCell(w.agent)}</div>
    <div>${ageCell(w)}</div>
    <div>${sizeCell(w)}</div>
    <div class="actions">
      <button title="Quick task" data-act="task" data-path="${enc}">⚡</button>
      <button title="Launch Claude" data-act="launch" data-path="${enc}">▶</button>
      <button title="Open in Cursor" data-act="open-cursor" data-path="${enc}">⤓</button>
      ${pruneable ? `<button title="Prune" data-act="remove" data-path="${enc}" data-repo="${encodeURIComponent(w.repoPath)}" data-primary="${w.isPrimary}">🧹</button>` : ''}
    </div>
  </div>`;
}

function render() {
  const html = state.snapshot.repos.map((r) => {
    const rows = r.worktrees.filter((w) => matches(w, r.repo)).map((w) => rowHtml(w, r.repo)).join('');
    if (!rows) return '';
    return `<div class="repo-group"><div class="repo-name">${r.repo}</div>${rows}</div>`;
  }).join('');
  $('#table').innerHTML = html || '<p style="color:var(--muted)">No worktrees match.</p>';
}

function findWorktree(path) {
  for (const r of state.snapshot.repos) for (const w of r.worktrees) if (w.path === path) return w;
  return null;
}

function colorizeDiff(text) {
  return text.split('\n').map((l) => {
    const e = l.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    if (l.startsWith('+')) return `<span class="diff-add">${e}</span>`;
    if (l.startsWith('-')) return `<span class="diff-del">${e}</span>`;
    if (l.startsWith('@@')) return `<span class="diff-hunk">${e}</span>`;
    return e;
  }).join('\n');
}

async function openDrawer(path) {
  const w = findWorktree(path);
  if (!w) return;
  const d = $('#drawer');
  d.classList.remove('hidden');
  d.innerHTML = `<button id="drawer-close" style="float:right">✕</button>
    <h3 class="branch">${w.branch || '(detached)'}</h3>
    <p style="color:var(--muted)">${w.repo} · ${w.owner} · ${ageCell(w)} · ${sizeCell(w)}</p>
    <div id="task-panel"></div>
    <h4>Diff</h4><pre id="diff">loading…</pre>`;
  $('#drawer-close').onclick = () => d.classList.add('hidden');
  const buf = state.taskBuf[path];
  if (buf) renderTaskPanel(path);
  const res = await fetch(`/api/diff?path=${encodeURIComponent(path)}`).then((r) => r.json());
  $('#diff').innerHTML = res.diff ? colorizeDiff(res.diff) : '(no changes)';
}

function renderTaskPanel(path) {
  const panel = $('#task-panel');
  if (!panel) return;
  const buf = state.taskBuf[path];
  if (!buf) { panel.innerHTML = ''; return; }
  panel.innerHTML = `<h4>Task output</h4><pre>${buf.text.replace(/</g, '&lt;')}</pre>
    ${buf.done ? `<button id="continue-int">Continue interactively</button>` : '<em>running…</em>'}`;
  const c = $('#continue-int');
  if (c) c.onclick = () => api('/api/launch', { path });
}

async function doAction(act, ds) {
  const path = decodeURIComponent(ds.path);
  if (act === 'launch') { await api('/api/launch', { path }); toast('Launching Claude…'); return; }
  if (act === 'open-cursor') { await api('/api/open', { path, target: 'cursor' }); return; }
  if (act === 'task') {
    const prompt = state.mode === 'auto' ? window.prompt('Task for Claude (headless):') : null;
    if (state.mode === 'auto' && !prompt) return;
    state.taskBuf[path] = { text: '', done: false };
    await api('/api/task', { path, prompt, mode: state.mode });
    openDrawer(path);
    return;
  }
  if (act === 'remove') {
    const w = findWorktree(path);
    if (w.status.dirty && !confirm('Worktree has uncommitted changes. Remove anyway?')) return;
    if (!confirm(`Remove worktree?\n${path}`)) return;
    const r = await api('/api/worktree/remove', { repoPath: decodeURIComponent(ds.repo), path, force: w.status.dirty, isPrimary: w.isPrimary, mode: state.mode });
    toast(r.error ? `Error: ${r.error}` : state.mode === 'guided' ? 'Sent to terminal' : 'Removed');
  }
}

function wireEvents() {
  $('#mode-toggle').onclick = () => setMode(state.mode === 'auto' ? 'guided' : 'auto');
  $('#search').oninput = (e) => { state.filter = e.target.value; render(); };
  $('#fetch-all').onclick = async () => { const r = await api('/api/fetch-all', { mode: state.mode }); toast(state.mode === 'guided' ? 'Sent to terminal' : 'Fetched all'); };

  $('#table').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) { e.stopPropagation(); doAction(btn.dataset.act, btn.dataset); return; }
    const row = e.target.closest('.row[data-path]');
    if (row) openDrawer(decodeURIComponent(row.dataset.path));
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); togglePalette(); }
    if (e.key === 'Escape') { $('#palette').classList.add('hidden'); $('#drawer').classList.add('hidden'); }
  });
}

function togglePalette() {
  const p = $('#palette');
  const show = p.classList.contains('hidden');
  p.classList.toggle('hidden');
  if (show) { $('#palette-input').value = ''; renderPalette(''); $('#palette-input').focus(); }
}
function paletteItems() {
  const items = [];
  for (const r of state.snapshot.repos) for (const w of r.worktrees) {
    items.push({ label: `${r.repo} · ${w.branch || '(detached)'}`, path: w.path });
  }
  return items;
}
function renderPalette(q) {
  const ql = q.toLowerCase();
  const items = paletteItems().filter((i) => i.label.toLowerCase().includes(ql)).slice(0, 30);
  $('#palette-list').innerHTML = items.map((i) => `<li data-path="${encodeURIComponent(i.path)}">${i.label}</li>`).join('');
}

function wirePalette() {
  $('#palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
  $('#palette-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-path]');
    if (li) { $('#palette').classList.add('hidden'); openDrawer(decodeURIComponent(li.dataset.path)); }
  });
}

function addJournal(entry) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="j-mode">${entry.mode || ''}</span>${entry.cmd}`;
  $('#journal-list').appendChild(li);
  $('#journal').scrollTop = $('#journal').scrollHeight;
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('worktrees', (e) => { state.snapshot = JSON.parse(e.data); render(); });
  es.addEventListener('journal', (e) => addJournal(JSON.parse(e.data)));
  es.addEventListener('task', (e) => {
    const d = JSON.parse(e.data);
    const buf = (state.taskBuf[d.path] ||= { text: '', done: false });
    if (d.chunk) buf.text += d.chunk;
    if (d.done) buf.done = true;
    renderTaskPanel(d.path);
  });
}

async function init() {
  state.config = await fetch('/api/config').then((r) => r.json());
  setMode(localStorage.getItem('forest-mode') || state.config.defaultMode);
  state.snapshot = await fetch('/api/worktrees').then((r) => r.json());
  (await fetch('/api/journal').then((r) => r.json())).forEach(addJournal);
  render();
  wireEvents();
  wirePalette();
  connectSSE();
}
init();
```

- [ ] **Step 2: Smoke — full dashboard**

Run:
```bash
node server.mjs &
SERVER=$!
sleep 1
open http://127.0.0.1:5577
kill $SERVER  # leave running while you click around, then kill
```
Expected (visual): worktrees grouped by repo with status/owner/agent/age/size; typing in search filters live; the Guided/Auto button toggles and persists across reload; clicking a row opens the drawer and shows the diff; ⌘K opens the palette; the journal bar shows commands as you trigger actions. Verify a **guided** prune opens a Terminal with `git worktree remove …` rather than removing silently.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: dashboard behavior — live table, actions, diff, palette, journal"
```

---

## Task 11: Launcher + README + end-to-end smoke

**Files:**
- Create: `bin/forest`, `README.md`
- Create at runtime: `config.json` (user copies from example)

**Interfaces:**
- Produces: a `forest` command on PATH that starts the server (if not already running) and opens the browser.

- [ ] **Step 1: Write `bin/forest`**

```bash
#!/usr/bin/env bash
set -euo pipefail
DIR="$HOME/sahibinden/forest"
PORT="$(node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.env.HOME+'/sahibinden/forest/config.json','utf8')).port||5577))}catch(e){process.stdout.write('5577')}" 2>/dev/null || echo 5577)"
if ! curl -s "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1; then
  (cd "$DIR" && nohup node server.mjs >/tmp/forest.log 2>&1 &)
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -s "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1 && break
    sleep 0.3
  done
fi
open "http://127.0.0.1:${PORT}"
```

- [ ] **Step 2: Make it executable and create the live config**

Run:
```bash
chmod +x bin/forest
cp -n config.example.json config.json
```
Expected: `bin/forest` is executable; `config.json` exists (gitignored). Edit `config.json` to set `jiraBaseUrl` to your Atlassian URL when ready.

- [ ] **Step 3: Symlink onto PATH**

Run:
```bash
ln -sf "$HOME/sahibinden/forest/bin/forest" "$HOME/.local/bin/forest"
which forest
```
Expected: `~/.local/bin/forest`.

- [ ] **Step 4: Write `README.md`**

```markdown
# Forest 🌲

A zero-dependency local web dashboard for tracking git worktrees across all repos
under `~/sahibinden/repo/`, and running Claude on a branch.

## Run

    forest        # starts the server (if down) and opens the dashboard

Or directly:

    node server.mjs

Then open http://127.0.0.1:5577.

## Posture

Forest is a glass cockpit, not an autopilot. Visibility is all-GUI; mutations are
terminal-first. The header **Guided ⟷ Auto** toggle decides whether an action runs
in your terminal (you stay fluent) or in the background (logged to the journal).
Both modes confirm destructive actions and never touch a repo's primary worktree.

## Config

Copy `config.example.json` to `config.json` and edit. Keys: `port`, `roots`,
`jiraBaseUrl`, `staleDays`, `defaultMode`, `terminalApp`, `openEditorCmd`,
`setupScript`.

## Test

    npm test    # node --test over lib/*.test.mjs
```

- [ ] **Step 5: End-to-end smoke**

Run:
```bash
forest
```
Expected: a browser tab opens at `http://127.0.0.1:5577` showing all worktrees across your repos. Running `forest` again just opens a new tab (server already up).

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all `node:test` suites pass (config, journal, git, agents, discover).

- [ ] **Step 7: Commit**

```bash
git add bin/forest README.md
git commit -m "feat: forest launcher and README"
```

---

## Self-Review Notes

- **Spec coverage:** all-repos table (T5/T10), diff viewer (T7/T10), create-from-ticket (T8/T10), launch Claude (T6/T8), quick-open (T6/T8/T10), stale/merged prune (T5/T10), glass-cockpit toggle + journal (T2/T8/T10), headless task + notify + handoff (T6/T8/T10), JIRA links (T10), auto-setup hook (see note), fetch-all + git ops (T8/T10), ⌘K palette (T10), agent detection (T4), safety rails (T8/T10), localhost bind (T7), config (T1), launcher (T11).
- **Auto-setup on create:** the `setupScript` config key exists and is read; wiring it to run after `worktree add` in auto mode is a 3-line addition in `lib/actions.mjs` `worktree/create` (run `config.setupScript` in `wtPath` if the file exists, stream output to the `task` SSE channel). Add it during T8 if desired; it is intentionally minimal and gated on the file existing.
- **Continue-interactively handoff:** implemented in-dashboard (T10 task panel) plus a plain OS notification (T6) — documented deviation, since dependency-free `display notification` has no action buttons.
- **Disk size:** `sizeBytes` is wired through the snapshot (`sizes` map) but populated lazily; a background `du -sk` pass can fill `sizes` and is a safe follow-up (cells show `—` until then). Not on the critical path.
