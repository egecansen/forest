import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { slug, previewFinish, finishCommands, executeFinish, executeEject } from './finish.mjs';
import { readLandings, recordLanding } from './landed.mjs';
import { createActionHandler } from './actions.mjs';
import { git, makeRepoWithWorktree, commitFile } from './finish-fixtures.mjs';

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
    `git -C '/r' stash pop`,
    `git -C '/r' merge-base --is-ancestor abc123 HEAD`,
    `git -C '/r' update-ref refs/forest/landed/tech-WEBT-1 abc123`,
    `git -C '/r' worktree remove '/r/.forest/wt/tech-WEBT-1'`,
  ]);
});

// Command-order regression: the pop must never be downstream of a cleanup
// step that can fail, so it must appear before the remove block whenever
// both are emitted (incident 2026-07-29 — see finish.mjs step 6/7 comment).
test('finishCommands: stash pop is emitted before worktree remove', () => {
  const preview = { worktreeName: 'tech-WEBT-1', branch: 'tech/WEBT-1', detached: false, head: 'abc123', dirty: true, mainBranch: 'master' };
  const cmds = finishCommands({ repoPath: '/r', path: '/r/.forest/wt/tech-WEBT-1', targetBranch: 'tech/WEBT-1', remove: true, preview });
  const popIndex = cmds.findIndex((c) => c.endsWith('stash pop'));
  const removeIndex = cmds.findIndex((c) => c.includes('worktree remove'));
  assert.notEqual(popIndex, -1);
  assert.notEqual(removeIndex, -1);
  assert.ok(popIndex < removeIndex, `expected stash pop (${popIndex}) before worktree remove (${removeIndex})`);
});

test('finishCommands: rename lands first when target differs; no stash/remove when clean/keep; main returns afterwards', () => {
  const preview = { worktreeName: 'tech-WEBT-1', branch: 'fix/other', detached: false, head: 'abc123', dirty: false, mainBranch: 'master' };
  const cmds = finishCommands({ repoPath: '/r', path: '/w', targetBranch: 'tech-WEBT-1', remove: false, preview });
  assert.deepEqual(cmds, [
    `git -C '/w' branch -m 'fix/other' 'tech-WEBT-1'`,
    `git -C '/w' switch --detach`,
    `git -C '/r' switch 'tech-WEBT-1'`,
    `git -C '/r' merge --no-edit abc123`,
    `git -C '/r' switch 'master'`,
  ]);
});

test('executeFinish: first landing — branch lands, worktree removed, main checkout returns to master', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await commitFile(wt, 'feat.txt', 'work\n', 'feat');
    const head = (await git(wt, 'rev-parse', 'HEAD')).trim();
    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.targetBranch, branch);
    assert.equal(r.previousBranch, 'master');
    assert.equal(r.landed, true);
    assert.equal(r.merged, 'up-to-date'); // first landing: branch tip == worktree HEAD
    assert.equal(r.removed, true);
    assert.equal(r.returned, true);
    assert.equal(r.returnedTo, 'master');
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'master');
    assert.equal((await git(repo, 'rev-parse', branch)).trim(), head); // the branch kept the landed commit
    assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).includes(wt), false);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: dirty worktree — changes arrive uncommitted in main, which stays on the landed branch', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await writeFile(join(wt, 'wip.txt'), 'uncommitted\n');
    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.stashed, true);
    assert.equal(r.stashPopped, true);
    const st = await git(repo, 'status', '--porcelain');
    assert.match(st, /\?\? wip\.txt/);
    // The carried file now lives in the main checkout on the landed branch;
    // returning to master would drag it along (the 2026-08-24 mix-up again).
    assert.equal(r.returned, false);
    assert.match(r.stayReason, /carried/);
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), branch);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

