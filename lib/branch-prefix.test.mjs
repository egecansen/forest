import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixCandidate, dominantPrefix, inferBranchPrefix } from './branch-prefix.mjs';

// ---- prefixCandidate ----

test('prefixCandidate: everything before the trailing digit run, including the separator', () => {
  assert.equal(prefixCandidate('tech/WEBT-233021'), 'tech/WEBT-');
  assert.equal(prefixCandidate('SHBDN-1'), 'SHBDN-');
  assert.equal(prefixCandidate('feature123'), 'feature');
});

test('prefixCandidate: no trailing digits at all is not a candidate', () => {
  assert.equal(prefixCandidate('main'), null);
  assert.equal(prefixCandidate('develop'), null);
  assert.equal(prefixCandidate(''), null);
  assert.equal(prefixCandidate(null), null);
});

test('prefixCandidate: a bare number has nothing before the digits, so it is not usable', () => {
  assert.equal(prefixCandidate('12345'), null);
});

// ---- dominantPrefix ----

test('dominantPrefix: the clean case — one prefix, every branch agrees', () => {
  const refs = [
    { name: 'tech/WEBT-233021', committedAt: '2026-08-10T10:00:00+03:00' },
    { name: 'tech/WEBT-241011', committedAt: '2026-08-12T10:00:00+03:00' },
    { name: 'tech/WEBT-198000', committedAt: '2026-07-01T10:00:00+03:00' },
  ];
  assert.equal(dominantPrefix(refs), 'tech/WEBT-');
});

test('dominantPrefix: mixed prefixes — count decides', () => {
  const refs = [
    { name: 'tech/WEBT-1', committedAt: '2026-01-01T00:00:00Z' },
    { name: 'tech/WEBT-2', committedAt: '2026-01-02T00:00:00Z' },
    { name: 'tech/WEBT-3', committedAt: '2026-01-03T00:00:00Z' },
    { name: 'feature/ABC-1', committedAt: '2026-08-01T00:00:00Z' }, // more recent, but fewer
  ];
  assert.equal(dominantPrefix(refs), 'tech/WEBT-');
});

test('dominantPrefix: a count tie is broken by the most recent commit date', () => {
  const refs = [
    { name: 'tech/WEBT-1', committedAt: '2026-01-01T00:00:00Z' },
    { name: 'tech/WEBT-2', committedAt: '2026-01-02T00:00:00Z' },
    { name: 'feature/ABC-1', committedAt: '2026-01-01T00:00:00Z' },
    { name: 'feature/ABC-2', committedAt: '2026-08-01T00:00:00Z' }, // newer than any tech/WEBT- branch
  ];
  assert.equal(dominantPrefix(refs), 'feature/ABC-');
});

test('dominantPrefix: a full tie (count AND latest date) is broken alphabetically', () => {
  const refs = [
    { name: 'b/PACK-1', committedAt: '2026-01-01T00:00:00Z' },
    { name: 'a/PACK-1', committedAt: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(dominantPrefix(refs), 'a/PACK-');
});

test('dominantPrefix: no branches at all is no usable sample', () => {
  assert.equal(dominantPrefix([]), null);
  assert.equal(dominantPrefix(undefined), null);
});

test('dominantPrefix: branches with no ticket numbers is no usable sample', () => {
  const refs = [
    { name: 'main', committedAt: '2026-01-01T00:00:00Z' },
    { name: 'develop', committedAt: '2026-01-01T00:00:00Z' },
    { name: 'release', committedAt: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(dominantPrefix(refs), null);
});

test('dominantPrefix: a candidate prefix containing a slash is returned intact', () => {
  const refs = [{ name: 'tech/WEBT-233021', committedAt: '2026-01-01T00:00:00Z' }];
  assert.equal(dominantPrefix(refs), 'tech/WEBT-');
});

// ---- inferBranchPrefix (the git call injected) ----

function fakeGit(refLines) {
  const calls = [];
  const impl = async (cwd, args) => {
    calls.push({ cwd, args });
    return refLines.map((r) => `${r.refname}\t${r.committedAt || ''}`).join('\n');
  };
  impl.calls = calls;
  return impl;
}

test('inferBranchPrefix: reads refs/heads and refs/remotes in one call, dedupes by logical name', async () => {
  const git = fakeGit([
    { refname: 'refs/heads/tech/WEBT-1', committedAt: '2026-01-01T00:00:00+03:00' },
    { refname: 'refs/heads/tech/WEBT-2', committedAt: '2026-01-02T00:00:00+03:00' },
    // Same logical branch as the local one above, pushed — must not double count.
    { refname: 'refs/remotes/origin/tech/WEBT-1', committedAt: '2026-01-01T00:00:00+03:00' },
    { refname: 'refs/remotes/origin/HEAD', committedAt: '2026-01-01T00:00:00+03:00' }, // filtered out
    { refname: 'refs/remotes/origin/main', committedAt: '2026-01-01T00:00:00+03:00' },
  ]);
  const prefix = await inferBranchPrefix('/repo/web-test', git);
  assert.equal(prefix, 'tech/WEBT-');
  assert.equal(git.calls.length, 1, 'exactly one git call, not one per ref namespace');
  assert.deepEqual(git.calls[0].args.slice(0, 3), ['for-each-ref', 'refs/heads', 'refs/remotes']);
});

test('inferBranchPrefix: remote-tracking enlarges a too-small local sample', async () => {
  const git = fakeGit([
    { refname: 'refs/heads/tech/WEBT-1', committedAt: '2026-01-01T00:00:00Z' },
    { refname: 'refs/remotes/origin/tech/WEBT-2', committedAt: '2026-01-02T00:00:00Z' },
    { refname: 'refs/remotes/origin/tech/WEBT-3', committedAt: '2026-01-03T00:00:00Z' },
  ]);
  assert.equal(await inferBranchPrefix('/repo/web-test', git), 'tech/WEBT-');
});

test('inferBranchPrefix: no branches at all returns null, never a guess', async () => {
  const git = fakeGit([]);
  assert.equal(await inferBranchPrefix('/repo/empty', git), null);
});

test('inferBranchPrefix: a failing git call (bare repo, no commits yet, …) also returns null, never throws', async () => {
  const git = async () => { throw new Error('fatal: not a git repository'); };
  assert.equal(await inferBranchPrefix('/not/a/repo', git), null);
});
