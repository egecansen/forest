import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleFrom, listRepoDirs, buildSnapshot } from './discover.mjs';
import { resolveSessionScope } from './session-scope.mjs';
import { makeRepoWithWorktree, commitFile, git } from './finish-fixtures.mjs';
import { createRegistry } from './agents.mjs';

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
  try {
    await mkdir(join(root, 'repoA', '.git'), { recursive: true });
    await mkdir(join(root, 'notrepo'), { recursive: true });
    await writeFile(join(root, 'loose.txt'), 'x');
    const repos = await listRepoDirs(root);
    assert.deepEqual(repos.map((r) => r.name).sort(), ['repoA']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listRepoDirs descends one level into a named container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forest-root-'));
  try {
    await mkdir(join(root, 'repoA', '.git'), { recursive: true });          // direct repo
    await mkdir(join(root, 'APPS', 'forest', '.git'), { recursive: true }); // nested under container
    await mkdir(join(root, 'APPS', 'looseDir'), { recursive: true });       // non-git child, ignored
    await mkdir(join(root, 'OTHER', 'nested', '.git'), { recursive: true });// not a container, not descended
    const repos = await listRepoDirs(root, ['APPS']);
    assert.deepEqual(repos.map((r) => r.name).sort(), ['forest', 'repoA']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  try {
    await mkdir(join(parent, '.claude'), { recursive: true });
    await writeFile(join(parent, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/gone.sh"' }] }] },
    }));
    const wt = join(parent, 'wt');
    await mkdir(wt, { recursive: true });

    const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/file.json' });
    assert.equal(scope.missing.length, 1);   // the shape buildWorktreeRecord summarises
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
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
    const scanRoot = await mkdtemp(join(tmpdir(), 'forest-scanroot-'));
    const { repo, wt } = await makeRepoWithWorktree({ branch, parent: scanRoot });
    try {
      await mkdir(join(repo, '.claude'), { recursive: true });
      await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/gone.sh"' }] }] },
      }));
      const snap = await buildSnapshot(
        { roots: [scanRoot], staleDays: 14 },
        { registry: new Map(), nowMs: Date.now(), claudeProjectsDir: '/no/such/claude-projects' },
      );
      const record = findRecord(snap, branch);
      assert.ok(record, 'expected the worktree to appear in the snapshot');
      assert.equal(typeof record.scope.active, 'number');
      assert.equal(typeof record.scope.missing, 'number');
      assert.equal(record.scope.missing, 1);
      assert.equal(record.scope.active, 0);
    } finally {
      await rm(scanRoot, { recursive: true, force: true });
    }
  });
});

test('buildSnapshot: worktree record counts a provisioned hook as active, not missing', async () => {
  await withIsolatedHome(async () => {
    const branch = 'tech/SCOPE-2';
    const scanRoot = await mkdtemp(join(tmpdir(), 'forest-scanroot-'));
    const { repo, wt } = await makeRepoWithWorktree({ branch, parent: scanRoot });
    try {
      await mkdir(join(repo, '.claude'), { recursive: true });
      await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/present.sh"' }] }] },
      }));
      await mkdir(join(wt, '.claude', 'hooks'), { recursive: true });
      await writeFile(join(wt, '.claude', 'hooks', 'present.sh'), '#!/bin/sh\nexit 0\n');
      const snap = await buildSnapshot(
        { roots: [scanRoot], staleDays: 14 },
        { registry: new Map(), nowMs: Date.now(), claudeProjectsDir: '/no/such/claude-projects' },
      );
      const record = findRecord(snap, branch);
      assert.ok(record, 'expected the worktree to appear in the snapshot');
      assert.equal(record.scope.missing, 0);
      assert.ok(record.scope.active >= 1);
    } finally {
      await rm(scanRoot, { recursive: true, force: true });
    }
  });
});

const snapArgs = { registry: createRegistry(), nowMs: Date.now(), claudeProjectsDir: '/no/such/projects' };