// Incident 2026-08-24: two Finishes in a row. The first popped its worktree's
// stash into the main checkout and left it there, uncommitted. The second
// switched the main checkout to a different branch while that work was still
// loose — git carried it across, and one branch ended up holding two tickets'
// changes. finish.mjs step 4 assumed "a refusing `switch` throws and aborts
// loudly", but switch only refuses when it would OVERWRITE local changes;
// files that do not collide with the target tree ride along silently.
test('executeFinish: refuses while the main checkout is dirty and a branch switch is required', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  try {
    await writeFile(join(repo, 'a.txt'), 'work left loose by a previous landing\n');
    await writeFile(join(wt, 'wip.txt'), 'this worktree\n');

    await assert.rejects(() => executeFinish({ repoPath: repo, path: wt }), /uncommitted/i);

    // and it must refuse BEFORE touching anything
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'master',
      'the main checkout must not have switched');
    assert.match(await git(repo, 'status', '--porcelain'), /a\.txt/,
      "the previous landing's work must still be in the main checkout");
    assert.match(await git(wt, 'status', '--porcelain'), /wip\.txt/,
      'the worktree must not have been stashed');
    assert.equal((await git(repo, 'stash', 'list')).trim(), '', 'no stash may have been taken');
    assert.ok((await git(repo, 'worktree', 'list', '--porcelain')).includes(wt),
      'the worktree must still be listed');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

// The refusal is scoped to the case that can actually mix work: a switch. When
// the main checkout already holds the target branch nothing moves between
// branches, so an in-progress edit there is the user's business, not a hazard.
test('executeFinish: a dirty main checkout is fine when no branch switch is needed', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await executeFinish({ repoPath: repo, path: wt, remove: false }); // lands, then main returns to master
    await git(repo, 'switch', branch); // the user opens the landed branch in the main checkout
    await commitFile(wt, 'more.txt', 'round2\n', 'round2');
    await writeFile(join(repo, 'a.txt'), 'user edit in progress\n');

    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.landed, true);
    assert.match(await git(repo, 'status', '--porcelain'), /a\.txt/,
      'the in-progress edit must be left exactly as it was');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: keep worktree — left detached, still listed', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    const r = await executeFinish({ repoPath: repo, path: wt, remove: false });
    assert.equal(r.removed, false);
    assert.equal(r.safetyRef, undefined);
    assert.equal((await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'HEAD'); // detached
    assert.equal(r.returned, true);
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'master'); // landed, then returned
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: re-landing merges detached worktree commits into the landed branch', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await executeFinish({ repoPath: repo, path: wt, remove: false }); // first landing; main returns to master
    await git(repo, 'switch', branch);                                // user opens the landed branch in main
    await commitFile(wt, 'more.txt', 'round2\n', 'round2');           // agent continues, detached
    await commitFile(repo, 'own.txt', 'mine\n', 'my own commit');     // user advances the branch
    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.merged, 'merged');
    assert.equal(r.removed, true);
    assert.equal(r.returned, false); // main was already on the branch — nothing to return to
    const log = await git(repo, 'log', '--oneline');
    assert.match(log, /round2/);
    assert.match(log, /my own commit/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: conflict — clean stop, worktree kept, stash kept; second run resumes', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await executeFinish({ repoPath: repo, path: wt, remove: false });
    await git(repo, 'switch', branch); // user works on the landed branch in main
    await commitFile(wt, 'a.txt', 'agent version\n', 'agent edit');
    await commitFile(repo, 'a.txt', 'user version\n', 'user edit');
    await writeFile(join(wt, 'wip.txt'), 'carried\n');
    const r1 = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r1.conflict, true);
    assert.equal(r1.removed, false);
    assert.equal(r1.safetyRef, undefined);
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

