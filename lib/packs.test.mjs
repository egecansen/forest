import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTree } from './packs.mjs';

const tmp = (p) => mkdtemp(join(tmpdir(), p));

test('copyTree copies new files and preserves the executable bit', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  await mkdir(join(src, 'lib'), { recursive: true });
  await writeFile(join(src, 'gate.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(src, 'gate.sh'), 0o755);
  await writeFile(join(src, 'lib', 'audit.sh'), 'audit\n');
  const conflicts = [];
  const r = await copyTree(src, dst, { owner: 'kit-a', conflicts });
  assert.equal(r.copied, 2);
  assert.equal(await readFile(join(dst, 'lib', 'audit.sh'), 'utf8'), 'audit\n');
  assert.equal((await stat(join(dst, 'gate.sh'))).mode & 0o111, 0o111);
  assert.deepEqual(conflicts, []);
});

test('copyTree skips byte-identical files without reporting a conflict', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  await writeFile(join(src, 'audit.sh'), 'same\n');
  await writeFile(join(dst, 'audit.sh'), 'same\n');
  const conflicts = [];
  const r = await copyTree(src, dst, { owner: 'kit-b', conflicts });
  assert.equal(r.copied, 0);
  assert.deepEqual(conflicts, []);
});

test('copyTree refuses to overwrite differing content and names both owners', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  await writeFile(join(src, 'audit.sh'), 'v2\n');
  await writeFile(join(dst, 'audit.sh'), 'v1\n');
  const conflicts = [];
  const written = new Map([[join(dst, 'audit.sh'), 'kit-a']]);
  await copyTree(src, dst, { owner: 'kit-b', conflicts, written });
  assert.equal(await readFile(join(dst, 'audit.sh'), 'utf8'), 'v1\n', 'destination must survive');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].incoming, 'kit-b');
  assert.equal(conflicts[0].existing, 'kit-a');
});

test('copyTree reports a pre-existing file it did not write', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  await writeFile(join(src, 'a.sh'), 'new\n');
  await writeFile(join(dst, 'a.sh'), 'old\n');
  const conflicts = [];
  await copyTree(src, dst, { owner: 'kit-a', conflicts });
  assert.equal(conflicts[0].existing, 'preexisting');
});

test('copyTree treats a missing source as a no-op', async () => {
  const dst = await tmp('forest-dst-');
  const conflicts = [];
  const r = await copyTree('/no/such/source', dst, { owner: 'kit-a', conflicts });
  assert.equal(r.copied, 0);
  assert.deepEqual(conflicts, []);
});

test('copyTree restores executable bit on identical content', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  await writeFile(join(src, 'hook.sh'), 'script\n');
  await chmod(join(src, 'hook.sh'), 0o755);
  await writeFile(join(dst, 'hook.sh'), 'script\n');
  await chmod(join(dst, 'hook.sh'), 0o644);
  const conflicts = [];
  const r = await copyTree(src, dst, { owner: 'kit-a', conflicts });
  assert.equal(r.copied, 0, 'identical content is not counted as copied');
  assert.equal((await stat(join(dst, 'hook.sh'))).mode & 0o111, 0o111, 'destination mode must be executable');
  assert.deepEqual(conflicts, []);
});
