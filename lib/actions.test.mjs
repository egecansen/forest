import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeTitle, runSelections, launchDecision, createActionHandler } from './actions.mjs';

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

test('prune endpoints delegate to prune.mjs and never force', async () => {
  const src = await readFile(new URL('./actions.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('/api/repo/prune-preview'), 'preview route must exist');
  assert.ok(src.includes('/api/repo/prune'), 'prune route must exist');
  assert.ok(src.includes('pruneWorktrees'), 'execution must delegate to prune.mjs');
  assert.ok(src.includes('selectCandidates'), 'candidate choice must delegate to prune.mjs');

  // Every git call the prune path makes lives in prune.mjs, so that is where
  // the no-force guarantee is checked. actions.mjs is deliberately NOT checked
  // for --force: the separate /api/worktree/remove route supports it on purpose,
  // behind a "remove anyway?" confirmation.
  const prune = await readFile(new URL('./prune.mjs', import.meta.url), 'utf8');
  assert.ok(!prune.includes('--force'), 'prune must never force-remove a worktree');
  assert.ok(!prune.includes(`'-D'`), 'prune must never force-delete a branch');
  assert.ok(!prune.includes('-D '), 'prune must never force-delete a branch');
});

const scopeWith = (missing) => async () => ({
  active: [{ command: 'a' }], missing, inline: [], sources: ['/s/settings.json'],
});
const H = (cmd) => ({ command: cmd, source: '/s/settings.json', file: '/s/gone.sh' });

test('launchDecision: clean worktree launches', async () => {
  const d = await launchDecision({ path: '/w', force: false, resolveScope: scopeWith([]), readRecord: async () => null });
  assert.deepEqual(d, { launch: true });
});

test('launchDecision: missing hooks block the launch and are reported', async () => {
  const d = await launchDecision({
    path: '/w', force: false,
    resolveScope: scopeWith([H('"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"')]),
    readRecord: async () => ({ selections: [{ pack: 'hektor' }] }),
  });
  assert.equal(d.launch, false);
  assert.equal(d.blocked, 'missing-hooks');
  assert.equal(d.missing.length, 1);
  assert.equal(d.missing[0].command, '"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"');
  assert.equal(d.repairable, true, 'a provision record makes repair possible');
});

test('launchDecision: repairable is false without a provision record', async () => {
  const d = await launchDecision({
    path: '/w', force: false,
    resolveScope: scopeWith([H('"x/gate.sh"')]),
    readRecord: async () => null,
  });
  assert.equal(d.launch, false);
  assert.equal(d.repairable, false);
});

test('launchDecision: force launches despite missing hooks', async () => {
  const d = await launchDecision({
    path: '/w', force: true,
    resolveScope: scopeWith([H('"x/gate.sh"')]),
    readRecord: async () => null,
  });
  assert.deepEqual(d, { launch: true });
});

test('launchDecision: a scope resolver that throws does not block the launch', async () => {
  const d = await launchDecision({
    path: '/w', force: false,
    resolveScope: async () => { throw new Error('unreadable settings'); },
    readRecord: async () => null,
  });
  assert.deepEqual(d, { launch: true }, 'a broken check must not make forest unusable');
});

test('/api/launch consults launchDecision before launching', async () => {
  const src = await readFile(new URL('./actions.mjs', import.meta.url), 'utf8');
  const i = src.indexOf(`url === '/api/launch'`);
  const block = src.slice(i, i + 2000);
  assert.ok(block.includes('launchDecision'), 'the launch route must consult the guard');
  assert.ok(
    block.indexOf('launchDecision') < block.indexOf('launchInteractive'),
    'the guard must run BEFORE the terminal is opened, not after',
  );
  assert.ok(block.includes('blocked'), 'the route must return the blocked payload');
});

// A slow full snapshot behind a read-only preview made the prune button look
// dead for ~9s. The preview may read the cache; the executor may NOT — it is
// what decides deletions.
function fakeRes() {
  return { code: 0, body: null, writeHead(c) { this.code = c; return this; }, end(b) { this.body = b; } };
}
function fakeCtx(calls) {
  const snap = { repos: [{ repoPath: '/r', worktrees: [] }] };
  return {
    config: { staleDays: 14, defaultMode: 'auto' },
    journal: { add() {} },
    broadcast() {},
    snapshot: async () => { calls.push('fresh'); return snap; },
    cachedSnapshot: async () => { calls.push('cached'); return snap; },
  };
}

test('prune-preview reads the cached snapshot, never a fresh build', async () => {
  const calls = [];
  const res = fakeRes();
  await createActionHandler()({ url: '/api/repo/prune-preview' }, res, fakeCtx(calls), async () => ({ repoPath: '/r' }));
  assert.deepEqual(calls, ['cached'], 'a read-only preview must not pay for a full rebuild');
  assert.equal(JSON.parse(res.body).candidates.length, 0);
});

test('prune reads a FRESH snapshot before deleting', async () => {
  const calls = [];
  const res = fakeRes();
  await createActionHandler()({ url: '/api/repo/prune' }, res, fakeCtx(calls), async () => ({ repoPath: '/r', paths: ['/r/wt'], mode: 'auto' }));
  assert.ok(calls.includes('fresh'), 'the executor must re-validate against a fresh snapshot');
  assert.ok(!calls.includes('cached'), 'the executor must never decide deletions from cached state');
});
