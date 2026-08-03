import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('launchDecision: missing hooks block the launch and are reported', async () => {
  const d = await launchDecision({
    path: '/w', force: false,
    resolveScope: scopeWith([H('"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"')]),
    readRecord: async () => ({ selections: [{ pack: 'hektor', kits: ['flaky-triage-kit'] }] }),
  });
  assert.equal(d.launch, false);
  assert.equal(d.blocked, 'missing-hooks');
  assert.equal(d.missing.length, 1);
  assert.equal(d.missing[0].command, '"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"');
  assert.equal(d.repairable, true, 'a record that still names a kit can have its installer re-run');
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

// The false promise this fix round exists for: after Remove, the record still
// has a non-empty selections list — the old meaning of `repairable` — but the
// unit whose installer wrote the dangling registration is no longer in it, so
// repair re-provisions the others and the missing count never moves.
test('launchDecision: repairable is false when the record names only skills', async () => {
  const d = await launchDecision({
    path: '/w', force: false,
    resolveScope: scopeWith([H('"x/gate.sh"')]),
    readRecord: async () => ({ selections: [{ pack: 'hektor', skills: ['hektor-verify'], kits: [] }] }),
  });
  assert.equal(d.launch, false);
  assert.equal(d.repairable, false,
    'repair replays the selections, and provisioning a skill writes .claude/skills/<id>/ and nothing else — it can never rewrite a hook registration');
});

test('launchDecision: repairable is true for a record that provisions the pack gates', async () => {
  const d = await launchDecision({
    path: '/w', force: false,
    resolveScope: scopeWith([H('"x/gate.sh"')]),
    readRecord: async () => ({ selections: [{ pack: 'hektor', skills: [], kits: [], hooks: true }] }),
  });
  assert.equal(d.repairable, true, 'forest writes the pack gate set itself, so repair can rewrite it');
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
  await mkdir(join(wt, '.claude', 'kits', 'k', 'core'), { recursive: true });
  await writeFile(join(wt, '.claude', 'kits', 'k', 'core', 'x.sh'), 'x\n');
  const res = fakeRes();
  await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
    { config: {}, journal: { add() {} }, broadcast() {} },
    async () => ({ path: wt, units: [{ kind: 'kit', id: 'k' }] }));
  assert.deepEqual(JSON.parse(res.body).removed, ['kit:k']);
  await assert.rejects(() => stat(join(wt, '.claude', 'kits', 'k')));
});

test('remove-units refuses a root-owned kit and changes nothing', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-'));
  await mkdir(join(wt, '.claude', 'kits', 'k'), { recursive: true });
  await writeFile(join(wt, '.claude', 'kits', 'k', 'x.sh'), 'x\n');
  await chmod(join(wt, '.claude', 'kits'), 0o500);          // parent not writable: unlink refused
  const res = fakeRes();
  await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
    { config: {}, journal: { add() {} }, broadcast() {} },
    async () => ({ path: wt, units: [{ kind: 'kit', id: 'k' }] }));
  await chmod(join(wt, '.claude', 'kits'), 0o700);          // restore so the tmpdir can be cleaned
  const body = JSON.parse(res.body);
  assert.deepEqual(body.removed, []);
  assert.equal(body.refused.length, 1);
  assert.match(body.refused[0].reason, /root-owned|hardened|permission/i);
  await stat(join(wt, '.claude', 'kits', 'k', 'x.sh'));     // still there
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
      { kits: ['k'], skills: ['s'] });
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
  } finally {
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
    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
      { config: {}, journal: { add() {} }, broadcast() {} },
      async () => ({ path: wt, units: [{ kind: 'kit', id }] }));
    const body = JSON.parse(res.body);
    assert.deepEqual(body.removed, [], 'a traversal id must never resolve to a path');
    assert.equal(body.refused.length, 1, 'a rejected unit must be reported, not silently dropped');
    await assertTraversalFixtureIntact(wt);
  });
}

test('remove-units rejects an id that is not a plain name', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-'));
  const res = fakeRes();
  await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
    { config: {}, journal: { add() {} }, broadcast() {} },
    async () => ({ path: wt, units: [{ kind: 'kit', id: '../../etc' }] }));
  assert.deepEqual(JSON.parse(res.body).removed, [], 'a traversal id must never resolve to a path');
});

test('remove-units folds a malformed unit into refused instead of dropping it silently', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-'));
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
