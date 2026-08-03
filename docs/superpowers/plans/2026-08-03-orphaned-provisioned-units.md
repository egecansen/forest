# Orphaned Provisioned Units Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a worktree from silently running a kit or skill that forest no longer manages, by making the provision record say what was written and having the launch guard compare that against the incoming selection.

**Architecture:** `writeProvisionRecord` gains an `inventory` of what provisioning actually produced. A new pure function `orphanedUnits(previousRecord, selections)` compares a previous inventory against an incoming selection. `/api/launch` reads the previous record **before** provisioning overwrites it, and returns the existing `blocked` payload with a second reason. A new route deletes orphans on request. Forest still deletes nothing without a yes.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert/strict`, no build step, no TypeScript. Run the suite with `npm test`.

## Global Constraints

- **Plain ESM, no TypeScript** — no type annotations, no `.ts`, no build step.
- **Tests use `node:test` and `node:assert/strict`**, matching the existing files.
- **Every filesystem fixture lives under `mktemp -d`** (`mkdtemp(join(tmpdir(), …))`), never in a real worktree and never in `.forest/`.
- **No test may open a Terminal.** `launchInteractive` opens a real window; any test that reaches it is a defect in the test.
- **No real `chown`** — a bare `chown root` needs a password nobody can answer in a test run. The root-owned case is driven with `chmod`.
- **`missing-hooks` outranks `orphaned-units`** when both conditions hold.
- **A failure to resolve state allows the launch.** The guard warns about gates; it must never become the reason forest cannot start a session (`lib/actions.mjs:28-30`).
- **Forest never mutates a worktree without a yes** — settled 2026-08-01, not up for reversal in this plan.
- **No AI trailers in commit messages** — no `Co-Authored-By`, no "Generated with", no session link.
- **Baseline suite is 168 passed, 0 failed** on `2f94526`. Derive and state your own total.
- **Mutation is the only accepted evidence for a new assertion**: show it applied, and show it produced the state the assertion names.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `lib/packs.mjs` | Provisioning and the provision record | `writeProvisionRecord` gains `inventory` |
| `lib/actions.mjs` | Route handling, the launch guard | `orphanedUnits`, ordering, payload, remove route, injectable `launch` |
| `public/app.js` | Client | the `orphaned-units` branch and its three actions |
| `lib/packs.test.mjs` | Record tests | inventory round-trip |
| `lib/actions.test.mjs` | Guard and route tests | orphan detection, ordering, priority, remove |

---

### Task 1: The provision record records what was written

**Files:**
- Modify: `lib/packs.mjs:243-248` (`writeProvisionRecord`)
- Test: `lib/packs.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `writeProvisionRecord(worktreePath, selections, inventory = null)` → the record path. When `inventory` is `null` or omitted, the key is absent from the file rather than written as `null`. `readProvisionRecord(worktreePath)` is unchanged and returns the parsed object, so `record.inventory` is `undefined` for a record written without one.

- [ ] **Step 1: Write the failing tests**

Append to `lib/packs.test.mjs`:

```js
test('writeProvisionRecord persists the inventory of what was written', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-inv-'));
  await writeProvisionRecord(wt, [{ pack: 'hektor', kits: ['flaky-triage-kit'] }],
    { kits: ['flaky-triage-kit'], skills: ['hektor-verify'] });
  const rec = await readProvisionRecord(wt);
  assert.deepEqual(rec.inventory, { kits: ['flaky-triage-kit'], skills: ['hektor-verify'] });
});

test('writeProvisionRecord omits the inventory key when there is none', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-inv-'));
  await writeProvisionRecord(wt, [{ pack: 'hektor' }]);
  const raw = await readFile(join(wt, '.claude', '.forest-provision.json'), 'utf8');
  assert.ok(!raw.includes('inventory'), 'a null inventory must not be written as a key');
  const rec = await readProvisionRecord(wt);
  assert.equal(rec.inventory, undefined, 'an old record reads back with no inventory');
});
```

If `mkdtemp`, `tmpdir`, `join`, `readFile` or `writeProvisionRecord`/`readProvisionRecord` are not already imported at the top of `lib/packs.test.mjs`, add them:

```js
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test 2>&1 | grep -A3 "inventory"`
Expected: FAIL — `rec.inventory` is `undefined` in the first test, because `writeProvisionRecord` ignores the third argument.

- [ ] **Step 3: Implement**

Replace `lib/packs.mjs:243-248` with:

