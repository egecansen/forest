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
