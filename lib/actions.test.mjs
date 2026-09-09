import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, stat, chmod, realpath, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { worktreeTitle, runSelections, launchDecision, orphanedUnits, createActionHandler, recordWithout, managedPath, PATH_ERROR, unchangedSince, provisionNotifyCommand } from './actions.mjs';
import { runGit } from './git.mjs';
import { writeProvisionRecord, readProvisionRecord, packFingerprint } from './packs.mjs';
import { resolveSessionScope } from './session-scope.mjs';
import { readPriorities } from './priorities.mjs';
import { git as gitFixture } from './finish-fixtures.mjs';

// Matches lib/session-scope.test.mjs's own isolation convention: without this,
// resolveSessionScope also reads the real machine's ~/.claude/settings.json
// and merges it in, making route-level tests depend on the developer's own
// global config.
const noRealHome = (p) => resolveSessionScope(p, { userSettingsPath: '/no/such/user-settings.json' });

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

// `repairable` is no longer a record-SHAPE predicate. It asks the pack source
// whether replaying the record's selections could write any hook wiring, using
// the same calls provisioning makes — so every case below needs a pack on
// disk, and each ships exactly the file that decides its answer. Written as a
// shape check, two of these tests could not have been written at all: the
// record looks identical in the true and false cases.
//
// `files` keys are paths relative to the pack directory.
async function packsFixture(files = {}) {
  const packs = await tmp('forest-packs-');
  await mkdir(join(packs, 'hektor'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const f = join(packs, 'hektor', rel);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, content);
  }
  return packs;
}

// Runs `launchDecision` against a real pack with one gate registered but
// absent, which is the only state in which `repairable` is reported at all.
async function decideWith(files, selections) {
  const packs = await packsFixture(files);
  try {
    return await launchDecision({
      path: '/w', force: false, packsDir: packs,
      resolveScope: scopeWith([H('"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"')]),
      readRecord: async () => (selections === null ? null : { selections }),
    });
  } finally {
    await rm(packs, { recursive: true, force: true });
  }
}

test('launchDecision: missing hooks block the launch and are reported', async () => {
  const d = await decideWith(
    { 'kits/flaky-triage-kit/install.sh': '#!/bin/sh\nexit 0\n' },
    [{ pack: 'hektor', kits: ['flaky-triage-kit'] }],
  );
  assert.equal(d.launch, false);
  assert.equal(d.blocked, 'missing-hooks');
  assert.equal(d.missing.length, 1);
  assert.equal(d.missing[0].command, '"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"');
  assert.equal(d.repairable, true,
    'the pack still ships this kit and it ships install.sh — re-running that installer is exactly what rewrites its registration');
});

test('launchDecision: repairable is false without a provision record', async () => {
  const d = await decideWith({ 'kits/flaky-triage-kit/install.sh': '#!/bin/sh\n' }, null);
  assert.equal(d.launch, false);
  assert.equal(d.repairable, false);
});

// The false promise the previous round fixed: after Remove, the record still
// has a non-empty selections list — the old meaning of `repairable` — but the
// unit whose installer wrote the dangling registration is no longer in it, so
// repair re-provisions the others and the missing count never moves. The pack
// really does ship this skill, so the answer is about what provisioning a
// skill WRITES, not about the skill being absent.
test('launchDecision: repairable is false when the record names only skills', async () => {
  const d = await decideWith(
    { 'skills/hektor-verify/SKILL.md': '# verify\n' },
    [{ pack: 'hektor', skills: ['hektor-verify'], kits: [] }],
  );
  assert.equal(d.launch, false);
  assert.equal(d.repairable, false,
    'repair replays the selections, and provisioning a skill writes .claude/skills/<id>/ and nothing else — it can never rewrite a hook registration');
});

// Case B from the review, executed. The dangling gate belongs to the kit the
// user removed; the record still names `other-kit`, which the pack DOES still
// ship — but it ships only kit.json: no install.sh, no hooks/, no settings
// fragment. Repair copies it into .claude/kits/ and writes no registration.
// The old shape predicate answered `true` here and `missing` never moved.
test('launchDecision: repairable is false when the record names a surviving kit that ships no wiring', async () => {
  const d = await decideWith(
    { 'kits/other-kit/kit.json': '{"id":"other-kit"}\n' },
    [{ pack: 'hektor', kits: ['other-kit'], skills: [] }],
  );
  assert.equal(d.repairable, false,
    'a kit with no install.sh, no hooks dir and no settings fragment is copied into .claude/kits/<id>/ and writes no wiring — repair provably cannot move the missing count');
});

// Case C from the review, executed. provisionPack skips a kit the pack no
// longer ships, so repair provisions kits: [], skills: [] — a literal no-op.
// A single exists() refutes the claim, so asserting it was not conservatism
// about an unknown; it was asserting an already-decided possibility.
test('launchDecision: repairable is false when the pack no longer ships the recorded kit', async () => {
  const d = await decideWith(
    { 'catalog.json': '{"pack":"hektor"}\n' },
    [{ pack: 'hektor', kits: ['flaky-triage-kit'], skills: [] }],
  );
  assert.equal(d.repairable, false,
    'provisionPack skips a kit the pack does not ship, so replaying this record provisions nothing at all');
});

// The convention branches: a kit with no installer answers `true` if it ships
// a hooks dir to copy or a settings fragment to merge — genuinely so for the
// first (a real script `copyTree` will copy), but the second is pinning
// `writesHookWiring`'s own over-approximation: `{"hooks":{}}` parses as JSON,
// so `isParsableJson` says yes, even though `mergeHooks(template.hooks || {})`
// merges nothing for it.
for (const [label, files, why] of [
  ['a hooks directory to copy', { 'kits/gate-kit/hooks/gate.sh': '#!/bin/sh\n' },
    'a hooks/ directory holding a real script is exactly what provisionKit copies into .claude/hooks/ — this genuinely writes wiring'],
  ['a settings fragment to merge', { 'kits/gate-kit/settings.hooks.json': '{"hooks":{}}\n' },
    'writesHookWiring only checks that settings.hooks.json parses, not that its hooks content is non-empty — this pins that over-approximation, not an actual registration write'],
]) {
  test(`launchDecision: repairable is true for a kit with no install.sh but ${label}`, async () => {
    const d = await decideWith(files, [{ pack: 'hektor', kits: ['gate-kit'], skills: [] }]);
    assert.equal(d.repairable, true, why);
  });
}

// Followup #2: `writesHookWiring` used to answer `true` for these from
// `exists()` alone. Both are refutable by a content check: `copyTree` reads
// an empty `hooks/` and copies nothing, and `provisionKit`'s `JSON.parse` on
// an unparsable settings fragment throws and is swallowed before `mergeHooks`
// ever runs (`lib/packs.mjs:202-204`) — so a repair offered on either state
// writes nothing and `missing` never moves.
test('launchDecision: repairable is false for a kit with no install.sh whose hooks/ directory exists but is empty', async () => {
  const packs = await packsFixture({});
  try {
    await mkdir(join(packs, 'hektor', 'kits', 'gate-kit', 'hooks'), { recursive: true });
    const d = await launchDecision({
      path: '/w', force: false, packsDir: packs,
      resolveScope: scopeWith([H('"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"')]),
      readRecord: async () => ({ selections: [{ pack: 'hektor', kits: ['gate-kit'], skills: [] }] }),
    });
    assert.equal(d.repairable, false,
      'an empty hooks/ directory copies nothing — copyTree finds no entries to copy — so replaying this record provisions no wiring at all');
  } finally {
    await rm(packs, { recursive: true, force: true });
  }
});

test('launchDecision: repairable is false for a kit with no install.sh whose settings.hooks.json is present but not valid JSON', async () => {
  const packs = await packsFixture({ 'kits/gate-kit/settings.hooks.json': '{ not valid json' });
  try {
    const d = await launchDecision({
      path: '/w', force: false, packsDir: packs,
      resolveScope: scopeWith([H('"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"')]),
      readRecord: async () => ({ selections: [{ pack: 'hektor', kits: ['gate-kit'], skills: [] }] }),
    });
    assert.equal(d.repairable, false,
      'provisionKit\'s JSON.parse on this file throws and is swallowed before mergeHooks ever runs, so replaying this record writes no registration');
  } finally {
    await rm(packs, { recursive: true, force: true });
  }
});

test('launchDecision: repairable is true for a record that provisions the pack gates', async () => {
  const d = await decideWith(
    { 'catalog.json': JSON.stringify({ pack: 'hektor', hooks: { dir: 'hooks', settings: 'settings.hooks.json' } }) },
    [{ pack: 'hektor', skills: [], kits: [], hooks: true }],
  );
  assert.equal(d.repairable, true, 'forest writes the pack gate set itself, so repair can rewrite it');
});

test('launchDecision: repairable is false when the pack catalog declares no gate set', async () => {
  const d = await decideWith(
    { 'catalog.json': '{"pack":"hektor"}\n' },
    [{ pack: 'hektor', skills: [], kits: [], hooks: true }],
  );
  assert.equal(d.repairable, false,
    'hooks: true against a catalog with no hooks block provisions nothing — out.hooks would never even be set');
});

// Followup #4: `writesHookWiring` checks `h.dir || h.settings`, not merely
// `h` truthy. A catalog whose `hooks` block declares ONLY `schemas` (no `dir`
// to copy, no `settings` fragment to merge) is the one fixture that pins the
// difference — `provisionPack` copies schemas but that is not hook wiring
// (no script under `.claude/hooks/`, no registration merged), so replaying
// this record writes nothing repair could use to move `missing`. Without
// this fixture, collapsing the check to `if (h)` leaves the suite green.
test('launchDecision: repairable is false when the pack catalog\'s gate set declares only schemas, no dir or settings', async () => {
  const d = await decideWith(
    { 'catalog.json': JSON.stringify({ pack: 'hektor', hooks: { schemas: 'schemas' } }) },
    [{ pack: 'hektor', skills: [], kits: [], hooks: true }],
  );
  assert.equal(d.repairable, false,
    'a gate set with only a schemas dir writes no hook script and merges no settings fragment — copying schemas alone is not hook wiring');
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
  // A worktree with a registered gate whose file does not exist: the guard
  // must block, and the terminal must never be opened. Previously this was a
  // source-text match (the literal name `launchInteractive` at a later offset
  // than `launchDecision`); now that `launch` is injectable the ordering is
  // directly observable as behaviour instead of a proxy for it.
  const wt = await mkdtemp(join(tmpdir(), 'forest-guard-'));
  try {
    await mkdir(join(wt, '.claude'), { recursive: true });
    await writeFile(join(wt, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command',
        command: `"${join(wt, '.claude', 'hooks', 'gone.sh')}"` }] }] },
    }));
    const res = fakeRes();
    let opened = false;
    await createActionHandler({ launch: async () => { opened = true; return { ok: true }; }, resolveScope: noRealHome })(
      { url: '/api/launch' }, res,
      { config: {}, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, selections: [] }),
    );
    assert.equal(JSON.parse(res.body).blocked, 'missing-hooks');
    assert.equal(opened, false, 'the guard must run BEFORE the terminal is opened, not after');
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
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

// ---- description routes ----

const WT_PATH = '/wt/web-test/tech-WEBT-229553';
function descCtx(repo, calls = []) {
  const worktree = { path: WT_PATH, repoPath: repo, branch: 'tech/WEBT-229553', ticket: 'WEBT-229553' };
  const snap = { repos: [{ repoPath: repo, worktrees: [worktree] }] };
  return {
    // No token on purpose: every assertion below must hold without a network.
    config: { jiraBaseUrl: 'https://jira.example.com', jiraProjectKey: 'SHBDN', jiraToken: '', jiraEmail: '', defaultMode: 'auto' },
    journal: { add() {} },
    broadcast() {},
    snapshot: async () => { calls.push('fresh'); return snap; },
    cachedSnapshot: async () => { calls.push('cached'); return snap; },
  };
}
const call = (url, body, ctx) => {
  const res = fakeRes();
  return createActionHandler()({ url }, res, ctx, async () => body).then(() => res);
};