```js
// `selections` is what the user asked for. `inventory` is what provisioning
// actually produced — they diverge the moment a unit is deselected, and the
// launch guard needs the second one to notice a unit left behind.
export async function writeProvisionRecord(worktreePath, selections, inventory = null) {
  const file = join(worktreePath, '.claude', PROVISION_FILE);
  await mkdir(dirname(file), { recursive: true });
  const rec = { at: new Date().toISOString(), selections };
  if (inventory) rec.inventory = inventory;
  await writeFile(file, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, and the previously-passing record tests still pass — the third parameter is optional, so every existing caller is unaffected.

- [ ] **Step 5: Mutation — prove the second assertion is not decorative**

Change `if (inventory) rec.inventory = inventory;` to `rec.inventory = inventory;` and re-run.
Expected: *"a null inventory must not be written as a key"* reddens, and nothing else does.
Revert, confirm the file is byte-identical (`git diff --stat lib/packs.mjs` shows only the intended change), re-run green.

- [ ] **Step 6: Commit**

```bash
git add lib/packs.mjs lib/packs.test.mjs
git commit -m "feat(packs): the provision record carries what was written

The record listed what was selected, and the launch guard needs what was
installed. They diverge the moment a unit is deselected."
```

---

### Task 2: `orphanedUnits`

**Files:**
- Modify: `lib/actions.mjs` — add the function immediately after `launchDecision` (which ends at `:44`)
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: the record shape from Task 1 — `{ at, selections, inventory?: { kits: string[], skills: string[] } }`.
- Produces: `orphanedUnits(previousRecord, selections)` → `Array<{ kind: 'kit' | 'skill', id: string, since: string }>`. Synchronous and pure: no filesystem, no `ctx`. `kind` is the singular `'kit'` or `'skill'`. `since` is `previousRecord.at`. Returns `[]` for a null record, a record with no `inventory`, or a selection that still names every unit.

- [ ] **Step 1: Write the failing tests**

Append to `lib/actions.test.mjs`, and add `orphanedUnits` to the existing import from `./actions.mjs`:

```js
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
  assert.deepEqual(orphanedUnits({ at: 'x', selections: [] }, []), [],
    'every record written before this feature has no inventory — it must not read as all-orphaned');
});

test('orphanedUnits: no record reports nothing', () => {
  assert.deepEqual(orphanedUnits(null, [{ pack: 'hektor' }]), []);
});

