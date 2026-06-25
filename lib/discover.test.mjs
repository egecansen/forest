import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleFrom, listRepoDirs } from './discover.mjs';

const DAY = 86_400_000;

test('staleFrom: merged is stale regardless of age', () => {
  assert.equal(staleFrom({ merged: true, lastCommitMs: Date.now(), nowMs: Date.now(), staleDays: 14 }), true);
});

test('staleFrom: old unmerged is stale', () => {
  const now = 100 * DAY;
  assert.equal(staleFrom({ merged: false, lastCommitMs: now - 20 * DAY, nowMs: now, staleDays: 14 }), true);
});

test('staleFrom: recent unmerged is not stale', () => {
  const now = 100 * DAY;
  assert.equal(staleFrom({ merged: false, lastCommitMs: now - 2 * DAY, nowMs: now, staleDays: 14 }), false);
});

test('listRepoDirs finds children with a .git entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forest-root-'));
  await mkdir(join(root, 'repoA', '.git'), { recursive: true });
  await mkdir(join(root, 'notrepo'), { recursive: true });
  await writeFile(join(root, 'loose.txt'), 'x');
  const repos = await listRepoDirs(root);
  assert.deepEqual(repos.map((r) => r.name).sort(), ['repoA']);
});