test('/api/description reads the cached snapshot and reports the rewritten ticket', async () => {
  const repo = await tmp('forest-desc-route-');
  try {
    const calls = [];
    const res = await call('/api/description', { path: WT_PATH }, descCtx(repo, calls));
    const out = JSON.parse(res.body);
    assert.deepEqual(calls, ['cached'], 'a read-only route must not pay for a full rebuild');
    assert.equal(out.ticket, 'SHBDN-229553');
    assert.equal(out.url, 'https://jira.example.com/browse/SHBDN-229553');
    assert.equal(out.override, false);
    assert.equal(out.text, 'https://jira.example.com/browse/SHBDN-229553', 'no token: link only');
    assert.match(out.jiraError, /jiraToken/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('/api/description/save then /api/description returns the override', async () => {
  const repo = await tmp('forest-desc-route-');
  try {
    const ctx = descCtx(repo);
    const saved = await call('/api/description/save', { path: WT_PATH, text: 'lang support on the pay-by-card component' }, ctx);
    assert.deepEqual(JSON.parse(saved.body), { ok: true });
    const out = JSON.parse((await call('/api/description', { path: WT_PATH }, ctx)).body);
    assert.equal(out.text, 'lang support on the pay-by-card component');
    assert.equal(out.override, true);
    assert.equal(out.jiraError, undefined, 'an override answers the question without asking Jira');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('/api/description/reset drops the override and returns the regenerated text', async () => {
  const repo = await tmp('forest-desc-route-');
  try {
    const ctx = descCtx(repo);
    await call('/api/description/save', { path: WT_PATH, text: 'mine' }, ctx);
    const out = JSON.parse((await call('/api/description/reset', { path: WT_PATH }, ctx)).body);
    assert.equal(out.override, false, 'reset must return the composed text, not the dropped override');
    assert.equal(out.text, 'https://jira.example.com/browse/SHBDN-229553');
    // And it must have persisted: a follow-up read agrees.
    const after = JSON.parse((await call('/api/description', { path: WT_PATH }, ctx)).body);
    assert.equal(after.override, false);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('description routes 404 on a path that is not a known worktree', async () => {
  const repo = await tmp('forest-desc-route-');
  try {
    const ctx = descCtx(repo);
    for (const url of ['/api/description', '/api/description/save', '/api/description/reset']) {
      const res = await call(url, { path: '/nowhere', text: 'x' }, ctx);
      assert.equal(res.code, 404, `${url} must not accept an unknown worktree`);
      assert.equal(JSON.parse(res.body).error, 'unknown worktree');
    }
  } finally { await rm(repo, { recursive: true, force: true }); }
});

// ---- orphaned provisioned units ----

const REC = (inventory) => ({ at: '2026-07-30T10:00:00.000Z', selections: [], inventory });

test('orphanedUnits: a deselected kit is reported', () => {
  const o = orphanedUnits(REC({ kits: ['flaky-triage-kit'], skills: [] }),
    [{ pack: 'hektor', kits: [], skills: ['hektor-verify'], hooks: true }]);
  assert.deepEqual(o, [{ kind: 'kit', id: 'flaky-triage-kit', since: '2026-07-30T10:00:00.000Z' }]);
});

test('orphanedUnits: a still-selected kit is not reported', () => {
  const o = orphanedUnits(REC({ kits: ['flaky-triage-kit'], skills: [] }),
    [{ pack: 'hektor', kits: ['flaky-triage-kit'] }]);
  assert.deepEqual(o, []);
});

test('orphanedUnits: a deselected skill is reported', () => {
  const o = orphanedUnits(REC({ kits: [], skills: ['hektor-verify', 'hektor-distill'] }),
    [{ pack: 'hektor', skills: ['hektor-verify'] }]);
  assert.deepEqual(o, [{ kind: 'skill', id: 'hektor-distill', since: '2026-07-30T10:00:00.000Z' }]);
});

test('orphanedUnits: a record with no inventory reports nothing', () => {
  assert.deepEqual(
    orphanedUnits({ at: 'x', selections: [{ pack: 'hektor', kits: ['flaky-triage-kit'] }] }, []),
    [],
    'a record written before this feature has no inventory; inferring one from its selections would report every unit it ever named as orphaned',
  );
});

test('orphanedUnits: no record reports nothing', () => {
  assert.deepEqual(orphanedUnits(null, [{ pack: 'hektor' }]), []);
});

test('orphanedUnits: a unit selected under a DIFFERENT pack still counts as selected', () => {
  const o = orphanedUnits(REC({ kits: ['k'], skills: [] }), [{ pack: 'other', kits: ['k'] }]);
  assert.deepEqual(o, [], 'the inventory is not keyed by pack, so neither is the comparison');
});

test('recordWithout carries the Cursor axis through untouched — a unit removal must not forget what install.sh wired', () => {
  const cursor = { packs: ['hektor'], at: '2026-09-07T10:00:00.000Z' };
  const next = recordWithout({ at: '2026-09-01T00:00:00.000Z', selections: [{ pack: 'hektor', kits: ['k1', 'k2'] }], cursor }, [{ kind: 'kit', id: 'k1' }]);
  assert.deepEqual(next.selections, [{ pack: 'hektor', kits: ['k2'] }]);
  assert.deepEqual(next.cursor, cursor);
  assert.equal(recordWithout({ selections: [] }, []).cursor, null);
});

test('remove-units deletes a kit directory', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-'));
  try {
    await mkdir(join(wt, '.claude', 'kits', 'k', 'core'), { recursive: true });
    await writeFile(join(wt, '.claude', 'kits', 'k', 'core', 'x.sh'), 'x\n');
    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
      { config: {}, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, units: [{ kind: 'kit', id: 'k' }] }));
    assert.deepEqual(JSON.parse(res.body).removed, ['kit:k']);
    await assert.rejects(() => stat(join(wt, '.claude', 'kits', 'k')));
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

test('remove-units refuses a root-owned kit and changes nothing', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-'));
  try {
    await mkdir(join(wt, '.claude', 'kits', 'k'), { recursive: true });
    await writeFile(join(wt, '.claude', 'kits', 'k', 'x.sh'), 'x\n');
    await chmod(join(wt, '.claude', 'kits'), 0o500);        // parent not writable: unlink refused
    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
      { config: {}, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, units: [{ kind: 'kit', id: 'k' }] }));
    const body = JSON.parse(res.body);
    assert.deepEqual(body.removed, []);
    assert.equal(body.refused.length, 1);
    assert.match(body.refused[0].reason, /root-owned|hardened|permission/i);
    await stat(join(wt, '.claude', 'kits', 'k', 'x.sh'));   // still there
  } finally {
    // In the finally, not after the handler: a failing assertion above used to
    // leave a chmod-hardened directory behind that the tmpdir sweep cannot
    // remove either.
    await chmod(join(wt, '.claude', 'kits'), 0o700).catch(() => {});
    await rm(wt, { recursive: true, force: true });
  }
});

// Removing the files without updating the record is what made Remove a
// one-way door: the next launch compared the same inventory against the same
// selection and blocked on a unit that no longer existed, offering a removal
// with nothing left to remove.
test('remove-units drops the removed unit from the record, from BOTH inventory and selections', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-rec-'));
  try {
    await mkdir(join(wt, '.claude', 'kits', 'k'), { recursive: true });
    await writeFile(join(wt, '.claude', 'kits', 'k', 'x.sh'), 'x\n');
    await writeProvisionRecord(wt, [{ pack: 'hektor', kits: ['k'], skills: ['s'], hooks: true }],
      { kits: ['k'], skills: ['s'] }, '2026-07-30T10:00:00.000Z');
    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
      { config: {}, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, units: [{ kind: 'kit', id: 'k' }] }));
    assert.deepEqual(JSON.parse(res.body).removed, ['kit:k']);
    const rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.inventory, { kits: [], skills: ['s'] },
      'the orphan guard compares against the inventory — leaving the id there re-blocks on a unit that is gone');
    assert.deepEqual(rec.selections, [{ pack: 'hektor', kits: [], skills: ['s'], hooks: true }],
      'repair replays the selections — leaving the id there reinstalls what the user just deleted');
    assert.equal(rec.at, '2026-07-30T10:00:00.000Z',
      'skill s was not re-provisioned by this removal, so its `since` must still read as its original provision — stamping the removal date makes a surviving orphan look newer, and so safer, than it is, in the dialog that gates an irreversible action');
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

// Followup #1: `stillListed` used to be decided entirely inside the per-unit
// delete loop, before the record write that was supposed to follow it even
// ran. Reproduced exactly as the register describes: the record file at
// 0444, `.claude/kits/` writable — `rm` succeeds, the write throws EACCES.
// Before the fix the route still answered `removed: ['kit:k'], refused: []`,
// the client read that as a clean sweep, alerted "the record no longer lists
// them", and recursed into startSession() — which met the same orphan guard
// immediately, because the record on disk still names `k`. That is the
// one-way-door loop the branch that introduced Remove was written to close,
// surviving behind a rarer trigger.
test('remove-units: a record write that throws after a successful rm must not be reported as a clean sweep', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-recfail-'));
  const recFile = join(wt, '.claude', '.forest-provision.json');
  try {
    await mkdir(join(wt, '.claude', 'kits', 'k'), { recursive: true });
    await writeFile(join(wt, '.claude', 'kits', 'k', 'x.sh'), 'x\n');
    await writeProvisionRecord(wt, [{ pack: 'hektor', kits: ['k'], skills: [] }], { kits: ['k'], skills: [] });
    await chmod(recFile, 0o444);   // record read-only; .claude/kits/ stays writable

    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
      { config: {}, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, units: [{ kind: 'kit', id: 'k' }] }));
    const body = JSON.parse(res.body);

    // The delete really happened...
    assert.deepEqual(body.removed, ['kit:k']);
    await assert.rejects(() => stat(join(wt, '.claude', 'kits', 'k')));

    // ...but the record write failed, so the id must still read as listed —
    // this is the field the client's clean-sweep branch gates on.
    const stuck = body.refused.filter((r) => r.stillListed);
    assert.equal(stuck.length, 1,
      'a record-write failure must not be reported as a clean sweep — the client would recurse into startSession() and meet the guard again');
    assert.equal(stuck[0].id, 'k');

    // And the record on disk really was not updated, so a relaunch against it
    // would in fact re-block — proving `stillListed: true` was not a lie in
    // the other direction either.
    await chmod(recFile, 0o644);
    const rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.inventory, { kits: ['k'], skills: [] },
      'the write never landed — the record still names the unit whose files are actually gone');
  } finally {
    await chmod(recFile, 0o644).catch(() => {});
    await rm(wt, { recursive: true, force: true });
  }
});

// Followup #3: the write-failure merge loop looked up an existing `refused`
// entry by `id` alone. A kit and a skill can share an id, so when the kit's
// entry (hardened, pushed inside the per-unit loop) already existed, the
// lookup for the skill (whose `rm` succeeded but whose record write then
// failed) found the KIT's entry instead of its own — flipped a field that was
// already `true` and never added the skill's own entry at all. The response
// carried one refused entry and the user was never told the record still
// names `skill:dup`.
test('remove-units: a refused entry from a failed record write is matched by { kind, id }, not id alone', async () => {
  const wt = await tmp('forest-rm-dup-');
  const recFile = join(wt, '.claude', '.forest-provision.json');
  try {
    // kit:dup is hardened — its own refused entry is pushed inside the
    // per-unit loop, before the record write is even attempted.
    await mkdir(join(wt, '.claude', 'kits', 'dup'), { recursive: true });
    await writeFile(join(wt, '.claude', 'kits', 'dup', 'kit.json'), '{"id":"dup"}\n');
    await chmod(join(wt, '.claude', 'kits', 'dup'), 0o500);

    // skill:dup deletes cleanly, so it only reaches `refused` via the
    // write-failure merge loop below — the one under test.
    await mkdir(join(wt, '.claude', 'skills', 'dup'), { recursive: true });
    await writeFile(join(wt, '.claude', 'skills', 'dup', 'SKILL.md'), '# dup\n');

    await writeProvisionRecord(wt, [{ pack: 'hektor', kits: ['dup'], skills: ['dup'] }],
      { kits: ['dup'], skills: ['dup'] });
    await chmod(recFile, 0o444);   // record read-only: the write after removal fails

    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
      { config: {}, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, units: [{ kind: 'kit', id: 'dup' }, { kind: 'skill', id: 'dup' }] }));
    const body = JSON.parse(res.body);

    // The skill really was deleted; the kit really was not.
    assert.deepEqual(body.removed, ['skill:dup']);
    await stat(join(wt, '.claude', 'kits', 'dup', 'kit.json'));             // kit: still there
    await assert.rejects(() => stat(join(wt, '.claude', 'skills', 'dup'))); // skill: gone

    // Two distinct facts, and both must reach the user — an id-only lookup
    // collapses the skill's write-failure entry into the kit's pre-existing
    // hardened-kit entry and reports only one.
    const stuck = body.refused.filter((r) => r.stillListed);
    assert.equal(stuck.length, 2,
      'the hardened kit and the write-failed skill are two distinct facts and must both reach the user');
    const kitEntry = stuck.find((r) => r.kind === 'kit' && r.id === 'dup');
    const skillEntry = stuck.find((r) => r.kind === 'skill' && r.id === 'dup');
    assert.ok(kitEntry, 'kit:dup must be reported — its files really are still on disk');
    assert.match(kitEntry.reason, /root-owned|hardened|permission/i);
    assert.ok(skillEntry, 'skill:dup must be reported separately from kit:dup despite sharing an id');
    assert.match(skillEntry.reason, /record could not be updated/);
  } finally {
    await chmod(join(wt, '.claude', 'kits', 'dup'), 0o700).catch(() => {});
    await chmod(recFile, 0o644).catch(() => {});
    await rm(wt, { recursive: true, force: true });
  }
});

test('remove-units leaves a record that never had an inventory without one', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-rec-'));
  try {
    await mkdir(join(wt, '.claude', 'skills', 's'), { recursive: true });
    await writeProvisionRecord(wt, [{ pack: 'hektor', skills: ['s'], kits: ['k'] }]);
    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
      { config: {}, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, units: [{ kind: 'skill', id: 's' }] }));
    const rec = await readProvisionRecord(wt);
    assert.equal(rec.inventory, undefined,
      'inventing an empty inventory would claim provisioning produced nothing — a different, false statement');
    assert.deepEqual(rec.selections, [{ pack: 'hektor', skills: [], kits: ['k'] }]);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

// A worktree whose record names two kits while only `kit-a` is on disk, and a
// pack that still ships the skill the incoming selection keeps. `harden` makes
// `kit-b` present but undeletable instead of absent.
async function refusalFixture({ harden = false } = {}) {
  const wt = await tmp('forest-rm-refuse-');
  const packs = await tmp('forest-packs-');
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-verify'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-verify', 'SKILL.md'), '# verify\n');
  await mkdir(join(wt, '.claude', 'kits', 'kit-a'), { recursive: true });
  await writeFile(join(wt, '.claude', 'kits', 'kit-a', 'kit.json'), '{"id":"kit-a"}\n');
  if (harden) {
    await mkdir(join(wt, '.claude', 'kits', 'kit-b'), { recursive: true });
    await writeFile(join(wt, '.claude', 'kits', 'kit-b', 'kit.json'), '{"id":"kit-b"}\n');
    // Its own directory, not the shared parent: kit-a next door must stay
    // deletable, so the test can show the two units diverging in one call.
    // A real hardened kit is root-owned; chmod reproduces the refusal without
    // a `chown` no test run can answer the password for.
    await chmod(join(wt, '.claude', 'kits', 'kit-b'), 0o500);
  }
  await writeProvisionRecord(wt, [{ pack: 'hektor', kits: ['kit-a', 'kit-b'], skills: ['hektor-verify'] }],
    { kits: ['kit-a', 'kit-b'], skills: ['hektor-verify'] });
  return { wt, packs };
}

function refusalDriver(packs) {
  const ctx = { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} };
  const handler = createActionHandler({ launch: async () => ({ ok: true, action: 'launched' }), resolveScope: noRealHome });
  return async (url, body) => {
    const res = fakeRes();
    await handler({ url }, res, ctx, async () => body);
    return JSON.parse(res.body);
  };
}

const BOTH_KITS = [{ kind: 'kit', id: 'kit-a' }, { kind: 'kit', id: 'kit-b' }];
const KEEP_SKILL = [{ pack: 'hektor', skills: ['hektor-verify'] }];

