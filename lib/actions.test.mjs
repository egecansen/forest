import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeTitle, runSelections } from './actions.mjs';

const tmp = (p) => mkdtemp(join(tmpdir(), p));

test('worktree creation composes its path via worktreePathFor', async () => {
  const src = await readFile(new URL('./actions.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('worktreePathFor'), 'actions.mjs must use the shared path helper');
  assert.ok(!src.includes('.forest/wt'), 'the .forest/wt literal must live only in config.mjs');
});

test('worktreeTitle: legacy in-repo layout with ticket', () => {
  const title = worktreeTitle('/some/repo/.forest/wt/tech-WEBT-123-thing');
  assert.strictEqual(title, 'WEBT-123', 'should extract ticket from legacy path');
});

test('worktreeTitle: new default root layout with ticket', () => {
  const title = worktreeTitle('/Users/x/.forest/wt/web-test/tech-WEBT-123-thing');
  assert.strictEqual(title, 'WEBT-123', 'should extract ticket from default root layout');
});

test('worktreeTitle: new default root layout without ticket', () => {
  const title = worktreeTitle('/Users/x/.forest/wt/web-test/refactor-thing');
  assert.strictEqual(title, 'refactor-thing', 'should return slug when no ticket, not leak repo name');
});

test('worktreeTitle: custom root with no .forest/wt segments, with ticket', () => {
  const title = worktreeTitle('/tmp/wt-root/web-test/tech-WEBT-123-thing');
  assert.strictEqual(title, 'WEBT-123', 'should extract ticket from custom root path');
});

test('worktreeTitle: custom root with no .forest/wt segments, without ticket', () => {
  const title = worktreeTitle('/tmp/wt-root/web-test/refactor-thing');
  assert.strictEqual(title, 'refactor-thing', 'should return slug when no ticket in custom root');
});

test('worktreeTitle: primary worktree (repo name as last segment)', () => {
  const title = worktreeTitle('/some/repo');
  assert.strictEqual(title, 'repo', 'should return repo name for primary worktree');
});

// Finding 4: /api/launch and /api/worktree/repair each ran their own copy of
// this loop; repair's copy silently dropped conflicts instead of journalling
// them. This test drives the shared helper directly and would have caught
// that — a repair run that hits a hash conflict must produce both a
// `conflicts` entry AND a `collision:` journal line, identically to launch.
test('runSelections: two kits colliding on the same path — one conflicts entry, one collision journal line, accumulated fields match', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    const packDir = join(packsDir, 'my-pack');
    await mkdir(join(packDir, 'kits', 'kit-a', 'hooks', 'lib'), { recursive: true });
    await writeFile(join(packDir, 'kits', 'kit-a', 'hooks', 'lib', 'audit.sh'), 'kit-a version\n');
    await mkdir(join(packDir, 'kits', 'kit-b', 'hooks', 'lib'), { recursive: true });
    await writeFile(join(packDir, 'kits', 'kit-b', 'hooks', 'lib', 'audit.sh'), 'kit-b version\n');
    await mkdir(join(packDir, 'kits', 'kit-a', 'skills', 'foo'), { recursive: true });
    await writeFile(join(packDir, 'kits', 'kit-a', 'skills', 'foo', 'SKILL.md'), '# foo\n');

    const journal = [];
    const ctx = { config: { packsDir }, journal: { add: (e) => journal.push(e) } };
    const selections = [{ pack: 'my-pack', kits: ['kit-a', 'kit-b'], skills: [], hooks: false }];

    const out = await runSelections({ ctx, path: wt, selections, mode: 'auto' });

    // accumulated fields match what was actually provisioned
    assert.deepEqual(out.kits, ['kit-a', 'kit-b']);
    assert.deepEqual(out.skills, []);
    assert.equal(out.hooks, false);
    assert.equal(await readFile(join(wt, '.claude', 'skills', 'foo', 'SKILL.md'), 'utf8'), '# foo\n');

    // one conflicts entry
    assert.equal(out.conflicts.length, 1);
    assert.equal(out.conflicts[0].incoming, 'kit-b');
    assert.equal(out.conflicts[0].existing, 'kit-a');
    assert.equal(
      await readFile(join(wt, '.claude', 'hooks', 'lib', 'audit.sh'), 'utf8'),
      'kit-a version\n',
      'destination must keep the first-provisioned kit\'s content',
    );

    // and one matching collision: journal line — the assertion that would have
    // caught repair's swallowed conflicts.
    const collisionLines = journal.filter((j) => j.cmd.startsWith('collision:'));
    assert.equal(collisionLines.length, 1);
    assert.match(collisionLines[0].cmd, /kit-b ≠ kit-a/);
    assert.equal(collisionLines[0].cwd, wt);
    assert.equal(collisionLines[0].mode, 'auto');
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});
