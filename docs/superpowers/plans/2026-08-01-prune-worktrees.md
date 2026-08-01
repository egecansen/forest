# Prune Stale Worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-repo `prune` button that previews, then deletes, worktrees that are old **and** empty **and** unused — along with their branches.

**Architecture:** A new `lib/prune.mjs` owns the whole decision: a pure `prunable()` predicate, candidate selection, the guided command builder, and execution. Two thin endpoints in `lib/actions.mjs` call it; `public/app.js` renders a preview dialog. Two pre-existing gaps in `lib/discover.mjs` are fixed first, because the predicate is unsound without them.

**Tech Stack:** Node built-ins only (`node:test`, `node:assert/strict`, `node:child_process`), git CLI, vanilla DOM.

## Global Constraints

- **Zero dependencies.** Node built-ins only — nothing added to `package.json`.
- **Safe git only:** `git worktree remove` never with `--force`; `git branch -d` never `-D`.
- **Local only.** No remote branch is ever deleted.
- **Never the primary worktree.** Same posture as `/api/worktree/remove` (`lib/actions.mjs:92`).
- **Keep-reason vocabulary, exactly:** `primary`, `locked`, `agent-running`, `dirty`, `has-commits`, `too-recent`.
- **Guided vs Auto:** guided hands a command chain to `runInTerminal`; auto runs in-process and broadcasts a fresh snapshot. Follow `/api/worktree/remove`.
- **The agent does not commit** (project rule `never-commit`). Each task ends by handing the working tree back.
- **Reference spec:** `docs/superpowers/specs/2026-08-01-prune-worktrees-design.md`

---

## File Structure

- **Create: `lib/prune.mjs`** — the predicate, candidate selection, command builder, executor. Every prune decision lives here; the endpoints stay dumb.
- **Create: `lib/prune.test.mjs`** — unit tests for the predicate, real-repo tests for the executor.
- **Modify: `lib/discover.mjs:82-90, 99-120`** — propagate `locked`; compute ahead/behind/merged for detached worktrees.
- **Modify: `lib/discover.test.mjs`** — regression tests for both fixes.
- **Modify: `lib/actions.mjs`** — two endpoints.
- **Modify: `lib/actions.test.mjs`** — assert the endpoints delegate to `prune.mjs`.
- **Modify: `public/app.js`, `public/style.css`** — button + dialog.

---

### Task 1: Fix the two `discover.mjs` gaps

The predicate reads `locked` and `ahead`. Today one is absent and the other lies for detached worktrees. Both tests must fail before the fix.

**Files:**
- Modify: `lib/discover.mjs:82-90` (ahead/merged guard), `lib/discover.mjs:99-120` (record fields)
- Test: `lib/discover.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: worktree records carrying `locked: boolean`, and truthful `ahead` / `behind` / `merged` for detached worktrees.

- [ ] **Step 1: Write the failing tests**

Append to `lib/discover.test.mjs` (the file already imports `buildSnapshot`, `createRegistry`, `makeRepoWithWorktree`; add `commitFile` and `git` to the existing `finish-fixtures.mjs` import, and `rm` to the `node:fs/promises` import):

```js
// Snapshot one repo via repoList (roots: [] keeps the scan away from tmpdir).
async function snapOf(repo) {
  return buildSnapshot(
    { roots: [], containers: [], staleDays: 14 },
    { registry: createRegistry(), nowMs: Date.now(), claudeProjectsDir: '/nonexistent-forest-test', repoList: [repo] },
  );
}

test('buildSnapshot reports a locked worktree as locked', async () => {
  const { repo, wt } = await makeRepoWithWorktree({ branch: 'tech/WEBT-901' });
  await git(repo, 'worktree', 'lock', wt);
  const snap = await snapOf(repo);
  const rec = snap.repos[0].worktrees.find((w) => !w.isPrimary);
  assert.equal(rec.locked, true, 'locked must reach the snapshot record');
  await git(repo, 'worktree', 'unlock', wt);
  await rm(repo, { recursive: true, force: true });
});