test('executeFinish: conflicted merge blocks removal (guard branch unreached — conflict returns first)', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await executeFinish({ repoPath: repo, path: wt, remove: false });
    await git(repo, 'switch', branch); // user works on the landed branch in main
    await commitFile(wt, 'a.txt', 'agent version\n', 'agent edit');
    await commitFile(repo, 'a.txt', 'user version\n', 'user edit');
    const r = await executeFinish({ repoPath: repo, path: wt }); // conflicts
    assert.equal(r.conflict, true);
    assert.equal(r.removed, false); // guard held: worktree commits not reachable
  } finally { await rm(repo, { recursive: true, force: true }); }
});

// Incident 2026-07-29: a worktree containing a read-only directory (a kit's
// self-lock, `chmod a-w`, applied to files AND directories) cannot have that
// directory's contents deleted, because deletion requires write permission
// on the parent — so `git worktree remove` throws. Before this fix, that
// throw aborted executeFinish before the stash pop (then step 7) ever ran,
// stranding the user's carried work in the stash. The fix moves the pop
// before removal and makes removal itself non-fatal.
test('executeFinish: a worktree removal failure (read-only directory) does not strand the stash', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  const lockedDir = join(wt, 'locked');
  try {
    // A committed (not dirty) file inside a directory we then lock down —
    // mirrors a kit's provisioned files, which are ordinary tracked content,
    // not part of the uncommitted work being carried over.
    await mkdir(lockedDir);
    await writeFile(join(lockedDir, 'kit-file.txt'), 'kit content\n');
    await git(wt, 'add', '.');
    await git(wt, 'commit', '-m', 'simulate a provisioned kit file');
    // The actual carried work: an uncommitted file the user needs back.
    await writeFile(join(wt, 'wip.txt'), 'carried\n');
    chmodSync(lockedDir, 0o555); // directories, not just files — deletion needs write on the parent

    const r = await executeFinish({ repoPath: repo, path: wt });

    assert.equal(r.stashPopped, true);
    assert.equal(r.removed, false);
    assert.equal(typeof r.removeError, 'string');
    assert.ok(r.removeError.length > 0);
    assert.equal(await readFile(join(repo, 'wip.txt'), 'utf8'), 'carried\n');
  } finally {
    chmodSync(lockedDir, 0o755); // restore BEFORE rm, or cleanup fails for the same reason
    await rm(repo, { recursive: true, force: true });
  }
});

// Finding 1 (fix wave review): the `git()` helper journals every step BEFORE
// running it, so a failed `worktree remove` was journalled identically to a
// successful one — the only record of the failure lived in the in-memory
// result, which nothing read. onStep must also receive a distinct failure
// line so the journal (not just the toast) reflects reality.
test('executeFinish: a failed worktree removal is journaled as a failure, not just the attempt', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  const lockedDir = join(wt, 'locked');
  try {
    await mkdir(lockedDir);
    await writeFile(join(lockedDir, 'kit-file.txt'), 'kit content\n');
    await git(wt, 'add', '.');
    await git(wt, 'commit', '-m', 'simulate a provisioned kit file');
    chmodSync(lockedDir, 0o555);

    const steps = [];
    const r = await executeFinish({ repoPath: repo, path: wt, onStep: (s) => steps.push(s) });

    assert.equal(r.removed, false);
    assert.equal(typeof r.removeError, 'string');
    const attempted = steps.filter((s) => s.cmd === 'git worktree remove ' + wt);
    assert.equal(attempted.length, 1, 'the attempt is still journalled (unchanged behaviour)');
    const failureLine = steps.find((s) => s.cmd.includes('worktree remove failed'));
    assert.ok(failureLine, 'expected a distinct journal line describing the removal failure');
    assert.ok(failureLine.cmd.includes(r.removeError), 'failure line should carry the actual error');
    assert.equal(failureLine.cwd, repo);
  } finally {
    chmodSync(lockedDir, 0o755);
    await rm(repo, { recursive: true, force: true });
  }
});

