import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod, rm, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { copyTree, readKitManifest, provisionKit, provisionPack, writeProvisionRecord, readProvisionRecord, matcherSlug, ensureDispatcher, registerDispatch, ensureExcluded, packTargets, autoSelections, packFingerprint } from './packs.mjs';
import { git as gitFixture } from './finish-fixtures.mjs';

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
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, '"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh" PreToolUse-Bash');
    assert.equal(await readlink(join(wt, '.claude', 'hooks', 'PreToolUse-Bash.d', '10-gate.sh')), '../gate.sh');
    assert.equal((await stat(join(wt, '.claude', 'hooks', 'dispatch.sh'))).mode & 0o111, 0o111);
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

// --- dispatcher (spec: docs/superpowers/specs/2026-08-05-hook-dispatcher-design.md) ---

const runDispatch = (dispatchPath, slug, wt, payload = '{}') => new Promise((resolve) => {
  const child = execFile('/bin/sh', [dispatchPath, slug],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: wt } },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) }));
  child.stdin.end(payload);
});

test('matcherSlug is stable and collision-free for the matchers in use', () => {
  assert.equal(matcherSlug('PreToolUse', 'Bash'), 'PreToolUse-Bash');
  assert.equal(matcherSlug('PreToolUse', 'Write|Edit'), 'PreToolUse-Write_Edit');
  assert.equal(matcherSlug('PostToolUse', 'Edit|Write|Bash'), 'PostToolUse-Edit_Write_Bash');
  assert.equal(matcherSlug('Stop', undefined), 'Stop');
  assert.equal(matcherSlug('Stop', '*'), 'Stop');
});