test('buildSnapshot counts commits on a DETACHED worktree', async () => {
  const { repo, wt } = await makeRepoWithWorktree({ branch: 'tech/WEBT-902' });
  await commitFile(wt, 'work.txt', 'unmerged\n', 'work not in master');
  await git(wt, 'switch', '--detach');
  const snap = await snapOf(repo);
  const rec = snap.repos[0].worktrees.find((w) => !w.isPrimary);
  assert.equal(rec.detached, true, 'fixture must be detached');
  assert.ok(rec.ahead > 0, 'a detached worktree holding unmerged commits must report ahead > 0');
  assert.equal(rec.merged, false, 'unmerged detached HEAD must not be reported as merged');
  await rm(repo, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run them and watch both fail**

Run: `node --test lib/discover.test.mjs`
Expected: FAIL — `locked` is `undefined` (record never copies it), and `ahead` is `0` because `discover.mjs:83` skips the computation for detached worktrees.

- [ ] **Step 3: Fix the ahead/merged guard**

In `lib/discover.mjs`, replace the block at lines 82-90:

```js
  let ahead = 0, behind = 0, merged = false, lastCommitMs = 0;
  if (wt.branch || wt.detached) {
    const ab = await safe(() => runGit(path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]), '0\t0');
    ({ ahead, behind } = parseAheadBehind(ab));
    // A branch resolves from the primary checkout; a detached HEAD only
    // resolves from inside the worktree that holds it.
    merged = await safe(async () => {
      await runGit(wt.branch ? repoPath : path, ['merge-base', '--is-ancestor', wt.branch || 'HEAD', base]);
      return true;
    }, false);
  }
```

- [ ] **Step 4: Propagate `locked`**

In the object returned by `buildWorktreeRecord` (`lib/discover.mjs:99-120`), add the field directly after `detached`:

```js
    detached: wt.detached,
    locked: wt.locked,
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, 139+ tests. The two new tests pass and no existing test regresses — pay attention to `discover.test.mjs` and `finish.test.mjs`, which assert on snapshot shape.

- [ ] **Step 6: Hand back**

Do not commit. Report: `locked` now reaches the record, detached worktrees report real counts, full suite green.

---

### Task 2: The `prunable` predicate

**Files:**
- Create: `lib/prune.mjs`
- Create: `lib/prune.test.mjs`

**Interfaces:**
- Consumes: worktree records from Task 1 (`isPrimary`, `locked`, `agent.state`, `status.dirty`, `ahead`, `ageDays`).
- Produces:
  - `prunable(wt, { staleDays }) -> { ok: true } | { ok: false, reason: string }`
  - `selectCandidates(worktrees, { staleDays }) -> { candidates: wt[], kept: [{ path, reason }] }`

- [ ] **Step 1: Write the failing tests**

Create `lib/prune.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prunable, selectCandidates } from './prune.mjs';

// A worktree that satisfies every condition; override one field per test.
const wt = (over = {}) => ({
  path: '/tmp/wt/tech-WEBT-1',
  branch: 'tech/WEBT-1',
  isPrimary: false,
  locked: false,
  detached: false,
  agent: { state: 'idle' },
  status: { dirty: false },
  ahead: 0,
  ageDays: 30,
  ...over,
});
const OPTS = { staleDays: 14 };

test('prunable: old, empty and unused is prunable', () => {
  assert.deepEqual(prunable(wt(), OPTS), { ok: true });
});

test('prunable: the primary worktree is never prunable', () => {
  assert.deepEqual(prunable(wt({ isPrimary: true }), OPTS), { ok: false, reason: 'primary' });
});

test('prunable: a locked worktree is kept', () => {
  assert.deepEqual(prunable(wt({ locked: true }), OPTS), { ok: false, reason: 'locked' });
});

test('prunable: a running agent keeps the worktree', () => {
  assert.deepEqual(prunable(wt({ agent: { state: 'running' } }), OPTS), { ok: false, reason: 'agent-running' });
});

test('prunable: idle and unknown agents do not block', () => {
  assert.equal(prunable(wt({ agent: { state: 'unknown' } }), OPTS).ok, true);
});

test('prunable: uncommitted changes keep the worktree', () => {
  assert.deepEqual(prunable(wt({ status: { dirty: true } }), OPTS), { ok: false, reason: 'dirty' });
});

test('prunable: commits of its own keep the worktree', () => {
  assert.deepEqual(prunable(wt({ ahead: 2 }), OPTS), { ok: false, reason: 'has-commits' });
});

test('prunable: younger than staleDays is kept', () => {
  assert.deepEqual(prunable(wt({ ageDays: 3 }), OPTS), { ok: false, reason: 'too-recent' });
});

test('prunable: exactly staleDays old is prunable', () => {
  assert.equal(prunable(wt({ ageDays: 14 }), OPTS).ok, true);
});

test('prunable: no commit at all counts as too-recent, never as old', () => {
  assert.deepEqual(prunable(wt({ ageDays: null }), OPTS), { ok: false, reason: 'too-recent' });
});

test('prunable: a missing agent field does not crash', () => {
  assert.equal(prunable(wt({ agent: undefined }), OPTS).ok, true);
});

test('selectCandidates splits and explains', () => {
  const out = selectCandidates([
    wt({ path: '/a' }),
    wt({ path: '/b', status: { dirty: true } }),
    wt({ path: '/c', isPrimary: true }),
  ], OPTS);
  assert.deepEqual(out.candidates.map((w) => w.path), ['/a']);
  assert.deepEqual(out.kept, [{ path: '/b', reason: 'dirty' }, { path: '/c', reason: 'primary' }]);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test lib/prune.test.mjs`
Expected: FAIL — `Cannot find module './prune.mjs'`.

- [ ] **Step 3: Write `lib/prune.mjs`**

```js
// lib/prune.mjs — decides which worktrees are safe to delete, and deletes them.
// The rule is deliberately conservative: old AND empty AND unused, all three.
// Worst case we remove a checkout the user must re-create; we never remove one
// holding work.

// Order matters only in that the first failing condition names the reason.
export function prunable(wt, { staleDays }) {
  if (wt.isPrimary) return { ok: false, reason: 'primary' };
  if (wt.locked) return { ok: false, reason: 'locked' };
  if (wt.agent?.state === 'running') return { ok: false, reason: 'agent-running' };
  if (wt.status?.dirty) return { ok: false, reason: 'dirty' };
  if ((wt.ahead ?? 0) > 0) return { ok: false, reason: 'has-commits' };
  // ageDays === null means "no commit to date it by" — treat as too recent, so
  // a freshly created empty worktree is never swept up.
  if (wt.ageDays == null || wt.ageDays < staleDays) return { ok: false, reason: 'too-recent' };
  return { ok: true };
}

export function selectCandidates(worktrees, { staleDays }) {
  const candidates = [];
  const kept = [];
  for (const wt of worktrees) {
    const v = prunable(wt, { staleDays });
    if (v.ok) candidates.push(wt);
    else kept.push({ path: wt.path, reason: v.reason });
  }
  return { candidates, kept };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `node --test lib/prune.test.mjs`
Expected: PASS, 12 tests.

- [ ] **Step 5: Hand back**

Do not commit. Report the predicate is implemented with a case per keep-reason.

---

### Task 3: Execution — remove worktrees, delete branches

**Files:**
- Modify: `lib/prune.mjs`
- Modify: `lib/prune.test.mjs`

**Interfaces:**
- Consumes: `prunable`, `selectCandidates` (Task 2); `runGit(cwd, args)` from `./git.mjs`.
- Produces:
  - `pruneCommands({ repoPath, targets }) -> string[]` where `targets` is `[{ path, branch, detached }]`
  - `pruneWorktrees({ repoPath, paths, worktrees, staleDays, onStep }) -> { removed: [{path, branch}], skipped: [{path, reason}], failed: [{path, step, error}] }`
  - `dirSizeBytes(path) -> number | null`

- [ ] **Step 1: Write the failing tests**

Append to `lib/prune.test.mjs` (extend the imports as shown):

```js
import { pruneCommands, pruneWorktrees, dirSizeBytes } from './prune.mjs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRepoWithWorktree, commitFile, git } from './finish-fixtures.mjs';

const wtCount = (porcelain) => porcelain.split('\n').filter((l) => l.startsWith('worktree ')).length;

// Build the record shape pruneWorktrees re-validates against.
const rec = (path, branch, over = {}) => ({
  path, branch, isPrimary: false, locked: false, detached: false,
  agent: { state: 'idle' }, status: { dirty: false }, ahead: 0, ageDays: 30, ...over,
});

test('pruneCommands builds a safe chain, and never -D or --force', () => {
  const cmds = pruneCommands({
    repoPath: '/r',
    targets: [{ path: '/w/a', branch: 'tech/A', detached: false }, { path: '/w/b', branch: null, detached: true }],
  });
  assert.deepEqual(cmds, [
    `git -C '/r' worktree remove '/w/a'`,
    `git -C '/r' branch -d 'tech/A'`,
    `git -C '/r' worktree remove '/w/b'`,
  ]);
  assert.ok(!cmds.join(' ').includes('-D'), 'must never force-delete a branch');
  assert.ok(!cmds.join(' ').includes('--force'), 'must never force-remove a worktree');
});

test('pruneWorktrees removes a merged worktree and its branch', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree({ branch: 'tech/WEBT-903' });
  const res = await pruneWorktrees({
    repoPath: repo, paths: [wt], worktrees: [rec(wt, branch)], staleDays: 14,
  });
  assert.deepEqual(res.failed, [], 'no step should fail');
  assert.deepEqual(res.removed.map((r) => r.path), [wt]);
  assert.equal(wtCount(await git(repo, 'worktree', 'list', '--porcelain')), 1, 'only the primary remains');
  assert.equal((await git(repo, 'branch', '--list', branch)).trim(), '', 'branch is gone');
  await rm(repo, { recursive: true, force: true });
});

test('pruneWorktrees re-validates and skips one that turned dirty', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree({ branch: 'tech/WEBT-904' });
  // The record says clean (what the preview saw); it is dirty by now.
  await writeFile(join(wt, 'a.txt'), 'edited after preview\n');
  const res = await pruneWorktrees({
    repoPath: repo, paths: [wt], worktrees: [rec(wt, branch, { status: { dirty: true } })], staleDays: 14,
  });
  assert.deepEqual(res.skipped, [{ path: wt, reason: 'dirty' }]);
  assert.deepEqual(res.removed, []);
  assert.equal(wtCount(await git(repo, 'worktree', 'list', '--porcelain')), 2, 'worktree survives');
  await rm(repo, { recursive: true, force: true });
});

test('pruneWorktrees refuses a path it was not asked about', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree({ branch: 'tech/WEBT-905' });
  const res = await pruneWorktrees({
    repoPath: repo, paths: ['/etc'], worktrees: [rec(wt, branch)], staleDays: 14,
  });
  assert.deepEqual(res.removed, [], 'a path with no matching record is never touched');
  assert.equal(wtCount(await git(repo, 'worktree', 'list', '--porcelain')), 2);
  await rm(repo, { recursive: true, force: true });
});

test('pruneWorktrees on a detached worktree deletes no branch', async () => {
  const { repo, wt } = await makeRepoWithWorktree({ branch: 'tech/WEBT-906' });
  await git(wt, 'switch', '--detach');
  const steps = [];
  const res = await pruneWorktrees({
    repoPath: repo, paths: [wt], worktrees: [rec(wt, null, { detached: true })], staleDays: 14,
    onStep: (s) => steps.push(s.cmd),
  });
  assert.deepEqual(res.failed, []);
  assert.ok(!steps.join(' ').includes('branch -d'), 'nothing to delete when detached');
  assert.equal(wtCount(await git(repo, 'worktree', 'list', '--porcelain')), 1);
  await rm(repo, { recursive: true, force: true });
});

test('pruneWorktrees keeps the branch when worktree removal fails', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree({ branch: 'tech/WEBT-907' });
  await rm(wt, { recursive: true, force: true });   // git worktree remove now fails validation
  const res = await pruneWorktrees({
    repoPath: repo, paths: [wt], worktrees: [rec(wt, branch)], staleDays: 14,
  });
  assert.equal(res.failed.length, 1, 'removal failure is reported');
  assert.equal(res.failed[0].step, 'worktree-remove');
  assert.notEqual((await git(repo, 'branch', '--list', branch)).trim(), '', 'branch must survive a failed removal');
  await rm(repo, { recursive: true, force: true });
});

test('one failing candidate does not stop the next', async () => {
  const a = await makeRepoWithWorktree({ branch: 'tech/WEBT-908' });
  const second = join(a.repo, '.forest', 'wt', 'tech-WEBT-909');
  await git(a.repo, 'worktree', 'add', '-b', 'tech/WEBT-909', second, 'HEAD');
  await rm(a.wt, { recursive: true, force: true });  // first one will fail
  const res = await pruneWorktrees({
    repoPath: a.repo, paths: [a.wt, second], staleDays: 14,
    worktrees: [rec(a.wt, a.branch), rec(second, 'tech/WEBT-909')],
  });
  assert.equal(res.failed.length, 1);
  assert.deepEqual(res.removed.map((r) => r.path), [second], 'the healthy one is still pruned');
  await rm(a.repo, { recursive: true, force: true });
});

test('dirSizeBytes measures a directory and returns null for a missing one', async () => {
  const { repo } = await makeRepoWithWorktree({ branch: 'tech/WEBT-910' });
  assert.ok((await dirSizeBytes(repo)) > 0, 'a real directory has a size');
  assert.equal(await dirSizeBytes('/nonexistent-forest-path'), null, 'missing path yields null, never a throw');
  await rm(repo, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test lib/prune.test.mjs`
Expected: FAIL — `pruneCommands`, `pruneWorktrees` and `dirSizeBytes` are not exported.

- [ ] **Step 3: Implement, appending to `lib/prune.mjs`**

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runGit } from './git.mjs';

const execFileP = promisify(execFile);
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Guided mode shows the user exactly what auto mode would run.
export function pruneCommands({ repoPath, targets }) {
  const out = [];
  for (const t of targets) {
    out.push(`git -C ${shQuote(repoPath)} worktree remove ${shQuote(t.path)}`);
    if (!t.detached && t.branch) out.push(`git -C ${shQuote(repoPath)} branch -d ${shQuote(t.branch)}`);
  }
  return out;
}

// `du -sk` on demand. The snapshot's sizeBytes is always null (server.mjs
// creates the sizes map and never fills it), and filling it on the 4s loop
// would add a du per worktree to the very storm pruning exists to reduce.
export async function dirSizeBytes(path) {
  try {
    const { stdout } = await execFileP('du', ['-sk', path]);
    const kb = parseInt(stdout.trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

// Deletes only what still satisfies `prunable` at this moment, re-checked
// against freshly-read records — never on the evidence the preview showed,
// which may be seconds stale.
export async function pruneWorktrees({ repoPath, paths, worktrees, staleDays, onStep = () => {} }) {
  const removed = [], skipped = [], failed = [];
  const byPath = new Map(worktrees.map((w) => [w.path, w]));

  for (const path of paths) {
    const wt = byPath.get(path);
    // No record for this path: it is not a worktree of this repo as far as we
    // know, so it is not ours to delete.
    if (!wt) { skipped.push({ path, reason: 'unknown' }); continue; }
    const v = prunable(wt, { staleDays });
    if (!v.ok) { skipped.push({ path, reason: v.reason }); continue; }

    const rmArgs = ['worktree', 'remove', path];
    onStep({ cmd: `git worktree remove ${path}`, cwd: repoPath });
    try {
      await runGit(repoPath, rmArgs);
    } catch (e) {
      // Branch deletion is skipped deliberately: a deleted branch with a
      // surviving worktree is worse than an un-pruned pair.
      failed.push({ path, step: 'worktree-remove', error: String(e) });
      continue;
    }

    if (!wt.detached && wt.branch) {
      onStep({ cmd: `git branch -d ${wt.branch}`, cwd: repoPath });
      try {
        await runGit(repoPath, ['branch', '-d', wt.branch]);
      } catch (e) {
        // -d refusing here means the predicate was wrong about this branch.
        // The worktree is already gone; report and keep going.
        failed.push({ path, step: 'branch-delete', error: String(e) });
      }
    }
    removed.push({ path, branch: wt.branch ?? null });
  }
  return { removed, skipped, failed };
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `node --test lib/prune.test.mjs`
Expected: PASS, 20 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. Nothing else imports `prune.mjs` yet, so no regression is possible; a failure here means a fixture leaked a temp dir.

- [ ] **Step 6: Hand back**

Do not commit. Report execution implemented, including re-validation, the unknown-path refusal, and branch-survives-failed-removal.

---

### Task 4: The two endpoints

**Files:**
- Modify: `lib/actions.mjs` (imports; two new route blocks beside `/api/repos/remove`, around line 232)
- Modify: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: `selectCandidates`, `pruneCommands`, `pruneWorktrees`, `dirSizeBytes` (Tasks 2-3); `ctx.snapshot()`, `ctx.journal`, `ctx.broadcast`, `ctx.config.staleDays`, `runInTerminal`.
- Produces: `POST /api/repo/prune-preview` and `POST /api/repo/prune`.

- [ ] **Step 1: Write the failing test**

Append to `lib/actions.test.mjs`, following the source-assertion style already used there (`actions.test.mjs:10-14`) — these routes are HTTP glue whose logic lives in `prune.mjs`, and the guarantees worth locking are that the glue delegates and never forces:

```js
test('prune endpoints delegate to prune.mjs and never force', async () => {
  const src = await readFile(new URL('./actions.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('/api/repo/prune-preview'), 'preview route must exist');
  assert.ok(src.includes('/api/repo/prune'), 'prune route must exist');
  assert.ok(src.includes('pruneWorktrees'), 'execution must delegate to prune.mjs');
  assert.ok(src.includes('selectCandidates'), 'candidate choice must delegate to prune.mjs');
  assert.ok(!/worktree'\s*,\s*'remove'[^\]]*--force/.test(src), 'no forced worktree removal');
  assert.ok(!src.includes(`'branch', '-D'`), 'no forced branch deletion');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test lib/actions.test.mjs`
Expected: FAIL on the first assertion — the route does not exist.

- [ ] **Step 3: Add the import to `lib/actions.mjs`**

Beside the existing `import { addRepo, removeRepo, repoErrorMessage } from './repos.mjs';` (line 12):

```js
import { selectCandidates, pruneCommands, pruneWorktrees, dirSizeBytes } from './prune.mjs';
```

- [ ] **Step 4: Add both routes, immediately after the `/api/repos/remove` block (after line 232)**

```js
      if (url === '/api/repo/prune-preview') {
        const { repoPath } = body;
        const snap = await ctx.snapshot();
        const repo = snap.repos.find((r) => r.repoPath === repoPath);
        if (!repo) return sendJson(res, { error: 'unknown repo' }, 404);
        const { candidates, kept } = selectCandidates(repo.worktrees, { staleDays: ctx.config.staleDays });
        const withSizes = await Promise.all(candidates.map(async (w) => ({
          path: w.path,
          branch: w.branch,
          detached: w.detached,
          ageDays: w.ageDays,
          sizeBytes: await dirSizeBytes(w.path),
        })));
        return sendJson(res, { candidates: withSizes, kept });
      }

      if (url === '/api/repo/prune') {
        const { repoPath, paths = [] } = body;
        if (!paths.length) return sendJson(res, { error: 'nothing selected' }, 400);
        const snap = await ctx.snapshot();
        const repo = snap.repos.find((r) => r.repoPath === repoPath);
        if (!repo) return sendJson(res, { error: 'unknown repo' }, 404);
        const staleDays = ctx.config.staleDays;

        if (mode === 'guided') {
          // Re-select from the fresh snapshot so the terminal never gets a
          // command for something that stopped qualifying.
          const { candidates } = selectCandidates(repo.worktrees, { staleDays });
          const targets = candidates.filter((w) => paths.includes(w.path));
          if (!targets.length) return sendJson(res, { error: 'nothing left to prune' }, 400);
          const command = pruneCommands({ repoPath, targets }).join(' && ');
          ctx.journal.add({ cmd: command, cwd: repoPath, mode });
          runInTerminal({ command, cwd: repoPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }

        const result = await pruneWorktrees({
          repoPath, paths, worktrees: repo.worktrees, staleDays,
          onStep: (s) => ctx.journal.add({ cmd: s.cmd, cwd: s.cwd, mode }),
        });
        for (const f of result.failed) ctx.journal.add({ cmd: `prune failed (${f.step}): ${f.path} — ${f.error}`, cwd: repoPath, mode });
        for (const s of result.skipped) ctx.journal.add({ cmd: `prune skipped: ${s.path} (${s.reason})`, cwd: repoPath, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, ...result });
      }
```

- [ ] **Step 5: Run and watch it pass**

Run: `node --test lib/actions.test.mjs`
Expected: PASS.

- [ ] **Step 6: Exercise the preview against a real repo**

With the server running (`bin/forest up`), pick a repo path out of the live snapshot and preview it — read-only, deletes nothing:

```bash
repo="$(curl -s http://127.0.0.1:5577/api/worktrees | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.repos.find(r=>r.worktrees.length>1)?.repoPath||j.repos[0].repoPath)})')"
echo "repo: $repo"
curl -s -X POST http://127.0.0.1:5577/api/repo/prune-preview \
  -H 'content-type: application/json' -d "{\"repoPath\":\"$repo\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("candidates:",j.candidates?.length);for(const c of j.candidates||[])console.log(" ",c.branch,c.ageDays+"d",c.sizeBytes);const by={};for(const k of j.kept||[])by[k.reason]=(by[k.reason]||0)+1;console.log("kept:",by)})'
```
Expected: a candidate count and a keep-reason tally. Zero candidates is a legitimate result — verify the `kept` tally explains why rather than assuming the endpoint is broken.

- [ ] **Step 7: Run the full suite and hand back**

Run: `npm test`
Expected: PASS. Do not commit; report both endpoints live and the preview's real output on this machine.

---

### Task 5: The button and the dialog

**Files:**
- Modify: `public/app.js` (repo header at line 132; a `prune` branch in the click handler beside `unlist-repo` at line 332)
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `POST /api/repo/prune-preview`, `POST /api/repo/prune` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Add the button to the repo header**

In `public/app.js`, in the template returned at line 132, insert the prune button between the existing `+ worktree` button and `${removeBtn}`:

```js
<button class="repo-prune" data-act="prune-repo" data-repo="${esc(r.repoPath)}" title="Remove merged, clean worktrees older than ${esc(String(state.config?.staleDays ?? 14))} days, and their branches">prune</button>
```

`state.config` is populated at boot from `/api/config` (`public/app.js:693`), so `staleDays` is available at render time; the `?? 14` covers the first paint before that fetch resolves.

- [ ] **Step 2: Handle the click**

Beside the `unlist-repo` handler (around line 332), add:

```js
if (act === 'prune-repo') {
  const repoPath = el.dataset.repo;
  const pv = await api('/api/repo/prune-preview', { repoPath });
  if (pv.error) return toast(`prune: ${pv.error}`);
  const kept = {};
  for (const k of pv.kept || []) kept[k.reason] = (kept[k.reason] || 0) + 1;
  const keptLine = Object.entries(kept).map(([r, n]) => `${n} ${r}`).join(', ') || 'none';
  if (!(pv.candidates || []).length) {
    return alert(`Nothing to prune.\n\nKept ${(pv.kept || []).length}: ${keptLine}.`);
  }
  const mb = (b) => (b == null ? '—' : `${Math.round(b / 1e6)} MB`);
  const list = pv.candidates
    .map((c) => `  ${c.branch || '(detached)'}   ${c.ageDays}d   ${mb(c.sizeBytes)}`)
    .join('\n');
  const ok = confirm(
    `Prune ${pv.candidates.length} worktree(s)?\n\n${list}\n\n`
    + `Branches are deleted with \`git branch -d\` (merged only).\n`
    + `Kept ${(pv.kept || []).length}: ${keptLine}.`,
  );
  if (!ok) return;
  const r = await api('/api/repo/prune', { repoPath, paths: pv.candidates.map((c) => c.path) });
  if (r.error) return toast(`prune: ${r.error}`);
  if (r.failed?.length) toast(`Pruned ${r.removed.length}, ${r.failed.length} failed — see the journal.`);
}
```

`api(path, body)` is the existing POST helper (`public/app.js:10`) and already toasts on network failure; `toast()` is the file's error channel. `confirm()` is used for the decision itself, matching the existing destructive-action handlers at `app.js:263, 332, 344-345`.

- [ ] **Step 3: Style the button in `public/style.css`**

Find the existing `.repo-add` rule and add `.repo-prune` to its selector list so the two buttons match, then give prune its own restrained accent:

```css
.repo-prune { opacity: .75; }
.repo-prune:hover { opacity: 1; }
```

- [ ] **Step 4: Verify in the browser**

Run `bin/forest restart`, open http://127.0.0.1:5577, and check, in order:
1. Every repo header shows `prune` beside `+ worktree`.
2. Clicking it on a repo with no candidates gives the "Nothing to prune" alert with a keep-reason tally — **and deletes nothing** (confirm the worktree count in the UI is unchanged).
3. Clicking Cancel on a repo *with* candidates deletes nothing.
4. Only if you choose to: confirm on one repo, then verify the pruned worktrees disappear from the UI and the journal shows one line per git command.

- [ ] **Step 5: Full suite and hand back**

Run: `npm test`
Expected: PASS, unchanged from Task 4 (no JS test covers `public/`).
Do not commit. Report what the preview found on the real repos.

---

## Self-Review

**Spec coverage:** predicate + keep-reasons → Task 2. `locked` propagation and the detached `ahead` fix → Task 1. Preview endpoint with on-demand `du` → Tasks 3-4. Execution order, no-force, skip-branch-on-failed-removal, per-item outcomes → Task 3. Re-validation against a fresh snapshot → Task 3 (`pruneWorktrees`) and Task 4 (both routes re-snapshot). Guided vs Auto → Task 4. UI button, dialog, empty state → Task 5. Tests → Tasks 1-3. Out-of-scope items (remote branches, all-repos prune, per-row checkboxes) appear nowhere.

**Placeholder scan:** no TBD/TODO. Task 5 originally deferred two names to the implementer; both were looked up and pinned instead — `api()` (`app.js:10`) for POST, `toast()` for errors, `state.config.staleDays` (`app.js:693`) for the threshold.

**Type consistency:** `prunable(wt, {staleDays})` returns `{ok}`/`{ok,reason}` in Tasks 2, 3 and its tests. `selectCandidates` returns `{candidates, kept}` in Tasks 2 and 4. `pruneWorktrees` returns `{removed, skipped, failed}` and takes `{repoPath, paths, worktrees, staleDays, onStep}` in Tasks 3 and 4 alike. `targets` entries are `{path, branch, detached}` in `pruneCommands` in both Task 3 and Task 4. Keep-reason strings match the Global Constraints vocabulary everywhere, plus `unknown` for a path with no record — which is a *skip* reason, not a keep-reason, and never shown as one.

**Known deviation:** no commit steps, per the project's `never-commit` rule.