// A conflicted pop means the worktree is still the user's only intact copy
// of the carried work, so removal must not proceed until that's resolved.
// Set up as a RE-landing (the first finish lands and returns main to master;
// the test then opens the branch in main, so the second one switches nothing). Before the dirty-main guard this test dirtied
// the main checkout across a branch switch — the very thing that is now
// refused up front. A conflicted pop is still reachable without a switch, and
// that is the path worth keeping covered.
test('executeFinish: a conflicted stash pop keeps the worktree — removal is skipped', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await executeFinish({ repoPath: repo, path: wt, remove: false });
    await git(repo, 'switch', branch);
    await writeFile(join(wt, 'a.txt'), 'agent version\n'); // carried via stash
    await writeFile(join(repo, 'a.txt'), 'user version\n'); // conflicts with the stash on pop
    const r = await executeFinish({ repoPath: repo, path: wt });

    assert.equal(r.stashConflict, true);
    assert.equal(r.removed, false);
    assert.equal(typeof r.removeSkipped, 'string');
    assert.match(r.removeSkipped, /stash pop conflicted/);
    assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).includes(wt), true);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeEject: reverses a finish — main back on the previous branch, worktree re-exists holding the landed branch, ledger empty', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await commitFile(wt, 'feat.txt', 'work\n', 'feat');
    const f = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(f.removed, true);
    assert.equal((await readLandings(repo)).length, 1);

    const e = await executeEject({ repoPath: repo });
    assert.equal(e.branch, branch);
    assert.equal(e.previousBranch, 'master');
    assert.equal(e.path, wt);

    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'master');
    assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).includes(wt), true);
    assert.equal((await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), branch);
    assert.deepEqual(await readLandings(repo), []);

    // Fix 5: a successful eject deletes the safety ref — its insurance job is done.
    const refs = await git(repo, 'for-each-ref', 'refs/forest/landed');
    assert.doesNotMatch(refs, new RegExp(`refs/forest/landed/${basename(wt)}`));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeEject: dirty conflicting main rejects the switch and leaves the ledger entry intact', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  try {
    await commitFile(wt, 'feat.txt', 'work\n', 'feat'); // feat.txt only exists on the landed branch, not on master
    await writeFile(join(wt, 'wip.txt'), 'carried\n');   // dirty worktree: main stays on the landed branch after finish
    await executeFinish({ repoPath: repo, path: wt });
    const before = await readLandings(repo);
    assert.equal(before.length, 1);

    // dirty main's checkout of feat.txt so switching back to master (which
    // doesn't track it) would discard the uncommitted edit — git refuses.
    await writeFile(join(repo, 'feat.txt'), 'dirty edit\n');

    await assert.rejects(() => executeEject({ repoPath: repo }));
    assert.deepEqual(await readLandings(repo), before);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: stash match is exact by line suffix — a same-prefix worktree\'s carried stash is never popped', async () => {
  const { repo, wt } = await makeRepoWithWorktree({ branch: 'tech/W-1' });
  try {
    const wt10 = join(repo, '.forest', 'wt', 'tech-W-10');
    await git(repo, 'worktree', 'add', '-b', 'tech/W-10', wt10, 'HEAD');
    await writeFile(join(wt10, 'leftover.txt'), 'from the other worktree\n');
    await git(wt10, 'stash', 'push', '-u', '-m', 'forest-finish tech-W-10');

    const r = await executeFinish({ repoPath: repo, path: wt }); // clean resume, no stash of its own
    assert.equal(r.stashPopped, false);
    assert.match(await git(repo, 'stash', 'list'), /forest-finish tech-W-10/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: name mismatch — explicit targetBranch renames before landing', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  try {
    await git(wt, 'switch', '-c', 'fix/other-name');
    const r = await executeFinish({ repoPath: repo, path: wt, targetBranch: basename(wt) });
    assert.equal(r.targetBranch, basename(wt));
    await assert.doesNotReject(() => git(repo, 'rev-parse', '--verify', `refs/heads/${basename(wt)}`)); // renamed branch exists
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'master'); // main returned after landing
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: removing finish writes the safety ref and a ledger entry', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await commitFile(wt, 'feat.txt', 'work\n', 'feat');
    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.removed, true);
    assert.equal(r.safetyRef, `refs/forest/landed/${basename(wt)}`);

    const refs = await git(repo, 'for-each-ref', 'refs/forest/landed');
    assert.match(refs, new RegExp(`refs/forest/landed/${basename(wt)}`));

    const { readLandings } = await import('./landed.mjs');
    const entries = await readLandings(repo);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].previousBranch, 'master');
    assert.equal(entries[0].worktreeName, basename(wt));
    assert.equal(entries[0].branch, branch);
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