// The one-way door survived any refused removal: a unit reached the record
// rewrite only on a successful `rm`, so a refusal left its id in `inventory`,
// the guard re-blocked on it, and Remove could never clear it —
//   2 remove   removed=[kit-a] refused=[kit-b: "already gone"]
//   3 relaunch blocked=orphaned-units  orphaned=[kit:kit-b]
//   4 remove   refused=[kit-b again]        ← forever
// ENOENT is not a failed removal. The unit is not on disk; the record is
// simply wrong to list it.
test('remove-units drops a unit that was already gone from the record, and the guard stops re-blocking on it', async () => {
  const { wt, packs } = await refusalFixture();
  try {
    const post = refusalDriver(packs);
    const rmBody = await post('/api/worktree/remove-units', { path: wt, units: BOTH_KITS });
    assert.deepEqual(rmBody.removed, ['kit:kit-a'], 'only kit-a was actually deleted');
    assert.equal(rmBody.refused.length, 1);
    assert.match(rmBody.refused[0].reason, /already gone/);
    assert.equal(rmBody.refused[0].stillListed, false,
      'nothing is left behind by a unit that was never on disk, so forest drops it from the record');

    const rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.inventory, { kits: [], skills: ['hektor-verify'] },
      'a refusal that means "there was nothing there" must still leave the record, or Remove is a door into a state whose only offered remedy is a removal with nothing left to remove');

    const relaunch = await post('/api/launch', { path: wt, selections: KEEP_SKILL });
    assert.notEqual(relaunch.blocked, 'orphaned-units',
      'the guard compares against the inventory, so dropping the id is what actually converges the loop');
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

// EPERM is the opposite fact and must not be treated the same: the files
// really ARE still there, still registered, still executing. Staying listed
// is correct — dropping the id would hide a running unit from the one guard
// that can see it.
test('remove-units keeps a unit it could not delete listed in the record — its files are still on disk', async () => {
  const { wt, packs } = await refusalFixture({ harden: true });
  try {
    const post = refusalDriver(packs);
    const rmBody = await post('/api/worktree/remove-units', { path: wt, units: BOTH_KITS });
    assert.deepEqual(rmBody.removed, ['kit:kit-a']);
    assert.equal(rmBody.refused.length, 1);
    assert.match(rmBody.refused[0].reason, /root-owned|hardened|permission/i);
    assert.equal(rmBody.refused[0].stillListed, true,
      'the client turns this into "the next launch blocks on it again" instead of "this guard is clear"');
    await stat(join(wt, '.claude', 'kits', 'kit-b', 'kit.json'));   // really still there

    const rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.inventory, { kits: ['kit-b'], skills: ['hektor-verify'] },
      'a unit whose files survived the removal must stay listed: it is still installed, still registered and still executing');

    const relaunch = await post('/api/launch', { path: wt, selections: KEEP_SKILL });
    assert.equal(relaunch.blocked, 'orphaned-units',
      'and the guard must still report it — this is the one case where re-blocking is the correct answer');
    assert.deepEqual(relaunch.orphaned.map((o) => o.id), ['kit-b']);
  } finally {
    await chmod(join(wt, '.claude', 'kits', 'kit-b'), 0o700).catch(() => {});
    await rm(wt, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

// Finding: the raw Error.message reached an alert box as
// `ENOENT: no such file or directory, lstat '/var/…'`.
test('remove-units refuses a unit that is not on disk in human words, not a raw fs error', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-gone-'));
  try {
    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
      { config: {}, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, units: [{ kind: 'kit', id: 'k' }] }));
    const body = JSON.parse(res.body);
    assert.deepEqual(body.removed, []);
    assert.equal(body.refused.length, 1);
    assert.match(body.refused[0].reason, /already gone/, 'the user is told what happened, in their own vocabulary');
    assert.doesNotMatch(body.refused[0].reason, /ENOENT|lstat|\/var\//, 'no syscall, no errno, no temp path');
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

// A traversal id must have something REAL at the target it would escape to,
// or a missing guard just throws ENOENT and looks identical to a guard that
// worked. Every escape target below holds real content, so a bypassed guard
// is observable as an actual deletion, not a response-body coincidence.
//   '.'         -> .claude/kits (the whole kits dir, one level up from an id)
//   '..'        -> .claude (kits, skills AND settings.json, two levels up)
//   '../../etc' -> <worktree>/etc, escaping .claude entirely
async function traversalFixture() {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-trav-'));
  await mkdir(join(wt, '.claude', 'kits', 'safe-kit'), { recursive: true });
  await writeFile(join(wt, '.claude', 'kits', 'safe-kit', 'x.sh'), 'x\n');
  await mkdir(join(wt, '.claude', 'skills', 'safe-skill'), { recursive: true });
  await writeFile(join(wt, '.claude', 'skills', 'safe-skill', 'SKILL.md'), '# safe\n');
  await writeFile(join(wt, '.claude', 'settings.json'), '{"hooks":{}}\n');
  await mkdir(join(wt, 'etc'), { recursive: true });
  await writeFile(join(wt, 'etc', 'canary'), 'do not delete\n');
  return wt;
}

async function assertTraversalFixtureIntact(wt) {
  await stat(join(wt, '.claude', 'kits', 'safe-kit', 'x.sh'));
  await stat(join(wt, '.claude', 'skills', 'safe-skill', 'SKILL.md'));
  await stat(join(wt, '.claude', 'settings.json'));
  await stat(join(wt, 'etc', 'canary'));
}

for (const id of ['.', '..', '../../etc']) {
  test(`remove-units refuses a traversal id (${JSON.stringify(id)}) and destroys nothing on disk`, async () => {
    const wt = await traversalFixture();
    try {
      const res = fakeRes();
      await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
        { config: {}, journal: { add() {} }, broadcast() {} },
        async () => ({ path: wt, units: [{ kind: 'kit', id }] }));
      const body = JSON.parse(res.body);
      assert.deepEqual(body.removed, [], 'a traversal id must never resolve to a path');
      assert.equal(body.refused.length, 1, 'a rejected unit must be reported, not silently dropped');
      await assertTraversalFixtureIntact(wt);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });
}

test('remove-units folds a malformed unit into refused instead of dropping it silently', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-'));
  try {
    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
      { config: {}, journal: { add() {} }, broadcast() {} },
      async () => ({
        path: wt,
        units: [
          { kind: 'file', id: 'k' },   // bad kind
          { kind: 'kit', id: 123 },    // bad id type
          'not-an-object',             // not a unit at all
          null,                        // null entry
        ],
      }));
    const body = JSON.parse(res.body);
    assert.deepEqual(body.removed, []);
    assert.equal(body.refused.length, 4, 'every malformed unit must be reported, not vanish silently');
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

// A worktree whose previous provision wrote a kit that the incoming selection
// drops. The fake pack lets runSelections succeed so the record IS overwritten
// — which is the whole point: the detection has to happen before that.
async function orphanFixture() {
  const wt = await mkdtemp(join(tmpdir(), 'forest-orph-'));
  const packs = await mkdtemp(join(tmpdir(), 'forest-packs-'));
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-verify'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-verify', 'SKILL.md'), '# verify\n');
  await writeProvisionRecord(wt, [{ pack: 'hektor', kits: ['flaky-triage-kit'] }],
    { kits: ['flaky-triage-kit'], skills: [] });
  return { wt, packs };
}

test('/api/launch blocks on a unit the new selection dropped', async () => {
  const { wt, packs } = await orphanFixture();
  try {
    const res = fakeRes();
    let opened = false;
    const ctx = { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} };
    await createActionHandler({ launch: async () => { opened = true; return { ok: true }; } })(
      { url: '/api/launch' }, res, ctx,
      async () => ({ path: wt, selections: [{ pack: 'hektor', skills: ['hektor-verify'] }] }),
    );
    const body = JSON.parse(res.body);
    assert.equal(body.blocked, 'orphaned-units');
    assert.deepEqual(body.orphaned.map((o) => `${o.kind}:${o.id}`), ['kit:flaky-triage-kit']);
    assert.equal(body.repairable, false,
      'repair replays the record\'s selections and cannot touch the incoming selection that makes these units orphans — it can never clear this block, however full the record is');
    assert.equal(body.provisioned, undefined,
      'a blocked call provisions nothing, so it must not report a provisioned field either');
    assert.equal(opened, false, 'a blocked launch must not open a terminal');
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

test('/api/launch reads the previous record before deciding, and a blocked call provisions nothing', async () => {
  const { wt, packs } = await orphanFixture();
  try {
    const res = fakeRes();
    const ctx = { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} };
    await createActionHandler({ launch: async () => ({ ok: true }) })(
      { url: '/api/launch' }, res, ctx,
      async () => ({ path: wt, selections: [{ pack: 'hektor', skills: ['hektor-verify'] }] }),
    );
    assert.equal(JSON.parse(res.body).blocked, 'orphaned-units',
      'comparing the incoming selection against the record written before this call ran');
    const rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.inventory, { kits: ['flaky-triage-kit'], skills: [] },
      'a blocked call must not provision or overwrite the record — otherwise an identical retry would compare the new selection against itself and launch');
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

test('/api/launch: force launches despite orphans', async () => {
  const { wt, packs } = await orphanFixture();
  try {
    const res = fakeRes();
    let opened = false;
    const ctx = { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} };
    await createActionHandler({ launch: async () => { opened = true; return { ok: true, action: 'x' }; } })(
      { url: '/api/launch' }, res, ctx,
      async () => ({ path: wt, selections: [{ pack: 'hektor', skills: ['hektor-verify'] }], force: true }),
    );
    assert.equal(opened, true, 'force must reach the terminal');
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

test('/api/launch reports the orphan, not the missing gate, when both hold', async () => {
  const { wt, packs } = await orphanFixture();
  try {
    await mkdir(join(wt, '.claude'), { recursive: true });
    await writeFile(join(wt, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${join(wt, '.claude', 'hooks', 'gone.sh')}"` }] }] } }));
    const res = fakeRes();
    const ctx = { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} };
    await createActionHandler({ launch: async () => ({ ok: true }), resolveScope: noRealHome })(
      { url: '/api/launch' }, res, ctx,
      async () => ({ path: wt, selections: [{ pack: 'hektor', skills: ['hektor-verify'] }] }),
    );
    assert.equal(JSON.parse(res.body).blocked, 'orphaned-units',
      'a missing gate cannot be evaluated until provisioning runs, and provisioning must not run while an orphan is unresolved — the orphan is reported first');
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

// The Critical this fix round exists for: a blocked call must not disarm the
// guard for the next one. Previously the record was overwritten by
// provisioning before the orphan check could return, so a blocked call still
// mutated the record — an identical retry then compared the new selection
// against itself, found nothing missing, and launched. Today's UI has no
// orphaned-units branch, so the generic failure this produced made "click
// Launch again" — the natural response to an unexplained error — the thing
// that silently created an unmanaged orphan.
test('/api/launch: two identical calls both block — a blocked call must not disarm the guard for the next one', async () => {
  const { wt, packs } = await orphanFixture();
  try {
    const ctx = { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} };
    let opened = false;
    const launch = async () => { opened = true; return { ok: true }; };
    const selections = [{ pack: 'hektor', skills: ['hektor-verify'] }];

    const res1 = fakeRes();
    await createActionHandler({ launch })({ url: '/api/launch' }, res1, ctx, async () => ({ path: wt, selections }));
    assert.equal(JSON.parse(res1.body).blocked, 'orphaned-units', 'first call blocks');

    const res2 = fakeRes();
    await createActionHandler({ launch })({ url: '/api/launch' }, res2, ctx, async () => ({ path: wt, selections }));
    assert.equal(JSON.parse(res2.body).blocked, 'orphaned-units',
      'an identical retry must block identically, not silently launch because the first call already overwrote the orphan out of the record');
    assert.equal(opened, false, 'neither call may reach the terminal');
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

// The whole remediation loop, at the route level, because that is where the
// convergence lives: a client that recurses into startSession() after Remove
// is only honest if the server has stopped re-blocking on the unit it just
// deleted. Before this fix the trace read:
//
//   1 launch          → blocked: orphaned-units
//   2 remove K        → files gone, record untouched
//   3 relaunch        → blocked: orphaned-units AGAIN (nothing left to remove)
//   4 force           → launches; scope.missing carried the dead gate
//   5.. relaunch      → blocked: missing-hooks, repairable: true — forever,
//                       because repair replays a selections list that no
//                       longer names K, so K's installer never runs again.
//
// and it must now read: 3 clears the orphan guard, and every later step tells
// the truth about what repair can do.
async function convergenceFixture() {
  const wt = await mkdtemp(join(tmpdir(), 'forest-conv-'));
  const packs = await mkdtemp(join(tmpdir(), 'forest-packs-'));
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-verify'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-verify', 'SKILL.md'), '# verify\n');
  // The kit on disk, and the registration its own installer wrote — pointing
  // at a gate under .claude/hooks/, which forest never wrote and never edits.
  await mkdir(join(wt, '.claude', 'kits', 'flaky-triage-kit'), { recursive: true });
  await writeFile(join(wt, '.claude', 'kits', 'flaky-triage-kit', 'kit.json'), '{"id":"flaky-triage-kit"}\n');
  await writeFile(join(wt, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command',
      command: `"${join(wt, '.claude', 'hooks', 'flaky-kit-self-protection-gate.sh')}"` }] }] },
  }));
  await writeProvisionRecord(wt,
    [{ pack: 'hektor', kits: ['flaky-triage-kit'], skills: ['hektor-verify'], hooks: false }],
    { kits: ['flaky-triage-kit'], skills: ['hektor-verify'] });
  return { wt, packs };
}

test('block → remove → relaunch → force → relaunch converges: the guard clears and no step promises a repair that cannot work', async () => {
  const { wt, packs } = await convergenceFixture();
  try {
    const ctx = { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} };
    let opened = 0;
    const handler = createActionHandler({
      launch: async () => { opened += 1; return { ok: true, action: 'launched' }; },
      resolveScope: noRealHome,
    });
    const selections = [{ pack: 'hektor', skills: ['hektor-verify'] }];
    const launch = async (extra = {}) => {
      const res = fakeRes();
      await handler({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections, ...extra }));
      return JSON.parse(res.body);
    };

    // 1 — the block.
    const first = await launch();
    assert.equal(first.blocked, 'orphaned-units', 'step 1: the deselected kit blocks the launch');
    assert.equal(first.repairable, false, 'step 1: repair cannot clear an orphan block');
    assert.equal(opened, 0, 'step 1: no terminal');

    // 2 — Remove, exactly as the client posts it.
    const rmRes = fakeRes();
    await handler({ url: '/api/worktree/remove-units' }, rmRes, ctx,
      async () => ({ path: wt, units: first.orphaned.map(({ kind, id }) => ({ kind, id })) }));
    assert.deepEqual(JSON.parse(rmRes.body).removed, ['kit:flaky-triage-kit'], 'step 2: the files are deleted');
    await assert.rejects(() => stat(join(wt, '.claude', 'kits', 'flaky-triage-kit')));

    // 3 — the client recurses. This is the step that used to repeat step 1.
    const second = await launch();
    assert.notEqual(second.blocked, 'orphaned-units',
      'step 3: a removed unit must stop being reported as an orphan — otherwise Remove is a door into a state whose only offered remedy is a removal with nothing left to remove');
    assert.equal(second.blocked, 'missing-hooks', 'step 3: what remains is the registration Remove could not touch');
    assert.equal(second.missing.length, 1);
    assert.match(second.missing[0].command, /flaky-kit-self-protection-gate\.sh/);
    assert.equal(second.repairable, false,
      'step 3: the record no longer names the kit whose installer wrote that registration, so repair provably cannot rewrite it');
    assert.equal(opened, 0, 'step 3: still no terminal');

    // 4 — Launch anyway. The response must carry the dead gate so the client
    // can say so; a forced launch that reports nothing is how step 4 went
    // silent.
    const forced = await launch({ force: true });
    assert.equal(forced.ok, true);
    assert.equal(opened, 1, 'step 4: force reaches the terminal');
    assert.equal(forced.scope.missing.length, 1,
      'step 4: the forced launch reports the still-missing gate — with the module-level resolver here this also silently merged the real ~/.claude/settings.json');
    assert.match(forced.scope.missing[0].command, /flaky-kit-self-protection-gate\.sh/);

    // 5 — and it stays converged: the orphan guard does not come back, and
    // repair is still not offered.
    const third = await launch();
    assert.equal(third.blocked, 'missing-hooks', 'step 5: the orphan guard does not return after a forced launch re-wrote the record');
    assert.equal(third.repairable, false, 'step 5: still honest');
    assert.equal(opened, 1, 'step 5: no second terminal');

    const rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.inventory, { kits: [], skills: ['hektor-verify'] },
      'the record ends up describing what is actually on disk');
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

// The route must hand `launchDecision` the configured packs root, or
// `repairable` is answered against no pack source at all and collapses to a
// constant `false` — which reads as honest and is not: it would hide every
// Repair that WOULD work. Every other route-level assertion in this file
// expects `false`, and a `false` from an un-threaded packsDir is
// indistinguishable from a `false` that was reasoned to, so this is the one
// test that can pin the threading.
test('/api/launch answers repairable from the configured packs root', async () => {
  const wt = await tmp('forest-repairable-');
  const packs = await packsFixture({ 'kits/flaky-triage-kit/install.sh': '#!/bin/sh\nexit 0\n' });
  try {
    await mkdir(join(wt, '.claude'), { recursive: true });
    await writeFile(join(wt, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command',
        command: `"${join(wt, '.claude', 'hooks', 'gone.sh')}"` }] }] },
    }));
    await writeProvisionRecord(wt, [{ pack: 'hektor', kits: ['flaky-triage-kit'], skills: [] }]);
    const res = fakeRes();
    let opened = false;
    await createActionHandler({ launch: async () => { opened = true; return { ok: true }; }, resolveScope: noRealHome })(
      { url: '/api/launch' }, res,
      { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, selections: [] }));
    const body = JSON.parse(res.body);
    assert.equal(body.blocked, 'missing-hooks');
    assert.equal(body.repairable, true,
      'the pack still ships this kit and it ships install.sh — the route must reach the pack source to know that');
    assert.equal(opened, false, 'a blocked launch must not open a terminal');
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

// The post-launch scope report used the module-level resolver while the guard
// eight lines above it used the injected one, so this assertion could only be
// written against whatever ~/.claude/settings.json the developer happened to
// have. The sentinel makes the wiring itself observable.
test('/api/launch reports the INJECTED resolver\'s scope after launching, not the machine\'s', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-scope-'));
  try {
    const res = fakeRes();
    await createActionHandler({
      launch: async () => ({ ok: true, action: 'launched' }),
      resolveScope: async () => ({
        active: [{ command: 'a' }], inline: [], sources: ['/s/settings.json'],
        missing: [{ command: 'SENTINEL-gate.sh', source: '/s/settings.json' }],
      }),
    })({ url: '/api/launch' }, res,
      { config: { defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, selections: [], force: true }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, 'force is what gets past the guard to the post-launch report');
    assert.deepEqual(body.scope.missing.map((h) => h.command), ['SENTINEL-gate.sh'],
      'the route must report the scope it was handed, not resolve a second, different one');
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

// ---- /api/jira/submit-branch ----

function submitCtx(calls = []) {
  const worktree = { path: WT_PATH, repoPath: '/r/web-test', branch: 'tech/WEBT-229553', ticket: 'WEBT-229553' };
  const detached = { path: '/wt/web-test/detached', repoPath: '/r/web-test', branch: null, ticket: null };
  const snap = { repos: [{ repoPath: '/r/web-test', worktrees: [worktree, detached] }] };
  return {
    config: { jiraBaseUrl: 'https://jira.example.com', jiraProjectKey: 'SHBDN', jiraToken: 'pat', jiraEmail: '', jiraBranchFieldId: 'customfield_10041', defaultMode: 'auto' },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => { calls.push('fresh'); return snap; },
    cachedSnapshot: async () => { calls.push('cached'); return snap; },
  };
}
const callSubmit = (body, ctx, submitBranch) => {
  const res = fakeRes();
  return createActionHandler({ submitBranch })({ url: '/api/jira/submit-branch' }, res, ctx, async () => body).then(() => res);
};

test('/api/jira/submit-branch passes the re-keyed ticket and full branch name', async () => {
  const calls = [];
  const ctx = submitCtx(calls);
  const seen = [];
  const res = await callSubmit({ path: WT_PATH }, ctx, async (key, branch, opts) => { seen.push({ key, branch, opts }); return { ok: true }; });
  const out = JSON.parse(res.body);
  assert.deepEqual(out, { key: 'SHBDN-229553', branch: 'tech/WEBT-229553', ok: true });
  assert.deepEqual(calls, ['cached'], 'the lookup must not pay for a full rebuild');
  assert.equal(seen[0].key, 'SHBDN-229553');
  assert.equal(seen[0].branch, 'tech/WEBT-229553');
  assert.equal(seen[0].opts.fieldId, 'customfield_10041');
  assert.equal(seen[0].opts.force, false);
  assert.equal(ctx.journal.entries.length, 1);
  assert.match(ctx.journal.entries[0].cmd, /SHBDN-229553/);
  assert.match(ctx.journal.entries[0].cmd, /tech\/WEBT-229553/);
});

test('/api/jira/submit-branch forwards force and does not journal a conflict', async () => {
  const ctx = submitCtx();
  let seenForce = null;
  const res = await callSubmit({ path: WT_PATH, force: true }, ctx, async (k, b, opts) => { seenForce = opts.force; return { conflict: 'tech/OLD-1' }; });
  assert.equal(seenForce, true);
  assert.equal(JSON.parse(res.body).conflict, 'tech/OLD-1');
  assert.equal(ctx.journal.entries.length, 0, 'nothing was written, so nothing is journalled');
});

test('/api/jira/submit-branch: already-set is reported but not journalled', async () => {
  const ctx = submitCtx();
  const res = await callSubmit({ path: WT_PATH }, ctx, async () => ({ ok: true, already: true }));
  assert.equal(JSON.parse(res.body).already, true);
  assert.equal(ctx.journal.entries.length, 0);
});

test('/api/jira/submit-branch: unknown worktree → 404, no ticket branch → 400', async () => {
  const ctx = submitCtx();
  const missing = await callSubmit({ path: '/nope' }, ctx, async () => ({ ok: true }));
  assert.equal(missing.code, 404);
  const detached = await callSubmit({ path: '/wt/web-test/detached' }, ctx, async () => ({ ok: true }));
  assert.equal(detached.code, 400);
  assert.match(JSON.parse(detached.body).error, /ticket/);
});

// ---- /api/jira/branch-field ----

const callRead = (body, ctx, readBranch) => {
  const res = fakeRes();
  return createActionHandler({ readBranch })({ url: '/api/jira/branch-field' }, res, ctx, async () => body).then(() => res);
};

test('/api/jira/branch-field reads the field for the re-keyed ticket', async () => {
  const calls = [];
  const ctx = submitCtx(calls);
  const seen = [];
  const res = await callRead({ path: WT_PATH }, ctx, async (key, opts) => { seen.push({ key, opts }); return { value: null }; });
  assert.deepEqual(JSON.parse(res.body), { ok: true, key: 'SHBDN-229553', value: null });
  assert.deepEqual(calls, ['cached'], 'a read-only route must not pay for a full rebuild');
  assert.equal(seen[0].key, 'SHBDN-229553');
  assert.equal(seen[0].opts.fieldId, 'customfield_10041');
});

test('/api/jira/branch-field: 404 unknown, 400 ticketless, jira errors pass through', async () => {
  const ctx = submitCtx();
  assert.equal((await callRead({ path: '/nope' }, ctx, async () => ({ value: 'x' }))).code, 404);
  const noTicket = await callRead({ path: '/wt/web-test/detached' }, ctx, async () => ({ value: 'x' }));
  assert.equal(noTicket.code, 400);
  const failed = await callRead({ path: WT_PATH }, ctx, async () => ({ error: 'Jira returned 500' }));
  assert.match(JSON.parse(failed.body).error, /500/);
});

// ---- /api/worktree/priority ----

function prioCtx(repo, calls = []) {
  const worktree = { path: WT_PATH, repoPath: repo, branch: 'tech/WEBT-229553', ticket: 'WEBT-229553' };
  const snap = { repos: [{ repoPath: repo, worktrees: [worktree] }] };
  return {
    config: { defaultMode: 'auto' },
    journal: { add() {} },
    broadcast() {},
    snapshot: async () => { calls.push('fresh'); return snap; },
    cachedSnapshot: async () => { calls.push('cached'); return snap; },
  };
}
const callPrio = (body, ctx) => {
  const res = fakeRes();
  return createActionHandler()({ url: '/api/worktree/priority' }, res, ctx, async () => body).then(() => res);
};

test('/api/worktree/priority: saves keyed by branch, clears on empty, validates the color', async () => {
  const repo = await tmp('forest-prio-route-');
  try {
    const ctx = prioCtx(repo);
    const saved = await callPrio({ path: WT_PATH, priority: 'red' }, ctx);
    assert.equal(JSON.parse(saved.body).ok, true);
    assert.deepEqual(await readPriorities(repo), { 'tech/WEBT-229553': 'red' });
    const cleared = await callPrio({ path: WT_PATH, priority: '' }, ctx);
    assert.equal(JSON.parse(cleared.body).ok, true);
    assert.deepEqual(await readPriorities(repo), {});
    const bad = await callPrio({ path: WT_PATH, priority: 'magenta' }, ctx);
    assert.equal(bad.code, 400);
    assert.match(JSON.parse(bad.body).error, /red/);
    assert.equal((await callPrio({ path: '/nope', priority: 'red' }, ctx)).code, 404);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('/api/worktree/priority echoes into the cached snapshot — never a rebuild', async () => {
  // A full snapshot build walks every repo and takes seconds; paying that per
  // swatch click made the whole server (and everything queued behind it) crawl.
  const repo = await tmp('forest-prio-route-');
  try {
    const calls = [];
    const ctx = prioCtx(repo, calls);
    let broadcasted = null;
    ctx.broadcast = (event, snap) => { broadcasted = { event, snap }; };
    const res = await callPrio({ path: WT_PATH, priority: 'blue' }, ctx);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.ok(!calls.includes('fresh'), 'a label change must not pay for a repo walk');
    assert.equal(broadcasted.event, 'worktrees');
    assert.equal(broadcasted.snap.repos[0].worktrees[0].priority, 'blue',
      'the cached record carries the new color so every open deck recolors');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

// ---- /api/jira/tickets + /api/jira/people ----

function ticketCtx() {
  return {
    config: { jiraBaseUrl: 'https://jira.example.com', jiraToken: 'pat', jiraEmail: '', defaultMode: 'auto' },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => ({ repos: [] }),
    cachedSnapshot: async () => ({ repos: [] }),
  };
}

const callJson = (url, body, deps) => {
  const res = fakeRes();
  return createActionHandler(deps)({ url }, res, ticketCtx(), async () => body).then(() => res);
};

test('/api/jira/tickets: sprint scope builds the sprint JQL and passes config through', async () => {
  const seen = [];
  const res = await callJson('/api/jira/tickets', { scope: 'sprint', assignee: 'egecan.sen' }, {
    searchTickets: async (jql, opts) => { seen.push({ jql, opts }); return { issues: [{ key: 'S-1' }], total: 1, truncated: false }; },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.deepEqual(body.issues, [{ key: 'S-1' }]);
  assert.match(seen[0].jql, /sprint in openSprints\(\)/);
  assert.match(seen[0].jql, /"egecan\.sen"/);
  assert.equal(seen[0].opts.baseUrl, 'https://jira.example.com');
  assert.equal(seen[0].opts.token, 'pat');
});

test('/api/jira/tickets: backlog scope builds the backlog JQL', async () => {
  const seen = [];
  await callJson('/api/jira/tickets', { scope: 'backlog', assignee: 'egecan.sen' }, {
    searchTickets: async (jql) => { seen.push(jql); return { issues: [], total: 0, truncated: false }; },
  });
  assert.match(seen[0], /sprint is EMPTY OR sprint not in openSprints\(\)/);
});

test('/api/jira/tickets: caches per (scope, person) and refresh bypasses', async () => {
  let calls = 0;
  const handler = createActionHandler({ searchTickets: async () => ({ issues: [], total: ++calls, truncated: false }) });
  const ctx = ticketCtx();
  const run = (body) => { const res = fakeRes(); return handler({ url: '/api/jira/tickets' }, res, ctx, async () => body).then(() => JSON.parse(res.body)); };
  assert.equal((await run({ scope: 'sprint', assignee: 'a' })).total, 1);
  assert.equal((await run({ scope: 'sprint', assignee: 'a' })).total, 1, 'same key must be a cache hit');
  assert.equal((await run({ scope: 'backlog', assignee: 'a' })).total, 2, 'scope is part of the key');
  assert.equal((await run({ scope: 'sprint', assignee: 'b' })).total, 3, 'person is part of the key');
  assert.equal((await run({ scope: 'sprint', assignee: 'a', refresh: true })).total, 4, 'refresh must bypass');
});

test('/api/jira/tickets: bad scope 400s, missing assignee 400s, jira errors pass through', async () => {
  const ok = { searchTickets: async () => ({ issues: [], total: 0, truncated: false }) };
  assert.equal((await callJson('/api/jira/tickets', { scope: 'nope', assignee: 'a' }, ok)).code, 400);
  assert.equal((await callJson('/api/jira/tickets', { scope: 'sprint', assignee: '  ' }, ok)).code, 400);
  const failed = await callJson('/api/jira/tickets', { scope: 'sprint', assignee: 'a' }, {
    searchTickets: async () => ({ error: 'Jira returned 500' }),
  });
  assert.match(JSON.parse(failed.body).error, /500/);
});

test('/api/jira/people: empty query returns just the authenticated user', async () => {
  const res = await callJson('/api/jira/people', { q: '' }, {
    whoami: async () => ({ name: 'egecan.sen', displayName: 'Egecan Sen' }),
    searchPeople: async () => { throw new Error('must not search on an empty query'); },
  });
  const body = JSON.parse(res.body);
  assert.deepEqual(body.me, { name: 'egecan.sen', displayName: 'Egecan Sen' });
  assert.deepEqual(body.people, [{ name: 'egecan.sen', displayName: 'Egecan Sen' }]);
});

test('/api/jira/people: a query searches, errors pass through', async () => {
  const res = await callJson('/api/jira/people', { q: 'sen' }, {
    searchPeople: async (q) => ({ people: [{ name: `x-${q}`, displayName: 'X' }] }),
  });
  assert.deepEqual(JSON.parse(res.body).people, [{ name: 'x-sen', displayName: 'X' }]);
  const failed = await callJson('/api/jira/people', { q: 'sen' }, { searchPeople: async () => ({ error: 'Jira returned 500' }) });
  assert.match(JSON.parse(failed.body).error, /500/);
});

// ---- /api/launch with a seeded prompt ----

test('/api/launch forwards a prompt to the launcher and reports it was sent', async () => {
  const seen = [];
  const res = fakeRes();
  const ctx = submitCtx();
  await createActionHandler({
    launch: async (args) => { seen.push(args); return { ok: true, action: 'launched' }; },
    resolveScope: noRealHome,
  })({ url: '/api/launch' }, res, ctx, async () => ({ path: WT_PATH, selections: [], prompt: 'Hektor, multi-ticket: A-1, A-2' }));
  assert.equal(seen[0].prompt, 'Hektor, multi-ticket: A-1, A-2');
  assert.equal(JSON.parse(res.body).promptSent, true);
  assert.ok(
    ctx.journal.entries.some((e) => e.cmd.includes('multi-ticket')),
    'the journal must record what was actually sent to the session',
  );
});

test('/api/launch: a focused (already alive) session did NOT receive the prompt', async () => {
  const res = fakeRes();
  const ctx = submitCtx();
  await createActionHandler({
    launch: async () => ({ ok: true, action: 'focused' }),
    resolveScope: noRealHome,
  })({ url: '/api/launch' }, res, ctx, async () => ({ path: WT_PATH, selections: [], prompt: 'Hektor, work A-1' }));
  const body = JSON.parse(res.body);
  assert.equal(body.action, 'focused');
  assert.equal(body.promptSent, false, 'silently dropping the ticket list would look like a launch');
  // The journal must tell the same truth as the response: a focused session
  // received nothing, so its line is bare `claude`, never the prompt text —
  // journalling it here would record a delivery that never happened.
  assert.equal(ctx.journal.entries.at(-1).cmd, 'claude');
  assert.ok(
    !ctx.journal.entries.some((e) => e.cmd.includes('work A-1')),
    'a focused session must not leave the undelivered prompt in the journal',
  );
});

test('/api/launch without a prompt is unchanged', async () => {
  const seen = [];
  const res = fakeRes();
  await createActionHandler({
    launch: async (args) => { seen.push(args); return { ok: true, action: 'launched' }; },
    resolveScope: noRealHome,
  })({ url: '/api/launch' }, res, submitCtx(), async () => ({ path: WT_PATH, selections: [] }));
  assert.equal(seen[0].prompt, undefined);
  assert.equal(JSON.parse(res.body).promptSent, false);
});

// ---- /api/srp ----

function srpCtx(config = {}) {
  return {
    config: { srpBaseUrl: 'https://srp.example.net/api', srpRefreshToken: 'refresh', testboxes: ['x:999'], defaultMode: 'auto', ...config },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => ({ repos: [] }),
    cachedSnapshot: async () => ({ repos: [] }),
  };
}

const callSrp = (url, body, deps, ctx = srpCtx(), headers = {}) => {
  const res = fakeRes();
  return createActionHandler(deps)({ url, headers }, res, ctx, async () => body).then(() => res);
};

test('/api/srp/boxes returns live reservations tagged as coming from SRP', async () => {
  const res = await callSrp('/api/srp/boxes', {}, {
    srpClient: () => ({ listReservations: async () => ({ boxes: [{ box: 'x:161', description: 'triage' }] }) }),
  });
  assert.deepEqual(JSON.parse(res.body), { ok: true, source: 'srp', boxes: [{ box: 'x:161', description: 'triage' }] });
});

test('/api/srp/boxes falls back to config.testboxes with the reason, never an error', async () => {
  const res = await callSrp('/api/srp/boxes', {}, {
    srpClient: () => ({ listReservations: async () => ({ error: 'SRP unreachable (ENOTFOUND) — on the VPN?' }) }),
  });
  assert.equal(res.code, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.source, 'config');
  assert.deepEqual(body.boxes, [{ box: 'tb999' }]);
  assert.match(body.reason, /unreachable/, 'the ticket half of the modal must keep working, with the reason visible');
});

test('/api/srp/boxes: no SRP config falls back without pretending to have called it', async () => {
  // Passing no srpClient dep would fall back to the real createSrpClient
  // import and, if the no-config guard ever regressed, issue a live HTTP
  // request — a test may never depend on the network to stay safe. This stub
  // proves the guard: it records whether it was ever constructed and throws
  // if so, so a regression fails LOUDLY here instead of hanging on a socket.
  let constructed = false;
  const srpClient = () => { constructed = true; throw new Error('must not construct a client with no SRP config'); };
  const res = await callSrp('/api/srp/boxes', {}, { srpClient }, srpCtx({ srpRefreshToken: '' }));
  assert.equal(res.code, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.source, 'config');
  assert.match(body.reason, /srpRefreshToken/);
  assert.equal(constructed, false, 'the guard must short-circuit before the client is ever built');
});

test('/api/srp/boxes: a thrown srpClient (construction or listReservations) still degrades to config, never 500s', async () => {
  const res = await callSrp('/api/srp/boxes', {}, {
    srpClient: () => { throw new Error('SRP client blew up unexpectedly'); },
  });
  assert.equal(res.code, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.source, 'config');
  assert.deepEqual(body.boxes, [{ box: 'tb999' }]);
  assert.match(body.reason, /blew up/);
});

test('/api/srp/reserve passes the form through and journals the request', async () => {
  const seen = [];
  const ctx = srpCtx();
  const res = await callSrp('/api/srp/reserve', { description: 'SHBDN-1', expectedEndDate: '2026-08-18 18:00', expectedState: 5 }, {
    srpClient: () => ({ reserve: async (form) => { seen.push(form); return { ok: true }; } }),
  }, ctx);
  assert.deepEqual(seen[0], { description: 'SHBDN-1', expectedEndDate: '2026-08-18 18:00', expectedState: 5 });
  assert.equal(JSON.parse(res.body).ok, true);
  assert.ok(ctx.journal.entries.some((e) => /srp: reserve/.test(e.cmd)));
});

test('/api/srp/reserve: queued is not an error', async () => {
  const res = await callSrp('/api/srp/reserve', { description: 'd', expectedEndDate: 'x' }, {
    srpClient: () => ({ reserve: async () => ({ queued: true, message: 'no free box' }) }),
  });
  assert.deepEqual(JSON.parse(res.body), { ok: true, queued: true, message: 'no free box' });
});

test('/api/srp/reserve: a missing description is refused before the network', async () => {
  const res = await callSrp('/api/srp/reserve', { description: '  ', expectedEndDate: 'x' }, {
    srpClient: () => ({ reserve: async () => { throw new Error('must not be called'); } }),
  });
  assert.equal(res.code, 400);
});

// A client per request means an access token per request: the token lives
// inside the client, so rebuilding it re-mints on every box load and every
// reserve, and srp.mjs's shared-mint machinery (written because these two
// calls race in the same tick) never runs at all. `createActionHandler()` is
// called once by server.mjs, so one client per handler is the spec's "held in
// memory for the server's lifetime".
test('the SRP client is built once per handler, not once per request', async () => {
  let constructed = 0;
  const handle = createActionHandler({
    srpClient: () => {
      constructed += 1;
      return {
        listReservations: async () => ({ boxes: [{ box: 'x:161' }] }),
        reserve: async () => ({ ok: true }),
      };
    },
  });
  const ctx = srpCtx();
  const call = (url, body) => {
    const res = fakeRes();
    return handle({ url }, res, ctx, async () => body).then(() => res);
  };
  await call('/api/srp/boxes', {});
  await call('/api/srp/boxes', {});
  await call('/api/srp/reserve', { description: 'd', expectedEndDate: '2026-08-18 18:00' });
  assert.equal(constructed, 1, 'every request after the first must reuse the token the first one minted');
});

// The memo may not outlive the config it closed over: baseUrl, refresh token
// and username are captured at construction, so a handler still holding the
// old client would keep presenting a token the user has already replaced.
test('a changed SRP config rebuilds the client rather than serving the stale one', async () => {
  const tokens = [];
  const handle = createActionHandler({
    srpClient: ({ refreshToken }) => {
      tokens.push(refreshToken);
      return { listReservations: async () => ({ boxes: [] }) };
    },
  });
  const call = (ctx) => {
    const res = fakeRes();
    return handle({ url: '/api/srp/boxes' }, res, ctx, async () => ({})).then(() => res);
  };
  await call(srpCtx({ srpRefreshToken: 'first' }));
  await call(srpCtx({ srpRefreshToken: 'first' }));
  await call(srpCtx({ srpRefreshToken: 'second' }));
  assert.deepEqual(tokens, ['first', 'second']);
});

// `x161` in config.json and `x:161` from SRP are the same box; only the SRP
// path normalised it, so which form reached the prompt depended on whether
// the user was on the VPN.
test('/api/srp/boxes: the config fallback list goes through boxLabel too', async () => {
  const res = await callSrp('/api/srp/boxes', {}, {
    srpClient: () => ({ listReservations: async () => ({ error: 'SRP unreachable — on the VPN?' }) }),
  }, srpCtx({ testboxes: ['x161', 'X-230', 'x_7', 'preprod box', ''] }));
  const body = JSON.parse(res.body);
  assert.equal(body.source, 'config');
  assert.deepEqual(body.boxes, [
    { box: 'tb161' }, { box: 'tb230' }, { box: 'tb7' },
    // Unrecognised shapes still pass through uncorrected — the prompt is
    // editable, and a plausible-looking wrong box is worse than an odd one.
    { box: 'preprod box' },
  ]);
});

// ---- /api/srp/token (Task 9: connect SRP from the browser bookmarklet) ----
//
// srpCtx()'s default srpBaseUrl is 'https://srp.example.net/api', so its
// origin — the value the bookmarklet's page is checked against — is this:
const SRP_ORIGIN = 'https://srp.example.net';

test('/api/srp/token: a POST whose Origin matches config.srpBaseUrl stores the credential', async () => {
  const res = await callSrp('/api/srp/token', { refreshToken: 'fresh-from-browser' }, {}, srpCtx(), { origin: SRP_ORIGIN });
  assert.equal(res.code, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, source: 'browser' });
});

test('/api/srp/token: a POST from any other Origin is refused and stores nothing', async () => {
  const seen = [];
  const handle = createActionHandler({
    srpClient: (opts) => { seen.push(opts); return { listReservations: async () => ({ boxes: [] }) }; },
  });
  const ctx = srpCtx();
  const call = (u, b, headers) => {
    const res = fakeRes();
    return handle({ url: u, headers }, res, ctx, async () => b).then(() => res);
  };
  const res = await call('/api/srp/token', { refreshToken: 'stolen' }, { origin: 'https://evil.example.net' });
  assert.equal(res.code, 403);
  // Nothing was stored: the next /api/srp/boxes call must still build its
  // client from config.srpRefreshToken, never the rejected credential.
  await call('/api/srp/boxes', {}, {});
  assert.equal(seen[0].refreshToken, 'refresh');
});

test('/api/srp/token: a missing Origin header is refused the same way', async () => {
  const res = await callSrp('/api/srp/token', { refreshToken: 't' }, {}, srpCtx(), {});
  assert.equal(res.code, 403);
});

test('/api/srp/token: a blank refreshToken is 400', async () => {
  const res = await callSrp('/api/srp/token', { refreshToken: '   ' }, {}, srpCtx(), { origin: SRP_ORIGIN });
  assert.equal(res.code, 400);
});

test('/api/srp/token: a missing refreshToken is 400', async () => {
  const res = await callSrp('/api/srp/token', {}, {}, srpCtx(), { origin: SRP_ORIGIN });
  assert.equal(res.code, 400);
});

test('/api/srp/token: after a successful POST, /api/srp/boxes builds its client from the runtime token, not config.srpRefreshToken', async () => {
  const seen = [];
  const handle = createActionHandler({
    srpClient: (opts) => { seen.push(opts); return { listReservations: async () => ({ boxes: [] }) }; },
  });
  const ctx = srpCtx({ srpRefreshToken: 'stale-config-token' });
  const call = (u, b, headers = {}) => {
    const res = fakeRes();
    return handle({ url: u, headers }, res, ctx, async () => b).then(() => res);
  };
  await call('/api/srp/token', { refreshToken: 'fresh-from-browser' }, { origin: SRP_ORIGIN });
  await call('/api/srp/boxes', {});
  assert.equal(seen.length, 1, 'the boxes call must have actually built a client');
  assert.equal(seen[0].refreshToken, 'fresh-from-browser');
});

// The bookmarklet hands over SRP's own access token alongside the refresh
// token; the memoised client should start from it too, not just the refresh
// token, so the first read after a connect skips SRP's mint round trip.
test('/api/srp/token: the runtime access token rides along with the refresh token into the memoised client', async () => {
  const seen = [];
  const handle = createActionHandler({
    srpClient: (opts) => { seen.push(opts); return { listReservations: async () => ({ boxes: [] }) }; },
  });
  const ctx = srpCtx();
  const call = (u, b, headers = {}) => {
    const res = fakeRes();
    return handle({ url: u, headers }, res, ctx, async () => b).then(() => res);
  };
  await call('/api/srp/token', { refreshToken: 'fresh-from-browser', accessToken: 'fresh-access' }, { origin: SRP_ORIGIN });
  await call('/api/srp/boxes', {});
  assert.equal(seen[0].refreshToken, 'fresh-from-browser');
  assert.equal(seen[0].accessToken, 'fresh-access');
});

// A memo keyed only on the refresh token would silently keep serving a
// client built from the FIRST bookmarklet run forever, even after a second
// run handed over a fresher access token under the same (unchanged) refresh
// token — a real case, since SRP's access token can rotate independently.
test('/api/srp/token: reconnecting with the same refresh token but a fresh access token rebuilds the memoised client', async () => {
  const seen = [];
  const handle = createActionHandler({
    srpClient: (opts) => { seen.push(opts); return { listReservations: async () => ({ boxes: [] }) }; },
  });
  const ctx = srpCtx();
  const call = (u, b, headers = {}) => {
    const res = fakeRes();
    return handle({ url: u, headers }, res, ctx, async () => b).then(() => res);
  };
  await call('/api/srp/token', { refreshToken: 'same-refresh', accessToken: 'access-1' }, { origin: SRP_ORIGIN });
  await call('/api/srp/boxes', {});
  await call('/api/srp/token', { refreshToken: 'same-refresh', accessToken: 'access-2' }, { origin: SRP_ORIGIN });
  await call('/api/srp/boxes', {});
  assert.equal(seen.length, 2, 'a fresh access token must rebuild the memoised client even when the refresh token is unchanged');
  assert.equal(seen[1].accessToken, 'access-2');
});

test('/api/srp/token: the token value reaches no journal entry and no response body', async () => {
  const ctx = srpCtx();
  const secret = 'super-secret-refresh-token-xyz-do-not-leak';
  const res = await callSrp('/api/srp/token', { refreshToken: secret, accessToken: 'also-secret' }, {}, ctx, { origin: SRP_ORIGIN });
  assert.equal(res.code, 200);
  assert.ok(!res.body.includes(secret), 'the response body must never echo the token');
  assert.ok(!ctx.journal.entries.some((e) => JSON.stringify(e).includes(secret)), 'no journal entry may contain the token value');
});

// ---- /api/srp/login (Task 9, round 3: log in once inside forest) ----

test('/api/srp/login: a blank username or password is 400, no login attempted', async () => {
  let called = false;
  const deps = { loginSrp: async () => { called = true; return { accessToken: 'a', refreshToken: 'r' }; } };
  for (const body of [{ username: '', password: 'p' }, { username: 'u', password: '' }, { username: '  ', password: '  ' }, {}]) {
    const res = await callSrp('/api/srp/login', body, deps);
    assert.equal(res.code, 400, JSON.stringify(body));
  }
  assert.equal(called, false, 'a blank field must refuse before ever calling loginSrp');
});

test('/api/srp/login: success stores both tokens and rebuilds the memoised client from them', async () => {
  const seen = [];
  const handle = createActionHandler({
    loginSrp: async ({ baseUrl, username, password }) => {
      assert.equal(baseUrl, 'https://srp.example.net/api');
      assert.equal(username, 'ege');
      assert.equal(password, 'hunter2');
      return { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' };
    },
    srpClient: (opts) => { seen.push(opts); return { listReservations: async () => ({ boxes: [] }) }; },
  });
  const ctx = srpCtx();
  const call = (u, b, headers = {}) => {
    const res = fakeRes();
    return handle({ url: u, headers }, res, ctx, async () => b).then(() => res);
  };
  const res = await call('/api/srp/login', { username: 'ege', password: 'hunter2' });
  assert.deepEqual(JSON.parse(res.body), { ok: true, source: 'login', username: 'ege' });
  await call('/api/srp/boxes', {});
  assert.equal(seen[0].refreshToken, 'fresh-refresh');
  assert.equal(seen[0].accessToken, 'fresh-access');
});

test('/api/srp/login: a rejected login is reported and journals only the username', async () => {
  const ctx = srpCtx();
  const res = await callSrp('/api/srp/login', { username: 'ege', password: 'wrong' }, {
    loginSrp: async () => ({ error: 'SRP rejected those credentials' }),
  }, ctx);
  assert.deepEqual(JSON.parse(res.body), { error: 'SRP rejected those credentials' });
  assert.ok(!ctx.journal.entries.length, 'a rejected login must not be journalled at all');
});

test('/api/srp/login: a rejected login leaves the previously stored credential untouched', async () => {
  const seen = [];
  const handle = createActionHandler({
    loginSrp: async () => ({ error: 'SRP rejected those credentials' }),
    srpClient: (opts) => { seen.push(opts); return { listReservations: async () => ({ boxes: [] }) }; },
  });
  const ctx = srpCtx({ srpRefreshToken: 'still-the-config-token' });
  const call = (u, b, headers = {}) => {
    const res = fakeRes();
    return handle({ url: u, headers }, res, ctx, async () => b).then(() => res);
  };
  await call('/api/srp/login', { username: 'ege', password: 'wrong' });
  await call('/api/srp/boxes', {});
  assert.equal(seen[0].refreshToken, 'still-the-config-token', 'a failed login must not overwrite the runtime credential store');
});

test('/api/srp/login: the password appears in no journal entry and no response body', async () => {
  const ctx = srpCtx();
  const secret = 'super-secret-password-do-not-leak';
  const res = await callSrp('/api/srp/login', { username: 'ege', password: secret }, {
    loginSrp: async () => ({ accessToken: 'a', refreshToken: 'r' }),
  }, ctx);
  assert.ok(!res.body.includes(secret), 'the response body must never echo the password');
  assert.ok(!ctx.journal.entries.some((e) => JSON.stringify(e).includes(secret)), 'no journal entry may contain the password');
  assert.ok(ctx.journal.entries.some((e) => /srp: connected as ege/.test(e.cmd)), 'the username IS useful and should be journalled');
});

// ---- /api/worktree/create (refactored to share createWorktreeAt with
// /api/tickets/worktrees below — this is the one test proving that
// refactor is behaviour-preserving) ----

async function bareRepoFixture() {
  const repo = await mkdtemp(join(tmpdir(), 'forest-tix-repo-'));
  const wtRoot = await mkdtemp(join(tmpdir(), 'forest-tix-wtroot-'));
  await gitFixture(repo, 'init', '-b', 'master');
  await gitFixture(repo, 'config', 'user.email', 't@t');
  await gitFixture(repo, 'config', 'user.name', 't');
  await gitFixture(repo, 'config', 'gc.auto', '0');
  await writeFile(join(repo, 'a.txt'), 'base\n');
  await gitFixture(repo, 'add', '.');
  await gitFixture(repo, 'commit', '-m', 'base');
  return { repo, wtRoot };
}

function ticketsCtx({ repo, wtRoot, packs } = {}, overrides = {}) {
  const snap = { repos: repo ? [{ repo: basename(repo), repoPath: repo, worktrees: [] }] : [] };
  return {
    config: { worktreeRoot: wtRoot, packsDir: packs || '/no/such/packs', openEditorCmd: 'open -a Cursor', defaultMode: 'auto', ...overrides },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => snap,
    cachedSnapshot: async () => snap,
  };
}

test('/api/worktree/create still creates a worktree after being refactored to share createWorktreeAt', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    await createActionHandler()({ url: '/api/worktree/create' }, res, ctx, async () => ({
      repoPath: repo, branch: 'tech/WEBT-1', newBranch: true, mode: 'auto',
    }));
    assert.equal(res.code, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.mode, 'auto');
    assert.match(body.command, /'worktree' 'add' '-b' 'tech\/WEBT-1'/);
    await stat(join(wtRoot, 'a.txt').replace('a.txt', '')); // wtRoot itself must exist
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

// A new branch must be cut from the repo's base branch, not from whatever the
// primary checkout happens to have out at that moment. Observed damage from
// the old `base || 'HEAD'` default: two ticket worktrees created while the
// primary sat on an unrelated feature branch each carried that branch's
// unmerged commit, and one of them was pushed with it — the other ticket's
// 11 files showed up in its PR diff.
test('/api/worktree/create: a new branch is cut from the base branch, not the primary checkout\'s HEAD', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    await gitFixture(repo, 'switch', '-c', 'tech/OTHER-1');
    await writeFile(join(repo, 'b.txt'), 'other\n');
    await gitFixture(repo, 'add', '.');
    await gitFixture(repo, 'commit', '-m', 'other ticket work');

    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    await createActionHandler()({ url: '/api/worktree/create' }, res, ctx, async () => ({
      repoPath: repo, branch: 'tech/WEBT-1', newBranch: true, mode: 'auto',
    }));
    assert.equal(res.code, 200);
    const body = JSON.parse(res.body);
    assert.match(body.command, /'tech\/WEBT-1' '[^']+' 'master'$/, 'the start point must be the resolved base branch');
    const log = await runGit(repo, ['log', '--oneline', 'tech/WEBT-1']);
    assert.ok(!log.includes('other ticket work'), 'the new branch must not carry the primary checkout\'s unmerged work');
    assert.ok(log.includes('base'), 'the new branch must still be cut from the base branch');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/worktree/create: an explicit base still wins over the resolved default', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    await gitFixture(repo, 'switch', '-c', 'tech/OTHER-1');
    await writeFile(join(repo, 'b.txt'), 'other\n');
    await gitFixture(repo, 'add', '.');
    await gitFixture(repo, 'commit', '-m', 'other ticket work');
    await gitFixture(repo, 'switch', 'master');

    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    await createActionHandler()({ url: '/api/worktree/create' }, res, ctx, async () => ({
      repoPath: repo, branch: 'tech/WEBT-2', newBranch: true, base: 'tech/OTHER-1', mode: 'auto',
    }));
    assert.equal(res.code, 200);
    const log = await runGit(repo, ['log', '--oneline', 'tech/WEBT-2']);
    assert.ok(log.includes('other ticket work'), 'an explicitly named base must be honoured verbatim');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

// A repo whose default branch is neither main nor master and which has no
// origin/HEAD to read: nothing resolves, so the old HEAD behaviour is still
// the only sensible fallback and must keep working.
test('/api/worktree/create: falls back to HEAD when no base branch resolves', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'forest-nobase-repo-'));
  const wtRoot = await mkdtemp(join(tmpdir(), 'forest-nobase-wtroot-'));
  try {
    await gitFixture(repo, 'init', '-b', 'trunk');
    await gitFixture(repo, 'config', 'user.email', 't@t');
    await gitFixture(repo, 'config', 'user.name', 't');
    await writeFile(join(repo, 'a.txt'), 'base\n');
    await gitFixture(repo, 'add', '.');
    await gitFixture(repo, 'commit', '-m', 'base');

    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    await createActionHandler()({ url: '/api/worktree/create' }, res, ctx, async () => ({
      repoPath: repo, branch: 'tech/WEBT-3', newBranch: true, mode: 'auto',
    }));
    assert.equal(res.code, 200);
    const body = JSON.parse(res.body);
    assert.match(body.command, /'tech\/WEBT-3' '[^']+' 'HEAD'$/, 'with nothing to resolve, HEAD stays the fallback');
    const log = await runGit(repo, ['log', '--oneline', 'tech/WEBT-3']);
    assert.ok(log.includes('base'), 'the worktree must still be created');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

// ---- /api/tickets/worktrees ----

test('/api/tickets/worktrees: cannot infer a prefix -> 400, nothing created', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({ inferBranchPrefix: async () => null });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-1'], selections: [] }));
    assert.equal(res.code, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes(repo), 'the error must name the repo it could not infer a prefix for');
    assert.ok(!body.results, 'a 400 here must not also carry a results array');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: creates one worktree per ticket, maps the trailing number onto the inferred prefix', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const openCalls = [];
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async (args) => {
        openCalls.push(args);
        return { ok: true, cli: true, foldersAdded: args.worktrees.length, briefsOpened: args.briefPaths.length, workspaceFile: '/fake/web-test.code-workspace' };
      },
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-233021', 'SHBDN-241011'], selections: [], boxes: ['tb161'], prompt: 'the session line',
    }));
    assert.equal(res.code, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.results.map((r) => r.branch), ['tech/WEBT-233021', 'tech/WEBT-241011']);
    assert.ok(body.results.every((r) => r.path && r.existed === false));
    for (const r of body.results) await stat(join(r.path, '.git')); // must be a real worktree
    assert.ok(body.results.every((r) => r.briefPath && r.briefPath.endsWith(`docs/hektor/tickets/${r.ticket}.md`)),
      'every ticket with a worktree must also get a brief');

    await new Promise((r) => setTimeout(r, 20)); // let the unawaited window-open settle
    assert.equal(openCalls.length, 1);
    assert.equal(openCalls[0].primaryPath, repo);
    assert.equal(openCalls[0].worktreeRoot, wtRoot);
    assert.deepEqual(
      openCalls[0].worktrees.map((w) => w.path).sort(),
      body.results.map((r) => r.path).sort(),
    );
    assert.deepEqual(openCalls[0].worktrees.map((w) => w.name).sort(), ['SHBDN-233021', 'SHBDN-241011'].sort(),
      'each worktree is named after its ticket key, not its slugged path');
    assert.deepEqual(openCalls[0].briefPaths.sort(), body.results.map((r) => r.briefPath).sort());
    assert.ok(ctx.journal.entries.some((e) => /Cursor workspace opened: \/fake\/web-test\.code-workspace \(2 worktree folder\(s\), 2 brief\(s\) opened as tabs\)/.test(e.cmd)));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

// The route that actually caused the damage: the Jira bulk flow passes
// base: undefined for every ticket, so it inherited the same HEAD default.
test('/api/tickets/worktrees: ticket branches are cut from the base branch, not the primary checkout\'s HEAD', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    await gitFixture(repo, 'switch', '-c', 'tech/WEBT-999');
    await writeFile(join(repo, 'other.txt'), 'unrelated\n');
    await gitFixture(repo, 'add', '.');
    await gitFixture(repo, 'commit', '-m', 'another ticket in flight');

    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true, cli: true, foldersAdded: 2, briefsOpened: 0, workspaceFile: '/fake/ws' }),
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-233170', 'SHBDN-257365'], selections: [],
    }));
    assert.equal(res.code, 200);
    const body = JSON.parse(res.body);
    for (const r of body.results) {
      const log = await runGit(repo, ['log', '--oneline', r.branch]);
      assert.ok(!log.includes('another ticket in flight'),
        `${r.branch} must not carry the unrelated branch the primary had checked out`);
    }
    await new Promise((r) => setTimeout(r, 20)); // let the unawaited window-open settle
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

// "Also: journal what the window step actually did" — before this, a silent
// failure here (the CLI missing, or the open call itself throwing) left the
// user with nothing to read at all once the window didn't show up.
test('/api/tickets/worktrees: the CLI-missing fallback is journalled, naming how many worktrees were NOT added', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true, cli: false, foldersAdded: 0, workspaceFile: null }),
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-1'], selections: [] }));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(ctx.journal.entries.some((e) => /Cursor CLI not found — opened only the primary checkout/.test(e.cmd)
      && /1 worktree\(s\) and 1 brief\(s\) were NOT opened/.test(e.cmd)));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: the window step throwing is journalled too, not swallowed silently', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => { throw new Error('ENOENT: no such file'); },
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-1'], selections: [] }));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(ctx.journal.entries.some((e) => /Cursor window did not open: .*ENOENT/.test(e.cmd)));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: partial failure — one bad ticket key does not abort the rest', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({ inferBranchPrefix: async () => 'tech/WEBT-', openCursorWorkspace: async () => ({ ok: true }) });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-1', 'no-number-here'], selections: [],
    }));
    const body = JSON.parse(res.body);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].branch, 'tech/WEBT-1');
    assert.ok(body.results[0].path);
    assert.equal(body.results[1].ticket, 'no-number-here');
    assert.ok(body.results[1].error);
    assert.equal(body.results[1].path, undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: an existing branch/worktree for a ticket is success, not an error — the existing path comes back', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const branch = 'tech/WEBT-1';
    // Deliberately NOT forest's own computed path, to prove the lookup is by
    // branch name (via `git worktree list`), not by re-deriving the path.
    const preWt = join(wtRoot, 'somewhere-else');
    await gitFixture(repo, 'worktree', 'add', '-b', branch, preWt, 'HEAD');
    // git canonicalises symlinks (macOS: /var -> /private/var) when it
    // records a worktree's path, so the value `git worktree list` reports
    // back can differ textually from `preWt` above even though both name
    // the same directory — resolve the expectation the same way rather than
    // asserting byte-for-byte string equality against the un-resolved path.
    const preWtReal = await realpath(preWt);
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({ inferBranchPrefix: async () => 'tech/WEBT-', openCursorWorkspace: async () => ({ ok: true }) });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-1'], selections: [] }));
    const body = JSON.parse(res.body);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].ticket, 'SHBDN-1');
    assert.equal(body.results[0].branch, branch);
    assert.equal(body.results[0].path, preWtReal);
    assert.equal(body.results[0].existed, true);
    assert.ok(body.results[0].briefPath, 'a brief is written for an already-existing worktree too');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: provisions the merged selection and wires the Cursor adapter for the pack offering it', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  const packs = await mkdtemp(join(tmpdir(), 'forest-tix-packs-'));
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-from-jira'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-from-jira', 'SKILL.md'), '# from-jira\n');
  // The Cursor axis is now wired whenever a selected pack ships install.sh
  // (the same gate /api/launch has always used), not by which skill id was
  // picked — so the fixture must actually ship one.
  await writeFile(join(packs, 'hektor', 'install.sh'), '#!/bin/sh\n');
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot, packs });
    const adapterCalls = [];
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      runCursorAdapterInstall: async (args) => { adapterCalls.push(args); return { ok: true, stdout: 'install: done' }; },
    });
    const selections = [{ pack: 'hektor', skills: ['hektor-from-jira'], kits: [], hooks: false }];
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-1'], selections }));
    const body = JSON.parse(res.body);
    assert.equal(body.results[0].cursorAdapterError, undefined);
    const wtPath = body.results[0].path;
    const skillFile = await readFile(join(wtPath, '.claude', 'skills', 'hektor-from-jira', 'SKILL.md'), 'utf8');
    assert.match(skillFile, /from-jira/);
    assert.deepEqual(adapterCalls, [{ packsDir: packs, pack: 'hektor', worktreePath: wtPath, noKits: true }]);
    // The label is worktreeTitle(wtPath) now (ensureProvisioned's own
    // convention, shared with /api/launch), not the raw branch string.
    assert.ok(ctx.journal.entries.some((e) => /cursor adapter wired for WEBT-1/.test(e.cmd)));
    const rec = await readProvisionRecord(wtPath);
    assert.deepEqual(rec.selections, selections, 'the provision record must be written, same as /api/launch');
    assert.deepEqual(rec.cursor.packs, ['hektor'], 'the Cursor axis is recorded so repair can replay it');
    assert.match(rec.cursor.at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: a failing Cursor-adapter install is a per-ticket note, not a failed ticket', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  const packs = await mkdtemp(join(tmpdir(), 'forest-tix-packs2-'));
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-multi-ticket'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-multi-ticket', 'SKILL.md'), '# multi\n');
  // Same reason as the test above: the pack must actually ship install.sh
  // for ensureProvisioned to attempt wiring it at all.
  await writeFile(join(packs, 'hektor', 'install.sh'), '#!/bin/sh\n');
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot, packs });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      runCursorAdapterInstall: async () => ({ error: "hektor/install.sh --harness cursor failed (exit 69): jq is required" }),
    });
    const selections = [{ pack: 'hektor', skills: ['hektor-multi-ticket'], kits: [], hooks: false }];
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-1'], selections }));
    const body = JSON.parse(res.body);
    assert.equal(body.results.length, 1);
    assert.ok(body.results[0].path, 'the worktree itself still exists');
    assert.match(body.results[0].cursorAdapterError, /jq is required/);
    assert.ok(ctx.journal.entries.some((e) => /cursor adapter NOT wired/.test(e.cmd)));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: no pack in the selection offers the required skills — the Cursor-adapter step is skipped silently, not reported as a failure', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    let adapterCalled = false;
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      runCursorAdapterInstall: async () => { adapterCalled = true; return { ok: true }; },
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-1'], selections: [{ pack: 'other-pack', skills: ['some-skill'], kits: [], hooks: false }],
    }));
    const body = JSON.parse(res.body);
    assert.equal(body.results[0].cursorAdapterError, undefined);
    assert.equal(adapterCalled, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: the default adapter runner calls the pack\'s install.sh with --harness cursor --project <wt> --no-kits', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  const packs = await mkdtemp(join(tmpdir(), 'forest-tix-packs3-'));
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-from-jira'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-from-jira', 'SKILL.md'), '# from-jira\n');
  await writeFile(join(packs, 'hektor', 'install.sh'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(packs, 'args.txt'))}\n`);
  await chmod(join(packs, 'hektor', 'install.sh'), 0o755);
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot, packs });
    const handle = createActionHandler({ inferBranchPrefix: async () => 'tech/WEBT-', openCursorWorkspace: async () => ({ ok: true }) });
    const selections = [{ pack: 'hektor', skills: ['hektor-from-jira'], kits: [], hooks: false }];
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-1'], selections }));
    const body = JSON.parse(res.body);
    assert.equal(body.results[0].cursorAdapterError, undefined);
    const args = (await readFile(join(packs, 'args.txt'), 'utf8')).trim().split('\n');
    assert.deepEqual(args, ['--harness', 'cursor', '--project', body.results[0].path, '--no-kits']);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: opening the Cursor window does not block the HTTP response', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    let openStarted = false;
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: () => { openStarted = true; return new Promise(() => {}); }, // never resolves
    });
    const startedAt = Date.now();
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-1'], selections: [] }));
    assert.ok(Date.now() - startedAt < 2000, 'the response must not wait on window-opening');
    assert.equal(res.code, 200);
    assert.equal(openStarted, true, 'the open call must still have been fired');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

// ---- ticket briefs (round: "start working immediately, without crawling
// around" — docs/hektor/tickets/<KEY>.md per worktree) ----

test('/api/tickets/worktrees: the brief assembles heading, Jira link, description, testboxes, and the exact session line — and the worktree stays git-clean', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot }, { jiraBaseUrl: 'https://jira.sahibinden.com', jiraToken: 'pat' });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      fetchIssueDetail: async () => ({ summary: 'Fix the login button', description: 'Steps:\n1. Click login\n2. Observe crash' }),
    });
    const prompt = 'https://jira.sahibinden.com/browse/SHBDN-233021 - tb161 - tb230';
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-233021'], selections: [], boxes: ['tb161', 'tb230'], prompt,
    }));
    const body = JSON.parse(res.body);
    const briefPath = body.results[0].briefPath;
    assert.ok(briefPath.endsWith('docs/hektor/tickets/SHBDN-233021.md'));
    const content = await readFile(briefPath, 'utf8');
    assert.match(content, /^# SHBDN-233021: Fix the login button/m);
    assert.match(content, /Jira: https:\/\/jira\.sahibinden\.com\/browse\/SHBDN-233021/);
    assert.match(content, /Steps:\n1\. Click login\n2\. Observe crash/);
    assert.match(content, /tb161, tb230/);
    assert.match(content, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(content, /## Progress/);
    assert.match(content, /Status: not started/);
    assert.match(content, /- \[ \] Ticket \+ linked tickets read/);
    assert.match(content, /- \[ \] Scenarios distilled/);
    assert.match(content, /- \[ \] Tests written/);
    assert.match(content, /- \[ \] Run on the reserved box/);
    assert.match(content, /- \[ \] Result summarised/);
    assert.match(content, /## Notes/);

    // "It must not pollute git status" — verified, not assumed. Scoped to
    // docs/hektor/ specifically (what THIS check owns) rather than the
    // whole worktree — the per-ticket .cursor/rules/*.mdc file this same
    // round also writes is a SEPARATE concern with its own dedicated test
    // below, and this fixture repo does not set up .cursor/'s exclusion
    // (which the real deployment gets from elsewhere — see writeTicketRule).
    const status = await runGit(body.results[0].path, ['status', '--porcelain', '--', 'docs/hektor']);
    assert.equal(status.trim(), '', 'the brief must not show up as an untracked file');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: a Jira fetch failure degrades the brief\'s description without blocking the ticket', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      fetchIssueDetail: async () => ({ error: 'Jira rejected the credentials (401)' }),
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-1'], selections: [], boxes: [],
    }));
    const body = JSON.parse(res.body);
    assert.equal(body.results[0].error, undefined, 'a Jira failure must not fail the ticket');
    assert.ok(body.results[0].briefPath, 'the brief is still written despite the Jira failure');
    const content = await readFile(body.results[0].briefPath, 'utf8');
    assert.match(content, /description unavailable/);
    assert.match(content, /\(none\)/, 'an empty box list reads as "(none)", not blank');
    assert.match(content, /^# SHBDN-1$/m, 'no summary available — the heading is just the ticket key, no trailing ": "');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: the brief is excluded via .git/info/exclude — confirmed via git status --porcelain, not assumed', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      fetchIssueDetail: async () => ({ error: 'no jira configured' }),
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-1'], selections: [], boxes: [],
    }));
    const body = JSON.parse(res.body);
    const wtPath = body.results[0].path;
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^\/docs\/hektor\/$/m);
    // Scoped to docs/hektor specifically — this fixture repo does NOT set up
    // .cursor/'s exclusion (see the two rule-file tests below for that), so
    // an unscoped check here would also see the (unrelated) rule file.
    const status = await runGit(wtPath, ['status', '--porcelain', '--', 'docs/hektor']);
    assert.equal(status.trim(), '', 'the brief must not appear as untracked');
    assert.ok(!ctx.journal.entries.some((e) => /WARNING:.*docs\/hektor.*not excluded/.test(e.cmd)),
      'no dirty-warning for the brief should be journalled when its exclusion actually worked');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: a second ticket in the same repo does not duplicate the exclude entry', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      fetchIssueDetail: async () => ({ error: 'no jira configured' }),
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-1', 'SHBDN-2'], selections: [], boxes: [],
    }));
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    const matches = exclude.match(/^\/docs\/hektor\/$/gm) || [];
    assert.equal(matches.length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

// ---- per-ticket Cursor rule (round: "deliver the brief without anyone
// pasting it" — .cursor/rules/ticket-<KEY>.mdc, alwaysApply:true) ----

test('/api/tickets/worktrees: writes a per-ticket Cursor rule — frontmatter, alwaysApply true, a pointer to the brief, never restating the Hektor skills', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      fetchIssueDetail: async () => ({ error: 'no jira configured' }),
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-1'], selections: [], boxes: ['tb161', 'tb230'],
    }));
    const body = JSON.parse(res.body);
    const rulePath = body.results[0].rulePath;
    assert.ok(rulePath.endsWith('.cursor/rules/ticket-SHBDN-1.mdc'));
    const content = await readFile(rulePath, 'utf8');
    assert.match(content, /^---\n/);
    assert.match(content, /^description: Ticket SHBDN-1 —.*docs\/hektor\/tickets\/SHBDN-1\.md/m);
    assert.match(content, /^alwaysApply: true$/m);
    assert.match(content, /docs\/hektor\/tickets\/SHBDN-1\.md/);
    assert.match(content, /tech\/WEBT-1/);
    assert.match(content, /tb161, tb230/);
    assert.match(content, /Progress/, 'points at keeping the brief\'s Progress section current');
    // A pointer, not a second copy — must NOT restate the methodology
    // hektor.mdc already routes to.
    assert.ok(!/hektor-from-jira|hektor-multi-ticket|SKILL\.md|hektor-orchestrator/.test(content),
      'must not restate the Hektor methodology — hektor.mdc already routes to it, and a second copy would drift');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: a Cursor rule without a name falls back to "(none reserved)" when no box is held', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      fetchIssueDetail: async () => ({ error: 'no jira configured' }),
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-1'], selections: [], boxes: [],
    }));
    const body = JSON.parse(res.body);
    const content = await readFile(body.results[0].rulePath, 'utf8');
    assert.match(content, /Reserved testbox\(es\): \(none reserved\)/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: .cursor/ NOT already excluded — the rule shows up dirty, and a WARNING is journalled (the safety net actually fires)', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      fetchIssueDetail: async () => ({ error: 'no jira configured' }),
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-1'], selections: [], boxes: [],
    }));
    const body = JSON.parse(res.body);
    const status = await runGit(body.results[0].path, ['status', '--porcelain', '--', '.cursor']);
    assert.notEqual(status.trim(), '', 'sanity check: this fixture really does NOT already exclude .cursor/');
    assert.ok(ctx.journal.entries.some((e) => /WARNING: \.cursor\/rules\/ticket-SHBDN-1\.mdc is not excluded/.test(e.cmd)),
      'a shared exclude that is not actually there must be reported, not silently trusted');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: .cursor/ ALREADY excluded (the real-world case) — the rule is clean, no warning, and forest does not touch the exclude file for it', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    // Simulates what the coordinator observed on a real repo: .cursor/ is
    // ALREADY covered by the repo's shared exclude before this route ever
    // runs (handled elsewhere — not this route's job to write).
    await appendFile(join(repo, '.git', 'info', 'exclude'), '/.cursor/\n');
    const res = fakeRes();
    const ctx = ticketsCtx({ repo, wtRoot });
    const handle = createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ ok: true }),
      fetchIssueDetail: async () => ({ error: 'no jira configured' }),
    });
    await handle({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({
      repoPath: repo, tickets: ['SHBDN-1'], selections: [], boxes: [],
    }));
    const body = JSON.parse(res.body);
    const status = await runGit(body.results[0].path, ['status', '--porcelain', '--', '.cursor']);
    assert.equal(status.trim(), '', 'the rule must not appear as untracked when .cursor/ is already excluded');
    assert.ok(!ctx.journal.entries.some((e) => /WARNING:.*\.cursor.*not excluded/.test(e.cmd)),
      'no warning when the pre-existing exclusion actually held');
    // forest must not have written its own .cursor/ pattern — that exclusion
    // is someone else's to own, per the brief.
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.equal((exclude.match(/\.cursor/g) || []).length, 1, 'forest must not add a second .cursor/ pattern of its own');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

// ---- /api/launch, /api/task: agent choice ----

// A real worktree dir + packs root for the Cursor-axis launch tests: unlike
// WT_PATH, provisioning has to actually write .claude/ here.
async function cursorLaunchFixture() {
  const wt = await tmp('forest-clx-wt-');
  const packs = await tmp('forest-clx-packs-');
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-verify'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-verify', 'SKILL.md'), '# verify\n');
  await writeFile(join(packs, 'hektor', 'install.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(packs, 'hektor', 'install.sh'), 0o755);
  await mkdir(join(packs, 'plain', 'skills', 'tidy'), { recursive: true });
  await writeFile(join(packs, 'plain', 'skills', 'tidy', 'SKILL.md'), '# tidy\n');
  const ctx = {
    config: { packsDir: packs, defaultMode: 'auto', terminalApp: 'Terminal', claudeCmd: 'claude', cursorAgentCmd: '/opt/bin/cursor-agent' },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => ({ repos: [{ repo: 'wt', repoPath: '/r/wt', worktrees: [{ path: wt }] }] }),
    cachedSnapshot: async () => ({ repos: [{ repo: 'wt', repoPath: '/r/wt', worktrees: [{ path: wt }] }] }),
  };
  const cleanup = () => Promise.all([rm(wt, { recursive: true, force: true }), rm(packs, { recursive: true, force: true })]);
  return { wt, packs, ctx, cleanup };
}
const BOTH = [
  { pack: 'hektor', skills: ['hektor-verify'], kits: [], hooks: false },
  { pack: 'plain', skills: ['tidy'], kits: [], hooks: false },
];
const oneMissingGate = async () => ({ active: [], missing: [{ command: '/x/gone.sh', source: '/x/settings.json', file: '/x/gone.sh' }], inline: [], sources: [] });

test('/api/launch: agent must be claude or cursor — anything else is a 400 that mutates nothing', async () => {
  const seen = [];
  const res = fakeRes();
  const ctx = submitCtx();
  await createActionHandler({ launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; }, resolveScope: noRealHome })(
    { url: '/api/launch' }, res, ctx, async () => ({ path: WT_PATH, selections: [], agent: 'gemini' }));
  assert.equal(res.code, 400);
  assert.equal(JSON.parse(res.body).error, "agent must be 'claude' or 'cursor'");
  assert.equal(seen.length, 0);
  assert.equal(ctx.journal.entries.length, 0);
});

test('/api/launch: agent absent means claude, and the response echoes what the launcher actually ran', async () => {
  const seen = [];
  let res = fakeRes();
  await createActionHandler({ launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; }, resolveScope: noRealHome })(
    { url: '/api/launch' }, res, submitCtx(), async () => ({ path: WT_PATH, selections: [] }));
  assert.equal(seen[0].agent, 'claude');
  assert.deepEqual(seen[0].cmds, { claude: 'claude', cursor: 'cursor-agent' }, 'a ctx without the config keys still names a command per agent');
  assert.equal(JSON.parse(res.body).agent, 'claude');
  // Focused: the lock says cursor even though the request said claude — the
  // response names the session that is really there.
  res = fakeRes();
  await createActionHandler({ launch: async () => ({ ok: true, action: 'focused', agent: 'cursor' }), resolveScope: noRealHome })(
    { url: '/api/launch' }, res, submitCtx(), async () => ({ path: WT_PATH, selections: [], agent: 'claude' }));
  assert.equal(JSON.parse(res.body).agent, 'cursor');
});

test('/api/launch: agent cursor wires every selected pack that ships install.sh, skips the Claude gate check, launches the configured cursor command, and journals it', async () => {
  const { wt, packs, ctx, cleanup } = await cursorLaunchFixture();
  try {
    const seen = [], adapterCalls = [];
    const handle = createActionHandler({
      launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; },
      resolveScope: oneMissingGate,
      runCursorAdapterInstall: async (args) => { adapterCalls.push(args); return { ok: true, stdout: '' }; },
    });
    let res = fakeRes();
    await handle({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: BOTH, agent: 'cursor', prompt: 'work A-1' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.agent, 'cursor');
    assert.equal(body.promptSent, true);
    assert.equal(body.cursorAdapter, undefined);
    assert.deepEqual(body.scope, { active: 0, missing: [] }, 'Cursor scope comes from .cursor/hooks.json, not settings.json');
    assert.equal(seen[0].agent, 'cursor');
    assert.equal(seen[0].prompt, 'work A-1');
    assert.deepEqual(seen[0].cmds, { claude: 'claude', cursor: '/opt/bin/cursor-agent' });
    assert.deepEqual(adapterCalls, [{ packsDir: packs, pack: 'hektor', worktreePath: wt, noKits: true }], 'plain ships no install.sh and is skipped silently');
    assert.deepEqual((await readProvisionRecord(wt)).cursor.packs, ['hektor']);
    assert.ok(ctx.journal.entries.some((e) => e.cmd === "/opt/bin/cursor-agent 'work A-1'"), JSON.stringify(ctx.journal.entries));
    assert.ok(ctx.journal.entries.some((e) => /cursor adapter wired for /.test(e.cmd)));

    // The same worktree, same resolver, agent claude: the missing Claude
    // gate DOES block — proving the skip above is per-agent, not removed.
    res = fakeRes();
    await handle({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: BOTH, agent: 'claude' }));
    assert.equal(JSON.parse(res.body).blocked, 'missing-hooks');
  } finally { await cleanup(); }
});

test('/api/launch: a failing Cursor axis is journalled and reported, and the session still launches', async () => {
  const { wt, ctx, cleanup } = await cursorLaunchFixture();
  try {
    const seen = [];
    const res = fakeRes();
    await createActionHandler({
      launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; },
      resolveScope: noRealHome,
      runCursorAdapterInstall: async () => ({ error: 'hektor/install.sh --harness cursor failed (exit 69): jq is required' }),
    })({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: BOTH, agent: 'cursor' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.match(body.cursorAdapter.error, /jq is required/);
    assert.equal(seen.length, 1, 'the window still opens — the user asked for a session, not a gate');
    assert.ok(ctx.journal.entries.some((e) => /cursor adapter NOT wired for /.test(e.cmd)));
    assert.equal((await readProvisionRecord(wt)).cursor, undefined, 'nothing landed, so nothing is recorded');
  } finally { await cleanup(); }
});

test('/api/launch: a runner that THROWS is reported like one that fails — the session still launches', async () => {
  const { wt, ctx, cleanup } = await cursorLaunchFixture();
  try {
    const seen = [];
    const res = fakeRes();
    await createActionHandler({
      launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; },
      resolveScope: noRealHome,
      runCursorAdapterInstall: async () => { throw new Error('spawn ENOENT'); },
    })({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: BOTH, agent: 'cursor' }));
    const body = JSON.parse(res.body);
    assert.equal(res.code, 200);
    assert.equal(body.ok, true);
    assert.match(body.cursorAdapter.error, /hektor\/install\.sh threw: spawn ENOENT/);
    assert.equal(seen.length, 1);
    assert.equal((await readProvisionRecord(wt)).cursor, undefined);
  } finally { await cleanup(); }
});

test('/api/launch: an unwritable provision record is a journalled WARNING, not a 500 and not a "NOT wired" error', async () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores file modes
  const { wt, ctx, cleanup } = await cursorLaunchFixture();
  const recordFile = join(wt, '.claude', '.forest-provision.json');
  try {
    const seen = [];
    const res = fakeRes();
    const handler = createActionHandler({
      launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; },
      resolveScope: noRealHome,
      // A single request: provisioning's OWN writeProvisionRecord call
      // (actions.mjs ~line 1372, ahead of wireCursorAxis) needs the record
      // writable and runs first, so freezing before the request would 500
      // there and never reach wireCursorAxis at all. Freezing from inside
      // this injected install call lands the chmod after that write has
      // already landed and before wireCursorAxis's own read/write of the
      // same file — which is the scenario this test is about.
      runCursorAdapterInstall: async () => { await chmod(recordFile, 0o444); return { ok: true, stdout: '' }; },
    });
    await handler({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: BOTH, agent: 'cursor' }));
    const body = JSON.parse(res.body);
    assert.equal(res.code, 200, res.body);
    assert.equal(body.ok, true);
    // `cursorAdapter` is only spread into the body when truthy (actions.mjs
    // ~line 1446), so a success round-trips as an absent key — `undefined`,
    // not `null` — same convention as the assertion at line ~2549 above.
    assert.equal(body.cursorAdapter, undefined, 'the gates landed — nothing to report as NOT wired');
    assert.equal(seen.length, 1, 'the window still opens');
    assert.ok(ctx.journal.entries.some((e) => /WARNING: Cursor axis wired but not recorded/.test(e.cmd)), JSON.stringify(ctx.journal.entries));
  } finally {
    await chmod(recordFile, 0o644).catch(() => {});
    await cleanup();
  }
});

test('/api/launch: agent cursor with a selection that ships no install.sh runs nothing, and the provision line omits the Cursor axis', async () => {
  const { wt, ctx, cleanup } = await cursorLaunchFixture();
  try {
    const adapterCalls = [];
    const res = fakeRes();
    await createActionHandler({
      launch: async (a) => ({ ok: true, action: 'launched', agent: a.agent }),
      resolveScope: noRealHome,
      runCursorAdapterInstall: async (args) => { adapterCalls.push(args); return { ok: true, stdout: '' }; },
    })({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: [{ pack: 'plain', skills: ['tidy'], kits: [], hooks: false }], agent: 'cursor' }));
    assert.equal(JSON.parse(res.body).ok, true);
    assert.deepEqual(adapterCalls, []);
    // ensureProvisioned (Task 7) folded the old per-call "no pack ships an
    // install.sh" chatter into one provision line that simply omits the
    // "; .cursor/ wired" suffix when no selected pack has an installer —
    // there is no separate message to look for any more.
    assert.ok(ctx.journal.entries.some((e) => e.cmd.startsWith('provision (launch):') && !e.cmd.includes('.cursor/')), JSON.stringify(ctx.journal.entries));
  } finally { await cleanup(); }
});

test('/api/launch: agent cursor with an empty selection runs no installer, and the scope names the missing Cursor gates', async () => {
  const { wt, ctx, cleanup } = await cursorLaunchFixture();
  try {
    await mkdir(join(wt, '.cursor'), { recursive: true });
    await writeFile(join(wt, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: './.cursor/hooks/gone.sh', timeout: 10 }] } }));
    const adapterCalls = [];
    const res = fakeRes();
    await createActionHandler({
      launch: async (a) => ({ ok: true, action: 'launched', agent: a.agent }),
      resolveScope: noRealHome,
      runCursorAdapterInstall: async (args) => { adapterCalls.push(args); return { ok: true, stdout: '' }; },
    })({ url: '/api/launch' }, res, ctx, async () => ({ path: wt, selections: [], agent: 'cursor' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual(adapterCalls, []);
    assert.deepEqual(body.scope, { active: 0, missing: [{ command: './.cursor/hooks/gone.sh', source: join(wt, '.cursor', 'hooks.json') }] });
    assert.ok(ctx.journal.entries.some((e) => /scope: 1 Cursor gate script\(s\) registered but missing/.test(e.cmd)));
  } finally { await cleanup(); }
});

test('/api/task guided: opens the chosen agent in a Terminal and journals its command; a bad agent is a 400', async () => {
  const seen = [];
  let res = fakeRes();
  const ctx = submitCtx();
  const handle = createActionHandler({ launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; } });
  await handle({ url: '/api/task' }, res, ctx, async () => ({ path: WT_PATH, mode: 'guided', agent: 'cursor' }));
  assert.deepEqual(JSON.parse(res.body), { mode: 'guided', agent: 'cursor' });
  assert.equal(seen[0].agent, 'cursor');
  assert.deepEqual(seen[0].cmds, { claude: 'claude', cursor: 'cursor-agent' });
  assert.equal(ctx.journal.entries.at(-1).cmd, 'cursor-agent');
  res = fakeRes();
  await handle({ url: '/api/task' }, res, ctx, async () => ({ path: WT_PATH, mode: 'guided', agent: 'nope' }));
  assert.equal(res.code, 400);
  assert.equal(seen.length, 1);
});

// ---- /api/worktree/scope + /api/worktree/repair: the Cursor axis ----

async function repairFixture({ cursorPacks = null, hooksJson = false } = {}) {
  const wt = await tmp('forest-rep-wt-');
  const packs = await tmp('forest-rep-packs-');
  for (const pack of ['hektor', 'other']) {
    await mkdir(join(packs, pack, 'skills', `${pack}-skill`), { recursive: true });
    await writeFile(join(packs, pack, 'skills', `${pack}-skill`, 'SKILL.md'), `# ${pack}\n`);
    await writeFile(join(packs, pack, 'install.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(packs, pack, 'install.sh'), 0o755);
  }
  await mkdir(join(packs, 'plain', 'skills', 'tidy'), { recursive: true });
  await writeFile(join(packs, 'plain', 'skills', 'tidy', 'SKILL.md'), '# tidy\n');
  const selections = [
    { pack: 'hektor', skills: ['hektor-skill'], kits: [], hooks: false },
    { pack: 'other', skills: ['other-skill'], kits: [], hooks: false },
    { pack: 'plain', skills: ['tidy'], kits: [], hooks: false },
  ];
  await writeProvisionRecord(wt, selections, { kits: [], skills: [] }, null,
    cursorPacks ? { packs: cursorPacks, at: '2026-09-01T00:00:00.000Z' } : null);
  if (hooksJson) {
    await mkdir(join(wt, '.cursor'), { recursive: true });
    await writeFile(join(wt, '.cursor', 'hooks.json'), '{"version":1,"hooks":{}}\n');
  }
  const ctx = {
    config: { packsDir: packs, defaultMode: 'auto' },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => ({ repos: [{ repo: 'wt', repoPath: '/r/wt', worktrees: [{ path: wt }] }] }),
    cachedSnapshot: async () => ({ repos: [{ repo: 'wt', repoPath: '/r/wt', worktrees: [{ path: wt }] }] }),
  };
  const cleanup = () => Promise.all([rm(wt, { recursive: true, force: true }), rm(packs, { recursive: true, force: true })]);
  return { wt, packs, ctx, cleanup };
}
const repairWith = (runCursorAdapterInstall) => createActionHandler({ resolveScope: noRealHome, runCursorAdapterInstall });

