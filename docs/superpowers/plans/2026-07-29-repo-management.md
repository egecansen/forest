# Repo Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user add and remove the repos forest shows, from the UI, without hand-editing `config.json` or restarting the server.

**Architecture:** A new `lib/repos.mjs` owns a forest-written `repos.json` and all path validation. `buildSnapshot` gains a third repo source alongside roots and containers, merged and deduplicated by real path, with each record carrying `listed: boolean`. Two thin routes in `lib/actions.mjs` mutate the list and rebroadcast the snapshot; the UI adds one form in the header and one remove control on listed repo groups.

**Tech Stack:** Node 20+ ESM (`.mjs`), `node:test` + `node:assert/strict`, zero runtime dependencies, vanilla JS frontend (no framework, no build step).

## Global Constraints

- **No new dependencies.** `node:` builtins only.
- **Test command:** `node --test` from the repo root. The full suite (111 tests at baseline) must be green before each commit, not just the new file.
- **Style:** ESM, 2-space indent, single quotes, semicolons — match the surrounding file.
- **Fixtures must clean up.** Every `mkdtemp` gets a `try/finally` + `rm`. The suite already leaks 28 temp dirs per run; do not add to it.
- **`repos.json` is never overwritten when unreadable.** A malformed file is the only record of what the user added; clobbering it loses that. Reads fall back to an empty list, and writes refuse.
- **Removing a repo touches nothing on disk** — not the repo, not its worktrees, not its `.claude/`.
- **Spec:** `docs/superpowers/specs/2026-07-29-repo-management-design.md` is the source of truth for behaviour.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/repos.mjs` (create) | Read/write `repos.json`, validate a pasted path, map a failure reason to a human message. The only module that knows the file's shape. |
| `lib/repos.test.mjs` (create) | Covers the module against real temp dirs and real git repos. |
| `lib/discover.mjs` (modify) | `buildSnapshot` accepts `repoList`, merges it with the scan, dedupes by real path, tags records with `listed`, and reports skipped entries. |
| `lib/discover.test.mjs` (modify) | Snapshot-level coverage of the merge, the dedupe and the skip. |
| `server.mjs` (modify) | Loads the list at startup, holds it in memory, passes it to `buildSnapshot`, journals skipped entries once per path per run, exposes it on `ctx`. |
| `lib/actions.mjs` (modify) | `POST /api/repos/add` and `POST /api/repos/remove`. |
| `public/app.js`, `public/index.html`, `public/style.css` (modify) | The add form and the remove control. |

---

### Task 1: `lib/repos.mjs` — the list and its validation

**Files:**
- Create: `lib/repos.mjs`
- Test: `lib/repos.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `expandPath(input: string) → string` — trims, expands a leading `~`.
  - `readRepoList(forestRoot: string) → Promise<string[]>` — `[]` when absent or malformed; never throws.
  - `addRepo(forestRoot: string, input: string) → Promise<{ ok: true, repos: string[] } | { ok: false, reason: string }>` where `reason` is one of `not-absolute`, `not-found`, `not-a-repo`, `already-listed`, `list-unreadable`.
  - `removeRepo(forestRoot: string, input: string) → Promise<{ ok: true, repos: string[] } | { ok: false, reason: 'list-unreadable' }>`.
  - `repoErrorMessage(reason: string) → string`.

- [ ] **Step 1: Write the failing tests**

