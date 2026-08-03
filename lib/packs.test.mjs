import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTree, readKitManifest, provisionKit, provisionPack, writeProvisionRecord, readProvisionRecord } from './packs.mjs';

const tmp = (p) => mkdtemp(join(tmpdir(), p));

test('copyTree copies new files and preserves the executable bit', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  try {
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
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test('copyTree skips byte-identical files without reporting a conflict', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  try {
    await writeFile(join(src, 'audit.sh'), 'same\n');
    await writeFile(join(dst, 'audit.sh'), 'same\n');
    const conflicts = [];
    const r = await copyTree(src, dst, { owner: 'kit-b', conflicts });
    assert.equal(r.copied, 0);
    assert.deepEqual(conflicts, []);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test('copyTree refuses to overwrite differing content and names both owners', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  try {
    await writeFile(join(src, 'audit.sh'), 'v2\n');
    await writeFile(join(dst, 'audit.sh'), 'v1\n');
    const conflicts = [];
    const written = new Map([[join(dst, 'audit.sh'), 'kit-a']]);
    await copyTree(src, dst, { owner: 'kit-b', conflicts, written });
    assert.equal(await readFile(join(dst, 'audit.sh'), 'utf8'), 'v1\n', 'destination must survive');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].incoming, 'kit-b');
    assert.equal(conflicts[0].existing, 'kit-a');
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test('copyTree reports a pre-existing file it did not write', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  try {
    await writeFile(join(src, 'a.sh'), 'new\n');
    await writeFile(join(dst, 'a.sh'), 'old\n');
    const conflicts = [];
    await copyTree(src, dst, { owner: 'kit-a', conflicts });
    assert.equal(conflicts[0].existing, 'preexisting');
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test('copyTree treats a missing source as a no-op', async () => {
  const dst = await tmp('forest-dst-');
  try {
    const conflicts = [];
    const r = await copyTree('/no/such/source', dst, { owner: 'kit-a', conflicts });
    assert.equal(r.copied, 0);
    assert.deepEqual(conflicts, []);
  } finally {
    await rm(dst, { recursive: true, force: true });
  }
});

test('copyTree restores executable bit on identical content', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  try {
    await writeFile(join(src, 'hook.sh'), 'script\n');
    await chmod(join(src, 'hook.sh'), 0o755);
    await writeFile(join(dst, 'hook.sh'), 'script\n');
    await chmod(join(dst, 'hook.sh'), 0o644);
    const conflicts = [];
    const r = await copyTree(src, dst, { owner: 'kit-a', conflicts });
    assert.equal(r.copied, 0, 'identical content is not counted as copied');
    assert.equal((await stat(join(dst, 'hook.sh'))).mode & 0o111, 0o111, 'destination mode must be executable');
    assert.deepEqual(conflicts, []);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test('readKitManifest falls back to conventions when kit.json is absent', async () => {
  const kit = await tmp('forest-kit-');
  try {
    const m = await readKitManifest(kit);
    assert.equal(m.hooksDir, 'hooks');
    assert.equal(m.schemasDir, 'schemas');
    assert.equal(m.skillsDir, 'skills');
    assert.equal(m.settingsFile, 'settings.hooks.json');
  } finally {
    await rm(kit, { recursive: true, force: true });
  }
});

test('readKitManifest lets kit.json override the hooks directory', async () => {
  const kit = await tmp('forest-kit-');
  try {
    await writeFile(join(kit, 'kit.json'), JSON.stringify({
      id: 'flaky', label: 'Flaky', hooks: { dir: 'adapters/claude', settings: 'gates.json' },
    }));
    const m = await readKitManifest(kit);
    assert.equal(m.id, 'flaky');
    assert.equal(m.hooksDir, 'adapters/claude');
    assert.equal(m.settingsFile, 'gates.json');
    assert.equal(m.schemasDir, 'schemas');   // untouched keys keep the convention
  } finally {
    await rm(kit, { recursive: true, force: true });
  }
});

test('provisionKit installs hooks, skills and the settings fragment', async () => {
  const kit = await tmp('forest-kit-'), wt = await tmp('forest-wt-');
  try {
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
  } finally {
    await rm(kit, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('provisionKit is idempotent — a second run adds no duplicate registration', async () => {
  const kit = await tmp('forest-kit-'), wt = await tmp('forest-wt-');
  try {
    await writeFile(join(kit, 'settings.hooks.json'), JSON.stringify({
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x.sh' }] }] },
    }));
    const args = { kitDir: kit, kitId: 'k', worktreePath: wt, conflicts: [], written: new Map() };
    await provisionKit(args);
    await provisionKit({ ...args, written: new Map() });
    const settings = JSON.parse(await readFile(join(wt, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(settings.hooks.Stop[0].hooks.length, 1);
  } finally {
    await rm(kit, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
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

// safeId's job is to forbid path navigation, not just constrain characters.
// '.' and '..' are made entirely of characters the old regex accepted, and
// all four safeId call sites join their id straight into a path — the same
// defect the delete route's traversal guard closes, just less destructive
// here because these call sites write instead of removing.
test('provisionPack refuses a pack id of ".." instead of reading from the packs directory\'s parent', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    await assert.rejects(
      () => provisionPack({ packsDir, pack: '..', worktreePath: wt }),
      /invalid pack id/,
      'a path-navigation pack id must never resolve packDir outside packsDir',
    );
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('provisionPack refuses a skill id of "." instead of copying the whole pack into .claude/skills', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    const packDir = join(packsDir, 'my-pack');
    await mkdir(join(packDir, 'skills', 'real-skill'), { recursive: true });
    await writeFile(join(packDir, 'skills', 'real-skill', 'SKILL.md'), '# real\n');
    await mkdir(join(packDir, 'skills', 'unselected-skill'), { recursive: true });
    await writeFile(join(packDir, 'skills', 'unselected-skill', 'SKILL.md'), '# unselected\n');

    const r = await provisionPack({ packsDir, pack: 'my-pack', skills: ['.'], worktreePath: wt });

    assert.deepEqual(r.skills, [], 'a path-navigation id must never be treated as a real skill');
    await assert.rejects(
      () => readFile(join(wt, '.claude', 'skills', 'unselected-skill', 'SKILL.md')),
      'an unselected skill must never bleed into .claude/skills via a "." id',
    );
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('provisionPack refuses a kit id of ".." instead of copying the whole packsDir into .claude', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    const packDir = join(packsDir, 'my-pack');
    await mkdir(join(packDir, 'kits', 'real-kit'), { recursive: true });
    await writeFile(join(packDir, 'kits', 'real-kit', 'x.sh'), 'x\n');
    await mkdir(join(packsDir, 'other-pack', 'skills', 'other-skill'), { recursive: true });
    await writeFile(join(packsDir, 'other-pack', 'skills', 'other-skill', 'SKILL.md'), '# other\n');

    const r = await provisionPack({ packsDir, pack: 'my-pack', kits: ['..'], worktreePath: wt });

    assert.deepEqual(r.kits, [], 'a path-navigation id must never be treated as a real kit');
    await assert.rejects(
      () => readFile(join(wt, '.claude', 'other-pack', 'skills', 'other-skill', 'SKILL.md'), 'utf8'),
      'a sibling pack must never bleed into .claude itself via a ".." kit id',
    );
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

test('provision record round-trips the selections', async () => {
  const wt = await tmp('forest-wt-');
  try {
    const selections = [{ pack: 'hektor', skills: [], kits: ['flaky-triage-kit'], hooks: true }];
    const file = await writeProvisionRecord(wt, selections);
    assert.ok(file.endsWith(join('.claude', '.forest-provision.json')));
    const rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.selections, selections);
    assert.ok(!Number.isNaN(Date.parse(rec.at)));
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

test('readProvisionRecord returns null for a worktree that has none', async () => {
  const wt = await tmp('forest-wt-');
  try {
    assert.equal(await readProvisionRecord(wt), null);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

// A kit that ships install.sh owns its own wiring. Copying the tree and hoping
// the four conventions line up is what left a worktree holding the kit with
// none of it wired, while the provision record reported success.

// The installer is the ONLY thing that produces the wired state here, so a test
// that passes cannot be passing because a convention copy did the work.
async function kitWithInstaller(body) {
  const kitDir = await tmp('forest-kit-');
  await writeFile(join(kitDir, 'install.sh'), `#!/bin/sh\n${body}\n`);
  await chmod(join(kitDir, 'install.sh'), 0o755);
  return kitDir;
}

test('provisionKit runs a kit\'s own install.sh instead of the conventions', async () => {
  // The kit ALSO ships a conventional skills/ dir under a different name, so the
  // assertions distinguish "the installer ran" from "the convention copy ran".
  const kitDir = await kitWithInstaller(
    'while [ $# -gt 0 ]; do [ "$1" = "--project" ] && P="$2"; shift; done\n'
    + 'mkdir -p "$P/.claude/skills/wired-by-installer"\n'
    + 'echo skill > "$P/.claude/skills/wired-by-installer/SKILL.md"',
  );
  const wt = await tmp('forest-wt-');
  try {
    await mkdir(join(kitDir, 'skills', 'copied-by-convention'), { recursive: true });
    await writeFile(join(kitDir, 'skills', 'copied-by-convention', 'SKILL.md'), '# nope\n');

    const notes = [];
    const r = await provisionKit({ kitDir, kitId: 'kit-x', worktreePath: wt, conflicts: [], written: new Map(), notes });

    assert.deepEqual(r.skills, ['wired-by-installer']);
    assert.equal(await readFile(join(wt, '.claude', 'skills', 'wired-by-installer', 'SKILL.md'), 'utf8'), 'skill\n');
    await assert.rejects(stat(join(wt, '.claude', 'skills', 'copied-by-convention')));
    assert.match(notes[0], /^kit-x: wired by its own install\.sh \(skills: wired-by-installer\)$/);
    // The kit tree itself is still copied — forest tracks the kit's presence there.
    assert.equal((await stat(join(wt, '.claude', 'kits', 'kit-x', 'install.sh'))).isFile(), true);
  } finally {
    await rm(kitDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('provisionKit reports a failed install.sh instead of returning success', async () => {
  const kitDir = await kitWithInstaller('echo "boom: could not write config" >&2\nexit 3');
  const wt = await tmp('forest-wt-');
  try {
    const notes = [];
    const r = await provisionKit({ kitDir, kitId: 'kit-y', worktreePath: wt, conflicts: [], written: new Map(), notes });

    assert.deepEqual(r.skills, []);
    assert.match(notes[0], /^kit-y: install\.sh FAILED \(exit 3\) — the kit is copied but NOT wired\./);
    assert.match(notes[0], /boom: could not write config/);
  } finally {
    await rm(kitDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('provisionKit reports exit 75 as the kit\'s protection, not a failure', async () => {
  const kitDir = await kitWithInstaller('echo "install: refusing to overwrite a root-owned install" >&2\nexit 75');
  const wt = await tmp('forest-wt-');
  try {
    const notes = [];
    await provisionKit({ kitDir, kitId: 'kit-z', worktreePath: wt, conflicts: [], written: new Map(), notes });

    assert.match(notes[0], /root-owned \(hardened\)/);
    assert.doesNotMatch(notes[0], /FAILED/);
  } finally {
    await rm(kitDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('provisionPack surfaces installer notes to its caller', async () => {
  const packsDir = await tmp('forest-packs-');
  const wt = await tmp('forest-wt-');
  try {
    const kitDir = join(packsDir, 'my-pack', 'kits', 'kit-n');
    await mkdir(kitDir, { recursive: true });
    await writeFile(join(kitDir, 'install.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(kitDir, 'install.sh'), 0o755);

    const out = await provisionPack({ packsDir, pack: 'my-pack', kits: ['kit-n'], worktreePath: wt });
    assert.deepEqual(out.kits, ['kit-n']);
    assert.equal(out.notes.length, 1);
    assert.match(out.notes[0], /^kit-n: wired by its own install\.sh$/);
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('writeProvisionRecord persists the inventory of what was written', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-inv-'));
  try {
    await writeProvisionRecord(wt, [{ pack: 'hektor', kits: ['flaky-triage-kit'] }],
      { kits: ['flaky-triage-kit'], skills: ['hektor-verify'] });
    const rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.inventory, { kits: ['flaky-triage-kit'], skills: ['hektor-verify'] });
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

test('writeProvisionRecord omits the inventory key when there is none', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-inv-'));
  try {
    await writeProvisionRecord(wt, [{ pack: 'hektor' }]);
    const raw = await readFile(join(wt, '.claude', '.forest-provision.json'), 'utf8');
    assert.ok(!raw.includes('inventory'), 'a null inventory must not be written as a key');
    const rec = await readProvisionRecord(wt);
    assert.equal(rec.inventory, undefined, 'an old record reads back with no inventory');
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});
