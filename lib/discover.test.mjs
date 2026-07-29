import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleFrom, listRepoDirs, buildSnapshot } from './discover.mjs';
import { resolveSessionScope } from './session-scope.mjs';

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

test('listRepoDirs descends one level into a named container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forest-root-'));
  await mkdir(join(root, 'repoA', '.git'), { recursive: true });          // direct repo
  await mkdir(join(root, 'APPS', 'forest', '.git'), { recursive: true }); // nested under container
  await mkdir(join(root, 'APPS', 'looseDir'), { recursive: true });       // non-git child, ignored
  await mkdir(join(root, 'OTHER', 'nested', '.git'), { recursive: true });// not a container, not descended
  const repos = await listRepoDirs(root, ['APPS']);
  assert.deepEqual(repos.map((r) => r.name).sort(), ['forest', 'repoA']);
});

test('buildSnapshot returns empty repos for a missing root without throwing', async () => {
  const snap = await buildSnapshot(
    { roots: ['/no/such/forest-root-xyz'], staleDays: 14 },
    { registry: new Map(), nowMs: Date.now(), claudeProjectsDir: '/nope' },
  );
  assert.deepEqual(snap.repos, []);
  assert.equal(typeof snap.generatedAt, 'number');
});

test('buildWorktreeRecord reports the session scope of a worktree', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'forest-scope-'));
  await mkdir(join(parent, '.claude'), { recursive: true });
  await writeFile(join(parent, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/gone.sh"' }] }] },
  }));
  const wt = join(parent, 'wt');
  await mkdir(wt, { recursive: true });

  const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/file.json' });
  assert.equal(scope.missing.length, 1);   // the shape buildWorktreeRecord summarises
});
