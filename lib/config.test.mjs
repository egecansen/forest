import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, mergeConfig, loadConfig, worktreePathFor } from './config.mjs';

test('mergeConfig returns DEFAULTS when given empty object', () => {
  const c = mergeConfig({});
  assert.equal(c.port, DEFAULTS.port);
  assert.equal(c.defaultMode, 'guided');
});

test('mergeConfig overrides only provided keys', () => {
  const c = mergeConfig({ port: 9000, defaultMode: 'auto' });
  assert.equal(c.port, 9000);
  assert.equal(c.defaultMode, 'auto');
  assert.equal(c.staleDays, DEFAULTS.staleDays); // untouched
});

test('mergeConfig replaces roots array wholesale', () => {
  const c = mergeConfig({ roots: ['/a', '/b'] });
  assert.deepEqual(c.roots, ['/a', '/b']);
});

test('config.mjs source bakes in no personal path (portable)', async () => {
  const src = await readFile(new URL('./config.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('sahibinden'));
  assert.ok(!src.includes('/Users/'));
});

test('DEFAULTS expose absolute roots/packsDir + containers', () => {
  assert.ok(Array.isArray(DEFAULTS.containers));
  assert.ok(DEFAULTS.roots.every((r) => r.startsWith('/')));
  assert.equal(typeof DEFAULTS.packsDir, 'string');
});

test('mergeConfig overrides containers and packsDir', () => {
  const c = mergeConfig({ containers: ['X'], packsDir: '/p' });
  assert.deepEqual(c.containers, ['X']);
  assert.equal(c.packsDir, '/p');
});

test('loadConfig merges values from a real file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forest-cfg-'));
  const p = join(dir, 'config.json');
  await writeFile(p, JSON.stringify({ port: 8123 }));
  const c = await loadConfig(p);
  assert.equal(c.port, 8123);
  assert.equal(c.defaultMode, 'guided'); // default preserved
});

test('loadConfig returns DEFAULTS when file is missing', async () => {
  const c = await loadConfig('/no/such/forest-config-xyz.json');
  assert.equal(c.port, DEFAULTS.port);
});

test('loadConfig throws on malformed JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forest-cfg-'));
  const p = join(dir, 'bad.json');
  await writeFile(p, '{ not json');
  await assert.rejects(() => loadConfig(p));
});

test('DEFAULTS.worktreeRoot is absolute and ends in .forest/wt', () => {
  assert.ok(DEFAULTS.worktreeRoot.startsWith('/'));
  assert.ok(DEFAULTS.worktreeRoot.endsWith(join('.forest', 'wt')));
});

test('mergeConfig overrides worktreeRoot', () => {
  const c = mergeConfig({ worktreeRoot: '/tmp/wt' });
  assert.equal(c.worktreeRoot, '/tmp/wt');
});

test('worktreePathFor nests the repo name under the root', () => {
  const p = worktreePathFor({ worktreeRoot: '/wt', repoPath: '/a/b/web-test', branchSlug: 'tech-WEBT-1' });
  assert.equal(p, '/wt/web-test/tech-WEBT-1');
});

test('worktreePathFor never returns a path inside the repo', () => {
  const repoPath = '/a/b/web-test';
  const p = worktreePathFor({ worktreeRoot: '/wt', repoPath, branchSlug: 's' });
  assert.ok(!p.startsWith(repoPath));
});