// Fix 1: executeEject's restore path — if recordLanding's own restore write
// throws, the original failure must not be silently replaced.
test('executeEject: restore write also fails — one combined error, entry recoverable from the message', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  const worktreeName = basename(wt);
  try {
    await commitFile(wt, 'feat.txt', 'work\n', 'feat'); // feat.txt only exists on the landed branch
    await writeFile(join(wt, 'wip.txt'), 'carried\n');   // dirty worktree: main stays on the landed branch after finish
    await executeFinish({ repoPath: repo, path: wt });
    assert.equal((await readLandings(repo)).length, 1);

    // Force the switch to fail first — same setup as the existing refusal test:
    // a dirty edit to a tracked file that only exists on the landed branch.
    await writeFile(join(repo, 'feat.txt'), 'dirty edit\n');

    // Make the restore ALSO fail, deterministically. Naively chmod'ing
    // .forest BEFORE calling executeEject was tried first, per the brief —
    // but it fails one step too early: popLanding's own ledger-trim write
    // shares the exact same atomic-write path (lib/landed.mjs `write()`)
    // against the same directory, so the whole call throws a raw EACCES out
    // of popLanding instead of exercising executeEject's catch/restore
    // branch at all. (Confirmed empirically, not just in theory — see the
    // report.) So instead: chmod from inside `onStep`, which fires from
    // executeEject's own `git()` helper right before the first git command
    // in its try block — i.e. strictly *after* popLanding's write has
    // already landed successfully, and strictly *before* the switch (which
    // we've engineered to fail) runs. That is deterministic, not a race.
    const forestDir = join(repo, '.forest');
    const onStep = () => { try { chmodSync(forestDir, 0o555); } catch { /* ignore */ } };

    try {
      await assert.rejects(
        () => executeEject({ repoPath: repo, onStep }),
        (err) => {
          assert.match(err.message, /ledger restore ALSO failed/);
          assert.ok(err.message.includes(branch), 'combined error should contain the entry\'s branch name');
          assert.ok(err.message.includes(`refs/forest/landed/${worktreeName}`), 'combined error should point to the safety ref');
          // (c): the full popped entry, recoverable as JSON straight out of the message.
          const embedded = JSON.parse(err.message.slice(err.message.indexOf('{')));
          assert.equal(embedded.worktreeName, worktreeName);
          assert.equal(embedded.branch, branch);
          assert.equal(embedded.previousBranch, 'master');
          assert.equal(embedded.path, wt);
          return true;
        },
      );
    } finally {
      chmodSync(forestDir, 0o755); // restore permissions before the fixture rm()
    }
  } finally { await rm(repo, { recursive: true, force: true }); }
});

// Fix 2: guided eject must guard a null previousBranch (recorded when the
// primary was detached at finish time) instead of building `git switch 'null'`.
test('guided eject: null previousBranch is rejected with a 400, not "git switch \'null\'"', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await recordLanding(repo, {
      worktreeName: basename(wt), branch, previousBranch: null, path: wt,
      head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', ts: Date.now(),
    });
    assert.equal((await readLandings(repo)).length, 1);

    const handleAction = createActionHandler();
    const req = { url: '/api/worktree/eject' };
    const res = {
      statusCode: null, body: null,
      writeHead(code) { this.statusCode = code; },
      end(str) { this.body = str ? JSON.parse(str) : null; },
    };
    const ctx = {
      config: {}, journal: { add: () => {} },
      broadcast: () => {}, snapshot: async () => ({}),
    };
    const readBody = async () => ({ repoPath: repo, mode: 'guided' });

    await handleAction(req, res, ctx, readBody);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /no previous branch/);
    // the ledger entry must still be there — this route only reads, never pops
    assert.equal((await readLandings(repo)).length, 1);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