Create `lib/repos.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expandPath, readRepoList, addRepo, removeRepo, repoErrorMessage } from './repos.mjs';

const execFileP = promisify(execFile);
const tmp = (p) => mkdtemp(join(tmpdir(), p));
async function makeRepo() {
  const dir = await tmp('forest-repo-');
  await execFileP('git', ['-C', dir, 'init', '-b', 'master']);
  return dir;
}

test('expandPath trims and expands a leading ~', () => {
  assert.equal(expandPath('  /a/b  '), '/a/b');
  assert.equal(expandPath('~'), homedir());
  assert.equal(expandPath('~/x'), join(homedir(), 'x'));
});

test('readRepoList returns [] for an absent file', async () => {
  const root = await tmp('forest-root-');
  try { assert.deepEqual(await readRepoList(root), []); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('readRepoList returns [] for a malformed file and does not rewrite it', async () => {
  const root = await tmp('forest-root-');
  try {
    await writeFile(join(root, 'repos.json'), '{ not json');
    assert.deepEqual(await readRepoList(root), []);
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), '{ not json');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('addRepo persists a real repo and readRepoList returns it', async () => {
  const root = await tmp('forest-root-');
  const repo = await makeRepo();
  try {
    const r = await addRepo(root, repo);
    assert.equal(r.ok, true);
    assert.deepEqual(r.repos, [repo]);
    assert.deepEqual(await readRepoList(root), [repo]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

test('addRepo rejects a relative path, a missing dir and a non-repo dir', async () => {
  const root = await tmp('forest-root-');
  const plain = await tmp('forest-plain-');
  try {
    assert.equal((await addRepo(root, 'relative/path')).reason, 'not-absolute');
    assert.equal((await addRepo(root, '/no/such/dir-xyz')).reason, 'not-found');
    assert.equal((await addRepo(root, plain)).reason, 'not-a-repo');
    assert.deepEqual(await readRepoList(root), []);
  } finally { await rm(root, { recursive: true, force: true }); await rm(plain, { recursive: true, force: true }); }
});

test('addRepo rejects a duplicate reached through a symlink', async () => {
  const root = await tmp('forest-root-');
  const repo = await makeRepo();
  const linkDir = await tmp('forest-link-');
  const link = join(linkDir, 'alias');
  try {
    await symlink(repo, link);
    assert.equal((await addRepo(root, repo)).ok, true);
    assert.equal((await addRepo(root, link)).reason, 'already-listed');
    assert.deepEqual(await readRepoList(root), [repo]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(linkDir, { recursive: true, force: true });
  }
});

test('addRepo refuses to write over a malformed list', async () => {
  const root = await tmp('forest-root-');
  const repo = await makeRepo();
  try {
    await writeFile(join(root, 'repos.json'), '{ not json');
    assert.equal((await addRepo(root, repo)).reason, 'list-unreadable');
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), '{ not json');
  } finally { await rm(root, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

test('removeRepo drops the entry and leaves the repo on disk', async () => {
  const root = await tmp('forest-root-');
  const repo = await makeRepo();
  try {
    await addRepo(root, repo);
    const r = await removeRepo(root, repo);
    assert.equal(r.ok, true);
    assert.deepEqual(r.repos, []);
    assert.deepEqual(await readRepoList(root), []);
    const st = await stat(join(repo, '.git'));   // the repo itself is untouched
    assert.ok(st.isDirectory());
  } finally { await rm(root, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

test('removeRepo is a no-op for a path that is not listed', async () => {
  const root = await tmp('forest-root-');
  const repo = await makeRepo();
  try {
    await addRepo(root, repo);
    const r = await removeRepo(root, '/some/other/path');
    assert.deepEqual(r.repos, [repo]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

test('repoErrorMessage gives a distinct message per reason', () => {
  const seen = new Set(['not-absolute', 'not-found', 'not-a-repo', 'already-listed', 'list-unreadable'].map(repoErrorMessage));
  assert.equal(seen.size, 5);
  assert.match(repoErrorMessage('nonsense'), /\w/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/repos.test.mjs`
Expected: FAIL — cannot find module `./repos.mjs`.

- [ ] **Step 3: Implement `lib/repos.mjs`**

