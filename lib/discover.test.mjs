import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { staleFrom, listRepoDirs, buildSnapshot } from './discover.mjs';
import { resolveSessionScope } from './session-scope.mjs';
import { makeRepoWithWorktree } from './finish-fixtures.mjs';

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

// buildSnapshot drives buildWorktreeRecord's real wiring (not just the resolver
// it delegates to), so these exercise the scope field end-to-end: real repo,
// real worktree, real git discovery. buildWorktreeRecord calls resolveSessionScope
// without a userSettingsPath override, so the real $HOME/.claude/settings.json
// would otherwise leak into the count — pointed at an empty temp HOME so the
// assertions are exact regardless of the machine running the suite.
async function withIsolatedHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'forest-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); }
  finally {
    process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

// git reports worktree paths through the real (symlink-resolved) filesystem
// path — on macOS that's /private/var/... where tmpdir() itself hands back
// /var/... — so match by branch, not by the fixture's own `wt` string.
function findRecord(snap, branch) {
  return snap.repos.flatMap((r) => r.worktrees).find((w) => w.branch === branch);
}

test('buildSnapshot: worktree record scope is a count, and counts a missing hook', async () => {
  await withIsolatedHome(async () => {
    const branch = 'tech/SCOPE-1';
    const { repo, wt } = await makeRepoWithWorktree({ branch });
    try {
      await mkdir(join(repo, '.claude'), { recursive: true });
      await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/gone.sh"' }] }] },
      }));
      const snap = await buildSnapshot(
        { roots: [dirname(repo)], staleDays: 14 },
        { registry: new Map(), nowMs: Date.now(), claudeProjectsDir: '/no/such/claude-projects' },
      );
      const record = findRecord(snap, branch);
      assert.ok(record, 'expected the worktree to appear in the snapshot');
      assert.equal(typeof record.scope.active, 'number');
      assert.equal(typeof record.scope.missing, 'number');
      assert.equal(record.scope.missing, 1);
      assert.equal(record.scope.active, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test('buildSnapshot: worktree record counts a provisioned hook as active, not missing', async () => {
  await withIsolatedHome(async () => {
    const branch = 'tech/SCOPE-2';
    const { repo, wt } = await makeRepoWithWorktree({ branch });
    try {
      await mkdir(join(repo, '.claude'), { recursive: true });
      await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/present.sh"' }] }] },
      }));
      await mkdir(join(wt, '.claude', 'hooks'), { recursive: true });
      await writeFile(join(wt, '.claude', 'hooks', 'present.sh'), '#!/bin/sh\nexit 0\n');
      const snap = await buildSnapshot(
        { roots: [dirname(repo)], staleDays: 14 },
        { registry: new Map(), nowMs: Date.now(), claudeProjectsDir: '/no/such/claude-projects' },
      );
      const record = findRecord(snap, branch);
      assert.ok(record, 'expected the worktree to appear in the snapshot');
      assert.equal(record.scope.missing, 0);
      assert.ok(record.scope.active >= 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
