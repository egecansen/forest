import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { worktreeTitle, runSelections, launchDecision, orphanedUnits, createActionHandler } from './actions.mjs';
import { writeProvisionRecord, readProvisionRecord } from './packs.mjs';
import { resolveSessionScope } from './session-scope.mjs';

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