test('ensureDispatcher writes an executable dispatch.sh once and repairs drift', async () => {
  const wt = await tmp('forest-wt-');
  try {
    const hooksDir = join(wt, '.claude', 'hooks');
    const p = await ensureDispatcher(hooksDir);
    assert.equal((await stat(p)).mode & 0o111, 0o111);
    const body = await readFile(p, 'utf8');
    await writeFile(p, '#!/bin/sh\nexit 3\n');
    await ensureDispatcher(hooksDir);
    assert.equal(await readFile(p, 'utf8'), body, 'a drifted dispatcher is rewritten to current');
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('dispatch.sh runs entries in name order, first non-zero exit wins, broken links warn', async () => {
  const wt = await tmp('forest-wt-');
  try {
    const hooksDir = join(wt, '.claude', 'hooks');
    await mkdir(join(hooksDir, 'lib'), { recursive: true });
    await writeFile(join(hooksDir, 'lib', 'shared.sh'), 'echo "lib-loaded"\n');
    // a.sh proves payload delivery AND dirname-relative lib loading through the symlink.
    await writeFile(join(hooksDir, 'a.sh'),
      '#!/bin/bash\n. "$(dirname "${BASH_SOURCE[0]}")/lib/shared.sh"\ncat\n');
    await writeFile(join(hooksDir, 'b.sh'), '#!/bin/sh\necho "b-blocks" >&2\nexit 2\n');
    await chmod(join(hooksDir, 'a.sh'), 0o755);
    await chmod(join(hooksDir, 'b.sh'), 0o755);
    const d = join(hooksDir, 'PreToolUse-Bash.d');
    await mkdir(d, { recursive: true });
    await symlink('../a.sh', join(d, '10-a.sh'));
    await symlink('../b.sh', join(d, '20-b.sh'));
    await symlink('../gone.sh', join(d, '05-gone.sh'));   // broken, sorts first
    const dispatch = await ensureDispatcher(hooksDir);

    const r = await runDispatch(dispatch, 'PreToolUse-Bash', wt, '{"tool":"Bash"}');
    assert.equal(r.code, 2, 'first non-zero exit propagates');
    assert.match(r.stderr, /05-gone\.sh .*not executable/, 'broken symlink warns instead of failing the call');
    assert.match(r.stdout, /lib-loaded/, 'BASH_SOURCE lib loading survives the symlink (realpath)');
    assert.match(r.stdout, /{"tool":"Bash"}/, 'payload reaches each entry');
    assert.match(r.stderr, /b-blocks/, 'blocking gate stderr comes through');

    const empty = await runDispatch(dispatch, 'NoSuchSlug', wt);
    assert.equal(empty.code, 0, 'missing .d directory is a fact, not an error');
    assert.equal(empty.stderr, '');
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('copyTree overwrite updates a differing file instead of reporting a conflict', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  try {
    await writeFile(join(src, 'gate.sh'), 'v2\n');
    await writeFile(join(dst, 'gate.sh'), 'v1\n');
    const conflicts = [];
    const r = await copyTree(src, dst, { owner: 'kit-a', conflicts, overwrite: true });
    assert.equal(await readFile(join(dst, 'gate.sh'), 'utf8'), 'v2\n', 'refresh must take the source version');
    assert.equal(r.updated, 1);
    assert.deepEqual(conflicts, []);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test('copyTree overwrite still refuses a path another owner wrote THIS run', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  try {
    await writeFile(join(src, 'audit.sh'), 'kit-b version\n');
    await writeFile(join(dst, 'audit.sh'), 'kit-a version\n');
    const conflicts = [];
    const written = new Map([[join(dst, 'audit.sh'), 'kit-a']]);
    await copyTree(src, dst, { owner: 'kit-b', conflicts, written, overwrite: true });
    assert.equal(await readFile(join(dst, 'audit.sh'), 'utf8'), 'kit-a version\n',
      'a same-run cross-kit collision is a conflict even on refresh');
    assert.equal(conflicts.length, 1);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test('provisionPack refresh updates a stale vendored kit file without a conflict', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    const kit = join(packsDir, 'p', 'kits', 'k');
    await mkdir(kit, { recursive: true });
    await writeFile(join(kit, 'kernel.md'), 'v1\n');
    await provisionPack({ packsDir, pack: 'p', kits: ['k'], worktreePath: wt });
    await writeFile(join(kit, 'kernel.md'), 'v2\n');   // the pack source moved on
    const stale = await provisionPack({ packsDir, pack: 'p', kits: ['k'], worktreePath: wt });
    assert.equal(stale.conflicts.length, 1, 'a plain provision must still refuse to clobber');
    const fresh = await provisionPack({ packsDir, pack: 'p', kits: ['k'], worktreePath: wt, refresh: true });
    assert.deepEqual(fresh.conflicts, [], 'refresh reports no conflict for its own stale vendor copy');
    assert.equal(await readFile(join(wt, '.claude', 'kits', 'k', 'kernel.md'), 'utf8'), 'v2\n');
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('registerDispatch links in fragment order, registers one line, and is idempotent', async () => {
  const wt = await tmp('forest-wt-');
  try {
    const fragment = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/commit-gate.sh"', timeout: 10 },
      { type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/destructive-command-gate.sh"', timeout: 10 },
    ] }] } };
    await registerDispatch(wt, fragment);
    await registerDispatch(wt, fragment);   // idempotent
    const d = join(wt, '.claude', 'hooks', 'PreToolUse-Bash.d');
    assert.equal(await readlink(join(d, '10-commit-gate.sh')), '../commit-gate.sh');
    assert.equal(await readlink(join(d, '20-destructive-command-gate.sh')), '../destructive-command-gate.sh');
    const settings = JSON.parse(await readFile(join(wt, '.claude', 'settings.local.json'), 'utf8'));
    const block = settings.hooks.PreToolUse.find((b) => b.matcher === 'Bash');
    assert.equal(block.hooks.length, 1, 'exactly one registration per (event, matcher)');
    assert.equal(block.hooks[0].command, '"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh" PreToolUse-Bash');
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('registerDispatch strips a superseded per-script line — same event+matcher only', async () => {
  const wt = await tmp('forest-wt-');
  try {
    await mkdir(join(wt, '.claude'), { recursive: true });
    await writeFile(join(wt, '.claude', 'settings.local.json'), JSON.stringify({
      hooks: { PreToolUse: [
        { matcher: 'Bash', hooks: [
          { type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/skills/old-layout/hooks/commit-gate.sh"', timeout: 10 },
          { type: 'command', command: 'jq -r .cwd', timeout: 10 },
        ] },
        { matcher: 'Write|Edit', hooks: [
          { type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/commit-gate.sh"', timeout: 10 },
        ] },
      ] },
    }));
    await registerDispatch(wt, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/commit-gate.sh"', timeout: 10 },
    ] }] } });
    const settings = JSON.parse(await readFile(join(wt, '.claude', 'settings.local.json'), 'utf8'));
    const bash = settings.hooks.PreToolUse.find((b) => b.matcher === 'Bash');
    assert.deepEqual(bash.hooks.map((h) => h.command), [
      'jq -r .cwd',
      '"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh" PreToolUse-Bash',
    ], 'old-style line for a linked basename is gone; inline line survives');
    const we = settings.hooks.PreToolUse.find((b) => b.matcher === 'Write|Edit');
    assert.equal(we.hooks[0].command, '"$CLAUDE_PROJECT_DIR/.claude/hooks/commit-gate.sh"',
      'a different matcher block is not this pass\'s to clean');
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('provisionPack always writes the dispatcher, even for an installer-owned kit', async () => {
  // A worktree session inherits its PRIMARY repo's registrations (git common
  // dir). Once the primary registers dispatcher lines, every worktree needs
  // dispatch.sh present or those inherited lines exec-fail — so provisioning
  // writes it unconditionally; with no .d directories it is a silent no-op.
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    const kit = join(packsDir, 'p', 'kits', 'k');
    await mkdir(kit, { recursive: true });
    await writeFile(join(kit, 'install.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(kit, 'install.sh'), 0o755);
    await provisionPack({ packsDir, pack: 'p', kits: ['k'], worktreePath: wt });
    assert.equal((await stat(join(wt, '.claude', 'hooks', 'dispatch.sh'))).mode & 0o111, 0o111);
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('end-to-end: a gate-set provision resolves with every gate active and none missing', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    const packDir = join(packsDir, 'gate-pack');
    await mkdir(join(packDir, 'hooks'), { recursive: true });
    for (const name of ['commit-gate.sh', 'observe.sh']) {
      await writeFile(join(packDir, 'hooks', name), '#!/bin/sh\nexit 0\n');
      await chmod(join(packDir, 'hooks', name), 0o755);
    }
    await writeFile(join(packDir, 'settings.hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [
          { type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/commit-gate.sh"', timeout: 10 },
        ] }],
        PostToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [
          { type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/observe.sh"', timeout: 10 },
        ] }],
      },
    }));
    await writeFile(join(packDir, 'catalog.json'), JSON.stringify({
      pack: 'gate-pack', skills: [],
      hooks: { id: 'gate-pack-gates', dir: 'hooks', settings: 'settings.hooks.json' },
    }));

    await provisionPack({ packsDir, pack: 'gate-pack', hooks: true, worktreePath: wt });
    const { resolveSessionScope } = await import('./session-scope.mjs');
    const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
    assert.equal(scope.missing.length, 0, 'zero registered-but-missing gates');
    assert.deepEqual(scope.active.map((h) => h.file).sort(), [
      join(wt, '.claude', 'hooks', 'commit-gate.sh'),
      join(wt, '.claude', 'hooks', 'observe.sh'),
    ], 'both gates resolve through their .d entries');
    const settings = JSON.parse(await readFile(join(wt, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1, 'one line per (event, matcher)');
    assert.equal(settings.hooks.PostToolUse[0].hooks.length, 1);
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('registerDispatch merges a non-path command verbatim and writes no dispatcher for it', async () => {
  const wt = await tmp('forest-wt-');
  try {
    await registerDispatch(wt, { hooks: { Stop: [{ matcher: '*', hooks: [
      { type: 'command', command: 'x.sh' },
    ] }] } });
    const settings = JSON.parse(await readFile(join(wt, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepEqual(settings.hooks.Stop[0].hooks, [{ type: 'command', command: 'x.sh' }]);
    await assert.rejects(stat(join(wt, '.claude', 'hooks', 'dispatch.sh')), 'nothing linked → no dispatcher');
  } finally { await rm(wt, { recursive: true, force: true }); }
});

// ---- ensureExcluded (the Cursor-brief round: docs/hektor/ must not show up
// as untracked in the user's `git status`) ----

async function freshRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'forest-exclude-'));
  await gitFixture(repo, 'init', '-b', 'master');
  await gitFixture(repo, 'config', 'user.email', 't@t');
  await gitFixture(repo, 'config', 'user.name', 't');
  await gitFixture(repo, 'config', 'gc.auto', '0');
  await writeFile(join(repo, 'a.txt'), 'base\n');
  await gitFixture(repo, 'add', '.');
  await gitFixture(repo, 'commit', '-m', 'base');
  return repo;
}

test('ensureExcluded: appends the pattern to .git/info/exclude when not already ignored, and it actually takes effect', async () => {
  const repo = await freshRepo();
  try {
    const ok = await ensureExcluded(repo, { checkPath: 'docs/hektor/tickets/SHBDN-1.md', pattern: '/docs/hektor/' });
    assert.equal(ok, true);
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^\/docs\/hektor\/$/m);
    const checked = await new Promise((res) => execFile('git', ['-C', repo, 'check-ignore', '-q', 'docs/hektor/tickets/SHBDN-1.md'], (err) => res(!err)));
    assert.equal(checked, true);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('ensureExcluded: calling it again (a second ticket) does not duplicate the exclude line', async () => {
  const repo = await freshRepo();
  try {
    await ensureExcluded(repo, { checkPath: 'docs/hektor/tickets/SHBDN-1.md', pattern: '/docs/hektor/' });
    await ensureExcluded(repo, { checkPath: 'docs/hektor/tickets/SHBDN-2.md', pattern: '/docs/hektor/' });
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    const matches = exclude.match(/^\/docs\/hektor\/$/gm) || [];
    assert.equal(matches.length, 1);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('ensureExcluded: already ignored via a tracked .gitignore is left alone — no redundant exclude entry written', async () => {
  const repo = await freshRepo();
  try {
    // `git init` itself already creates an empty (or sample-commented)
    // .git/info/exclude — its mere EXISTENCE proves nothing here. What must
    // NOT happen is forest appending its own pattern on top of a path the
    // tracked .gitignore already covers.
    await writeFile(join(repo, '.gitignore'), '/docs/hektor/\n');
    await gitFixture(repo, 'add', '.gitignore');
    await gitFixture(repo, 'commit', '-m', 'gitignore');
    const before = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8').catch(() => '');
    const ok = await ensureExcluded(repo, { checkPath: 'docs/hektor/tickets/SHBDN-1.md', pattern: '/docs/hektor/' });
    assert.equal(ok, true);
    const after = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8').catch(() => '');
    assert.equal(after, before, 'must not write a redundant exclude entry for an already-ignored path');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('ensureExcluded: from inside a LINKED worktree, the exclude lands at the shared common git dir, not a per-worktree copy', async () => {
  const repo = await freshRepo();
  const wtRoot = await mkdtemp(join(tmpdir(), 'forest-exclude-wt-'));
  try {
    const wt = join(wtRoot, 'tech-WEBT-1');
    await gitFixture(repo, 'worktree', 'add', '-b', 'tech/WEBT-1', wt, 'HEAD');
    const ok = await ensureExcluded(wt, { checkPath: 'docs/hektor/tickets/SHBDN-1.md', pattern: '/docs/hektor/' });
    assert.equal(ok, true);
    // Written at the PRIMARY repo's own info/exclude, not something local to
    // the worktree — proving the "shared, not per-worktree" claim.
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^\/docs\/hektor\/$/m);
    const checkedFromPrimary = await new Promise((res) => execFile('git', ['-C', repo, 'check-ignore', '-q', 'docs/hektor/tickets/SHBDN-1.md'], (err) => res(!err)));
    assert.equal(checkedFromPrimary, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('ensureExcluded: not a git repo at all returns false, never throws', async () => {
  const notRepo = await mkdtemp(join(tmpdir(), 'forest-notrepo-'));
  try {
    const ok = await ensureExcluded(notRepo, { checkPath: 'docs/hektor/tickets/SHBDN-1.md', pattern: '/docs/hektor/' });
    assert.equal(ok, false);
  } finally { await rm(notRepo, { recursive: true, force: true }); }
});

test('writeProvisionRecord persists the Cursor axis when given, omits the key when not', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-inv-'));
  try {
    await writeProvisionRecord(wt, [{ pack: 'hektor', skills: ['hektor-verify'] }], null, null,
      { packs: ['hektor'], at: '2026-09-07T10:00:00.000Z' });
    const rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.cursor, { packs: ['hektor'], at: '2026-09-07T10:00:00.000Z' });
    assert.equal(rec.inventory, undefined);

    await writeProvisionRecord(wt, [{ pack: 'hektor' }]);
    const raw = await readFile(join(wt, '.claude', '.forest-provision.json'), 'utf8');
    assert.ok(!raw.includes('cursor'), 'a record with no Cursor axis must not claim one');
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

const CAT = (over = {}) => ({
  pack: 'hektor',
  skillsets: [{ id: 'hektor-verify' }, { id: 'hektor-conventions' }],
  kits: [{ id: 'flaky-triage-kit' }],
  hooks: { id: 'hektor-gates', dir: 'hooks' },
  targets: ['web-test', 'test-data-client'],
  ...over,
});

test('autoSelections: a targeted repo gets the whole pack in picker shape', () => {
  assert.deepEqual(autoSelections([CAT()], 'web-test'), [
    { pack: 'hektor', skills: ['hektor-verify', 'hektor-conventions'], kits: ['flaky-triage-kit'], hooks: true },
  ]);
});

test('autoSelections: "*" targets every repo', () => {
  assert.equal(autoSelections([CAT({ targets: ['*'] })], 'forest').length, 1);
});

test('autoSelections: a repo the pack does not target gets nothing', () => {
  assert.deepEqual(autoSelections([CAT()], 'forest'), []);
});

test('autoSelections: no targets, an empty list, or a malformed value means picker-only', () => {
  assert.deepEqual(autoSelections([CAT({ targets: undefined })], 'web-test'), []);
  assert.deepEqual(autoSelections([CAT({ targets: [] })], 'web-test'), []);
  assert.deepEqual(autoSelections([CAT({ targets: 'web-test' })], 'web-test'), []);
  assert.deepEqual(packTargets({ targets: 'web-test' }), []);
  assert.deepEqual(packTargets({ targets: [' web-test ', 3, ''] }), ['web-test']);
});

test('autoSelections: hooks is false for a pack with no gate set, and ids that fail safeId are dropped', () => {
  const out = autoSelections([CAT({ hooks: undefined, skillsets: [{ id: 'ok' }, { id: '../evil' }], kits: [] })], 'web-test');
  assert.deepEqual(out, [{ pack: 'hektor', skills: ['ok'], kits: [], hooks: false }]);
});

test('autoSelections: no repo name means nothing', () => {
  assert.deepEqual(autoSelections([CAT()], ''), []);
  assert.deepEqual(autoSelections([CAT()], undefined), []);
});

async function packInGit() {
  const root = await tmp('forest-fp-');
  await gitFixture(root, 'init', '-b', 'main');
  await gitFixture(root, 'config', 'user.email', 't@t');
  await gitFixture(root, 'config', 'user.name', 't');
  await gitFixture(root, 'config', 'gc.auto', '0');
  await mkdir(join(root, 'packs', 'hektor', 'skills', 's'), { recursive: true });
  await writeFile(join(root, 'packs', 'hektor', 'catalog.json'), '{"pack":"hektor"}\n');
  await writeFile(join(root, 'packs', 'hektor', 'skills', 's', 'SKILL.md'), '# s\n');
  await gitFixture(root, 'add', '.');
  await gitFixture(root, 'commit', '-m', 'pack');
  return root;
}
const treeHash = (root) => new Promise((res) => execFile('git', ['-C', root, 'rev-parse', 'HEAD:packs/hektor'], (e, out) => res(e ? null : String(out).trim())));

test('packFingerprint: a clean pack inside a git repo is its tree hash', async () => {
  const root = await packInGit();
  try {
    const fp = await packFingerprint(join(root, 'packs'), 'hektor', { now: 1, ttlMs: 0 });
    assert.match(fp, /^[0-9a-f]{40}$/);
    assert.equal(fp, await treeHash(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packFingerprint: an edited or untracked file makes the pack dirty → null (always provision)', async () => {
  const root = await packInGit();
  try {
    await writeFile(join(root, 'packs', 'hektor', 'skills', 's', 'SKILL.md'), '# edited\n');
    assert.equal(await packFingerprint(join(root, 'packs'), 'hektor', { now: 1, ttlMs: 0 }), null);
    await gitFixture(root, 'checkout', '--', '.');
    await writeFile(join(root, 'packs', 'hektor', 'skills', 's', 'NEW.md'), 'new\n');
    assert.equal(await packFingerprint(join(root, 'packs'), 'hektor', { now: 2, ttlMs: 0 }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packFingerprint: a pack outside any git repo, or a bad id, is null', async () => {
  const packs = await tmp('forest-fp-nogit-');
  try {
    await mkdir(join(packs, 'hektor'), { recursive: true });
    assert.equal(await packFingerprint(packs, 'hektor', { now: 1, ttlMs: 0 }), null);
    assert.equal(await packFingerprint(packs, '../x', { now: 1, ttlMs: 0 }), null);
  } finally { await rm(packs, { recursive: true, force: true }); }
});

test('packFingerprint: the answer is cached for ttlMs so a burst of launches forks git once', async () => {
  const root = await packInGit();
  try {
    const first = await packFingerprint(join(root, 'packs'), 'hektor', { now: 1000, ttlMs: 2000 });
    await writeFile(join(root, 'packs', 'hektor', 'skills', 's', 'SKILL.md'), '# edited\n');
    assert.equal(await packFingerprint(join(root, 'packs'), 'hektor', { now: 2500, ttlMs: 2000 }), first, 'inside the window: the cached hash');
    assert.equal(await packFingerprint(join(root, 'packs'), 'hektor', { now: 3001, ttlMs: 2000 }), null, 'after the window: recomputed, and dirty');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('copyTree with overwrite lists every path it replaced', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  try {
    await mkdir(join(src, 'lib'), { recursive: true });
    await writeFile(join(src, 'a.sh'), 'new a\n');
    await writeFile(join(src, 'lib', 'b.sh'), 'new b\n');
    await writeFile(join(src, 'same.sh'), 'same\n');
    await mkdir(join(dst, 'lib'), { recursive: true });
    await writeFile(join(dst, 'a.sh'), 'old a\n');
    await writeFile(join(dst, 'lib', 'b.sh'), 'old b\n');
    await writeFile(join(dst, 'same.sh'), 'same\n');
    const updatedPaths = [];
    const r = await copyTree(src, dst, { owner: 'pack', overwrite: true, updatedPaths });
    assert.equal(r.updated, 2);
    assert.deepEqual([...r.updatedPaths].sort(), [join(dst, 'a.sh'), join(dst, 'lib', 'b.sh')]);
    assert.equal(r.updatedPaths, updatedPaths, 'the caller\'s array is the one filled');
    assert.equal(await readFile(join(dst, 'a.sh'), 'utf8'), 'new a\n');
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test('provisionPack refresh returns the overwritten paths', async () => {
  const packs = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    await mkdir(join(packs, 'p', 'skills', 's'), { recursive: true });
    await writeFile(join(packs, 'p', 'skills', 's', 'SKILL.md'), '# v2\n');
    await mkdir(join(wt, '.claude', 'skills', 's'), { recursive: true });
    await writeFile(join(wt, '.claude', 'skills', 's', 'SKILL.md'), '# v1, edited locally\n');
    const r = await provisionPack({ packsDir: packs, pack: 'p', skills: ['s'], worktreePath: wt, refresh: true });
    assert.deepEqual(r.updated, [join(wt, '.claude', 'skills', 's', 'SKILL.md')]);
    assert.deepEqual(r.conflicts, []);
  } finally {
    await rm(packs, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('writeProvisionRecord: fingerprints and auto are written when given and never invented', async () => {
  const wt = await tmp('forest-rec-');
  try {
    await writeProvisionRecord(wt, [{ pack: 'p', skills: ['s'], kits: [], hooks: false }], { kits: [], skills: ['s'] }, null, null,
      { fingerprints: { p: 'abc' }, auto: true });
    let rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.fingerprints, { p: 'abc' });
    assert.equal(rec.auto, true);
    await writeProvisionRecord(wt, [{ pack: 'p', skills: ['s'], kits: [], hooks: false }]);
    rec = await readProvisionRecord(wt);
    assert.equal('fingerprints' in rec, false);
    assert.equal('auto' in rec, false);
  } finally { await rm(wt, { recursive: true, force: true }); }
});
