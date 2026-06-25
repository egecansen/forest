import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, mergeConfig, loadConfig } from './config.mjs';

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
