# Finish Worktree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repeatable "Finish" operation — land a worktree's branch into the main checkout (switch-or-merge), carry uncommitted changes, optionally remove the worktree — exposed as a forest UI button and an idea-worktrees IntelliJ action.

**Architecture:** The algorithm (spec: `docs/superpowers/specs/2026-07-23-finish-worktree-design.md`, in this repo) is implemented twice, natively per tool: a new `lib/finish.mjs` module in forest (Node, wired into the existing action router + web UI), and new `GitWorktreeService` methods + action/dialog in the IntelliJ plugin (Kotlin). Milestone 2 adds Eject (undo) and a safety ref before worktree deletion.

**Tech Stack:** forest — plain Node ESM, `node:test`, no deps. Plugin — Kotlin 2.1/JVM 21, IntelliJ Platform Gradle Plugin 2.7.1 targeting IC 2025.1.4.1, `BasePlatformTestCase` + real git fixture repos.

## Global Constraints

- **NEVER `git commit` or `git push` in either repo.** Egecan reviews and commits manually. Wherever this plan says "Checkpoint", run the named verification and stop — do not commit. (This overrides the plan template's usual commit steps.)
- Spec is authoritative for semantics: `/Users/egecan.sen/sahibinden/repo/APPS/forest/docs/superpowers/specs/2026-07-23-finish-worktree-design.md`. Any semantic change lands in the spec first.
- The Finish operation itself must never create commits of user work (a merge commit produced by `git merge` is allowed) and never touches remotes.
- Merge, never rebase. Conflict is a clean stop, not an error: worktree intact, stash kept, "resolve in your IDE, then press Finish again."
- forest repo root: `/Users/egecan.sen/sahibinden/repo/APPS/forest`. Tests: `node --test` from that dir. Node built-ins only — no new npm dependencies.
- Plugin repo root: `/Users/egecan.sen/sahibinden/repo/APPS/idea-worktrees`. Tests: `./gradlew test` (JDK 21). Existing detekt config must stay green: `./gradlew detekt`.
- forest naming: worktree dir basename is `slug(branch)` where `slug = (b) => b.replace(/[^A-Za-z0-9._-]+/g, '-')`. Plugin naming match: basename equals sanitized branch OR `<projectName>-<sanitized branch>` (see `WorktreeOperations.suggestDirectoryName`).
- All new plugin git calls go through the service's existing `executeGitCommand(workingDir, vararg args)` (background-thread asserted, 30s timeout, returns `ProcessOutput`). All new forest git calls go through `runGit(cwd, args)` (throws the `execFile` error object on non-zero exit; `.stderr` available on the error).

---

# Part 1 — forest (Milestone 1)

### Task 1: `lib/finish.mjs` — preview + guided-command generation

**Files:**
- Create: `lib/finish.mjs`
- Test: `lib/finish.test.mjs`

**Interfaces:**
- Consumes: `runGit`, `parseStatus` from `./git.mjs`.
- Produces (used by Tasks 2–4):
  - `slug(branch: string): string`
  - `async previewFinish({repoPath, path}): Promise<Preview>` where `Preview = { worktreeName, branch: string|null, detached: boolean, head: string, dirty: boolean, dirtyCount: number, targetBranch: string|null, nameMismatch: boolean, candidates: string[], mainBranch: string|null, relanding: boolean, mergeInProgress: boolean }`
  - `finishCommands({repoPath, path, targetBranch, remove, preview}): string[]` — pre-quoted shell commands for guided mode.

- [ ] **Step 1: Write the failing tests** — `lib/finish.test.mjs`. The suite's first real-git fixture helper lives at the top of this file and is reused by Task 2's tests:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { slug, previewFinish, finishCommands, executeFinish } from './finish.mjs';

const execFileP = promisify(execFile);
export async function git(cwd, ...args) {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args]);
  return stdout;
}
// Fixture: a primary repo with one commit on master and a worktree at
// .forest/wt/<slug(branch)> holding <branch>. Caller must rm() it.
export async function makeRepoWithWorktree({ branch = 'tech/WEBT-1' } = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'forest-finish-'));
  await git(repo, 'init', '-b', 'master');
  await git(repo, 'config', 'user.email', 't@t');
  await git(repo, 'config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'base\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  const wt = join(repo, '.forest', 'wt', slug(branch));
  await git(repo, 'worktree', 'add', '-b', branch, wt, 'HEAD');
  return { repo, wt, branch };
}
export async function commitFile(cwd, name, content, msg) {
  await writeFile(join(cwd, name), content);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', msg);
}

test('slug matches forest worktree naming', () => {
  assert.equal(slug('tech/WEBT-251448'), 'tech-WEBT-251448');
});