```js
// lib/repos.mjs — the user's curated repo list, stored in repos.json beside
// config.json. Forest owns this file; config.json stays hand-authored and is
// never rewritten from the UI.
import { readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

const FILE = 'repos.json';

const MESSAGES = {
  'not-absolute': 'Enter an absolute path — a relative one would resolve against the server, not your repo.',
  'not-found': 'No such directory.',
  'not-a-repo': 'That directory is not a git repository.',
  'already-listed': 'Already added.',
  'list-unreadable': 'repos.json is unreadable — fix or delete it, then try again.',
};

export const repoErrorMessage = (reason) => MESSAGES[reason] || 'Could not add that path.';

export function expandPath(input) {
  const s = String(input ?? '').trim();
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

const isGitRepo = (path) => new Promise((res) => execFile('git', ['-C', path, 'rev-parse', '--git-dir'], (err) => res(!err)));
const real = async (p) => { try { return await realpath(p); } catch { return p; } };

// { repos, malformed } — malformed means the file exists but could not be
// parsed, which is the one case where writing would destroy the user's record.
async function readState(forestRoot) {
  let text;
  try { text = await readFile(join(forestRoot, FILE), 'utf8'); }
  catch { return { repos: [], malformed: false }; }
  try {
    const json = JSON.parse(text);
    const repos = Array.isArray(json.repos) ? json.repos.filter((p) => typeof p === 'string') : [];
    return { repos, malformed: false };
  } catch { return { repos: [], malformed: true }; }
}

export async function readRepoList(forestRoot) {
  return (await readState(forestRoot)).repos;
}

async function writeRepoList(forestRoot, repos) {
  await writeFile(join(forestRoot, FILE), `${JSON.stringify({ repos }, null, 2)}\n`);
}

export async function addRepo(forestRoot, input) {
  const path = expandPath(input);
  if (!isAbsolute(path)) return { ok: false, reason: 'not-absolute' };
  let st;
  try { st = await stat(path); } catch { return { ok: false, reason: 'not-found' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'not-found' };
  if (!(await isGitRepo(path))) return { ok: false, reason: 'not-a-repo' };

  const { repos, malformed } = await readState(forestRoot);
  if (malformed) return { ok: false, reason: 'list-unreadable' };
  const key = await real(path);
  for (const r of repos) if ((await real(r)) === key) return { ok: false, reason: 'already-listed' };

  const next = [...repos, path];
  await writeRepoList(forestRoot, next);
  return { ok: true, repos: next };
}

export async function removeRepo(forestRoot, input) {
  const { repos, malformed } = await readState(forestRoot);
  if (malformed) return { ok: false, reason: 'list-unreadable' };
  const key = await real(expandPath(input));
  const next = [];
  for (const r of repos) if ((await real(r)) !== key) next.push(r);
  if (next.length !== repos.length) await writeRepoList(forestRoot, next);
  return { ok: true, repos: next };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: PASS — 111 baseline plus 9 new.

- [ ] **Step 5: Commit**

```bash
git add lib/repos.mjs lib/repos.test.mjs
git commit -m "feat(repos): curated repo list with validated add/remove"
```

---

### Task 2: Discovery merges the list

**Files:**
- Modify: `lib/discover.mjs:111-130` (`buildSnapshot`)
- Test: `lib/discover.test.mjs`

**Interfaces:**
- Consumes: `readRepoList` is NOT used here — the list arrives as an argument, keeping discovery pure.
- Produces: `buildSnapshot(config, { registry, nowMs, claudeProjectsDir, sizes, repoList = [] })` → `{ repos, generatedAt, skippedRepos }`. Each repo record gains `listed: boolean`. `skippedRepos: string[]` holds listed paths that are no longer git repos.

- [ ] **Step 1: Write the failing tests**

Append to `lib/discover.test.mjs` (it already imports `mkdtemp`, `mkdir`, `writeFile`, `rm`, `tmpdir`, `join`, and `makeRepoWithWorktree` from `./finish-fixtures.mjs`; add any that are missing, plus `buildSnapshot` from `./discover.mjs` and `createRegistry` from `./agents.mjs` if not already imported):

```js
const snapArgs = { registry: createRegistry(), nowMs: Date.now(), claudeProjectsDir: '/no/such/projects' };

test('buildSnapshot includes a listed repo that the scan cannot reach', async () => {
  const { repo, wt } = await makeRepoWithWorktree({ branch: 'tech/LIST-1' });
  const emptyRoot = await mkdtemp(join(tmpdir(), 'forest-emptyroot-'));
  try {
    const snap = await buildSnapshot({ roots: [emptyRoot], containers: [], staleDays: 14 }, { ...snapArgs, repoList: [repo] });
    const rec = snap.repos.find((r) => r.repoPath === repo);
    assert.ok(rec, 'listed repo must appear even though no root reaches it');
    assert.equal(rec.listed, true);
    assert.ok(rec.worktrees.some((w) => w.path === wt));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(emptyRoot, { recursive: true, force: true });
  }
});