test('/api/worktree/repair: replays every recorded Cursor pack with --no-kits and reports the count', async () => {
  const { wt, packs, ctx, cleanup } = await repairFixture({ cursorPacks: ['hektor', 'other'] });
  try {
    const adapterCalls = [];
    const res = fakeRes();
    await repairWith(async (a) => { adapterCalls.push(a); return { ok: true, stdout: '' }; })(
      { url: '/api/worktree/repair' }, res, ctx, async () => ({ path: wt }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.deepEqual(body.cursor, { wired: 2 });
    assert.deepEqual(adapterCalls, [
      { packsDir: packs, pack: 'hektor', worktreePath: wt, noKits: true },
      { packsDir: packs, pack: 'other', worktreePath: wt, noKits: true },
    ]);
    assert.deepEqual((await readProvisionRecord(wt)).cursor.packs, ['hektor', 'other']);
    assert.ok(ctx.journal.entries.some((e) => /repair: .*cursor axis: 2\/2 pack\(s\) re-wired/.test(e.cmd)), JSON.stringify(ctx.journal.entries));
  } finally { await cleanup(); }
});

test('/api/worktree/repair: no Cursor axis recorded and no .cursor/hooks.json → cursor null, no installer runs', async () => {
  const { wt, ctx, cleanup } = await repairFixture();
  try {
    const adapterCalls = [];
    const res = fakeRes();
    await repairWith(async (a) => { adapterCalls.push(a); return { ok: true, stdout: '' }; })(
      { url: '/api/worktree/repair' }, res, ctx, async () => ({ path: wt }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.cursor, null);
    assert.deepEqual(adapterCalls, []);
  } finally { await cleanup(); }
});

test('/api/worktree/repair: legacy — .cursor/hooks.json present but no record slot → replays every recorded pack that ships install.sh and backfills the slot', async () => {
  const { wt, ctx, cleanup } = await repairFixture({ hooksJson: true });
  try {
    const adapterCalls = [];
    const res = fakeRes();
    await repairWith(async (a) => { adapterCalls.push(a); return { ok: true, stdout: '' }; })(
      { url: '/api/worktree/repair' }, res, ctx, async () => ({ path: wt }));
    const body = JSON.parse(res.body);
    assert.deepEqual(body.cursor, { wired: 2 });
    assert.deepEqual(adapterCalls.map((a) => a.pack), ['hektor', 'other'], 'plain has no install.sh — nothing to replay');
    assert.deepEqual((await readProvisionRecord(wt)).cursor.packs, ['hektor', 'other']);
  } finally { await cleanup(); }
});

test('/api/worktree/repair: one installer failing is reported, the other still lands, and the record keeps every pack ever wired', async () => {
  const { wt, ctx, cleanup } = await repairFixture({ cursorPacks: ['hektor', 'other'] });
  try {
    const res = fakeRes();
    await repairWith(async (a) => (a.pack === 'other' ? { error: 'other/install.sh --harness cursor failed (exit 1): boom' } : { ok: true, stdout: '' }))(
      { url: '/api/worktree/repair' }, res, ctx, async () => ({ path: wt }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.cursor.wired, 1);
    assert.match(body.cursor.error, /other\/install\.sh/);
    assert.deepEqual((await readProvisionRecord(wt)).cursor.packs, ['hektor', 'other'], 'a pack whose replay failed is still installed at its old version — do not forget it');
    assert.ok(ctx.journal.entries.some((e) => /cursor adapter NOT wired for /.test(e.cmd)));
  } finally { await cleanup(); }
});

test('/api/worktree/scope: reports the Cursor axis next to the Claude one', async () => {
  const wt = await tmp('forest-scope-');
  try {
    let res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/scope' }, res, submitCtx(), async () => ({ path: wt }));
    assert.deepEqual(JSON.parse(res.body).cursor, { active: 0, missing: [], file: null });
    await mkdir(join(wt, '.cursor'), { recursive: true });
    await writeFile(join(wt, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: './.cursor/hooks/gone.sh', timeout: 10 }] } }));
    res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/scope' }, res, submitCtx(), async () => ({ path: wt }));
    const body = JSON.parse(res.body);
    assert.equal(typeof body.active, 'number', 'the Claude fields are untouched');
    assert.deepEqual(body.cursor, {
      active: 0,
      missing: [{ event: 'beforeShellExecution', command: './.cursor/hooks/gone.sh', file: join(wt, '.cursor', 'hooks', 'gone.sh') }],
      file: join(wt, '.cursor', 'hooks.json'),
    });
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('runSelections with refresh journals every overwritten file by name, capped at ten', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    await mkdir(join(packsDir, 'p', 'skills', 's'), { recursive: true });
    for (let i = 0; i < 12; i++) {
      await writeFile(join(packsDir, 'p', 'skills', 's', `f${String(i).padStart(2, '0')}.md`), 'new\n');
    }
    await mkdir(join(wt, '.claude', 'skills', 's'), { recursive: true });
    for (let i = 0; i < 12; i++) {
      await writeFile(join(wt, '.claude', 'skills', 's', `f${String(i).padStart(2, '0')}.md`), 'old\n');
    }
    const journal = [];
    const ctx = { config: { packsDir }, journal: { add: (e) => journal.push(e) } };
    const out = await runSelections({ ctx, path: wt, selections: [{ pack: 'p', skills: ['s'], kits: [], hooks: false }], mode: 'auto', refresh: true });
    assert.equal(out.updated.length, 12);
    const line = journal.find((e) => e.cmd.startsWith('refresh: overwrote 12 provisioned file(s)'));
    assert.ok(line, `expected a refresh line, got ${JSON.stringify(journal.map((e) => e.cmd))}`);
    assert.ok(line.cmd.includes('.claude/skills/s/f00.md'));
    assert.ok(line.cmd.endsWith('and 2 more'));
    assert.ok(!line.cmd.includes('f11.md'));
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});

test('recordWithout carries fingerprints and auto through untouched', () => {
  const rec = { at: '2026-09-09T00:00:00.000Z', selections: [{ pack: 'p', skills: ['a', 'b'], kits: [], hooks: false }],
    inventory: { kits: [], skills: ['a', 'b'] }, fingerprints: { p: 'abc' }, auto: true };
  const next = recordWithout(rec, [{ kind: 'skill', id: 'b' }]);
  assert.deepEqual(next.fingerprints, { p: 'abc' });
  assert.equal(next.auto, true);
  assert.deepEqual(next.selections, [{ pack: 'p', skills: ['a'], kits: [], hooks: false }]);
});

// ---- managedPath: every mutating route validates the path it acts on ----

function snapCtx({ repos = [], worktreeRoot = '/wtroot' } = {}) {
  const snap = { repos };
  return {
    config: { worktreeRoot, defaultMode: 'auto' },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => snap,
    cachedSnapshot: async () => snap,
  };
}
const REPO = { repo: 'web-test', repoPath: '/r/web-test', worktrees: [{ path: '/wtroot/web-test/tech-WEBT-1' }] };

test('managedPath: a listed repo, a listed worktree, and a pending path under worktreeRoot/<repo>/ are managed', async () => {
  const ctx = snapCtx({ repos: [REPO] });
  assert.deepEqual(await managedPath(ctx, '/r/web-test'), { ok: true, kind: 'repo', repoName: 'web-test', repoPath: '/r/web-test' });
  assert.deepEqual(await managedPath(ctx, '/wtroot/web-test/tech-WEBT-1'), { ok: true, kind: 'worktree', repoName: 'web-test', repoPath: '/r/web-test' });
  assert.deepEqual(await managedPath(ctx, '/wtroot/web-test/tech-WEBT-2'), { ok: true, kind: 'pending', repoName: 'web-test', repoPath: '/r/web-test' });
});

test('managedPath: anything else is refused — foreign dirs, traversal, a pending path for an unlisted repo, non-strings', async () => {
  const ctx = snapCtx({ repos: [REPO] });
  for (const p of ['/etc', '/wtroot/other-repo/x', '/wtroot/web-test/a/b', '/wtroot/web-test/../../etc', 'relative/path', '', null, 42]) {
    assert.equal((await managedPath(ctx, p)).ok, false, `must refuse ${JSON.stringify(p)}`);
  }
});

test('managedPath: a repo record without a name falls back to the directory basename', async () => {
  const ctx = snapCtx({ repos: [{ repoPath: '/r/test-data-client', worktrees: [] }] });
  assert.equal((await managedPath(ctx, '/r/test-data-client')).repoName, 'test-data-client');
  assert.equal((await managedPath(ctx, '/wtroot/test-data-client/x')).kind, 'pending');
});

test('managedPath: a ctx with no snapshot function (unit-test ctx only; server.mjs always provides one) is unverified but allowed', async () => {
  const r = await managedPath({ config: {} }, '/anything');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'unverified');
});

test('mutating routes refuse a path forest does not manage with a 400 and touch nothing', async () => {
  const ctx = snapCtx({ repos: [REPO] });
  let opened = 0;
  const handle = createActionHandler({ launch: async () => { opened++; return { ok: true }; } });
  const cases = [
    ['/api/launch', { path: '/etc', selections: [] }],
    ['/api/task', { path: '/etc', prompt: 'x', mode: 'guided' }],
    ['/api/open', { path: '/etc', target: 'finder' }],
    ['/api/worktree/create', { repoPath: '/etc', branch: 'b', newBranch: true, mode: 'auto' }],
    ['/api/worktree/remove', { repoPath: '/r/web-test', path: '/etc', mode: 'auto' }],
    ['/api/worktree/repair', { path: '/etc' }],
    ['/api/tickets/worktrees', { repoPath: '/etc', tickets: ['SHBDN-1'] }],
    ['/api/git', { path: '/etc', action: 'fetch', mode: 'auto' }],
    ['/api/worktree/remove-units', { path: '/etc', units: [] }],
    ['/api/worktree/apply-diff', { sourcePath: '/wtroot/web-test/tech-WEBT-1', targetPath: '/etc', mode: 'auto' }],
    ['/api/worktree/apply-diff', { sourcePath: '/etc', targetPath: '/wtroot/web-test/tech-WEBT-1', mode: 'auto' }],
    ['/api/worktree/finish', { repoPath: '/r/web-test', path: '/etc', mode: 'auto' }],
    ['/api/worktree/eject', { repoPath: '/etc', mode: 'auto' }],
  ];
  for (const [url, body] of cases) {
    const res = fakeRes();
    await handle({ url }, res, ctx, async () => body);
    assert.equal(res.code, 400, `${url} must refuse`);
    assert.equal(JSON.parse(res.body).error, PATH_ERROR, url);
  }
  assert.equal(opened, 0);
  assert.equal(ctx.journal.entries.length, 0, 'a refused request journals nothing');
});

test('unchangedSince: true only when every fingerprint matches, the record covers the selection, and the Cursor axis is recorded', () => {
  const sel = [{ pack: 'p', skills: ['a', 'b'], kits: ['k'], hooks: true }];
  const rec = { selections: sel, fingerprints: { p: 'abc' }, cursor: { packs: ['p'] } };
  assert.equal(unchangedSince(rec, sel, { p: 'abc' }, ['p']), true);
  assert.equal(unchangedSince(rec, sel, { p: 'abd' }, ['p']), false, 'pack changed');
  assert.equal(unchangedSince(rec, sel, { p: null }, ['p']), false, 'dirty pack never skips');
  assert.equal(unchangedSince({ ...rec, cursor: null }, sel, { p: 'abc' }, ['p']), false, 'cursor axis not wired yet');
  assert.equal(unchangedSince(rec, sel, { p: 'abc' }, []), true, 'no installer, nothing to wire');
  assert.equal(unchangedSince({ ...rec, selections: [{ pack: 'p', skills: ['a'], kits: ['k'], hooks: true }] }, sel, { p: 'abc' }, ['p']), false, 'record misses a skill');
  assert.equal(unchangedSince({ ...rec, selections: [{ pack: 'p', skills: ['a', 'b'], kits: ['k'], hooks: false }] }, sel, { p: 'abc' }, ['p']), false, 'record misses the gates');
  assert.equal(unchangedSince(null, sel, { p: 'abc' }, []), false);
});

// A pack in a git repo with targets, an installer that leaves a marker, and
// a worktree path under worktreeRoot/<repo>/ so managedPath reads it as
// pending. Everything ensureProvisioned touches, in one fixture.
async function autoFixture({ targets = ['web-test'], installer = true } = {}) {
  const root = await tmp('forest-auto-');
  await gitFixture(root, 'init', '-b', 'main');
  await gitFixture(root, 'config', 'user.email', 't@t');
  await gitFixture(root, 'config', 'user.name', 't');
  await gitFixture(root, 'config', 'gc.auto', '0');
  const packs = join(root, 'packs');
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-verify'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-verify', 'SKILL.md'), '# verify\n');
  await writeFile(join(packs, 'hektor', 'catalog.json'), JSON.stringify({
    pack: 'hektor', targets, skillsets: [{ id: 'hektor-verify', label: 'Verify' }], kits: [],
  }));
  if (installer) {
    await writeFile(join(packs, 'hektor', 'install.sh'), '#!/bin/sh\nmkdir -p "$4/.cursor" && echo wired > "$4/.cursor/marker"\n');
    await chmod(join(packs, 'hektor', 'install.sh'), 0o755);
  }
  await gitFixture(root, 'add', '.');
  await gitFixture(root, 'commit', '-m', 'pack');
  const wtRoot = join(root, 'wt');
  const wt = join(wtRoot, 'web-test', 'tech-WEBT-1');
  await mkdir(wt, { recursive: true });
  const snap = { repos: [{ repo: 'web-test', repoPath: '/r/web-test', worktrees: [] }, { repo: 'forest', repoPath: '/r/forest', worktrees: [] }] };
  const ctx = {
    config: { packsDir: packs, worktreeRoot: wtRoot, defaultMode: 'auto', autoProvision: true },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => snap,
    cachedSnapshot: async () => snap,
  };
  return { root, packs, wt, wtRoot, ctx, cleanup: () => rm(root, { recursive: true, force: true }) };
}
// packFingerprint caches per pack dir for two seconds; a test that commits a
// pack change and provisions again inside that window would read the stale
// hash and wrongly skip. Every route test injects an uncached fingerprint.
const FRESH = (packsDir, pack) => packFingerprint(packsDir, pack, { ttlMs: 0 });
const provisionCall = (ctx, body) => {
  const res = fakeRes();
  return createActionHandler({ fingerprint: FRESH })({ url: '/api/worktree/provision' }, res, ctx, async () => body).then(() => res);
};

