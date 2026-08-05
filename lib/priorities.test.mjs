import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPriorities, savePriority, clearPriority, priorityKey, PRIORITY_COLORS } from './priorities.mjs';

const withRepo = async (fn) => {
  const repo = await mkdtemp(join(tmpdir(), 'forest-prio-'));
  try { return await fn(repo); } finally { await rm(repo, { recursive: true, force: true }); }
};

test('PRIORITY_COLORS: the fixed four-color palette', () => {
  assert.deepEqual(PRIORITY_COLORS, ['red', 'amber', 'blue', 'green']);
});

test('savePriority/readPriorities: roundtrip, persisted to .forest/priorities.json', async () => {
  await withRepo(async (repo) => {
    assert.deepEqual(await readPriorities(repo), {});
    await savePriority(repo, 'tech/WEBT-229553', 'red');
    assert.deepEqual(await readPriorities(repo), { 'tech/WEBT-229553': 'red' });
    const raw = JSON.parse(await readFile(join(repo, '.forest', 'priorities.json'), 'utf8'));
    assert.deepEqual(raw, { 'tech/WEBT-229553': 'red' });
  });
});

test('savePriority: overwrites in place', async () => {
  await withRepo(async (repo) => {
    await savePriority(repo, 'b', 'red');
    await savePriority(repo, 'b', 'green');
    assert.deepEqual(await readPriorities(repo), { b: 'green' });
  });
});

test('clearPriority: removes the entry; clearing an absent key is a no-op', async () => {
  await withRepo(async (repo) => {
    await savePriority(repo, 'a', 'amber');
    await savePriority(repo, 'b', 'blue');
    await clearPriority(repo, 'a');
    assert.deepEqual(await readPriorities(repo), { b: 'blue' });
    await clearPriority(repo, 'never-there'); // must not throw or create noise
    assert.deepEqual(await readPriorities(repo), { b: 'blue' });
  });
});

test('readPriorities: missing file, corrupt JSON and non-object payloads read as empty', async () => {
  await withRepo(async (repo) => {
    assert.deepEqual(await readPriorities(repo), {});
    await mkdir(join(repo, '.forest'), { recursive: true });
    await writeFile(join(repo, '.forest', 'priorities.json'), '{not json');
    assert.deepEqual(await readPriorities(repo), {});
    await writeFile(join(repo, '.forest', 'priorities.json'), '["red"]');
    assert.deepEqual(await readPriorities(repo), {});
  });
});

test('priorityKey: branch when there is one, path for detached', () => {
  assert.equal(priorityKey({ branch: 'tech/WEBT-1', path: '/wt/x' }), 'tech/WEBT-1');
  assert.equal(priorityKey({ branch: null, path: '/wt/x' }), '/wt/x');
});
