import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTree, readKitManifest, provisionKit, provisionPack } from './packs.mjs';

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

test('readKitManifest falls back to conventions when kit.json is absent', async () => {
  const kit = await tmp('forest-kit-');
  const m = await readKitManifest(kit);
  assert.equal(m.hooksDir, 'hooks');
  assert.equal(m.schemasDir, 'schemas');
  assert.equal(m.skillsDir, 'skills');
  assert.equal(m.settingsFile, 'settings.hooks.json');
});

test('readKitManifest lets kit.json override the hooks directory', async () => {
  const kit = await tmp('forest-kit-');
  await writeFile(join(kit, 'kit.json'), JSON.stringify({
    id: 'flaky', label: 'Flaky', hooks: { dir: 'adapters/claude', settings: 'gates.json' },
  }));
  const m = await readKitManifest(kit);
  assert.equal(m.id, 'flaky');
  assert.equal(m.hooksDir, 'adapters/claude');
  assert.equal(m.settingsFile, 'gates.json');
  assert.equal(m.schemasDir, 'schemas');   // untouched keys keep the convention
});

test('provisionKit installs hooks, skills and the settings fragment', async () => {
  const kit = await tmp('forest-kit-'), wt = await tmp('forest-wt-');
  await mkdir(join(kit, 'hooks'), { recursive: true });
  await writeFile(join(kit, 'hooks', 'gate.sh'), '#!/bin/sh\n');
  await chmod(join(kit, 'hooks', 'gate.sh'), 0o755);
  await mkdir(join(kit, 'skills', 'my-skill'), { recursive: true });
  await writeFile(join(kit, 'skills', 'my-skill', 'SKILL.md'), '# skill\n');
  await writeFile(join(kit, 'settings.hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"' }] }] },
  }));

  const conflicts = [];
  const r = await provisionKit({ kitDir: kit, kitId: 'my-kit', worktreePath: wt, conflicts, written: new Map() });

  assert.deepEqual(r.skills, ['my-skill']);
  assert.equal((await stat(join(wt, '.claude', 'hooks', 'gate.sh'))).mode & 0o111, 0o111);
  assert.equal(await readFile(join(wt, '.claude', 'skills', 'my-skill', 'SKILL.md'), 'utf8'), '# skill\n');
  assert.ok(await readFile(join(wt, '.claude', 'kits', 'my-kit', 'settings.hooks.json'), 'utf8'));
  const settings = JSON.parse(await readFile(join(wt, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, '"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"');
  assert.deepEqual(conflicts, []);
});

test('provisionKit is idempotent — a second run adds no duplicate registration', async () => {
  const kit = await tmp('forest-kit-'), wt = await tmp('forest-wt-');
  await writeFile(join(kit, 'settings.hooks.json'), JSON.stringify({
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x.sh' }] }] },
  }));
  const args = { kitDir: kit, kitId: 'k', worktreePath: wt, conflicts: [], written: new Map() };
  await provisionKit(args);
  await provisionKit({ ...args, written: new Map() });
  const settings = JSON.parse(await readFile(join(wt, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(settings.hooks.Stop[0].hooks.length, 1);
});

test('provisionPack: two kits colliding on the same hooks path — conflict recorded, first kit\'s content wins', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    const packDir = join(packsDir, 'my-pack');
    await mkdir(join(packDir, 'kits', 'kit-a', 'hooks', 'lib'), { recursive: true });
    await writeFile(join(packDir, 'kits', 'kit-a', 'hooks', 'lib', 'audit.sh'), 'kit-a version\n');
    await mkdir(join(packDir, 'kits', 'kit-b', 'hooks', 'lib'), { recursive: true });
    await writeFile(join(packDir, 'kits', 'kit-b', 'hooks', 'lib', 'audit.sh'), 'kit-b version\n');

    const r = await provisionPack({ packsDir, pack: 'my-pack', kits: ['kit-a', 'kit-b'], worktreePath: wt });

    assert.deepEqual(r.kits, ['kit-a', 'kit-b']);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].incoming, 'kit-b');
    assert.equal(r.conflicts[0].existing, 'kit-a');
    assert.equal(
      await readFile(join(wt, '.claude', 'hooks', 'lib', 'audit.sh'), 'utf8'),
      'kit-a version\n',
      'the destination must keep the first-provisioned kit\'s content, not be silently clobbered',
    );
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('provisionPack: a kit selection with no directory on disk is skipped, other kits still provision', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    const packDir = join(packsDir, 'my-pack');
    await mkdir(join(packDir, 'kits', 'real-kit', 'skills', 'foo'), { recursive: true });
    await writeFile(join(packDir, 'kits', 'real-kit', 'skills', 'foo', 'SKILL.md'), '# foo\n');

    const r = await provisionPack({ packsDir, pack: 'my-pack', kits: ['ghost', 'real-kit'], worktreePath: wt });

    assert.deepEqual(r.kits, ['real-kit']);
    assert.deepEqual(r.kitSkills, ['foo']);
    assert.deepEqual(r.conflicts, []);
    assert.equal(await readFile(join(wt, '.claude', 'skills', 'foo', 'SKILL.md'), 'utf8'), '# foo\n');
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('provisionPack: pack-level hooks branch still copies hooks/schemas and merges settings after the rewire', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    const packDir = join(packsDir, 'gate-pack');
    await mkdir(join(packDir, 'hooks'), { recursive: true });
    await writeFile(join(packDir, 'hooks', 'gate.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(packDir, 'hooks', 'gate.sh'), 0o755);
    await mkdir(join(packDir, 'schemas'), { recursive: true });
    await writeFile(join(packDir, 'schemas', 'gate.schema.json'), '{}\n');
    await writeFile(join(packDir, 'settings.hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'gate.sh' }] }] },
    }));
    await writeFile(join(packDir, 'catalog.json'), JSON.stringify({
      pack: 'gate-pack',
      hooks: { id: 'gate-pack-gates', dir: 'hooks', schemas: 'schemas', settings: 'settings.hooks.json' },
    }));

    const r = await provisionPack({ packsDir, pack: 'gate-pack', hooks: true, worktreePath: wt });

    assert.equal(r.hooks, true);
    assert.deepEqual(r.conflicts, []);
    assert.equal((await stat(join(wt, '.claude', 'hooks', 'gate.sh'))).mode & 0o111, 0o111);
    assert.equal(await readFile(join(wt, '.claude', 'schemas', 'gate.schema.json'), 'utf8'), '{}\n');
    const settings = JSON.parse(await readFile(join(wt, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'gate.sh');
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});