test('buildSnapshot includes a listed repo that the scan cannot reach', async () => {
  const { repo, wt } = await makeRepoWithWorktree({ branch: 'tech/LIST-1' });
  const emptyRoot = await mkdtemp(join(tmpdir(), 'forest-emptyroot-'));
  try {
    const snap = await buildSnapshot({ roots: [emptyRoot], containers: [], staleDays: 14 }, { ...snapArgs, repoList: [repo] });
    const rec = snap.repos.find((r) => r.repoPath === repo);
    assert.ok(rec, 'listed repo must appear even though no root reaches it');
    assert.equal(rec.listed, true);
    // git reports worktree paths through the real (symlink-resolved) path —
    // on macOS that's /private/var/... where tmpdir() itself hands back
    // /var/... (see the findRecord comment above) — so resolve `wt` the same
    // way before comparing, instead of dropping to a weaker branch match.
    const realWt = await realpath(wt).catch(() => wt);
    assert.ok(rec.worktrees.some((w) => w.path === realWt));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(emptyRoot, { recursive: true, force: true });
  }
});

test('buildSnapshot yields one record when a repo is both scanned and listed', async () => {
  const scanRoot = await mkdtemp(join(tmpdir(), 'forest-scanroot-'));
  const { repo } = await makeRepoWithWorktree({ branch: 'tech/LIST-2', parent: scanRoot });
  // The scan reaches `repo` via its raw path; the listed path reaches the
  // *same* repo only through a symlink alias, so the two strings differ but
  // resolve to one directory. This makes realOrSelf's realpath() call
  // load-bearing: a naive string-identity dedupe would see two distinct
  // paths and keep both, whereas real-path dedupe collapses them to one.
  const aliasParent = await mkdtemp(join(tmpdir(), 'forest-alias-'));
  const aliasPath = join(aliasParent, 'alias');
  try {
    await symlink(repo, aliasPath, 'dir');
    const snap = await buildSnapshot({ roots: [scanRoot], containers: [], staleDays: 14 }, { ...snapArgs, repoList: [aliasPath] });
    const hits = snap.repos.filter((r) => r.repoPath === repo || r.repoPath === aliasPath);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].listed, false, 'the scan wins, so no remove control is offered');
  } finally {
    await rm(aliasParent, { recursive: true, force: true });
    await rm(scanRoot, { recursive: true, force: true });
  }
});

test('buildSnapshot skips a listed path that is no longer a repo and reports it', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'forest-plain-'));
  const emptyRoot = await mkdtemp(join(tmpdir(), 'forest-emptyroot-'));
  try {
    const snap = await buildSnapshot({ roots: [emptyRoot], containers: [], staleDays: 14 }, { ...snapArgs, repoList: [plain, '/no/such/dir-xyz'] });
    assert.equal(snap.repos.length, 0);
    assert.deepEqual(snap.skippedRepos.sort(), [plain, '/no/such/dir-xyz'].sort());
  } finally {
    await rm(plain, { recursive: true, force: true });
    await rm(emptyRoot, { recursive: true, force: true });
  }
});

// Snapshot one repo via repoList (roots: [] keeps the scan away from tmpdir).
async function snapOf(repo) {
  return buildSnapshot(
    { roots: [], containers: [], staleDays: 14 },
    { registry: createRegistry(), nowMs: Date.now(), claudeProjectsDir: '/nonexistent-forest-test', repoList: [repo] },
  );
}

// isPrimary compares `path === repoPath`, which is never true in a fixture:
// git resolves symlinks (/private/var/...) and tmpdir() does not (/var/...).
// So select the secondary worktree by its resolved path, as the tests above do.
async function secondaryOf(snap, wt) {
  const real = await realpath(wt);
  return snap.repos.flatMap((r) => r.worktrees).find((w) => w.path === real);
}

