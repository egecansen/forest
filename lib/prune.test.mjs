import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prunable, selectCandidates, pruneCommands, pruneWorktrees, dirSizeBytes } from './prune.mjs';
import { makeRepoWithWorktree, commitFile, git } from './finish-fixtures.mjs';

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

// Locking is how a `git worktree remove` is made to fail for real: git refuses
// with "cannot remove a locked working tree". Deleting the directory does NOT
// fail — git simply cleans up its admin files and succeeds.
// The record still says locked:false, which is exactly the stale-evidence case:
// the preview saw it unlocked, it was locked before the user confirmed.
test('pruneWorktrees keeps the branch when worktree removal fails', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree({ branch: 'tech/WEBT-907' });
  await git(repo, 'worktree', 'lock', wt);
  const res = await pruneWorktrees({
    repoPath: repo, paths: [wt], worktrees: [rec(wt, branch)], staleDays: 14,
  });
  assert.equal(res.failed.length, 1, 'removal failure is reported');
  assert.equal(res.failed[0].step, 'worktree-remove');
  assert.notEqual((await git(repo, 'branch', '--list', branch)).trim(), '', 'branch must survive a failed removal');
  await git(repo, 'worktree', 'unlock', wt);
  await rm(repo, { recursive: true, force: true });
});

test('one failing candidate does not stop the next', async () => {
  const a = await makeRepoWithWorktree({ branch: 'tech/WEBT-908' });
  const second = join(a.repo, '.forest', 'wt', 'tech-WEBT-909');
  await git(a.repo, 'worktree', 'add', '-b', 'tech/WEBT-909', second, 'HEAD');
  await git(a.repo, 'worktree', 'lock', a.wt);   // first one will fail
  const res = await pruneWorktrees({
    repoPath: a.repo, paths: [a.wt, second], staleDays: 14,
    worktrees: [rec(a.wt, a.branch), rec(second, 'tech/WEBT-909')],
  });
  assert.equal(res.failed.length, 1);
  assert.deepEqual(res.removed.map((r) => r.path), [second], 'the healthy one is still pruned');
  await git(a.repo, 'worktree', 'unlock', a.wt);
  await rm(a.repo, { recursive: true, force: true });
});

test('dirSizeBytes measures a directory and returns null for a missing one', async () => {
  const { repo } = await makeRepoWithWorktree({ branch: 'tech/WEBT-910' });
  assert.ok((await dirSizeBytes(repo)) > 0, 'a real directory has a size');
  assert.equal(await dirSizeBytes('/nonexistent-forest-path'), null, 'missing path yields null, never a throw');
  await rm(repo, { recursive: true, force: true });
});
