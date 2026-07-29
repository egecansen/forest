import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readdir, mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordLanding, readLandings, popLanding, pruneLandings } from './landed.mjs';
import { git, makeRepoWithWorktree } from './finish-fixtures.mjs';

test('recordLanding/readLandings: roundtrip', async () => {
  const { repo } = await makeRepoWithWorktree();
  try {
    assert.deepEqual(await readLandings(repo), []);
    const entry = { worktreeName: 'tech-WEBT-1', branch: 'tech/WEBT-1', previousBranch: 'master', path: '/x', head: 'abc', ts: 1000 };
    await recordLanding(repo, entry);
    const entries = await readLandings(repo);
    assert.deepEqual(entries, [entry]);
    // persisted to disk at .forest/landed.json
    const raw = JSON.parse(await readFile(join(repo, '.forest', 'landed.json'), 'utf8'));
    assert.deepEqual(raw, [entry]);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('popLanding: returns last entry and shrinks the file', async () => {
  const { repo } = await makeRepoWithWorktree();
  try {
    const e1 = { worktreeName: 'a', branch: 'a', previousBranch: 'master', path: '/a', head: '111', ts: 1 };
    const e2 = { worktreeName: 'b', branch: 'b', previousBranch: 'master', path: '/b', head: '222', ts: 2 };
    await recordLanding(repo, e1);
    await recordLanding(repo, e2);
    const popped = await popLanding(repo);
    assert.deepEqual(popped, e2);
    const remaining = await readLandings(repo);
    assert.deepEqual(remaining, [e1]);
    const popped2 = await popLanding(repo);
    assert.deepEqual(popped2, e1);
    assert.deepEqual(await readLandings(repo), []);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('popLanding: null on an empty/missing ledger', async () => {
  const { repo } = await makeRepoWithWorktree();
  try {
    assert.equal(await popLanding(repo), null);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('pruneLandings: removes only entries older than maxAgeDays, deletes their refs, keeps the rest', async () => {
  const { repo } = await makeRepoWithWorktree();
  try {
    const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
    const DAY = 86_400_000;
    const now = 100 * DAY; // arbitrary injected "now"
    const oldEntry = { worktreeName: 'old-wt', branch: 'old', previousBranch: 'master', path: '/old', head, ts: now - 20 * DAY };
    const freshEntry = { worktreeName: 'fresh-wt', branch: 'fresh', previousBranch: 'master', path: '/fresh', head, ts: now - 1 * DAY };
    await recordLanding(repo, oldEntry);
    await recordLanding(repo, freshEntry);
    await git(repo, 'update-ref', 'refs/forest/landed/old-wt', head);
    await git(repo, 'update-ref', 'refs/forest/landed/fresh-wt', head);

    await pruneLandings(repo, { maxAgeDays: 14, now });

    const remaining = await readLandings(repo);
    assert.deepEqual(remaining, [freshEntry]);

    const refs = await git(repo, 'for-each-ref', 'refs/forest/landed');
    assert.doesNotMatch(refs, /refs\/forest\/landed\/old-wt/);
    assert.match(refs, /refs\/forest\/landed\/fresh-wt/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('pruneLandings: entry exactly at the boundary (age == maxAgeDays) is kept', async () => {
  const { repo } = await makeRepoWithWorktree();
  try {
    const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
    const DAY = 86_400_000;
    const now = 100 * DAY;
    const boundaryEntry = { worktreeName: 'boundary-wt', branch: 'b', previousBranch: 'master', path: '/b', head, ts: now - 14 * DAY };
    await recordLanding(repo, boundaryEntry);
    await git(repo, 'update-ref', 'refs/forest/landed/boundary-wt', head);

    await pruneLandings(repo, { maxAgeDays: 14, now });

    assert.deepEqual(await readLandings(repo), [boundaryEntry]);
    const refs = await git(repo, 'for-each-ref', 'refs/forest/landed');
    assert.match(refs, /refs\/forest\/landed\/boundary-wt/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('pruneLandings: no-op write when nothing expired', async () => {
  const { repo } = await makeRepoWithWorktree();
  try {
    // No ledger file at all — must not throw, must not create one.
    await pruneLandings(repo, { maxAgeDays: 14, now: Date.now() });
    assert.deepEqual(await readLandings(repo), []);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('pruneLandings: expired entry with an already-absent ref is dropped (absence == success)', async () => {
  const { repo } = await makeRepoWithWorktree();
  try {
    const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
    const DAY = 86_400_000;
    const now = 100 * DAY;
    // Deliberately never create refs/forest/landed/gone-wt — simulates a ref
    // that's already missing (e.g. a previous prune partially succeeded).
    const goneEntry = { worktreeName: 'gone-wt', branch: 'gone', previousBranch: 'master', path: '/gone', head, ts: now - 20 * DAY };
    await recordLanding(repo, goneEntry);

    await pruneLandings(repo, { maxAgeDays: 14, now });

    assert.deepEqual(await readLandings(repo), []); // absent ref treated as already-deleted: entry drops
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('pruneLandings: genuine ref-delete failure keeps the entry for retry (stale lock forces `update-ref -d` to fail)', async () => {
  const { repo } = await makeRepoWithWorktree();
  try {
    const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
    const DAY = 86_400_000;
    const now = 100 * DAY;
    const stuckEntry = { worktreeName: 'stuck-wt', branch: 'stuck', previousBranch: 'master', path: '/stuck', head, ts: now - 20 * DAY };
    await recordLanding(repo, stuckEntry);
    await git(repo, 'update-ref', 'refs/forest/landed/stuck-wt', head);

    // Simulate a concurrent/crashed git process holding the ref's lock, so
    // `git update-ref -d` deterministically fails (exit 1) even though the
    // ref exists.
    await mkdir(join(repo, '.git', 'refs', 'forest', 'landed'), { recursive: true });
    await writeFile(join(repo, '.git', 'refs', 'forest', 'landed', 'stuck-wt.lock'), '');

    await pruneLandings(repo, { maxAgeDays: 14, now });

    // Deletion failed genuinely (not "ref already absent") -> entry is kept, not dropped.
    assert.deepEqual(await readLandings(repo), [stuckEntry]);
    const refs = await git(repo, 'for-each-ref', 'refs/forest/landed');
    assert.match(refs, /refs\/forest\/landed\/stuck-wt/); // ref itself untouched/orphaned, ready to retry
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('recordLanding: 25 concurrent calls on one repo — readLandings returns exactly 25 entries', async () => {
  const { repo } = await makeRepoWithWorktree();
  try {
    const proms = [];
    for (let i = 0; i < 25; i++) {
      proms.push(recordLanding(repo, {
        worktreeName: `wt-${i}`, branch: `b-${i}`, previousBranch: 'master',
        path: `/x${i}`, head: `head${i}`, ts: i,
      }));
    }
    await Promise.all(proms);

    const entries = await readLandings(repo);
    assert.equal(entries.length, 25); // pre-fix (bare read-modify-write, no lock/atomic rename): collapses to as few as 1
    assert.equal(new Set(entries.map((e) => e.worktreeName)).size, 25); // all distinct, none clobbered
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('writes leave no *.tmp* leftovers in .forest/', async () => {
  const { repo } = await makeRepoWithWorktree();
  try {
    const proms = [];
    for (let i = 0; i < 10; i++) {
      proms.push(recordLanding(repo, { worktreeName: `t-${i}`, branch: `t-${i}`, previousBranch: 'master', path: `/t${i}`, head: 'h', ts: i }));
    }
    await Promise.all(proms);
    await popLanding(repo);
    await pruneLandings(repo, { maxAgeDays: 14, now: Date.now() });

    const files = await readdir(join(repo, '.forest'));
    assert.deepEqual(files.filter((f) => f.includes('.tmp')), []);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