test('previewFinish: clean matching worktree — no prompt case', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    const p = await previewFinish({ repoPath: repo, path: wt });
    assert.equal(p.branch, branch);
    assert.equal(p.detached, false);
    assert.equal(p.targetBranch, branch);
    assert.equal(p.nameMismatch, false);
    assert.equal(p.dirty, false);
    assert.equal(p.mainBranch, 'master');
    assert.equal(p.relanding, false);
    assert.equal(p.mergeInProgress, false);
    assert.match(p.head, /^[0-9a-f]{40}$/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('previewFinish: renamed branch inside worktree — mismatch with two candidates', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  try {
    await git(wt, 'switch', '-c', 'fix/other-name');
    const p = await previewFinish({ repoPath: repo, path: wt });
    assert.equal(p.nameMismatch, true);
    assert.deepEqual(p.candidates, ['fix/other-name', basename(wt)]);
    assert.equal(p.targetBranch, 'fix/other-name'); // branch name is the default
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('previewFinish: detached worktree resolves same-named branch, flags relanding', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await git(wt, 'switch', '--detach');
    await git(repo, 'switch', branch);
    const p = await previewFinish({ repoPath: repo, path: wt });
    assert.equal(p.detached, true);
    assert.equal(p.targetBranch, branch);
    assert.equal(p.relanding, true);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('previewFinish: dirty count includes untracked', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  try {
    await writeFile(join(wt, 'new.txt'), 'x\n');
    await writeFile(join(wt, 'a.txt'), 'changed\n');
    const p = await previewFinish({ repoPath: repo, path: wt });
    assert.equal(p.dirty, true);
    assert.equal(p.dirtyCount, 2);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('finishCommands: full first-landing sequence, quoted, in order', () => {
  const preview = { worktreeName: 'tech-WEBT-1', branch: 'tech/WEBT-1', detached: false, head: 'abc123', dirty: true, mainBranch: 'master' };
  const cmds = finishCommands({ repoPath: '/r', path: '/r/.forest/wt/tech-WEBT-1', targetBranch: 'tech/WEBT-1', remove: true, preview });
  assert.deepEqual(cmds, [
    `git -C '/r/.forest/wt/tech-WEBT-1' stash push -u -m 'forest-finish tech-WEBT-1'`,
    `git -C '/r/.forest/wt/tech-WEBT-1' switch --detach`,
    `git -C '/r' switch 'tech/WEBT-1'`,
    `git -C '/r' merge --no-edit abc123`,
    `git -C '/r' merge-base --is-ancestor abc123 HEAD`,
    `git -C '/r' worktree remove '/r/.forest/wt/tech-WEBT-1'`,
    `git -C '/r' stash pop`,
  ]);
});

test('finishCommands: rename lands first when target differs; no stash/remove when clean/keep', () => {
  const preview = { worktreeName: 'tech-WEBT-1', branch: 'fix/other', detached: false, head: 'abc123', dirty: false, mainBranch: 'master' };
  const cmds = finishCommands({ repoPath: '/r', path: '/w', targetBranch: 'tech-WEBT-1', remove: false, preview });
  assert.deepEqual(cmds, [
    `git -C '/w' branch -m 'fix/other' 'tech-WEBT-1'`,
    `git -C '/w' switch --detach`,
    `git -C '/r' switch 'tech-WEBT-1'`,
    `git -C '/r' merge --no-edit abc123`,
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/egecan.sen/sahibinden/repo/APPS/forest && node --test lib/finish.test.mjs`
Expected: FAIL — `Cannot find module ... finish.mjs`.

- [ ] **Step 3: Implement `lib/finish.mjs` (preview + commands only; `executeFinish` is Task 2 — export a stub that throws so the import in the test file resolves)**

```js
// lib/finish.mjs — the Finish algorithm (spec: docs/superpowers/specs/2026-07-23-finish-worktree-design.md)
import { basename } from 'node:path';
import { runGit, parseStatus } from './git.mjs';

export const slug = (b) => b.replace(/[^A-Za-z0-9._-]+/g, '-');
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function tryGit(cwd, args) {
  try { return { ok: true, out: await runGit(cwd, args) }; }
  catch (e) { return { ok: false, err: e }; }
}

// Same-named branch for a detached worktree: the local branch whose slug
// equals the worktree dir name.
async function sameNamedBranch(repoPath, worktreeName) {
  const out = await runGit(repoPath, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']);
  return out.split('\n').filter(Boolean).find((b) => slug(b) === worktreeName) ?? null;
}

export async function previewFinish({ repoPath, path }) {
  const worktreeName = basename(path);
  const branchRaw = (await runGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const detached = branchRaw === 'HEAD';
  const branch = detached ? null : branchRaw;
  const head = (await runGit(path, ['rev-parse', 'HEAD'])).trim();
  const status = parseStatus(await runGit(path, ['status', '--porcelain']));
  const mainRaw = (await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const mainBranch = mainRaw === 'HEAD' ? null : mainRaw;
  const nameMismatch = !!branch && slug(branch) !== worktreeName;
  const targetBranch = detached ? await sameNamedBranch(repoPath, worktreeName) : branch;
  return {
    worktreeName, branch, detached, head,
    dirty: status.dirty, dirtyCount: status.changed,
    targetBranch, nameMismatch,
    candidates: nameMismatch ? [branch, worktreeName] : [],
    mainBranch,
    relanding: !!targetBranch && targetBranch === mainBranch,
    mergeInProgress: (await tryGit(repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok,
  };
}

// Guided mode: the linear happy-path sequence. Joined with ' && ' by the
// caller, so any failing step (incl. a merge conflict) stops the chain and
// leaves the user at their terminal to resolve — consistent with guided
// philosophy. Strings are pre-quoted per runInTerminal's contract.
export function finishCommands({ repoPath, path, targetBranch, remove, preview }) {
  const cmds = [];
  if (preview.branch && preview.branch !== targetBranch) {
    cmds.push(`git -C ${shQuote(path)} branch -m ${shQuote(preview.branch)} ${shQuote(targetBranch)}`);
  }
  if (preview.dirty) {
    cmds.push(`git -C ${shQuote(path)} stash push -u -m ${shQuote(`forest-finish ${preview.worktreeName}`)}`);
  }
  if (!preview.detached) cmds.push(`git -C ${shQuote(path)} switch --detach`);
  if (preview.mainBranch !== targetBranch) cmds.push(`git -C ${shQuote(repoPath)} switch ${shQuote(targetBranch)}`);
  cmds.push(`git -C ${shQuote(repoPath)} merge --no-edit ${preview.head}`);
  if (remove) {
    cmds.push(`git -C ${shQuote(repoPath)} merge-base --is-ancestor ${preview.head} HEAD`);
    cmds.push(`git -C ${shQuote(repoPath)} worktree remove ${shQuote(path)}`);
  }
  if (preview.dirty) cmds.push(`git -C ${shQuote(repoPath)} stash pop`);
  return cmds;
}

export async function executeFinish() { throw new Error('not implemented — Task 2'); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/egecan.sen/sahibinden/repo/APPS/forest && node --test lib/finish.test.mjs`
Expected: all Task 1 tests PASS. Then run the whole suite — `node --test` — expected: no regressions.

- [ ] **Step 5: Checkpoint** — do NOT commit (global constraint). Confirm `git -C /Users/egecan.sen/sahibinden/repo/APPS/forest status --short` shows only `lib/finish.mjs`, `lib/finish.test.mjs`, and the docs files.

---

### Task 2: `executeFinish` — the auto-mode orchestrator

**Files:**
- Modify: `lib/finish.mjs` (replace the stub)
- Test: `lib/finish.test.mjs` (append)

**Interfaces:**
- Produces (used by Task 3): `async executeFinish({repoPath, path, targetBranch?, remove = true, onStep = () => {}}): Promise<Result>` where `Result = { targetBranch, previousBranch, landed, merged: 'none'|'up-to-date'|'merged', conflict, removed, removeSkipped?: string, stashed, stashPopped, stashConflict? }`. `onStep({cmd, cwd})` fires before every git mutation (Task 3 journals through it). Throws on hard errors (e.g. merge in progress, unresolvable target) — conflict is NOT a throw.

- [ ] **Step 1: Append the failing tests** to `lib/finish.test.mjs`:

```js
test('executeFinish: first landing — main switches to branch, worktree removed', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await commitFile(wt, 'feat.txt', 'work\n', 'feat');
    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.targetBranch, branch);
    assert.equal(r.previousBranch, 'master');
    assert.equal(r.landed, true);
    assert.equal(r.merged, 'up-to-date'); // first landing: branch tip == worktree HEAD
    assert.equal(r.removed, true);
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), branch);
    assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).includes(wt), false);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: dirty worktree — changes arrive uncommitted in main', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  try {
    await writeFile(join(wt, 'wip.txt'), 'uncommitted\n');
    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.stashed, true);
    assert.equal(r.stashPopped, true);
    const st = await git(repo, 'status', '--porcelain');
    assert.match(st, /\?\? wip\.txt/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: keep worktree — left detached, still listed', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    const r = await executeFinish({ repoPath: repo, path: wt, remove: false });
    assert.equal(r.removed, false);
    assert.equal((await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'HEAD'); // detached
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), branch);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: re-landing merges detached worktree commits into the landed branch', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await executeFinish({ repoPath: repo, path: wt, remove: false }); // first landing
    await commitFile(wt, 'more.txt', 'round2\n', 'round2');           // agent continues, detached
    await commitFile(repo, 'own.txt', 'mine\n', 'my own commit');     // user advances the branch
    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.merged, 'merged');
    assert.equal(r.removed, true);
    const log = await git(repo, 'log', '--oneline');
    assert.match(log, /round2/);
    assert.match(log, /my own commit/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: conflict — clean stop, worktree kept, stash kept; second run resumes', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await executeFinish({ repoPath: repo, path: wt, remove: false });
    await commitFile(wt, 'a.txt', 'agent version\n', 'agent edit');
    await commitFile(repo, 'a.txt', 'user version\n', 'user edit');
    await writeFile(join(wt, 'wip.txt'), 'carried\n');
    const r1 = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r1.conflict, true);
    assert.equal(r1.removed, false);
    assert.equal(r1.stashPopped, false);
    assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).includes(wt), true);
    // user resolves in the IDE and commits the merge:
    await writeFile(join(repo, 'a.txt'), 'resolved\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '--no-edit');
    // Finish again — resumes: removal + stash pop
    const r2 = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r2.conflict, false);
    assert.equal(r2.removed, true);
    assert.equal(r2.stashPopped, true);
    assert.match(await git(repo, 'status', '--porcelain'), /\?\? wip\.txt/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: ancestor guard — unmerged worktree never removed', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  try {
    await executeFinish({ repoPath: repo, path: wt, remove: false });
    await commitFile(wt, 'a.txt', 'agent version\n', 'agent edit');
    await commitFile(repo, 'a.txt', 'user version\n', 'user edit');
    const r = await executeFinish({ repoPath: repo, path: wt }); // conflicts
    assert.equal(r.conflict, true);
    assert.equal(r.removed, false); // guard held: worktree commits not reachable
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: name mismatch — explicit targetBranch renames before landing', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  try {
    await git(wt, 'switch', '-c', 'fix/other-name');
    const r = await executeFinish({ repoPath: repo, path: wt, targetBranch: basename(wt) });
    assert.equal(r.targetBranch, basename(wt));
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), basename(wt));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: merge in progress in main — hard abort, nothing touched', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  try {
    await commitFile(repo, 'b.txt', 'x\n', 'main work');
    await git(repo, 'switch', '-c', 'other', 'master~0');
    // manufacture an in-progress conflicted merge in main
    await commitFile(repo, 'c.txt', 'ours\n', 'ours');
    await git(repo, 'switch', 'master');
    await commitFile(repo, 'c.txt', 'theirs\n', 'theirs');
    await git(repo, 'merge', 'other').catch(() => {});
    await assert.rejects(() => executeFinish({ repoPath: repo, path: wt }), /merge in progress/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test lib/finish.test.mjs`
Expected: Task 1 tests PASS; every `executeFinish` test FAILS with `not implemented — Task 2`.

- [ ] **Step 3: Replace the stub with the implementation** in `lib/finish.mjs`:

```js
export async function executeFinish({ repoPath, path, targetBranch, remove = true, onStep = () => {} }) {
  const git = async (cwd, args, { allowFail = false } = {}) => {
    onStep({ cmd: `git ${args.join(' ')}`, cwd });
    const r = await tryGit(cwd, args);
    if (!r.ok && !allowFail) throw r.err;
    return r;
  };

  const p = await previewFinish({ repoPath, path });
  if (p.mergeInProgress) throw new Error('main checkout has a merge in progress — resolve it first, then Finish again');
  targetBranch = targetBranch || p.targetBranch;
  if (!targetBranch) throw new Error(`cannot resolve a target branch for ${p.worktreeName}`);

  const result = {
    targetBranch, previousBranch: p.mainBranch,
    landed: false, merged: 'none', conflict: false,
    removed: false, stashed: false, stashPopped: false,
  };
  const stashMsg = `forest-finish ${p.worktreeName}`;

  // 1. naming (spec step 1) — rename only when an explicit different name was chosen
  if (p.branch && p.branch !== targetBranch) await git(path, ['branch', '-m', p.branch, targetBranch]);
  // 2. stash carry
  if (p.dirty) { await git(path, ['stash', 'push', '-u', '-m', stashMsg]); result.stashed = true; }
  // 3. free the branch
  if (!p.detached) await git(path, ['switch', '--detach']);
  // 4. land — git-native dirty-main policy: a refusing `switch` throws and aborts loudly
  if (p.mainBranch !== targetBranch) {
    const exists = (await tryGit(repoPath, ['rev-parse', '-q', '--verify', `refs/heads/${targetBranch}`])).ok;
    await git(repoPath, exists ? ['switch', targetBranch] : ['switch', '-c', targetBranch, p.head]);
  }
  result.landed = true;
  // 5. combine
  const merge = await git(repoPath, ['merge', '--no-edit', p.head], { allowFail: true });
  if (!merge.ok) {
    const unmerged = (await tryGit(repoPath, ['ls-files', '-u']));
    if (unmerged.ok && unmerged.out.trim()) { result.conflict = true; return result; } // stash + worktree kept
    throw merge.err;
  }
  result.merged = /Already up to date/i.test(merge.out) ? 'up-to-date' : 'merged';
  // 6. remove, behind the ancestor guard
  if (remove) {
    const safe = (await tryGit(repoPath, ['merge-base', '--is-ancestor', p.head, 'HEAD'])).ok;
    if (safe) { await git(repoPath, ['worktree', 'remove', path]); result.removed = true; }
    else result.removeSkipped = `worktree commits not yet reachable from ${targetBranch}`;
  }
  // 7. pop the carried stash — ours by message, also from an earlier conflicted run
  const list = (await tryGit(repoPath, ['stash', 'list'])).out ?? '';
  const line = list.split('\n').find((l) => l.includes(stashMsg));
  if (line) {
    const ref = line.slice(0, line.indexOf(':'));
    const pop = await git(repoPath, ['stash', 'pop', ref], { allowFail: true });
    result.stashPopped = pop.ok;
    if (!pop.ok) result.stashConflict = true; // git keeps the stash entry on pop conflict
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/finish.test.mjs` — expected: all PASS. Then `node --test` — expected: full suite green.

- [ ] **Step 5: Checkpoint** — no commit. `git status --short` should still list only the finish files + docs.

---

### Task 3: API endpoints `/api/worktree/finish` + `/api/worktree/finish-preview`

**Files:**
- Modify: `lib/actions.mjs`

**Interfaces:**
- Consumes: `previewFinish`, `executeFinish`, `finishCommands` from `./finish.mjs` (Tasks 1–2); existing `ctx.journal`, `ctx.broadcast`, `ctx.snapshot`, `runInTerminal`, `sendJson`.
- Produces (used by Task 4's UI):
  - `POST /api/worktree/finish-preview` body `{repoPath, path}` → the `Preview` object (or `{error}` 500).
  - `POST /api/worktree/finish` body `{repoPath, path, targetBranch?, remove?, isPrimary?, mode?}` → guided: `{mode, command}`; auto: `{mode, ...Result}`; primary guard: `{error}` 400.

- [ ] **Step 1: Add the import** at the top of `lib/actions.mjs`, and delete the local `slug` const in favor of the shared one:

```js
import { previewFinish, executeFinish, finishCommands, slug } from './finish.mjs';
```

(Remove the line `const slug = (b) => b.replace(/[^A-Za-z0-9._-]+/g, '-');` — `/api/worktree/create` keeps working through the imported `slug`.)

- [ ] **Step 2: Add the two handler branches** inside `handleAction`'s `try`, directly after the `/api/worktree/apply-diff` block:

```js
      if (url === '/api/worktree/finish-preview') {
        const { repoPath, path } = body;
        return sendJson(res, await previewFinish({ repoPath, path }));
      }

      if (url === '/api/worktree/finish') {
        const { repoPath, path, targetBranch, remove = true, isPrimary } = body;
        if (isPrimary) return sendJson(res, { error: 'refusing to finish the primary worktree' }, 400);
        if (mode === 'guided') {
          const preview = await previewFinish({ repoPath, path });
          const tb = targetBranch || preview.targetBranch;
          if (!tb) return sendJson(res, { error: `cannot resolve a target branch for ${preview.worktreeName}` }, 400);
          const command = finishCommands({ repoPath, path, targetBranch: tb, remove, preview }).join(' && ');
          ctx.journal.add({ cmd: command, cwd: repoPath, mode });
          runInTerminal({ command, cwd: repoPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }
        const result = await executeFinish({
          repoPath, path, targetBranch, remove,
          onStep: (s) => ctx.journal.add({ cmd: s.cmd, cwd: s.cwd, mode }),
        });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, ...result });
      }
```

(Hard errors bubble to the existing top-level catch → `{error: String(e)}` 500 — same as every other action.)

- [ ] **Step 3: Verify by hand against a scratch repo** (the action layer has no test harness today; the algorithm underneath is covered by Task 2):

```bash
cd /Users/egecan.sen/sahibinden/repo/APPS/forest && node --test   # still green
node server.mjs &   # or restart the running instance
# scratch repo:
R=$(mktemp -d)/repo
git init -b master "$R"
git -C "$R" commit --allow-empty -m base
git -C "$R" worktree add -b t/demo "$R/.forest/wt/t-demo" HEAD
git -C "$R/.forest/wt/t-demo" commit --allow-empty -m work
curl -s -XPOST localhost:5577/api/worktree/finish-preview \
  -H 'content-type: application/json' -d "{\"repoPath\":\"$R\",\"path\":\"$R/.forest/wt/t-demo\"}"
# expect JSON with targetBranch "t/demo", relanding false
curl -s -XPOST localhost:5577/api/worktree/finish \
  -H 'content-type: application/json' -d "{\"repoPath\":\"$R\",\"path\":\"$R/.forest/wt/t-demo\",\"mode\":\"auto\"}"
# expect {"mode":"auto","targetBranch":"t/demo","landed":true,"merged":"up-to-date","removed":true,...}
git -C $R branch --show-current   # → t/demo
```

- [ ] **Step 4: Checkpoint** — no commit.

---

### Task 4: forest UI — Finish button + confirm modal

**Files:**
- Modify: `public/index.html` (new `#finishwt` modal)
- Modify: `public/app.js` (row/drawer button, `doAction` case, modal logic)

**Interfaces:**
- Consumes: Task 3's endpoints via the existing `api(path, body)` helper; `state.mode`; snapshot record fields `w.path`, `w.repoPath`, `w.isPrimary`, `w.branch`, `w.ahead`, `w.behind`, `w.status.dirty`.

- [ ] **Step 1: Add the modal markup** to `public/index.html`, next to the existing `#newwt` modal, following its exact structure (`.modal.hidden` > `.modal-card`, dismissed the same way):

```html
<div id="finishwt" class="modal hidden">
  <div class="modal-card">
    <h3>Finish worktree</h3>
    <p id="fw-summary" class="hint"></p>
    <div id="fw-namechoice" class="hidden">
      <label class="row-inline"><input type="radio" name="fw-name" id="fw-name-branch" checked /> <span id="fw-name-branch-label"></span></label>
      <label class="row-inline"><input type="radio" name="fw-name" id="fw-name-wt" /> <span id="fw-name-wt-label"></span></label>
    </div>
    <label class="row-inline"><input id="fw-remove" type="checkbox" checked /> Remove worktree after landing</label>
    <div class="modal-actions">
      <button id="fw-cancel" class="btn-ghost">Cancel</button>
      <button id="fw-go" class="btn-accent">Finish</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Wire it in `public/app.js`.**
  1. In `rowHtml(w, repo)`, add a Finish button to `.col-actions` for every non-primary row, next to the existing conditional remove button: `<button data-act="finish" data-path="${encodeURIComponent(w.path)}" title="Finish: land this worktree's branch in the main checkout">✓</button>` (gate with `w.isPrimary ? '' : ...`, same pattern the 🧹 button uses).
  2. In the `doAction(act, ds)` switch, add `case 'finish': openFinish(decodeURIComponent(ds.path)); break;`.
  3. In `openDrawer(...)`, add a `Finish worktree` button beside the existing "Remove worktree" danger button, calling the same `openFinish(w.path)`.
  4. Add the modal logic (top-level functions, wired in `wireEvents()` like `#nw-*`):

```js
let finishCtx = null; // { w, preview }

async function openFinish(path) {
  const w = findWorktree(path); // helper: scan state.snapshot.repos[].worktrees for path — add if absent
  if (!w || w.isPrimary) { toast('Cannot finish the primary worktree'); return; }
  const preview = await api('/api/worktree/finish-preview', { repoPath: w.repoPath, path: w.path });
  if (preview.error) { toast(`Error: ${preview.error}`); return; }
  if (preview.mergeInProgress) { toast('Main checkout has a merge in progress — resolve it first'); return; }
  if (!preview.targetBranch && !preview.nameMismatch) { toast('Cannot resolve a target branch for this worktree'); return; }
  finishCtx = { w, preview };
  $('#fw-summary').textContent =
    `${preview.worktreeName} → ${preview.relanding ? 'merge into' : 'land as'} ${preview.targetBranch ?? preview.candidates[0]}` +
    ` · ${preview.dirtyCount} uncommitted file(s) will carry over · ↑${w.ahead} ↓${w.behind} vs ${w.baseBranch}`;
  $('#fw-namechoice').classList.toggle('hidden', !preview.nameMismatch);
  if (preview.nameMismatch) {
    $('#fw-name-branch-label').textContent = `Land as "${preview.candidates[0]}" (the branch's name)`;
    $('#fw-name-wt-label').textContent = `Land as "${preview.candidates[1]}" (the worktree's name)`;
    $('#fw-name-branch').checked = true;
  }
  $('#fw-remove').checked = true;
  $('#finishwt').classList.remove('hidden');
}

async function submitFinish() {
  const { w, preview } = finishCtx;
  const targetBranch = preview.nameMismatch
    ? ($('#fw-name-wt').checked ? preview.candidates[1] : preview.candidates[0])
    : preview.targetBranch;
  $('#finishwt').classList.add('hidden');
  const r = await api('/api/worktree/finish', {
    repoPath: w.repoPath, path: w.path, targetBranch,
    remove: $('#fw-remove').checked, isPrimary: w.isPrimary, mode: state.mode,
  });
  if (r.error) { toast(`Error: ${r.error}`); return; }
  if (state.mode === 'guided') { toast('Finish sequence sent to terminal'); return; }
  if (r.conflict) { toast('Merge conflict — resolve in your IDE, then press Finish again'); return; }
  toast(`Landed ${r.targetBranch}${r.removed ? ', worktree removed' : ''}${r.stashConflict ? ' — stash pop conflicted, stash kept' : ''}`);
}
```

Wire in `wireEvents()`: `$('#fw-go').onclick = submitFinish; $('#fw-cancel').onclick = () => $('#finishwt').classList.add('hidden');` and include `#finishwt` in the shared Escape/backdrop dismissal the other modals use.

- [ ] **Step 3: Manual browser verification** (no JS test harness exists): restart the server, open `http://127.0.0.1:5577`, and against a scratch repo from Task 3's recipe check: ✓ button visible on non-primary rows only; modal shows summary/dirty count; auto mode lands + row disappears via SSE broadcast; guided mode opens Terminal with the ` && ` chain; conflict case toasts the resolve-and-repeat message; name-mismatch case shows the radio pair.

- [ ] **Step 4: Checkpoint** — no commit. `node --test` still green.

---

# Part 2 — idea-worktrees plugin (Milestone 1)

### Task 5: models + naming rule + `previewFinish` service method

**Files:**
- Create: `src/main/kotlin/com/bahadirustun/ideaworktrees/model/FinishModels.kt`
- Modify: `src/main/kotlin/com/bahadirustun/ideaworktrees/services/GitWorktreeService.kt`
- Test: `src/test/kotlin/com/bahadirustun/ideaworktrees/services/FinishWorktreeTest.kt`

**Interfaces:**
- Produces (used by Tasks 6–7):

```kotlin
// model/FinishModels.kt
enum class MergeOutcome { NONE, UP_TO_DATE, MERGED }
data class FinishPreview(
    val worktreeName: String, val branch: String?, val detached: Boolean, val head: String,
    val dirtyCount: Int, val targetBranch: String?, val nameMismatch: Boolean,
    val candidates: List<String>, val mainBranch: String?, val relanding: Boolean,
    val mergeInProgress: Boolean,
)
data class FinishResult(
    val targetBranch: String, val previousBranch: String?, val landed: Boolean,
    val merged: MergeOutcome, val conflict: Boolean, val removed: Boolean,
    val removeSkipped: String? = null, val stashed: Boolean, val stashPopped: Boolean,
    val stashConflict: Boolean = false,
)
// GitWorktreeService additions
fun previewFinish(worktree: WorktreeInfo): CompletableFuture<FinishPreview>
companion object { fun slugify(branch: String): String /* [^A-Za-z0-9._-]+ -> "-" */ }
```

- [ ] **Step 1: Write the failing tests** — `FinishWorktreeTest.kt`, extending the existing fixture base (JUnit-3 style method naming, real git via `runGit`, `.await()` helper):

```kotlin
package com.bahadirustun.ideaworktrees.services

import com.bahadirustun.ideaworktrees.AbstractGitWorktreeTestCase
import com.bahadirustun.ideaworktrees.model.MergeOutcome
import java.nio.file.Path

class FinishWorktreeTest : AbstractGitWorktreeTestCase() {

    private val service: GitWorktreeService
        get() = GitWorktreeService.getInstance(project)

    private fun makeWorktree(branch: String = "tech/WEBT-1"): Path {
        createEmptyCommit("base")
        val path = worktreePath(GitWorktreeService.slugify(branch))
        service.createWorktree(path, branch, createBranch = true, allowCreateInitialCommit = true).await()
        return path
    }

    private fun worktreeAt(path: Path) =
        service.listWorktrees().await().first { normalizePath(it.path) == normalizePath(path) }

    fun testSlugifyMatchesForestNaming() {
        assertEquals("tech-WEBT-251448", GitWorktreeService.slugify("tech/WEBT-251448"))
    }

    fun testPreviewCleanMatchingWorktree() {
        val path = makeWorktree()
        val p = service.previewFinish(worktreeAt(path)).await()
        assertEquals("tech/WEBT-1", p.branch)
        assertFalse(p.detached)
        assertEquals("tech/WEBT-1", p.targetBranch)
        assertFalse(p.nameMismatch)
        assertEquals(0, p.dirtyCount)
        assertFalse(p.relanding)
        assertFalse(p.mergeInProgress)
    }

    fun testPreviewNameMismatchListsBothCandidates() {
        val path = makeWorktree()
        runGit("switch", "-c", "fix/other-name", workingDir = path)
        val p = service.previewFinish(worktreeAt(path)).await()
        assertTrue(p.nameMismatch)
        assertEquals(listOf("fix/other-name", path.fileName.toString()), p.candidates)
        assertEquals("fix/other-name", p.targetBranch)
    }

    fun testPreviewDetachedResolvesSameNamedBranchAndRelanding() {
        val path = makeWorktree()
        runGit("switch", "--detach", workingDir = path)
        runGit("switch", "tech/WEBT-1", workingDir = projectPath)
        val p = service.previewFinish(worktreeAt(path)).await()
        assertTrue(p.detached)
        assertEquals("tech/WEBT-1", p.targetBranch)
        assertTrue(p.relanding)
    }

    fun testPreviewCountsUntrackedAsDirty() {
        val path = makeWorktree()
        path.writeFile("wip.txt", "x")
        assertEquals(1, service.previewFinish(worktreeAt(path)).await().dirtyCount)
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/egecan.sen/sahibinden/repo/APPS/idea-worktrees && ./gradlew test --tests "com.bahadirustun.ideaworktrees.services.FinishWorktreeTest"`
Expected: compilation FAILURE (`FinishPreview`/`previewFinish`/`slugify` unresolved).

- [ ] **Step 3: Implement.** Create `model/FinishModels.kt` with the three types exactly as in Interfaces (package `com.bahadirustun.ideaworktrees.model`). In `GitWorktreeService`:
  - companion: `fun slugify(branch: String): String = branch.replace(Regex("[^A-Za-z0-9._-]+"), "-")`
  - private helpers, all built on the existing `executeGitCommand`:

```kotlin
private fun gitOut(dir: Path, vararg args: String): String {
    val out = executeGitCommand(dir, *args)
    check(out.exitCode == 0) { "git ${args.joinToString(" ")} failed: ${out.stderr.ifBlank { out.stdout }}" }
    return out.stdout.trim()
}
private fun gitOk(dir: Path, vararg args: String): Boolean = executeGitCommand(dir, *args).exitCode == 0

private fun sameNamedBranch(repoDir: Path, worktreeName: String): String? =
    gitOut(repoDir, "for-each-ref", "refs/heads", "--format=%(refname:short)")
        .lines().filter { it.isNotBlank() }.firstOrNull { slugify(it) == worktreeName }

private fun buildFinishPreview(worktree: WorktreeInfo, mainDir: Path): FinishPreview {
    val name = worktree.path.fileName.toString()
    val branchRaw = gitOut(worktree.path, "rev-parse", "--abbrev-ref", "HEAD")
    val detached = branchRaw == "HEAD"
    val branch = if (detached) null else branchRaw
    val head = gitOut(worktree.path, "rev-parse", "HEAD")
    val dirtyCount = gitOut(worktree.path, "status", "--porcelain").lines().count { it.isNotBlank() }
    val mainRaw = gitOut(mainDir, "rev-parse", "--abbrev-ref", "HEAD")
    val mainBranch = if (mainRaw == "HEAD") null else mainRaw
    val projectName = mainDir.fileName?.toString().orEmpty()
    val matches = branch != null &&
        (slugify(branch) == name || "$projectName-${slugify(branch)}" == name)
    val nameMismatch = branch != null && !matches
    val target = if (detached) sameNamedBranch(mainDir, name) else branch
    return FinishPreview(
        worktreeName = name, branch = branch, detached = detached, head = head,
        dirtyCount = dirtyCount, targetBranch = target, nameMismatch = nameMismatch,
        candidates = if (nameMismatch) listOf(branch!!, name) else emptyList(),
        mainBranch = mainBranch, relanding = target != null && target == mainBranch,
        mergeInProgress = gitOk(mainDir, "rev-parse", "-q", "--verify", "MERGE_HEAD"),
    )
}
```

  - public method, following the service's `runAsync` pattern (main dir = `listWorktrees` entry with `isMain`, its `path`):

```kotlin
fun previewFinish(worktree: WorktreeInfo): CompletableFuture<FinishPreview> =
    runAsync("preview finish") {
        val mainDir = requireNotNull(doListWorktrees().firstOrNull { it.isMain }?.path) { "main worktree not found" }
        buildFinishPreview(worktree, mainDir)
    }
```

  (If the internal synchronous lister isn't named `doListWorktrees`, use whatever private function `listWorktrees()` wraps — reuse it, don't shell out twice.)

- [ ] **Step 4: Run to verify pass**

Run: `./gradlew test --tests "com.bahadirustun.ideaworktrees.services.FinishWorktreeTest"` — expected PASS.
Then: `./gradlew detekt` — expected clean.

- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 6: `finishWorktree` service method

**Files:**
- Modify: `src/main/kotlin/com/bahadirustun/ideaworktrees/services/GitWorktreeService.kt`
- Test: `src/test/kotlin/com/bahadirustun/ideaworktrees/services/FinishWorktreeTest.kt` (append)

**Interfaces:**
- Produces (used by Task 7): `fun finishWorktree(worktree: WorktreeInfo, targetBranch: String?, removeAfter: Boolean): CompletableFuture<FinishResult>` — future completes exceptionally on hard errors (merge-in-progress, unresolvable target, refused switch); a merge conflict completes normally with `conflict = true`. Publishes `WORKTREE_TOPIC` on any state change.

- [ ] **Step 1: Append failing tests** (same fixture; these mirror forest's Task 2 matrix — first landing, dirty carry, keep-worktree, re-landing merge, conflict/resume, ancestor guard, rename):

```kotlin
    fun testFinishFirstLandingSwitchesMainAndRemovesWorktree() {
        val path = makeWorktree()
        projectPath.let { } // main starts on the base branch
        path.writeFile("feat.txt", "work")
        runGit("add", ".", workingDir = path)
        runGit("commit", "-m", "feat", workingDir = path)
        val r = service.finishWorktree(worktreeAt(path), null, removeAfter = true).await()
        assertEquals("tech/WEBT-1", r.targetBranch)
        assertTrue(r.landed)
        assertEquals(MergeOutcome.UP_TO_DATE, r.merged)
        assertTrue(r.removed)
        assertEquals("tech/WEBT-1", runGit("rev-parse", "--abbrev-ref", "HEAD").trim())
        assertFalse(runGit("worktree", "list", "--porcelain").contains(normalizePath(path)))
    }

    fun testFinishCarriesUncommittedChangesToMain() {
        val path = makeWorktree()
        path.writeFile("wip.txt", "uncommitted")
        val r = service.finishWorktree(worktreeAt(path), null, removeAfter = true).await()
        assertTrue(r.stashed)
        assertTrue(r.stashPopped)
        assertTrue(runGit("status", "--porcelain").contains("wip.txt"))
    }

    fun testFinishKeepWorktreeLeavesItDetached() {
        val path = makeWorktree()
        val r = service.finishWorktree(worktreeAt(path), null, removeAfter = false).await()
        assertFalse(r.removed)
        assertEquals("HEAD", runGit("rev-parse", "--abbrev-ref", "HEAD", workingDir = path).trim())
    }

    fun testFinishRelandingMergesNewDetachedCommits() {
        val path = makeWorktree()
        service.finishWorktree(worktreeAt(path), null, removeAfter = false).await()
        path.writeFile("more.txt", "round2")
        runGit("add", ".", workingDir = path); runGit("commit", "-m", "round2", workingDir = path)
        projectPath.writeFile("own.txt", "mine")
        runGit("add", ".", workingDir = projectPath); runGit("commit", "-m", "own", workingDir = projectPath)
        val r = service.finishWorktree(worktreeAt(path), null, removeAfter = true).await()
        assertEquals(MergeOutcome.MERGED, r.merged)
        assertTrue(r.removed)
        val log = runGit("log", "--oneline")
        assertTrue(log.contains("round2")); assertTrue(log.contains("own"))
    }

    fun testFinishConflictStopsCleanlyThenResumes() {
        val path = makeWorktree()
        service.finishWorktree(worktreeAt(path), null, removeAfter = false).await()
        path.writeFile("clash.txt", "agent")
        runGit("add", ".", workingDir = path); runGit("commit", "-m", "agent", workingDir = path)
        projectPath.writeFile("clash.txt", "user")
        runGit("add", ".", workingDir = projectPath); runGit("commit", "-m", "user", workingDir = projectPath)
        path.writeFile("wip.txt", "carried")
        val r1 = service.finishWorktree(worktreeAt(path), null, removeAfter = true).await()
        assertTrue(r1.conflict); assertFalse(r1.removed); assertFalse(r1.stashPopped)
        // resolve + commit the merge, then finish again
        projectPath.writeFile("clash.txt", "resolved")
        runGit("add", ".", workingDir = projectPath); runGit("commit", "--no-edit", workingDir = projectPath)
        val r2 = service.finishWorktree(worktreeAt(path), null, removeAfter = true).await()
        assertFalse(r2.conflict); assertTrue(r2.removed); assertTrue(r2.stashPopped)
        assertTrue(runGit("status", "--porcelain").contains("wip.txt"))
    }

    fun testFinishRenamesWhenExplicitTargetGiven() {
        val path = makeWorktree()
        runGit("switch", "-c", "fix/other-name", workingDir = path)
        val target = path.fileName.toString()
        val r = service.finishWorktree(worktreeAt(path), target, removeAfter = true).await()
        assertEquals(target, r.targetBranch)
        assertEquals(target, runGit("rev-parse", "--abbrev-ref", "HEAD").trim())
    }
```

- [ ] **Step 2: Run to verify failure** — `./gradlew test --tests "...FinishWorktreeTest"`: compilation error on `finishWorktree`.

- [ ] **Step 3: Implement** in `GitWorktreeService` (transliteration of `executeFinish` from forest's Task 2 — keep step comments aligned with the spec):

```kotlin
fun finishWorktree(worktree: WorktreeInfo, targetBranch: String?, removeAfter: Boolean): CompletableFuture<FinishResult> =
    runAsync("finish worktree") {
        val mainDir = requireNotNull(doListWorktrees().firstOrNull { it.isMain }?.path) { "main worktree not found" }
        val p = buildFinishPreview(worktree, mainDir)
        check(!p.mergeInProgress) { "main checkout has a merge in progress — resolve it first, then Finish again" }
        val target = targetBranch ?: p.targetBranch
        ?: error("cannot resolve a target branch for ${p.worktreeName}")
        val stashMsg = "worktree-finish ${p.worktreeName}"
        var stashed = false
        // 1. naming
        if (p.branch != null && p.branch != target) gitOut(worktree.path, "branch", "-m", p.branch, target)
        // 2. stash carry
        if (p.dirtyCount > 0) { gitOut(worktree.path, "stash", "push", "-u", "-m", stashMsg); stashed = true }
        // 3. free the branch
        if (!p.detached) gitOut(worktree.path, "switch", "--detach")
        // 4. land (git-native dirty-main policy: a refusing switch throws)
        if (p.mainBranch != target) {
            if (gitOk(mainDir, "rev-parse", "-q", "--verify", "refs/heads/$target")) gitOut(mainDir, "switch", target)
            else gitOut(mainDir, "switch", "-c", target, p.head)
        }
        // 5. combine
        val mergeOut = executeGitCommand(mainDir, "merge", "--no-edit", p.head)
        if (mergeOut.exitCode != 0) {
            val conflicted = executeGitCommand(mainDir, "ls-files", "-u").stdout.isNotBlank()
            check(conflicted) { "merge failed: ${mergeOut.stderr.ifBlank { mergeOut.stdout }}" }
            notifyWorktreesChanged()
            return@runAsync FinishResult(
                targetBranch = target, previousBranch = p.mainBranch, landed = true,
                merged = MergeOutcome.NONE, conflict = true, removed = false,
                stashed = stashed, stashPopped = false,
            )
        }
        val merged = if (mergeOut.stdout.contains("Already up to date", ignoreCase = true))
            MergeOutcome.UP_TO_DATE else MergeOutcome.MERGED
        // 6. remove behind the ancestor guard — a backstop for concurrent HEAD moves
        // (user switching branches in the IDE mid-finish); unreachable via the
        // sequential flow, where a completed merge always makes p.head an ancestor
        var removed = false; var removeSkipped: String? = null
        if (removeAfter) {
            if (gitOk(mainDir, "merge-base", "--is-ancestor", p.head, "HEAD")) {
                gitOut(mainDir, "worktree", "remove", worktree.path.toString()); removed = true
            } else removeSkipped = "worktree commits not yet reachable from $target"
        }
        // 7. pop the carried stash (ours by EXACT message suffix — a substring match
        // can grab another worktree's stash when names are prefixes, e.g. webt-100/webt-1005)
        val stashLine = executeGitCommand(mainDir, "stash", "list").stdout
            .lines().firstOrNull { it.endsWith(": $stashMsg") }
        var stashPopped = false; var stashConflict = false
        if (stashLine != null) {
            val ref = stashLine.substringBefore(':')
            if (executeGitCommand(mainDir, "stash", "pop", ref).exitCode == 0) stashPopped = true
            else stashConflict = true
        }
        notifyWorktreesChanged()
        FinishResult(
            targetBranch = target, previousBranch = p.mainBranch, landed = true,
            merged = merged, conflict = false, removed = removed, removeSkipped = removeSkipped,
            stashed = stashed, stashPopped = stashPopped, stashConflict = stashConflict,
        )
    }
```

- [ ] **Step 4: Run to verify pass** — `./gradlew test --tests "...FinishWorktreeTest"` PASS, then full `./gradlew test` (no regressions) and `./gradlew detekt` (clean; if a length rule trips, extract steps 5–7 into a private helper rather than baselining).

- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 7: dialog + shared flow + action + tool-window button + plugin.xml

**Files:**
- Create: `src/main/kotlin/com/bahadirustun/ideaworktrees/actions/FinishWorktreeAction.kt`
- Modify: `src/main/kotlin/com/bahadirustun/ideaworktrees/utils/WorktreeOperations.kt`
- Modify: `src/main/kotlin/com/bahadirustun/ideaworktrees/ui/WorktreeToolWindowPanel.kt`
- Modify: `src/main/resources/META-INF/plugin.xml`
- Test: `src/test/kotlin/com/bahadirustun/ideaworktrees/utils/FinishFlowTest.kt`

**Interfaces:**
- Consumes: `previewFinish`/`finishWorktree` (Tasks 5–6), `WorktreeOperations` callback pattern, `"Git Worktree"` notification group, `WORKTREE_TOPIC` refresh.
- Produces: `WorktreeOperations.finishWorktree(project, service, worktree, modalityState, callbacks: FinishWorktreeCallbacks)` — the one shared UX flow both entry points call.

- [ ] **Step 1: Shared flow in `WorktreeOperations`** (mirrors `deleteWorktree`'s shape — preview on background, dialog on EDT, run on background, notify on EDT):

```kotlin
data class FinishWorktreeCallbacks(
    val onSuccess: ((FinishResult) -> Unit)? = null,
    val onConflict: ((FinishResult) -> Unit)? = null,
    val onFailure: ((String) -> Unit)? = null,
    val onCancel: (() -> Unit)? = null,
)

fun finishWorktree(
    project: Project, service: GitWorktreeService, worktree: WorktreeInfo,
    modalityState: ModalityState = ModalityState.nonModal(),
    callbacks: FinishWorktreeCallbacks = FinishWorktreeCallbacks(),
) {
    service.previewFinish(worktree).whenComplete { preview, error ->
        ApplicationManager.getApplication().invokeLater({
            if (error != null || preview == null) {
                Messages.showErrorDialog(project, error?.message ?: "Preview failed", "Finish Worktree")
                callbacks.onFailure?.invoke(error?.message ?: "preview failed"); return@invokeLater
            }
            if (preview.mergeInProgress) {
                Messages.showErrorDialog(project, "The main checkout has a merge in progress — resolve it first.", "Finish Worktree")
                callbacks.onFailure?.invoke("merge in progress"); return@invokeLater
            }
            if (preview.targetBranch == null && !preview.nameMismatch) {
                Messages.showErrorDialog(project, "Cannot resolve a target branch for ${preview.worktreeName}.", "Finish Worktree")
                callbacks.onFailure?.invoke("no target branch"); return@invokeLater
            }
            val dialog = FinishWorktreeDialog(project, preview)
            if (!dialog.showAndGet()) { callbacks.onCancel?.invoke(); return@invokeLater }
            service.finishWorktree(worktree, dialog.selectedTargetBranch(), dialog.removeAfter())
                .whenComplete { result, err ->
                    ApplicationManager.getApplication().invokeLater({
                        notifyFinishOutcome(project, result, err, callbacks)
                    }, modalityState)
                }
        }, modalityState)
    }
}

private fun notifyFinishOutcome(
    project: Project, result: FinishResult?, err: Throwable?, callbacks: FinishWorktreeCallbacks,
) {
    val group = NotificationGroupManager.getInstance().getNotificationGroup("Git Worktree")
    when {
        err != null || result == null -> {
            Messages.showErrorDialog(project, err?.message ?: "Finish failed", "Finish Worktree")
            callbacks.onFailure?.invoke(err?.message ?: "finish failed")
        }
        result.conflict -> {
            group.createNotification(
                "Finish paused on a merge conflict",
                "Resolve the conflict in this project, commit the merge, then run Finish again.",
                NotificationType.WARNING,
            ).notify(project)
            callbacks.onConflict?.invoke(result)
        }
        else -> {
            val extras = buildList {
                if (result.removed) add("worktree removed")
                result.removeSkipped?.let { add(it) }
                if (result.stashConflict) add("stash pop conflicted — stash kept")
                else if (result.stashPopped) add("uncommitted changes carried over")
            }.joinToString(" · ")
            group.createNotification(
                "Landed ${result.targetBranch}",
                extras.ifBlank { "The IDE checkout is now on ${result.targetBranch}." },
                NotificationType.INFORMATION,
            ).notify(project)
            callbacks.onSuccess?.invoke(result)
        }
    }
}
```

`FinishWorktreeDialog` (internal class in the same file, next to `CreateWorktreeDialog`): a `DialogWrapper` with a summary `JBLabel` ("`<worktreeName>` → land as / merge into `<target>` · N uncommitted file(s) carry over"), a radio pair shown ONLY when `preview.nameMismatch` (option 1: `candidates[0]` "the branch's name", selected by default; option 2: `candidates[1]` "the worktree's name"), and a `JCheckBox("Remove worktree after landing", true)`. Expose `fun selectedTargetBranch(): String` and `fun removeAfter(): Boolean`.

- [ ] **Step 2: Entry points.**
  - `actions/FinishWorktreeAction.kt` — copy `DeleteWorktreeAction`'s structure verbatim (AnAction + DumbAware, BGT update thread, `isGitRepository()` gate, `listWorktrees().thenCombine(getCurrentWorktree())`, JBPopup `BaseListPopupStep("Finish Worktree", finishableWorktrees)`) with the filter `worktrees.filter { !it.isMain }`; `onChosen` → `WorktreeOperations.finishWorktree(project, service, worktree)`.
  - `WorktreeToolWindowPanel` — new `private inner class FinishAction : AnAction("Finish", "Land this worktree's branch in the main checkout", AllIcons.Actions.Commit)` enabled when `selectedWorktree != null && !selectedWorktree!!.isMain`; `actionPerformed` → `WorktreeOperations.finishWorktree(project, service, selectedWorktree!!, callbacks = FinishWorktreeCallbacks(onSuccess = { refreshWorktrees() }, onConflict = { refreshWorktrees() }))`. Add to `buildToolbar()` right after `DeleteAction()` and to `buildWorktreeContextGroup()`. `getActionUpdateThread() = ActionUpdateThread.EDT` like its siblings.
  - `plugin.xml` — inside the existing group, after the Merge action:

```xml
<action id="com.bahadirustun.ideaworktrees.FinishWorktreeAction"
        class="com.bahadirustun.ideaworktrees.actions.FinishWorktreeAction"
        text="Finish Worktree..."
        description="Land a worktree's branch in the main checkout, carry uncommitted changes, optionally remove the worktree"
        icon="AllIcons.Actions.Commit">
    <keyboard-shortcut keymap="$default" first-keystroke="ctrl alt W" second-keystroke="F"/>
</action>
```

- [ ] **Step 3: Headless-safe test** — `FinishFlowTest.kt` in `utils`, same pattern as `WorktreeOperationsTest` (dialog-driven flows are only partially testable headless: assert the preview-error paths run callbacks without throwing, e.g. finishing when a merge is in progress invokes `onFailure`; wrap dialog-reaching calls in try/catch as that test does).

- [ ] **Step 4: Verify**

Run: `./gradlew test` → green; `./gradlew detekt` → clean; `./gradlew verifyPlugin` → no new violations; `./gradlew runIde` → in the sandbox IDE open a repo with a worktree, check: action in VCS menu + `Ctrl+Alt+W, F`, tool-window Finish button state-gating, full landing flow, conflict notification wording.

- [ ] **Step 5: Checkpoint** — no commit.

---

# Part 3 — Milestone 2 (Eject + safety ref)

### Task 8: forest — safety ref + landed ledger + prune

**Files:**
- Modify: `lib/finish.mjs`, `server.mjs`
- Create: `lib/landed.mjs`
- Test: `lib/landed.test.mjs`, `lib/finish.test.mjs` (append)

**Interfaces:**
- Produces: `lib/landed.mjs` exports `async recordLanding(repoPath, entry)`, `async readLandings(repoPath): Promise<Entry[]>`, `async popLanding(repoPath): Promise<Entry|null>`, `async pruneLandings(repoPath, {maxAgeDays = 14, now = Date.now()})` over ledger file `<repoPath>/.forest/landed.json` (JSON array; `Entry = { worktreeName, branch, previousBranch, path, head, ts }`). `executeFinish` gains: before `worktree remove`, `git update-ref refs/forest/landed/<worktreeName> <head>` + `recordLanding`; result gains `safetyRef` field. `pruneLandings` deletes expired entries AND their refs (`git update-ref -d`). `server.mjs` calls `pruneLandings` for every repo in the first snapshot at startup.

- [ ] **Step 1: failing tests** — `lib/landed.test.mjs`: record→read roundtrip; pop returns last entry and shrinks file; prune removes only entries older than `maxAgeDays` (inject `now`) and deletes their `refs/forest/landed/*` ref (fixture repo + `git update-ref`, assert via `git for-each-ref refs/forest/landed`). Append to `finish.test.mjs`: after a removing finish, `git for-each-ref refs/forest/landed` contains the worktree name and `.forest/landed.json` has one entry with `previousBranch: 'master'`.
- [ ] **Step 2: verify failure** — `node --test lib/landed.test.mjs` fails on missing module.
- [ ] **Step 3: implement.** `lib/landed.mjs`:

```js
// lib/landed.mjs — ledger of landings, backing Eject and safety-ref pruning
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { runGit } from './git.mjs';

const file = (repoPath) => join(repoPath, '.forest', 'landed.json');

export async function readLandings(repoPath) {
  try { return JSON.parse(await readFile(file(repoPath), 'utf8')); }
  catch { return []; }
}
async function write(repoPath, entries) {
  await mkdir(dirname(file(repoPath)), { recursive: true });
  await writeFile(file(repoPath), JSON.stringify(entries, null, 2));
}
export async function recordLanding(repoPath, entry) {
  const entries = await readLandings(repoPath);
  entries.push(entry);
  await write(repoPath, entries);
}
export async function popLanding(repoPath) {
  const entries = await readLandings(repoPath);
  const last = entries.pop() ?? null;
  if (last) await write(repoPath, entries);
  return last;
}
export async function pruneLandings(repoPath, { maxAgeDays = 14, now = Date.now() } = {}) {
  const entries = await readLandings(repoPath);
  const keep = [];
  for (const e of entries) {
    if (now - e.ts <= maxAgeDays * 86_400_000) { keep.push(e); continue; }
    await runGit(repoPath, ['update-ref', '-d', `refs/forest/landed/${e.worktreeName}`]).catch(() => {});
  }
  if (keep.length !== entries.length) await write(repoPath, keep);
}
```

In `executeFinish` (Task 2), inside the `if (safe) { ... }` removal branch, insert BEFORE `worktree remove`:

```js
      await git(repoPath, ['update-ref', `refs/forest/landed/${p.worktreeName}`, p.head]);
      await recordLanding(repoPath, {
        worktreeName: p.worktreeName, branch: targetBranch,
        previousBranch: p.mainBranch, path, head: p.head, ts: Date.now(),
      });
      result.safetyRef = `refs/forest/landed/${p.worktreeName}`;
```

(plus `import { recordLanding } from './landed.mjs';` at the top of `finish.mjs`). In `server.mjs`, after the `snapshotInterval` setup, add the startup prune (spec names server-start as the prune point):

```js
import { pruneLandings } from './lib/landed.mjs';
// ...
snapshot().then((snap) => { for (const r of snap.repos) pruneLandings(r.repoPath).catch(() => {}); });
```

- [ ] **Step 4: verify pass** — `node --test` green.
- [ ] **Step 5: Checkpoint** — no commit.

### Task 9: forest — Eject endpoint + UI

**Files:**
- Modify: `lib/finish.mjs` (add `executeEject`), `lib/actions.mjs`, `lib/discover.mjs`, `public/app.js`
- Test: `lib/finish.test.mjs` (append)

**Interfaces:**
- Produces: `async executeEject({repoPath, onStep}): Promise<{branch, previousBranch, path}>` — pops the last ledger entry; in main: `git switch <previousBranch>` (git-native abort on refusal — re-push the entry on failure), then `git worktree add <path> <branch>`. `POST /api/worktree/eject` body `{repoPath, mode}` (guided variant emits the two commands via `finishCommands`-style builder). `buildSnapshot` repo records gain `landed: Entry[]` (read via `readLandings`); the drawer for the primary worktree shows "↩ Eject last landing: `<branch>`" when non-empty.

- [ ] **Step 1: failing tests** — append to `finish.test.mjs`: finish (remove) then `executeEject` → main back on `master`, worktree re-exists at the old path holding the branch, ledger empty; eject with dirty-conflicting main (uncommitted edit to a file the switch would overwrite) rejects and ledger still has the entry.
- [ ] **Step 2: verify failure.**
- [ ] **Step 3: implement.** In `lib/finish.mjs`:

```js
import { popLanding, recordLanding } from './landed.mjs'; // extend the Task 8 import

export async function executeEject({ repoPath, onStep = () => {} }) {
  const git = async (cwd, args) => {
    onStep({ cmd: `git ${args.join(' ')}`, cwd });
    return runGit(cwd, args);
  };
  const entry = await popLanding(repoPath);
  if (!entry) throw new Error('nothing to eject — no recorded landing');
  try {
    if (!entry.previousBranch) throw new Error('no previous branch recorded');
    await git(repoPath, ['switch', entry.previousBranch]); // git-native abort on refusal
    await git(repoPath, ['worktree', 'add', entry.path, entry.branch]);
  } catch (e) {
    await recordLanding(repoPath, entry); // restore the ledger entry on any failure
    throw e;
  }
  return { branch: entry.branch, previousBranch: entry.previousBranch, path: entry.path };
}
```

In `lib/actions.mjs`, after the finish handler:

```js
      if (url === '/api/worktree/eject') {
        const { repoPath } = body;
        if (mode === 'guided') {
          const entries = await readLandings(repoPath);
          const entry = entries[entries.length - 1];
          if (!entry) return sendJson(res, { error: 'nothing to eject — no recorded landing' }, 400);
          const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
          const command = [
            `git -C ${q(repoPath)} switch ${q(entry.previousBranch)}`,
            `git -C ${q(repoPath)} worktree add ${q(entry.path)} ${q(entry.branch)}`,
          ].join(' && ');
          ctx.journal.add({ cmd: command, cwd: repoPath, mode });
          runInTerminal({ command, cwd: repoPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }
        const result = await executeEject({
          repoPath, onStep: (s) => ctx.journal.add({ cmd: s.cmd, cwd: s.cwd, mode }),
        });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, ...result });
      }
```

(guided mode does NOT pop the ledger — the user runs the commands; the entry is cleared on the next auto eject or pruned. Import `executeEject` in the finish import line and `readLandings` from `./landed.mjs`.) In `lib/discover.mjs`, add `landed: await safe(() => readLandings(repoPath), [])` to the per-repo record next to where `worktrees` is assembled. In `public/app.js` `openDrawer`, when `w.isPrimary` and the repo record's `landed.length > 0`, render `<button id="eject-go">↩ Eject last landing: <branch></button>`, wired to `if (confirm('Recreate the worktree and switch the main checkout back?')) api('/api/worktree/eject', { repoPath: w.repoPath, mode: state.mode })` + result toast (same shape as `submitFinish`'s).

- [ ] **Step 4: verify** — `node --test` green + manual browser round-trip: Finish then Eject restores the worktree row.
- [ ] **Step 5: Checkpoint** — no commit.

### Task 10: plugin — safety ref + Eject action

**Files:**
- Modify: `services/GitWorktreeService.kt`, `utils/WorktreeOperations.kt`, `ui/WorktreeToolWindowPanel.kt`, `plugin.xml`
- Create: `actions/EjectWorktreeAction.kt`
- Test: `FinishWorktreeTest.kt` (append)

**Interfaces:**
- `finishWorktree` gains the safety ref (`update-ref refs/forest/landed/<name> <head>` before removal — same namespace as forest, so the two tools cover each other) and records `{branch, previousBranch, path}` via `PropertiesComponent.getInstance(project)` keys `ideaworktrees.lastFinish.branch/.previousBranch/.path`.
- New `fun ejectLastFinish(): CompletableFuture<WorktreeOperationResult>` — reads/clears those keys, `git switch <previousBranch>` in main (failure → `Failure`, keys restored), `git worktree add <path> <branch>`, notifies topic.
- `EjectWorktreeAction` (`second-keystroke="J"` — E is unused but J reads as "eJect"; confirm J is free in plugin.xml first, else pick E) + panel toolbar button enabled when the properties keys are present.
- Prune of `refs/forest/landed/*` older than 14 days: run inside `finishWorktree` after a successful removal (documented deviation from the spec's "on project open" — avoids a StartupActivity for pure insurance plumbing; note it in the spec's Milestone 2 section when implementing).

- [ ] **Step 1: failing tests** — append: after removing finish, `runGit("for-each-ref", "refs/forest/landed")` names the worktree; `ejectLastFinish()` restores main to `master` + re-adds the worktree and returns `Success`; eject with nothing recorded returns `Failure`.
- [ ] **Step 2: verify failure** — compilation error on `ejectLastFinish`.
- [ ] **Step 3: implement.** In `finishWorktree`'s removal branch (Task 6 step 6), BEFORE `worktree remove`:

```kotlin
                gitOut(mainDir, "update-ref", "refs/forest/landed/${p.worktreeName}", p.head)
                PropertiesComponent.getInstance(project).apply {
                    setValue("ideaworktrees.lastFinish.branch", target)
                    setValue("ideaworktrees.lastFinish.previousBranch", p.mainBranch)
                    setValue("ideaworktrees.lastFinish.path", worktree.path.toString())
                }
                pruneSafetyRefs(mainDir)
```

with the prune helper (commit date of the ref target is a good-enough age proxy for pure insurance):

```kotlin
private fun pruneSafetyRefs(mainDir: Path, maxAgeDays: Long = 14) {
    val cutoff = java.time.Instant.now().epochSecond - maxAgeDays * 86_400
    executeGitCommand(mainDir, "for-each-ref", "refs/forest/landed", "--format=%(refname) %(creatordate:unix)")
        .stdout.lines().filter { it.isNotBlank() }.forEach { line ->
            val (ref, date) = line.split(" ", limit = 2).let { it[0] to (it.getOrNull(1)?.trim()?.toLongOrNull() ?: 0L) }
            if (date in 1 until cutoff) executeGitCommand(mainDir, "update-ref", "-d", ref)
        }
}
```

New service method:

```kotlin
fun ejectLastFinish(): CompletableFuture<WorktreeOperationResult> =
    runAsync("eject last finish") {
        val props = PropertiesComponent.getInstance(project)
        val branch = props.getValue("ideaworktrees.lastFinish.branch")
        val previous = props.getValue("ideaworktrees.lastFinish.previousBranch")
        val path = props.getValue("ideaworktrees.lastFinish.path")
        if (branch == null || previous == null || path == null) {
            return@runAsync WorktreeOperationResult.Failure("Nothing to eject — no recorded landing")
        }
        val mainDir = requireNotNull(doListWorktrees().firstOrNull { it.isMain }?.path) { "main worktree not found" }
        val sw = executeGitCommand(mainDir, "switch", previous)
        if (sw.exitCode != 0) {
            return@runAsync WorktreeOperationResult.Failure("Could not switch back to $previous", sw.stderr)
        }
        val add = executeGitCommand(mainDir, "worktree", "add", path, branch)
        if (add.exitCode != 0) {
            return@runAsync WorktreeOperationResult.Failure("Could not recreate the worktree", add.stderr)
        }
        listOf("branch", "previousBranch", "path").forEach { props.unsetValue("ideaworktrees.lastFinish.$it") }
        notifyWorktreesChanged()
        WorktreeOperationResult.Success("Ejected $branch back to $path", "Main checkout is on $previous again")
    }
```

`EjectWorktreeAction` copies `FinishWorktreeAction`'s skeleton minus the picker (no selection needed): gate `update()` additionally on `PropertiesComponent.getInstance(project).getValue("ideaworktrees.lastFinish.branch") != null`; `actionPerformed` → yes/no confirm (`Messages.showYesNoDialog`) → `service.ejectLastFinish().whenComplete { ... }` → notify via the `"Git Worktree"` group. Register in plugin.xml after the Finish action with `second-keystroke="J"` (E is also free if J collides — check first). Panel gets an `EjectAction` inner class beside `FinishAction`, same enablement rule.

- [ ] **Step 4: verify** — `./gradlew test`, `detekt`, `verifyPlugin`, `runIde` smoke (Finish then Eject round-trip in the sandbox).
- [ ] **Step 5: Checkpoint** — no commit. Update the spec's Milestone 2 prune wording per the deviation above.

---

# Final verification (both repos)

- [ ] forest: `node --test` — full suite green.
- [ ] plugin: `./gradlew test detekt verifyPlugin` — green.
- [ ] End-to-end on the real repo (`/Users/egecan.sen/sahibinden/repo/web-test`, which currently has worktree `.forest/wt/tech-WEBT-251448` with 2 uncommitted files): **dry-run with a scratch worktree first** (`git worktree add -b t/finish-demo .forest/wt/t-finish-demo`), Finish it from the forest UI in auto mode, confirm the IDE checkout lands on `t/finish-demo`, Eject it back, then `git worktree remove` the scratch worktree and `git branch -D t/finish-demo`. Do NOT run the demo against `tech-WEBT-251448` — that's live work.
- [ ] Leave both repos' changes uncommitted for Egecan's review.