// Fix 4: a conflict-resume-style landing records previousBranch === branch
// (main was already on the target branch at finish time — step 4's switch
// was a no-op). There is nothing to eject: no previous branch to switch
// back to, no worktree state to recreate. executeEject must refuse with a
// friendly, actionable error and restore the popped entry rather than
// attempting (and failing) a `git switch <branch>`/`worktree add` pair.
test('executeEject: previousBranch === branch (main already on it at finish time) — friendly error, entry restored', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    const head = (await git(wt, 'rev-parse', 'HEAD')).trim();
    const entry = { worktreeName: basename(wt), branch, previousBranch: branch, path: wt, head, ts: Date.now() };
    await recordLanding(repo, entry);
    assert.deepEqual(await readLandings(repo), [entry]);

    await assert.rejects(() => executeEject({ repoPath: repo }), /nothing to eject/);
    assert.deepEqual(await readLandings(repo), [entry]);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

// Fix 2: the op lock (lib/oplock.mjs) must serialize concurrent Finish calls
// against the same repo. Without it, two `git -C repo ...` invocations race
// on the shared working tree/index/HEAD — at best a flaky `index.lock`
// collision, at worst a `switch` from one call landing mid the other's
// `merge`, corrupting which branch actually receives which commits. Fire
// both unawaited, `Promise.all` them, then assert the end state is exactly
// what two *sequential* finishes would produce — every time, not just on a
// lucky interleaving.
test('executeFinish: two concurrent finishes on one repo — op lock serializes them, both land cleanly', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'forest-finish-conc-'));
  try {
    await git(repo, 'init', '-b', 'master');
    await git(repo, 'config', 'user.email', 't@t');
    await git(repo, 'config', 'user.name', 't');
    await git(repo, 'config', 'gc.auto', '0');
    await writeFile(join(repo, 'base.txt'), 'base\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'base');

    const wtA = join(repo, '.forest', 'wt', 'tech-a');
    const wtB = join(repo, '.forest', 'wt', 'tech-b');
    await git(repo, 'worktree', 'add', '-b', 't/a', wtA, 'HEAD');
    await git(repo, 'worktree', 'add', '-b', 't/b', wtB, 'HEAD');
    await commitFile(wtA, 'a.txt', 'from a\n', 'a commit');
    await commitFile(wtB, 'b.txt', 'from b\n', 'b commit');

    const headA = (await git(wtA, 'rev-parse', 'HEAD')).trim();
    const headB = (await git(wtB, 'rev-parse', 'HEAD')).trim();

    // Unawaited — both start racing immediately; the op lock is what makes
    // the outcome deterministic despite the race.
    const pA = executeFinish({ repoPath: repo, path: wtA });
    const pB = executeFinish({ repoPath: repo, path: wtB });
    const [ra, rb] = await Promise.all([pA, pB]);

    assert.equal(ra.landed, true);
    assert.equal(rb.landed, true);
    assert.equal(ra.removed, true);
    assert.equal(rb.removed, true);

    const wtList = await git(repo, 'worktree', 'list', '--porcelain');
    assert.equal(wtList.includes(wtA), false);
    assert.equal(wtList.includes(wtB), false);

    assert.equal((await readLandings(repo)).length, 2);

    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'master', 'both landings return main to master');

    // Each worktree's commits must be reachable from ITS OWN target branch —
    // i.e. neither call's merge landed on the other's branch.
    await assert.doesNotReject(() => git(repo, 'merge-base', '--is-ancestor', headA, 't/a'));
    await assert.doesNotReject(() => git(repo, 'merge-base', '--is-ancestor', headB, 't/b'));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: worktree living outside the repo tree lands and is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forest-wtroot-'));
  const { repo, wt, branch } = await makeRepoWithWorktree({ branch: 'tech/OUT-1', root });
  try {
    assert.ok(!wt.startsWith(repo), 'fixture must place the worktree outside the repo');
    await commitFile(wt, 'out.txt', 'work\n', 'feat');
    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.targetBranch, branch);
    assert.equal(r.landed, true);
    assert.equal(r.removed, true);
    assert.equal(r.returned, true);
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'master');
    assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).includes(wt), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