test('/api/worktree/provision: a targeted repo\'s worktree gets the whole pack on both axes, and a record with fingerprints and auto', async () => {
  const f = await autoFixture();
  try {
    const res = await provisionCall(f.ctx, { path: f.wt });
    assert.equal(res.code, 200, res.body);
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true);
    assert.deepEqual(out.provisioned.skills, ['hektor-verify']);
    assert.deepEqual(out.cursor.wired, ['hektor']);
    assert.equal(out.auto, true);
    assert.match(out.fingerprints.hektor, /^[0-9a-f]{40}$/);
    assert.equal(await readFile(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify\n');
    assert.equal(await readFile(join(f.wt, '.cursor', 'marker'), 'utf8'), 'wired\n');
    const rec = await readProvisionRecord(f.wt);
    assert.equal(rec.auto, true);
    assert.equal(rec.fingerprints.hektor, out.fingerprints.hektor);
    assert.deepEqual(rec.cursor.packs, ['hektor']);
    assert.ok(f.ctx.journal.entries.some((e) => e.cmd.startsWith('provision (provision): 1 skill(s)')));
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: the second call with an unchanged pack is skipped and journals nothing', async () => {
  const f = await autoFixture();
  try {
    await provisionCall(f.ctx, { path: f.wt });
    const before = f.ctx.journal.entries.length;
    const res = await provisionCall(f.ctx, { path: f.wt });
    assert.equal(JSON.parse(res.body).skipped, 'unchanged');
    assert.equal(f.ctx.journal.entries.length, before);
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: a pack edit after the first call provisions again with refresh and names the overwritten file', async () => {
  const f = await autoFixture();
  try {
    await provisionCall(f.ctx, { path: f.wt });
    await writeFile(join(f.packs, 'hektor', 'skills', 'hektor-verify', 'SKILL.md'), '# verify v2\n');
    await gitFixture(f.root, 'add', '.');
    await gitFixture(f.root, 'commit', '-m', 'v2');
    const res = await provisionCall(f.ctx, { path: f.wt });
    assert.equal(JSON.parse(res.body).provisioned.skills.length, 1);
    assert.equal(await readFile(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify v2\n');
    assert.ok(f.ctx.journal.entries.some((e) => e.cmd.includes('refresh: overwrote 1 provisioned file(s): .claude/skills/hektor-verify/SKILL.md')));
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: a dirty pack (null fingerprint) provisions every time', async () => {
  const f = await autoFixture();
  try {
    await writeFile(join(f.packs, 'hektor', 'skills', 'hektor-verify', 'NOTES.md'), 'untracked\n');
    await provisionCall(f.ctx, { path: f.wt });
    const res = await provisionCall(f.ctx, { path: f.wt });
    const out = JSON.parse(res.body);
    assert.equal(out.skipped, undefined);
    assert.equal(out.fingerprints.hektor, null);
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: a repo the pack does not target gets nothing', async () => {
  const f = await autoFixture({ targets: ['test-data-client'] });
  try {
    const res = await provisionCall(f.ctx, { path: f.wt });
    assert.equal(JSON.parse(res.body).skipped, 'nothing to provision');
    await assert.rejects(stat(join(f.wt, '.claude')));
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: autoProvision: false skips the automatic path', async () => {
  const f = await autoFixture();
  try {
    f.ctx.config.autoProvision = false;
    const res = await provisionCall(f.ctx, { path: f.wt });
    // Only reachable on the automatic path (an explicit selection is honoured
    // even with autoProvision off), so `auto` must read true here.
    assert.deepEqual(JSON.parse(res.body), { ok: true, skipped: 'autoProvision off', auto: true });
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: the automatic selection never orphans a unit from an earlier partial record', async () => {
  const f = await autoFixture();
  try {
    // A second skill added to the catalog after the prior record was
    // written — the record is now genuinely partial (names only one of the
    // two skills the automatic selection now picks), so the guard has
    // something real to not-block on.
    await mkdir(join(f.packs, 'hektor', 'skills', 'hektor-conventions'), { recursive: true });
    await writeFile(join(f.packs, 'hektor', 'skills', 'hektor-conventions', 'SKILL.md'), '# conventions\n');
    await writeFile(join(f.packs, 'hektor', 'catalog.json'), JSON.stringify({
      pack: 'hektor', targets: ['web-test'], skillsets: [{ id: 'hektor-verify', label: 'Verify' }, { id: 'hektor-conventions', label: 'Conventions' }], kits: [],
    }));
    await gitFixture(f.root, 'add', '.');
    await gitFixture(f.root, 'commit', '-m', 'two skills');
    await writeProvisionRecord(f.wt, [{ pack: 'hektor', skills: ['hektor-verify'], kits: [], hooks: false }], { kits: [], skills: ['hektor-verify'] });
    const res = await provisionCall(f.ctx, { path: f.wt });
    const out = JSON.parse(res.body);
    assert.equal(out.blocked, undefined);
    assert.equal(out.ok, true, res.body);
    const rec = await readProvisionRecord(f.wt);
    assert.deepEqual(rec.inventory.skills.sort(), ['hektor-conventions', 'hektor-verify']);
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: a path that is not managed is a 400; a managed path that does not exist yet is a 409', async () => {
  const f = await autoFixture();
  try {
    let res = await provisionCall(f.ctx, { path: '/etc' });
    assert.equal(res.code, 400);
    res = await provisionCall(f.ctx, { path: join(f.wtRoot, 'web-test', 'not-yet') });
    assert.equal(res.code, 409);
    assert.equal(JSON.parse(res.body).error, 'worktree directory does not exist yet');
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: an installer failure is reported and journaled, the Claude axis still lands', async () => {
  const f = await autoFixture();
  try {
    await writeFile(join(f.packs, 'hektor', 'install.sh'), '#!/bin/sh\necho boom >&2; exit 3\n');
    await gitFixture(f.root, 'add', '.');
    await gitFixture(f.root, 'commit', '-m', 'broken installer');
    const res = await provisionCall(f.ctx, { path: f.wt });
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true);
    assert.match(out.cursor.error, /install\.sh --harness cursor failed \(exit 3\): boom/);
    assert.equal(await readFile(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify\n');
    assert.ok(f.ctx.journal.entries.some((e) => e.cmd.includes('cursor adapter NOT wired')));
  } finally { await f.cleanup(); }
});

test('/api/launch without a selections key provisions the automatic selection on both axes, then launches', async () => {
  const f = await autoFixture();
  try {
    const seen = [];
    const res = fakeRes();
    await createActionHandler({ launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; }, resolveScope: noRealHome })(
      { url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'claude' }));
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true, res.body);
    assert.equal(out.provision.auto, true);
    assert.deepEqual(out.provisioned.skills, ['hektor-verify']);
    assert.equal(await readFile(join(f.wt, '.cursor', 'marker'), 'utf8'), 'wired\n', 'a CLAUDE launch still wires the Cursor axis');
    assert.equal(seen.length, 1);
  } finally { await f.cleanup(); }
});

test('/api/launch with an explicit selection provisions exactly that and records auto: false', async () => {
  const f = await autoFixture();
  try {
    const res = fakeRes();
    await createActionHandler({ launch: async (a) => ({ ok: true, action: 'launched', agent: a.agent }), resolveScope: noRealHome })(
      { url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'cursor', selections: [{ pack: 'hektor', skills: ['hektor-verify'], kits: [], hooks: false }] }));
    assert.equal(JSON.parse(res.body).provision.auto, false);
    assert.equal((await readProvisionRecord(f.wt)).auto, false);
  } finally { await f.cleanup(); }
});

test('/api/launch with selections: [] (the missing-hooks retry) provisions nothing and still launches', async () => {
  const f = await autoFixture();
  try {
    const res = fakeRes();
    await createActionHandler({ launch: async (a) => ({ ok: true, action: 'launched', agent: a.agent }), resolveScope: noRealHome })(
      { url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'claude', selections: [], force: true }));
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true);
    assert.equal(out.provision.skipped, 'nothing to provision');
    await assert.rejects(stat(join(f.wt, '.claude')));
  } finally { await f.cleanup(); }
});

test('/api/task provisions the automatic selection before opening the Terminal', async () => {
  const f = await autoFixture();
  try {
    const seen = [];
    const res = fakeRes();
    await createActionHandler({ launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; } })(
      { url: '/api/task' }, res, f.ctx, async () => ({ path: f.wt, mode: 'guided', agent: 'cursor', prompt: 'x' }));
    assert.deepEqual(JSON.parse(res.body), { mode: 'guided', agent: 'cursor' });
    assert.equal(await readFile(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify\n');
    const idx = f.ctx.journal.entries.findIndex((e) => e.cmd.startsWith('provision (task)'));
    assert.ok(idx >= 0);
    assert.ok(idx < f.ctx.journal.entries.length - 1, 'provisioning is journaled before the launch line');
  } finally { await f.cleanup(); }
});

// ---- Task 9: provision at creation (auto and guided), and in the ticket
// route ----

test('provisionNotifyCommand posts the worktree path back to forest as JSON, shell-quoted', () => {
  const cmd = provisionNotifyCommand({ port: 5577, path: "/Users/me/.forest/wt/web-test/it's" });
  assert.equal(cmd, `curl -s -X POST -H 'content-type: application/json' --data '{"path":"/Users/me/.forest/wt/web-test/it'\\''s"}' http://127.0.0.1:5577/api/worktree/provision`);
});

test('/api/worktree/create auto: the new worktree is provisioned before the response returns', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  const f = await autoFixture();
  try {
    const ctx = ticketsCtx({ repo, wtRoot, packs: f.packs });
    ctx.config.autoProvision = true;
    // Target the fixture repo by its directory name.
    await writeFile(join(f.packs, 'hektor', 'catalog.json'), JSON.stringify({
      pack: 'hektor', targets: [basename(repo)], skillsets: [{ id: 'hektor-verify', label: 'Verify' }], kits: [],
    }));
    await gitFixture(f.root, 'add', '.');
    await gitFixture(f.root, 'commit', '-m', 'retarget');
    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/create' }, res, ctx, async () => ({
      repoPath: repo, branch: 'tech/WEBT-9', newBranch: true, mode: 'auto',
    }));
    const out = JSON.parse(res.body);
    assert.equal(out.mode, 'auto');
    assert.deepEqual(out.provision.provisioned.skills, ['hektor-verify']);
    const wt = join(wtRoot, basename(repo), 'tech-WEBT-9');
    assert.equal(await readFile(join(wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify\n');
    assert.equal(await readFile(join(wt, '.cursor', 'marker'), 'utf8'), 'wired\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
    await f.cleanup();
  }
});

test('/api/worktree/create guided: the Terminal command ends with the provision notify, and nothing is provisioned yet', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const ctx = ticketsCtx({ repo, wtRoot }, { port: 5599 });
    const seen = [];
    const res = fakeRes();
    await createActionHandler({ runTerminal: async (a) => { seen.push(a); return { ok: true }; } })({ url: '/api/worktree/create' }, res, ctx, async () => ({
      repoPath: repo, branch: 'tech/WEBT-9', newBranch: true, mode: 'guided',
    }));
    const out = JSON.parse(res.body);
    assert.equal(out.mode, 'guided');
    assert.equal(out.provisioning, 'on first launch or when the Terminal command finishes');
    assert.equal(seen.length, 1);
    const wt = join(wtRoot, basename(repo), 'tech-WEBT-9');
    assert.ok(seen[0].command.startsWith("git 'worktree' 'add'"), seen[0].command);
    assert.ok(seen[0].command.endsWith(` && ${provisionNotifyCommand({ port: 5599, path: wt })}`), seen[0].command);
    await assert.rejects(stat(wt), 'guided mode runs git in the Terminal, not here');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/worktree/create guided: with autoProvision false, no notify clause is appended and the response does not promise provisioning', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const ctx = ticketsCtx({ repo, wtRoot }, { port: 5599, autoProvision: false });
    const seen = [];
    const res = fakeRes();
    await createActionHandler({ runTerminal: async (a) => { seen.push(a); return { ok: true }; } })({ url: '/api/worktree/create' }, res, ctx, async () => ({
      repoPath: repo, branch: 'tech/WEBT-9', newBranch: true, mode: 'guided',
    }));
    const out = JSON.parse(res.body);
    assert.equal(out.mode, 'guided');
    assert.equal(out.provisioning, 'off (autoProvision is false)');
    assert.equal(seen.length, 1);
    assert.ok(!seen[0].command.includes('&& curl'), seen[0].command);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: with no selections the ticket worktree gets the automatic selection on both axes', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  const f = await autoFixture();
  try {
    await writeFile(join(f.packs, 'hektor', 'catalog.json'), JSON.stringify({
      pack: 'hektor', targets: [basename(repo)], skillsets: [{ id: 'hektor-verify', label: 'Verify' }], kits: [],
    }));
    await gitFixture(f.root, 'add', '.');
    await gitFixture(f.root, 'commit', '-m', 'retarget');
    const ctx = ticketsCtx({ repo, wtRoot, packs: f.packs });
    const res = fakeRes();
    await createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ cli: true, ok: true, workspaceFile: '/x', foldersAdded: 1, briefsOpened: 0 }),
      fetchIssueDetail: async () => ({ error: 'offline' }),
    })({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-7'] }));
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true, res.body);
    const r = out.results[0];
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(await readFile(join(r.path, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify\n');
    assert.equal(await readFile(join(r.path, '.cursor', 'marker'), 'utf8'), 'wired\n');
    assert.equal((await readProvisionRecord(r.path)).auto, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
    await f.cleanup();
  }
});

// ---- Final fix wave: Important #1 — force must always re-provision ----

test('/api/launch: "Launch anyway" (force) after the orphan dialog re-provisions the subset and rewrites the record, so the next launch is not blocked again', async () => {
  const f = await autoFixture();
  try {
    // Two skills in the catalog so a subset exists.
    await mkdir(join(f.packs, 'hektor', 'skills', 'hektor-conventions'), { recursive: true });
    await writeFile(join(f.packs, 'hektor', 'skills', 'hektor-conventions', 'SKILL.md'), '# conventions\n');
    await writeFile(join(f.packs, 'hektor', 'catalog.json'), JSON.stringify({
      pack: 'hektor', targets: ['web-test'], skillsets: [{ id: 'hektor-verify', label: 'Verify' }, { id: 'hektor-conventions', label: 'Conventions' }], kits: [],
    }));
    await gitFixture(f.root, 'add', '.');
    await gitFixture(f.root, 'commit', '-m', 'two skills');
    const handle = createActionHandler({ launch: async (a) => ({ ok: true, action: 'launched', agent: a.agent }), resolveScope: noRealHome, fingerprint: FRESH });
    const full = [{ pack: 'hektor', skills: ['hektor-verify', 'hektor-conventions'], kits: [], hooks: false }];
    const subset = [{ pack: 'hektor', skills: ['hektor-verify'], kits: [], hooks: false }];
    let res = fakeRes();
    await handle({ url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'claude', selections: full }));
    assert.equal(JSON.parse(res.body).ok, true, res.body);
    res = fakeRes();
    await handle({ url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'claude', selections: subset }));
    assert.equal(JSON.parse(res.body).blocked, 'orphaned-units');
    res = fakeRes();
    await handle({ url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'claude', selections: subset, force: true }));
    const forced = JSON.parse(res.body);
    assert.equal(forced.ok, true, res.body);
    assert.equal(forced.provision.skipped, undefined, 'force must provision, never skip');
    const rec = await readProvisionRecord(f.wt);
    assert.deepEqual(rec.selections[0].skills, ['hektor-verify'], 'the record now lists the subset');
    assert.deepEqual(rec.inventory.skills, ['hektor-verify']);
    res = fakeRes();
    await handle({ url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'claude', selections: subset }));
    assert.equal(JSON.parse(res.body).blocked, undefined, 'the next un-forced launch of the same subset is not blocked');
  } finally { await f.cleanup(); }
});

// The web-test case end to end: a hardened file under .claude/ must not turn a
// launch into "provision failed". The provision goes through, the launch
// proceeds, and the journal names the file that was kept.
test('/api/launch: a hardened (read-only) provisioned file is kept and journaled; the launch still happens', async () => {
  const f = await autoFixture();
  try {
    await mkdir(join(f.wt, '.claude', 'skills', 'hektor-verify'), { recursive: true });
    await writeFile(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), '# hardened local copy\n');
    await chmod(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 0o444);
    let launched = 0;
    const res = fakeRes();
    await createActionHandler({ launch: async (a) => { launched++; return { ok: true, action: 'launched', agent: a.agent }; }, resolveScope: noRealHome, fingerprint: FRESH })(
      { url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'claude' }));
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true, res.body);
    assert.equal(launched, 1);
    assert.equal(out.provisioned.conflicts.length, 1);
    assert.equal(out.provisioned.conflicts[0].reason, 'unwritable');
    assert.equal(await readFile(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# hardened local copy\n');
    const line = f.ctx.journal.entries.find((e) => e.cmd.startsWith('refresh skipped:'));
    assert.ok(line, `expected a "refresh skipped" journal line, got ${JSON.stringify(f.ctx.journal.entries.map((e) => e.cmd))}`);
    assert.ok(line.cmd.includes('.claude/skills/hektor-verify/SKILL.md'));
    assert.ok(line.cmd.includes('not writable'));
  } finally {
    await chmod(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 0o644).catch(() => {});
    await f.cleanup();
  }
});