test('orphanedUnits: a unit selected under a DIFFERENT pack still counts as selected', () => {
  const o = orphanedUnits(REC({ kits: ['k'], skills: [] }), [{ pack: 'other', kits: ['k'] }]);
  assert.deepEqual(o, [], 'the inventory is not keyed by pack, so neither is the comparison');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test 2>&1 | grep -i "orphanedUnits"`
Expected: FAIL — `orphanedUnits is not a function` / not exported.

- [ ] **Step 3: Implement**

Insert after `launchDecision` in `lib/actions.mjs`:

```js
// Units the previous provision wrote that the incoming selection no longer
// names. Provisioning is additive, so a deselected unit stays on disk,
// registered and running, at whatever version it had — and because the launch
// route overwrites the record with the new selection, it also stops being
// visible to `/api/worktree/repair`, which re-provisions from `rec.selections`.
//
// Pure and synchronous on purpose: it compares two records and touches nothing.
// `launchDecision` answers a different question from different inputs (the
// worktree's current disk state), so the two stay separate.
export function orphanedUnits(previousRecord, selections = []) {
  const inv = previousRecord?.inventory;
  if (!inv) return [];
  const picked = (key) => new Set(selections.flatMap((s) => s?.[key] || []));
  const out = [];
  for (const [key, kind] of [['kits', 'kit'], ['skills', 'skill']]) {
    const still = picked(key);
    for (const id of inv[key] || []) {
      if (!still.has(id)) out.push({ kind, id, since: previousRecord.at });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Mutation — prove the migration guard is load-bearing**

Change `if (!inv) return [];` to `const safe = inv || { kits: [], skills: [] };` and use `safe` throughout.
Expected: *"a record with no inventory reports nothing"* stays green — so that mutation proves nothing. Now instead change the guard to `const inv = previousRecord?.inventory || { kits: previousRecord?.selections?.flatMap((s) => s.kits || []) || [], skills: [] };` (inferring an inventory from the old selections).
Expected: *"a record with no inventory reports nothing"* reddens.
Revert and re-run green. Record both attempts in your report: the first mutation is an **equivalent mutant** and saying so is the honest result, not a failure.

- [ ] **Step 6: Commit**

```bash
git add lib/actions.mjs lib/actions.test.mjs
git commit -m "feat(actions): orphanedUnits compares an inventory against a selection

A unit the previous provision wrote and the new selection drops stays on
disk, registered and running, and disappears from the record that repair
reads."
```

---

### Task 3: The launch route detects orphans, in the right order

This is the task that breaks silently. The previous record must be read **before** `runSelections` runs and `writeProvisionRecord` overwrites it. Read it after and the comparison is the new selection against itself: always empty, always green, guard inert.

Testing that behaviourally requires the route to complete without opening a Terminal, so `launchInteractive` becomes injectable. That is why this task touches `createActionHandler`'s signature.

**Files:**
- Modify: `lib/actions.mjs:71` (`createActionHandler`), `:303-335` (the `/api/launch` block)
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: `orphanedUnits` (Task 2), `writeProvisionRecord(path, selections, inventory)` (Task 1).
- Produces: `createActionHandler({ launch = launchInteractive } = {})` — existing zero-argument callers are unaffected. `/api/launch` returns `{ ok: false, blocked: 'orphaned-units', orphaned: [...], repairable: boolean }` when orphans exist and no hook is missing.

- [ ] **Step 1: Write the failing tests**

Append to `lib/actions.test.mjs`:

```js
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
  assert.equal(opened, false, 'a blocked launch must not open a terminal');
});

test('/api/launch reads the previous record BEFORE provisioning overwrites it', async () => {
  const { wt, packs } = await orphanFixture();
  const res = fakeRes();
  const ctx = { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} };
  await createActionHandler({ launch: async () => ({ ok: true }) })(
    { url: '/api/launch' }, res, ctx,
    async () => ({ path: wt, selections: [{ pack: 'hektor', skills: ['hektor-verify'] }] }),
  );
  assert.equal(JSON.parse(res.body).blocked, 'orphaned-units',
    'reading the record after writeProvisionRecord compares the new selection against itself');
  const rec = await readProvisionRecord(wt);
  assert.deepEqual(rec.inventory.skills, ['hektor-verify'], 'the new record still gets written');
});

test('/api/launch: force launches despite orphans', async () => {
  const { wt, packs } = await orphanFixture();
  const res = fakeRes();
  let opened = false;
  const ctx = { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} };
  await createActionHandler({ launch: async () => { opened = true; return { ok: true, action: 'x' }; } })(
    { url: '/api/launch' }, res, ctx,
    async () => ({ path: wt, selections: [{ pack: 'hektor', skills: ['hektor-verify'] }], force: true }),
  );
  assert.equal(opened, true, 'force must reach the terminal');
});
```

Add to the imports at the top of `lib/actions.test.mjs` whatever is not already there:

```js
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeProvisionRecord, readProvisionRecord } from './packs.mjs';
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test 2>&1 | grep -B2 -A6 "orphaned-units"`
Expected: FAIL — `createActionHandler` takes no options, and the route returns no `blocked: 'orphaned-units'`.

- [ ] **Step 3: Implement**

Change the signature at `lib/actions.mjs:71`:

```js
// `launch` is injectable so the ordering in /api/launch can be tested without
// opening a real Terminal window.
export function createActionHandler({ launch = launchInteractive } = {}) {
```

Inside that function, replace every `launchInteractive(` call with `launch(`.

Then replace the `/api/launch` block at `:303-335` with:

```js
      if (url === '/api/launch') {
        const { path, selections = [] } = body;
        const sel = selections.filter((s) => s && s.pack && ((s.skills?.length) || (s.kits?.length) || s.hooks));

        // BEFORE provisioning: writeProvisionRecord below replaces this record
        // with `sel`, so reading it afterwards would compare `sel` to itself.
        const previous = await readProvisionRecord(path).catch(() => null);
        const orphaned = orphanedUnits(previous, sel);

        let provisioned = null;
        if (sel.length) {
          try {
            provisioned = await runSelections({ ctx, path, selections: sel, mode });
            await writeProvisionRecord(path, sel, { kits: provisioned.kits, skills: provisioned.skills });
            const n = provisioned.skills.length, k = provisioned.kits.length;
            ctx.journal.add({ cmd: `provision: ${n} skill(s)${k ? `, ${k} kit(s)` : ''}${provisioned.hooks ? ', gates' : ''} → .claude/`, cwd: path, mode });
          } catch (e) {
            return sendJson(res, { error: `provision failed: ${e}` }, 500);
          }
        }
        // Check BEFORE opening a terminal: a session loads its hook config at
        // start, so a worktree whose gates are missing produces a session that
        // silently runs ungated. Warning after the launch (which is what this
        // did) is too late to act on.
        const decision = await launchDecision({ path, force: !!body.force });
        if (!decision.launch) {
          ctx.journal.add({ cmd: `launch blocked: ${decision.missing.length} hook script(s) registered but missing`, cwd: path, mode });
          return sendJson(res, { ok: false, ...decision, provisioned });
        }
        // A registered-but-absent gate is a live hole; an orphan is a stale unit
        // that still runs. If both hold, the hole is reported first.
        if (orphaned.length && !body.force) {
          const names = orphaned.map((o) => o.id).join(', ');
          ctx.journal.add({ cmd: `launch blocked: ${orphaned.length} provisioned unit(s) no longer selected (${names})`, cwd: path, mode });
          return sendJson(res, {
            ok: false, blocked: 'orphaned-units', orphaned,
            repairable: !!(previous && Array.isArray(previous.selections) && previous.selections.length),
            provisioned,
          });
        }

        ctx.journal.add({ cmd: 'claude', cwd: path, mode: 'guided' });
        const r = await launch({ worktreePath: path, app: ctx.config.terminalApp, title: worktreeTitle(path) });
        const scope = await resolveSessionScope(path);
        if (scope.missing.length) {
          ctx.journal.add({ cmd: `scope: ${scope.missing.length} hook script(s) registered but missing`, cwd: path, mode });
        }
        return r && r.ok
          ? sendJson(res, { ok: true, action: r.action, provisioned, scope: { active: scope.active.length, missing: scope.missing.map((h) => ({ command: h.command, source: h.source })) } })
          : sendJson(res, { error: (r && r.error) || 'failed to open Terminal' }, 500);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, including the pre-existing `/api/launch consults launchDecision before launching` source-order test at `lib/actions.test.mjs:174`.

- [ ] **Step 5: Mutation — the ordering, which is the point of this task**

Move the two lines

```js
        const previous = await readProvisionRecord(path).catch(() => null);
        const orphaned = orphanedUnits(previous, sel);
```

to immediately **after** the `if (sel.length) { … }` block and re-run.

Expected: *"/api/launch reads the previous record BEFORE provisioning overwrites it"* reddens, and so does *"/api/launch blocks on a unit the new selection dropped"*. Both fail because the record now names `hektor-verify` and nothing else, so the dropped kit is invisible.

Revert, confirm `git diff` shows only the intended change, re-run green.

- [ ] **Step 6: Second mutation — the priority rule**

Swap the two blocks so the `orphaned` check runs before the `decision.launch` check, then add a fixture where both hold. If no existing test distinguishes them, that is a gap: write

```js
test('/api/launch reports the missing gate, not the orphan, when both hold', async () => {
  const { wt, packs } = await orphanFixture();
  await mkdir(join(wt, '.claude'), { recursive: true });
  await writeFile(join(wt, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${join(wt, '.claude', 'hooks', 'gone.sh')}"` }] }] } }));
  const res = fakeRes();
  const ctx = { config: { packsDir: packs, defaultMode: 'auto' }, journal: { add() {} }, broadcast() {} };
  await createActionHandler({ launch: async () => ({ ok: true }) })(
    { url: '/api/launch' }, res, ctx,
    async () => ({ path: wt, selections: [{ pack: 'hektor', skills: ['hektor-verify'] }] }),
  );
  assert.equal(JSON.parse(res.body).blocked, 'missing-hooks',
    'a registered-but-absent gate is a live hole and outranks a stale unit');
});
```

Expected with the blocks swapped: this test reddens. Revert and re-run green.

- [ ] **Step 7: Commit**

```bash
git add lib/actions.mjs lib/actions.test.mjs
git commit -m "feat(launch): block on a provisioned unit that is no longer selected

The previous record is read before provisioning replaces it — read it
after and the comparison is the new selection against itself, which is
always empty and always green.

launchInteractive becomes injectable so that ordering can be tested
without opening a Terminal."
```

---

### Task 4: Removing an orphan

**Files:**
- Modify: `lib/actions.mjs` — a new route beside `/api/worktree/repair` (`:199`)
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: the orphan shape from Task 2 — `{ kind, id, since }`.
- Produces: `POST /api/worktree/remove-units` with body `{ path, units: [{ kind, id }] }` → `{ ok: true, removed: string[], refused: [{ id, reason }] }`. A kit removes `.claude/kits/<id>/`; a skill removes `.claude/skills/<id>/`. Registrations are not touched.

There is no uninstall path to call — no kit ships one and forest's manifest has no concept of it. Removal is a directory deletion and nothing more. Two consequences, both reported rather than hidden:

- A **hardened** kit's files are root-owned, so deletion fails with `EPERM`. Report it in the kit's own vocabulary; change nothing. Unlocking needs the user's password and is their decision.
- Removing a kit's files without its registration produces exactly the `missing-hooks` state the existing guard catches. That is the intended handoff, and Task 5's copy says so.

- [ ] **Step 1: Write the failing tests**

```js
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

test('remove-units rejects an id that is not a plain name', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'forest-rm-'));
  const res = fakeRes();
  await createActionHandler()({ url: '/api/worktree/remove-units' }, res,
    { config: {}, journal: { add() {} }, broadcast() {} },
    async () => ({ path: wt, units: [{ kind: 'kit', id: '../../etc' }] }));
  assert.deepEqual(JSON.parse(res.body).removed, [], 'a traversal id must never resolve to a path');
});
```

Add `stat`, `chmod` and `rm` to the `node:fs/promises` import in the test file.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test 2>&1 | grep -i "remove-units"`
Expected: FAIL — the route does not exist, so `res.body` is whatever the handler's fallback returns.

- [ ] **Step 3: Implement**

Insert beside the repair route in `lib/actions.mjs`:

```js
      if (url === '/api/worktree/remove-units') {
        const { path, units = [] } = body;
        const removed = [], refused = [];
        for (const u of units) {
          if (!u || !safeId(u.id) || (u.kind !== 'kit' && u.kind !== 'skill')) continue;
          const dir = join(path, '.claude', u.kind === 'kit' ? 'kits' : 'skills', u.id);
          try {
            await rm(dir, { recursive: true, force: false });
            removed.push(`${u.kind}:${u.id}`);
            ctx.journal.add({ cmd: `removed ${u.kind} ${u.id} from .claude/`, cwd: path, mode });
          } catch (e) {
            // A hardened kit is root-owned; deleting it needs the password the
            // user holds. The kit's own installer says this in these words.
            refused.push({ id: u.id, reason: e.code === 'EPERM' || e.code === 'EACCES'
              ? `${u.id} is root-owned (hardened) — unlock it first, this changes nothing`
              : String(e.message || e) });
          }
        }
        return sendJson(res, { ok: true, removed, refused });
      }
```

Add `rm` to the `node:fs/promises` import at the top of `lib/actions.mjs`. `safeId` already exists in `lib/packs.mjs` — import it if `lib/actions.mjs` does not already.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Mutation — prove the traversal guard**

Delete `!safeId(u.id) ||` from the guard and re-run.
Expected: *"remove-units rejects an id that is not a plain name"* reddens.
Revert, re-run green.

- [ ] **Step 6: Commit**

```bash
git add lib/actions.mjs lib/actions.test.mjs
git commit -m "feat(actions): remove an orphaned unit on request

A directory deletion and nothing more — no kit ships an uninstall path.
A root-owned kit is refused in the kit's own words and nothing changes."
```

---

### Task 5: The client offers the three choices

**Files:**
- Modify: `public/app.js:583` (the `blocked` branch), `:623` (the existing `force: true` call)

**Interfaces:**
- Consumes: `{ blocked: 'orphaned-units', orphaned: [{ kind, id, since }], repairable }` from Task 3, and `POST /api/worktree/remove-units` from Task 4.
- Produces: no new exports.

- [ ] **Step 1: Read the existing branch**

Run: `sed -n '575,635p' public/app.js`

Match its idiom exactly — the same dialog helper, the same `api()` wrapper, the same re-launch call. Do not introduce a second dialog style.

- [ ] **Step 2: Add the branch**

Beside the existing `if (r && r.blocked === 'missing-hooks')` case:

```js
  if (r && r.blocked === 'orphaned-units') {
    const list = r.orphaned.map((o) => `  • ${o.kind} ${o.id} (since ${o.since.slice(0, 10)})`).join('\n');
    const choice = await choose(
      `${r.orphaned.length} unit(s) are installed here but no longer selected:\n\n${list}\n\n` +
      `They still run, at the version they had when they were last provisioned.`,
      ['Update', 'Remove', 'Launch anyway', 'Cancel'],
    );
    if (choice === 'Cancel') return;
    if (choice === 'Update') {
      const sel = withUnitsAdded(state.selections, r.orphaned);
      return launchWith(path, sel);
    }
    if (choice === 'Remove') {
      const rm = await api('/api/worktree/remove-units', { path, units: r.orphaned.map(({ kind, id }) => ({ kind, id })) });
      if (rm.refused?.length) {
        await notify(rm.refused.map((f) => f.reason).join('\n'));
      }
      if (rm.removed?.length) {
        await notify(
          `Removed ${rm.removed.join(', ')}.\n\n` +
          `Their harness registrations are still in place and now point at files that are gone — ` +
          `the next launch will block on that and offer to rewrite them. Removing is a two-step path.`,
        );
      }
      return launchWith(path, state.selections);
    }
    const forced = await api('/api/launch', { path, selections: state.selections, mode: state.mode, force: true });
    return handleLaunchResult(forced);
  }
```

`withUnitsAdded(selections, orphans)` puts each orphan's id back into the first selection entry whose `pack` matches, or into a new entry when none does:

```js
function withUnitsAdded(selections, orphans) {
  const out = selections.map((s) => ({ ...s, kits: [...(s.kits || [])], skills: [...(s.skills || [])] }));
  for (const o of orphans) {
    const key = o.kind === 'kit' ? 'kits' : 'skills';
    const target = out[0] || (out.push({ pack: state.pack, kits: [], skills: [] }), out[0]);
    if (!target[key].includes(o.id)) target[key].push(o.id);
  }
  return out;
}
```

If `choose`, `notify`, `launchWith`, `handleLaunchResult` or `state.pack` do not exist under those names in `public/app.js`, use the file's actual equivalents — read them in Step 1 and keep the structure, not the invented names.

- [ ] **Step 3: Verify by hand**

Run: `npm start`, open the UI, and launch a worktree whose `.forest-provision.json` has an `inventory` naming a unit the checkboxes do not. Confirm the dialog lists it, that **Update** re-launches with it selected, and that **Launch anyway** opens the terminal.

There is no browser test harness in this repo, so this step is manual. Say so in your report rather than claiming coverage you do not have.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: unchanged — `public/app.js` is not covered by `node:test`.

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): offer update, remove or launch-anyway for an orphaned unit

Remove says plainly that the registration outlives the files and that the
next launch will block on it — a two-step path by construction."
```

---

## Self-Review

**Spec coverage.** §1 the record's inventory → Task 1. §2 `orphanedUnits` → Task 2. §3 the ordering → Task 3, Step 5, with its own mutation. §4 the blocked payload and the `missing-hooks` priority → Task 3, Steps 3 and 6. §5 the client and the remove route → Tasks 4 and 5, including the "two-step path" copy the spec demands and the `EPERM` refusal. §6 the journal line → Task 3, Step 3. "What this does not do" needs no task — it records limits, and the migration limit is asserted by Task 2's *"a record with no inventory reports nothing"*. Testing items 1-9 map to Tasks 1-4. No gaps.

**Placeholder scan.** No TBD/TODO. Every code step carries the code. Task 5, Step 2 names four client helpers conditionally because `public/app.js` was not read while writing this plan — Step 1 makes reading it the first action, and the instruction is to use the file's real names rather than these. That is a deliberate, bounded instruction, not a placeholder.

**Type consistency.** `orphanedUnits(previousRecord, selections)` returns `{ kind, id, since }` in Task 2 and is consumed under those exact names in Tasks 3, 4 and 5. `kind` is singular `'kit'`/`'skill'` everywhere. `writeProvisionRecord(path, selections, inventory)` is defined in Task 1 and called with three arguments in Task 3. `removed` is `string[]` of `"kind:id"` in Task 4 and joined as such in Task 5. `createActionHandler({ launch })` is defined in Task 3 and used in Task 4's tests with no arguments, which the default makes valid.

**One deliberate scope addition.** Task 3 makes `launchInteractive` injectable, which the spec does not mention. Without it the ordering requirement — the spec's own §3, the thing it says breaks silently — can only be pinned by a source-text assertion like the existing one at `lib/actions.test.mjs:174`, and a text match is a proxy for the behaviour, not the behaviour. The injection is three lines and buys a real test.