test('buildSnapshot reports a locked worktree as locked', async () => {
  const { repo, wt } = await makeRepoWithWorktree({ branch: 'tech/WEBT-901' });
  try {
    await git(repo, 'worktree', 'lock', wt);
    const snap = await snapOf(repo);
    const rec = await secondaryOf(snap, wt);
    assert.ok(rec, 'expected the worktree in the snapshot');
    assert.equal(rec.locked, true, 'locked must reach the snapshot record');
    await git(repo, 'worktree', 'unlock', wt);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildSnapshot counts commits on a DETACHED worktree', async () => {
  const { repo, wt } = await makeRepoWithWorktree({ branch: 'tech/WEBT-902' });
  try {
    await commitFile(wt, 'work.txt', 'unmerged\n', 'work not in master');
    await git(wt, 'switch', '--detach');
    const snap = await snapOf(repo);
    const rec = await secondaryOf(snap, wt);
    assert.ok(rec, 'expected the worktree in the snapshot');
    assert.equal(rec.detached, true, 'fixture must be detached');
    assert.ok(rec.ahead > 0, 'a detached worktree holding unmerged commits must report ahead > 0');
    assert.equal(rec.merged, false, 'unmerged detached HEAD must not be reported as merged');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildSnapshot: a saved priority rides the worktree record; unlabeled is null', async () => {
  await withIsolatedHome(async () => {
    const branch = 'tech/PRIO-1';
    const scanRoot = await mkdtemp(join(tmpdir(), 'forest-scanroot-'));
    const { repo } = await makeRepoWithWorktree({ branch, parent: scanRoot });
    try {
      await mkdir(join(repo, '.forest'), { recursive: true });
      await writeFile(join(repo, '.forest', 'priorities.json'), JSON.stringify({ [branch]: 'red' }));
      const snap = await buildSnapshot(
        { roots: [scanRoot], staleDays: 14 },
        { registry: new Map(), nowMs: Date.now(), claudeProjectsDir: '/no/such/claude-projects' },
      );
      assert.equal(findRecord(snap, branch).priority, 'red');
      // Locate the primary through this test's own repo record rather than
      // isPrimary — tmpdir()'s /var → /private/var symlink makes the flag
      // unreliable in this fixture. `scanRoot` is this test's own isolated
      // parent (see makeRepoWithWorktree's `parent` option), so no other
      // test's repo can leak in here.
      const repoRec = snap.repos.find((r) => r.worktrees.some((w) => w.branch === branch));
      const primary = repoRec.worktrees.find((w) => w.branch === 'master');
      assert.equal(primary.priority, null, 'an unlabeled worktree carries an explicit null');
    } finally { await rm(scanRoot, { recursive: true, force: true }); }
  });
});

test('buildSnapshot: a ticket brief\'s Status: line rides the worktree record as ticketStatus', async () => {
  await withIsolatedHome(async () => {
    const branch = 'tech/TKST-1';
    const scanRoot = await mkdtemp(join(tmpdir(), 'forest-scanroot-'));
    const { repo, wt } = await makeRepoWithWorktree({ branch, parent: scanRoot });
    try {
      await mkdir(join(wt, 'docs', 'hektor', 'tickets'), { recursive: true });
      await writeFile(join(wt, 'docs', 'hektor', 'tickets', 'TKST-1.md'), 'Status: in progress\n');
      const snap = await buildSnapshot(
        { roots: [scanRoot], staleDays: 14 },
        { registry: new Map(), nowMs: Date.now(), claudeProjectsDir: '/no/such/claude-projects' },
      );
      const record = findRecord(snap, branch);
      assert.ok(record, 'expected the worktree to appear in the snapshot');
      assert.deepEqual(record.ticketStatus, { key: 'TKST-1', status: 'in progress' });
    } finally {
      await rm(scanRoot, { recursive: true, force: true });
    }
  });
});

test('buildSnapshot: a worktree with no brief is indistinguishable from today — ticketStatus is null', async () => {
  await withIsolatedHome(async () => {
    const branch = 'tech/TKST-2';
    const scanRoot = await mkdtemp(join(tmpdir(), 'forest-scanroot-'));
    const { repo } = await makeRepoWithWorktree({ branch, parent: scanRoot });
    try {
      const snap = await buildSnapshot(
        { roots: [scanRoot], staleDays: 14 },
        { registry: new Map(), nowMs: Date.now(), claudeProjectsDir: '/no/such/claude-projects' },
      );
      const record = findRecord(snap, branch);
      assert.ok(record, 'expected the worktree to appear in the snapshot');
      assert.equal(record.ticketStatus, null);
    } finally {
      await rm(scanRoot, { recursive: true, force: true });
    }
  });
});

test('buildSnapshot: a brief named after the re-keyed Jira key is found from a branch carrying a different team prefix', async () => {
  // The exact real-world bug: branch tech/WEBT-241011, brief written by the
  // tickets flow under docs/hektor/tickets/SHBDN-241011.md (config.jiraProjectKey
  // = 'SHBDN'). Naming the file after the branch-derived ticket alone found
  // nothing — this is the regression case for that.
  await withIsolatedHome(async () => {
    const branch = 'tech/WEBT-241011';
    const scanRoot = await mkdtemp(join(tmpdir(), 'forest-scanroot-'));
    const { repo, wt } = await makeRepoWithWorktree({ branch, parent: scanRoot });
    try {
      await mkdir(join(wt, 'docs', 'hektor', 'tickets'), { recursive: true });
      await writeFile(join(wt, 'docs', 'hektor', 'tickets', 'SHBDN-241011.md'), 'Status: in progress\n');
      const snap = await buildSnapshot(
        { roots: [scanRoot], staleDays: 14, jiraProjectKey: 'SHBDN' },
        { registry: new Map(), nowMs: Date.now(), claudeProjectsDir: '/no/such/claude-projects' },
      );
      const record = findRecord(snap, branch);
      assert.ok(record, 'expected the worktree to appear in the snapshot');
      assert.deepEqual(record.ticketStatus, { key: 'WEBT-241011', status: 'in progress' });
    } finally {
      await rm(scanRoot, { recursive: true, force: true });
    }
  });
});

test('buildSnapshot: a shared ticketStatusCache avoids re-reading an unchanged brief across two snapshot builds', async () => {
  await withIsolatedHome(async () => {
    const branch = 'tech/TKST-3';
    const scanRoot = await mkdtemp(join(tmpdir(), 'forest-scanroot-'));
    const { repo, wt } = await makeRepoWithWorktree({ branch, parent: scanRoot });
    try {
      await mkdir(join(wt, 'docs', 'hektor', 'tickets'), { recursive: true });
      await writeFile(join(wt, 'docs', 'hektor', 'tickets', 'TKST-3.md'), 'Status: blocked\n');
      const ticketStatusCache = new Map();
      const args = (nowMs) => [
        { roots: [scanRoot], staleDays: 14 },
        { registry: new Map(), nowMs, claudeProjectsDir: '/no/such/claude-projects', ticketStatusCache },
      ];
      const snap1 = await buildSnapshot(...args(Date.now()));
      assert.deepEqual(findRecord(snap1, branch).ticketStatus, { key: 'TKST-3', status: 'blocked' });
      assert.equal(ticketStatusCache.size, 1, 'the cache is populated after the first snapshot');
      // Second build reuses the same cache — a second run over an unchanged
      // brief must still resolve to the same status via the cached mtime.
      const snap2 = await buildSnapshot(...args(Date.now() + 4000));
      assert.deepEqual(findRecord(snap2, branch).ticketStatus, { key: 'TKST-3', status: 'blocked' });
    } finally {
      await rm(scanRoot, { recursive: true, force: true });
    }
  });
});