test('buildSnapshot yields one record when a repo is both scanned and listed', async () => {
  const { repo } = await makeRepoWithWorktree({ branch: 'tech/LIST-2' });
  try {
    const snap = await buildSnapshot({ roots: [dirname(repo)], containers: [], staleDays: 14 }, { ...snapArgs, repoList: [repo] });
    const hits = snap.repos.filter((r) => r.repoPath === repo);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].listed, false, 'the scan wins, so no remove control is offered');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('buildSnapshot skips a listed path that is no longer a repo and reports it', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'forest-plain-'));
  const emptyRoot = await mkdtemp(join(tmpdir(), 'forest-emptyroot-'));
  try {
    const snap = await buildSnapshot({ roots: [emptyRoot], containers: [], staleDays: 14 }, { ...snapArgs, repoList: [plain, '/no/such/dir-xyz'] });
    assert.equal(snap.repos.length, 0);
    assert.deepEqual(snap.skippedRepos.sort(), [plain, '/no/such/dir-xyz'].sort());
  } finally {
    await rm(plain, { recursive: true, force: true });
    await rm(emptyRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/discover.test.mjs`
Expected: FAIL — the listed repo is absent from `snap.repos`, and `snap.skippedRepos` is `undefined`.

- [ ] **Step 3: Implement in `lib/discover.mjs`**

Add `basename` to the `node:path` import and `realpath` to the `node:fs/promises` import, then replace `buildSnapshot` (lines 111-130) with:

```js
const realOrSelf = async (p) => { try { return await realpath(p); } catch { return p; } };

export async function buildSnapshot(config, { registry, nowMs, claudeProjectsDir, sizes = new Map(), repoList = [] }) {
  const repos = [];
  const skippedRepos = [];
  const seen = new Set();

  const addRepoRecord = async (name, repoPath, listed) => {
    const key = await realOrSelf(repoPath);
    if (seen.has(key)) return;          // scanned and listed are the same repo
    seen.add(key);
    const listText = await safe(() => runGit(repoPath, ['worktree', 'list', '--porcelain']), '');
    let wts = [];
    try { wts = parseWorktreeList(listText); } catch { wts = []; }
    const base = await safe(() => baseBranch(repoPath), 'HEAD');
    const ctx = { registry, nowMs, claudeProjectsDir, staleDays: config.staleDays, base, sizes };
    const worktrees = [];
    for (const wt of wts) {
      const rec = await safe(() => buildWorktreeRecord(name, repoPath, wt, ctx), null);
      if (rec) worktrees.push(rec);
    }
    const landed = await safe(() => readLandings(repoPath), []);
    repos.push({ repo: name, repoPath, worktrees, landed, listed });
  };

  for (const root of config.roots) {
    for (const { name, path: repoPath } of await listRepoDirs(root, config.containers)) {
      await addRepoRecord(name, repoPath, false);
    }
  }
  for (const p of repoList) {
    if (!(await exists(join(p, '.git')))) { skippedRepos.push(p); continue; }
    await addRepoRecord(basename(p), p, true);
  }
  return { repos, generatedAt: nowMs, skippedRepos };
}
```

The scan runs first deliberately: a repo the scan already finds keeps `listed: false`, so the UI offers no remove control for something that would reappear on the next refresh.

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/discover.mjs lib/discover.test.mjs
git commit -m "feat(discover): merge the curated repo list into the snapshot"
```

---

### Task 3: Server wiring and the two routes

**Files:**
- Modify: `server.mjs:18-32` and `:64` (`ctx`)
- Modify: `lib/actions.mjs` (imports + two new route branches)

**Interfaces:**
- Consumes: `readRepoList`, `addRepo`, `removeRepo`, `repoErrorMessage` (Task 1); `buildSnapshot`'s `repoList` option and `skippedRepos` (Task 2).
- Produces:
  - `ctx.forestRoot: string`, `ctx.getRepoList(): string[]`, `ctx.setRepoList(list: string[]): void`.
  - `POST /api/repos/add { path }` → `{ ok: true, repos }` or `{ error: <message> }` with 400.
  - `POST /api/repos/remove { path }` → `{ ok: true, repos }` or `{ error: <message> }` with 400.

- [ ] **Step 1: Wire the list into the server**

In `server.mjs`, after the config load (line 18):

```js
import { readRepoList } from './lib/repos.mjs';
...
let repoList = await readRepoList(ROOT);
const warnedRepos = new Set();
```

In the snapshot builder (line 32), pass the list and journal anything skipped, once per path per run:

```js
async function snapshot() {
  const snap = await buildSnapshot(config, { registry, nowMs: Date.now(), claudeProjectsDir: CLAUDE_PROJECTS, sizes, repoList });
  for (const p of snap.skippedRepos) {
    if (warnedRepos.has(p)) continue;
    warnedRepos.add(p);
    journal.add({ cmd: `repo skipped: ${p} is no longer a git repository (still listed)`, cwd: ROOT, mode: 'auto' });
  }
  return snap;
}
```

Extend the exported `ctx` (line 64):

```js
export const ctx = {
  config, registry, journal, broadcast, snapshot, CLAUDE_PROJECTS,
  forestRoot: ROOT,
  getRepoList: () => repoList,
  setRepoList: (list) => { repoList = list; warnedRepos.clear(); },
};
```

`warnedRepos.clear()` on every list change so a path that is re-added and still broken warns again.

- [ ] **Step 2: Add the routes**

In `lib/actions.mjs`, extend the imports:

```js
import { addRepo, removeRepo, repoErrorMessage } from './repos.mjs';
```

Add two branches beside the other `/api/*` handlers:

```js
      if (url === '/api/repos/add') {
        const { path } = body;
        const r = await addRepo(ctx.forestRoot, path);
        if (!r.ok) return sendJson(res, { error: repoErrorMessage(r.reason) }, 400);
        ctx.setRepoList(r.repos);
        ctx.journal.add({ cmd: `repo added: ${path}`, cwd: ctx.forestRoot, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { ok: true, repos: r.repos });
      }

      if (url === '/api/repos/remove') {
        const { path } = body;
        const r = await removeRepo(ctx.forestRoot, path);
        if (!r.ok) return sendJson(res, { error: repoErrorMessage(r.reason) }, 400);
        ctx.setRepoList(r.repos);
        ctx.journal.add({ cmd: `repo removed from the list (nothing deleted): ${path}`, cwd: ctx.forestRoot, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { ok: true, repos: r.repos });
      }
```

- [ ] **Step 3: Verify by hand against a running server**

Run `npm start` in a scratch shell (or reuse a running instance), then:

```bash
curl -s localhost:5577/api/repos/add -X POST -H 'content-type: application/json' -d '{"path":"/no/such/dir-xyz"}'
curl -s localhost:5577/api/repos/add -X POST -H 'content-type: application/json' -d '{"path":"/Users/egecan.sen/sahibinden/repo/SKLS/hektor"}'
curl -s localhost:5577/api/worktrees | head -c 400
```

Expected: the first returns `{"error":"No such directory."}` with 400; the second returns `{"ok":true,"repos":["…/SKLS/hektor"]}`; the third now contains a repo record for `hektor` with `"listed":true`. Put the actual output in your report.

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: PASS — unchanged count; this task adds no tests (its logic lives in Task 1's module, which is covered).

- [ ] **Step 5: Commit**

```bash
git add server.mjs lib/actions.mjs
git commit -m "feat(repos): add/remove routes, hot-applied to the snapshot"
```

---

### Task 4: UI — add form and remove control

**Files:**
- Modify: `public/index.html:19` (header)
- Modify: `public/app.js:97-101` (repo group render), `public/app.js:263+` (`doAction`), and the event wiring near `wireEvents`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `r.listed` on each repo record (Task 2); `/api/repos/add` and `/api/repos/remove` (Task 3).
- Produces: no module exports; UI only.

- [ ] **Step 1: Add the header form**

In `public/index.html`, inside `<header>` (line 19), after the existing controls:

```html
      <button id="addrepo-toggle" title="Add a repo to the list">+ repo</button>
      <span id="addrepo-form" class="hidden">
        <input id="addrepo-path" type="text" placeholder="/absolute/path/to/repo" size="34" />
        <button id="addrepo-go" class="btn-accent">Add</button>
        <span id="addrepo-err" class="addrepo-err"></span>
      </span>
```

In `public/style.css`:

```css
.addrepo-err { font-size: 12px; color: var(--amber, #d08a2a); margin-left: 8px; }
```

- [ ] **Step 2: Wire the form**

In `public/app.js`, near the other event wiring in `wireEvents`:

```js
  $('#addrepo-toggle').onclick = () => {
    $('#addrepo-form').classList.toggle('hidden');
    $('#addrepo-err').textContent = '';
    $('#addrepo-path').focus();
  };
  $('#addrepo-go').onclick = addRepoFromForm;
  $('#addrepo-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') addRepoFromForm(); });
```

And the handler beside it:

```js
async function addRepoFromForm() {
  const input = $('#addrepo-path');
  const err = $('#addrepo-err');
  const path = input.value.trim();
  if (!path) return;
  err.textContent = '';
  const r = await api('/api/repos/add', { path });
  if (!r || !r.ok) { err.textContent = (r && r.error) || 'server unreachable'; return; }
  input.value = '';
  $('#addrepo-form').classList.add('hidden');
  toast(`Added ${path}`);
}
```

The guard is `!r.ok`, not `r.error`: `api()` returns `{}` on a transport failure, and a guard that only checks for an error field would treat that as success — the bug class fixed in `dd7c68a`.

- [ ] **Step 3: Add the remove control to listed repo groups**

In `public/app.js:101`, extend the repo group header so the control renders only when the repo came from the list:

```js
    const removeBtn = r.listed
      ? `<button class="repo-unlist" data-act="unlist-repo" data-path="${encodeURIComponent(r.repoPath)}" title="Remove ${esc(r.repo)} from the list (nothing on disk is deleted)">✕</button>`
      : '';
    return `<div class="repo-group"><div class="repo-name"><span class="repo-name-label">${esc(r.repo)}<span class="repo-count">${shown.length}</span></span><button class="repo-add" data-repo="${esc(r.repoPath)}" title="New worktree in ${esc(r.repo)}">+ worktree</button>${removeBtn}</div>${rows}</div>`;
```

In `doAction`, beside the other branches:

```js
  if (act === 'unlist-repo') {
    if (!confirm(`Remove ${path} from forest's list?\n\nNothing on disk is deleted — the repo, its worktrees and its .claude/ stay exactly as they are.`)) return;
    const r = await api('/api/repos/remove', { path });
    if (!r || !r.ok) { toast(`Remove failed: ${(r && r.error) || 'server unreachable'}`); return; }
    toast(`Removed ${path} from the list`);
    return;
  }
```

The button must carry `data-path` (URI-encoded), not `data-repo`: `doAction`'s first line is `const path = decodeURIComponent(ds.path);`, run unconditionally for every action. A button without `data-path` would make that `decodeURIComponent(undefined)`, which yields the string `"undefined"` rather than throwing — a silent wrong value. Using `data-path` also lets this branch use the same `path` local as every other branch.

- [ ] **Step 4: Verify in the browser**

1. Reload `http://localhost:5577` (the server serves `public/` statically; no restart needed).
2. Press `+ repo`, paste a path that is not a repo → the inline error shows the server's message and nothing is added.
3. Paste `/Users/egecan.sen/sahibinden/repo/SKLS/hektor` → the form closes and a `hektor` group appears with its worktrees.
4. The `hektor` group shows `✕`; a scanned group (e.g. `forest`) does not.
5. Press `✕`, confirm → the group disappears and `ls /Users/egecan.sen/sahibinden/repo/SKLS/hektor` still lists the repo untouched.

Record what you actually observed, including the exact error text from step 2.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/index.html public/style.css
git commit -m "feat(ui): add and remove repos from the header"
```

---

## Done criteria

- `node --test` green (111 baseline + 12 new).
- A repo two levels below a root, under a directory that is not a container, appears in the UI after being pasted into the form — the `SKLS/hektor` case that motivated this.
- Its group carries a remove control; a scanned group does not.
- Removing it takes the group out of the list and leaves every file on disk untouched.
- A malformed `repos.json` yields an empty list, a clear error on add, and the file's contents preserved byte for byte.
