import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expandPath, readRepoList, readRepoState, addRepo, removeRepo, repoErrorMessage } from './repos.mjs';

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

// Finding 3: server.mjs discards the malformed flag (readRepoList only
// returns the array), so a corrupt repos.json produces silence at startup —
// every listed repo disappears with no explanation. readRepoState exposes
// the flag readRepoList already computes internally so server.mjs can
// journal a warning.
test('readRepoState reports malformed:false and the parsed repos for a well-formed file', async () => {
  const root = await tmp('forest-root-');
  const repo = await makeRepo();
  try {
    await writeFile(join(root, 'repos.json'), JSON.stringify({ repos: [repo] }));
    const state = await readRepoState(root);
    assert.deepEqual(state, { repos: [repo], malformed: false });
  } finally { await rm(root, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

test('readRepoState reports malformed:false for an absent file', async () => {
  const root = await tmp('forest-root-');
  try {
    assert.deepEqual(await readRepoState(root), { repos: [], malformed: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('readRepoState reports malformed:true for a corrupt file, without discarding it', async () => {
  const root = await tmp('forest-root-');
  try {
    await writeFile(join(root, 'repos.json'), '{ not json');
    const state = await readRepoState(root);
    assert.deepEqual(state, { repos: [], malformed: true });
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), '{ not json'); // untouched
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

// Finding 1: addRepo used to accept a path whenever `git -C <path>
// rev-parse --git-dir` succeeded — which is also true for any subdirectory
// of a repo (no working-tree checkout, so `git` walks up to find .git) —
// while discover.mjs's render criterion is the literal `exists(join(p,
// '.git'))`. That let a subdirectory be "added" successfully yet never
// render, with no way to remove it. The accept criterion must equal the
// render criterion, and a rejected subdirectory should say where the real
// repo root is.
test('addRepo rejects a subdirectory of a repo and names the real root', async () => {
  const root = await tmp('forest-root-');
  const repo = await makeRepo();
  const sub = join(repo, 'src', 'deep');
  try {
    await mkdir(sub, { recursive: true });
    const r = await addRepo(root, sub);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'inside-repo');
    assert.equal(await realpath(r.toplevel), await realpath(repo));
    assert.match(repoErrorMessage(r.reason, r), new RegExp(r.toplevel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(await readRepoList(root), []); // nothing was written
  } finally { await rm(root, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

test('addRepo rejects a bare repository', async () => {
  const root = await tmp('forest-root-');
  const bare = await tmp('forest-bare-');
  try {
    await execFileP('git', ['init', '--bare', bare]);
    const r = await addRepo(root, bare);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-a-repo'); // forest cannot render a bare repo
    assert.deepEqual(await readRepoList(root), []);
  } finally { await rm(root, { recursive: true, force: true }); await rm(bare, { recursive: true, force: true }); }
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
  const seen = new Set(['not-absolute', 'not-found', 'not-a-repo', 'already-listed', 'list-unreadable'].map((r) => repoErrorMessage(r)));
  assert.equal(seen.size, 5);
  assert.match(repoErrorMessage('nonsense'), /\w/);
  assert.match(repoErrorMessage('inside-repo', { toplevel: '/x/y' }), /\/x\/y/);
});

test('readRepoList and addRepo refuse schema-invalid repos.json (repos not an array)', async () => {
  const root = await tmp('forest-root-');
  const repo = await makeRepo();
  try {
    const content = '{"repos": "/some/path"}';
    await writeFile(join(root, 'repos.json'), content);
    // readRepoList returns [] without rewriting
    assert.deepEqual(await readRepoList(root), []);
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), content);
    // addRepo refuses to write
    assert.equal((await addRepo(root, repo)).reason, 'list-unreadable');
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), content);
    // removeRepo refuses to write
    assert.equal((await removeRepo(root, '/any/path')).reason, 'list-unreadable');
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), content);
  } finally { await rm(root, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

test('readRepoList and addRepo refuse schema-invalid repos.json (repos not array, with extra field)', async () => {
  const root = await tmp('forest-root-');
  const repo = await makeRepo();
  try {
    const content = '{"repos": "/some/important/path", "note": "hand-authored, do not lose"}';
    await writeFile(join(root, 'repos.json'), content);
    // readRepoList returns [] without rewriting or losing data
    assert.deepEqual(await readRepoList(root), []);
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), content);
    // addRepo refuses to write
    assert.equal((await addRepo(root, repo)).reason, 'list-unreadable');
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), content);
    // removeRepo refuses to write
    assert.equal((await removeRepo(root, '/any/path')).reason, 'list-unreadable');
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), content);
  } finally { await rm(root, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

test('readRepoList and addRepo refuse schema-invalid repos.json (array with non-string elements)', async () => {
  const root = await tmp('forest-root-');
  const repo = await makeRepo();
  try {
    const content = '{"repos": ["/a", 42]}';
    await writeFile(join(root, 'repos.json'), content);
    // readRepoList returns [] without silently dropping the 42 on write
    assert.deepEqual(await readRepoList(root), []);
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), content);
    // addRepo refuses to write
    assert.equal((await addRepo(root, repo)).reason, 'list-unreadable');
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), content);
    // removeRepo refuses to write
    assert.equal((await removeRepo(root, '/any/path')).reason, 'list-unreadable');
    assert.equal(await readFile(join(root, 'repos.json'), 'utf8'), content);
  } finally { await rm(root, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); }
});

// N=20: empirically, N=5 (small, unlocked, real `git` child-process spawns
// per addRepo) almost never actually interleaves on this machine — the
// isGitRepo() exec is slow and jittery enough relative to the fast
// read-modify-write that it naturally re-serializes 5 concurrent calls (0
// dropped entries across 25+ trial runs during development). N=20 reliably
// puts enough concurrent child processes in flight that their completions
// bunch up and the write race actually triggers (10/10 trial runs against
// the unlocked body dropped entries). See task-5-report.md for the
// measurements. Kept above the brief's suggested floor of 5 for this reason.
test('concurrent addRepo calls against the same forestRoot do not drop entries', async () => {
  const root = await tmp('forest-root-');
  const repos = [];
  const N = 20;
  try {
    for (let i = 0; i < N; i++) repos.push(await makeRepo());

    const results = await Promise.all(repos.map((r) => addRepo(root, r)));
    assert.ok(results.every((r) => r.ok === true), `every add should succeed: ${JSON.stringify(results)}`);

    const list = await readRepoList(root);
    assert.equal(list.length, N, `expected ${N} entries, got ${list.length}: ${JSON.stringify(list)}`);
    for (const r of repos) assert.ok(list.includes(r), `${r} missing from ${JSON.stringify(list)}`);

    const text = await readFile(join(root, 'repos.json'), 'utf8');
    const parsed = JSON.parse(text); // must still parse — no interleaved/corrupt write
    assert.equal(parsed.repos.length, N, `on-disk repos array should have ${N} entries, got ${parsed.repos.length}`);
  } finally {
    await rm(root, { recursive: true, force: true });
    await Promise.all(repos.map((r) => rm(r, { recursive: true, force: true })));
  }
});