// 2026-09-11: Finish used to leave the main checkout ON the landed branch —
// that was the point of the original design (bring the branch to the IDE the
// user already had open). With Cursor opening worktrees directly, every
// landing just switched the primary off master and the ticket's files
// "appeared in the project". A landing now ends by putting the main checkout
// back where it was — unless it is holding the worktree's carried changes,
// which must not ride onto the previous branch.
test('finishCommands: a clean landing ends by returning the main checkout to its previous branch', () => {
  const preview = { worktreeName: 'tech-WEBT-1', branch: 'tech/WEBT-1', detached: false, head: 'abc123', dirty: false, mainBranch: 'master' };
  const cmds = finishCommands({ repoPath: '/r', path: '/w', targetBranch: 'tech/WEBT-1', remove: true, preview });
  assert.equal(cmds.at(-1), `git -C '/r' switch 'master'`);
  assert.ok(cmds.indexOf(`git -C '/r' worktree remove '/w'`) < cmds.length - 1, 'the return comes after removal');
});

test('finishCommands: no return step when the worktree is dirty — the carried changes need the landed branch checked out', () => {
  const preview = { worktreeName: 'tech-WEBT-1', branch: 'tech/WEBT-1', detached: false, head: 'abc123', dirty: true, mainBranch: 'master' };
  const cmds = finishCommands({ repoPath: '/r', path: '/w', targetBranch: 'tech/WEBT-1', remove: true, preview });
  assert.equal(cmds.filter((c) => c === `git -C '/r' switch 'master'`).length, 0);
});

test('finishCommands: no return step when the main checkout was already on the target branch', () => {
  const preview = { worktreeName: 'tech-WEBT-1', branch: 'tech/WEBT-1', detached: false, head: 'abc123', dirty: false, mainBranch: 'tech/WEBT-1' };
  const cmds = finishCommands({ repoPath: '/r', path: '/w', targetBranch: 'tech/WEBT-1', remove: true, preview });
  assert.equal(cmds.filter((c) => c.startsWith(`git -C '/r' switch`)).length, 0);
});

test('executeFinish: main checkout detached at finish time — landing proceeds, nothing to return to, reason given', async () => {
  const { repo, wt, branch } = await makeRepoWithWorktree();
  try {
    await git(repo, 'switch', '--detach');
    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.landed, true);
    assert.equal(r.removed, true);
    assert.equal(r.returned, false);
    assert.match(r.stayReason, /detached/);
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), branch);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('executeFinish: the return step is journaled after removal, like every other step', async () => {
  const { repo, wt } = await makeRepoWithWorktree();
  try {
    const steps = [];
    await executeFinish({ repoPath: repo, path: wt, onStep: (s) => steps.push(s) });
    const ret = steps.findIndex((s) => s.cmd === 'git switch master' && s.cwd === repo);
    assert.notEqual(ret, -1, 'expected a journal line for the switch back to master');
    const removal = steps.findIndex((s) => s.cmd.startsWith('git worktree remove'));
    assert.ok(ret > removal, `return (${ret}) must come after removal (${removal})`);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
