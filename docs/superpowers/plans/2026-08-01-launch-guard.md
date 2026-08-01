# Launch Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop forest from launching a Claude session into a worktree whose registered hook scripts are missing, without ever repairing the worktree unasked.

**Architecture:** `/api/launch` resolves session scope *before* launching instead of after, and returns `blocked: "missing-hooks"` with a `repairable` flag rather than opening a terminal. The picker turns that into a confirm offering "Repair, then launch" or "Launch anyway"; both re-call `/api/launch` with `force: true`.

**Tech Stack:** Node built-ins (`node:test`, `node:assert/strict`), vanilla DOM.

## Global Constraints

- **Zero dependencies.** Node built-ins only — nothing added to `package.json`.
- **Forest never mutates a worktree without a yes.** Repair runs only on explicit confirmation.
- **`force: true` is the only way to launch past the guard**, so the block cannot be bypassed by accident.
- **`repairable` is `readProvisionRecord(path) !== null`** — repair returns 409 `no provision record` without one (`lib/actions.mjs:181-184`).
- **The existing badge and 🩹 button are untouched** (`public/app.js:51`, `:88`).
- **The agent does not commit** (project rule `never-commit`). Each task ends by handing the working tree back.
- **Reference spec:** `docs/superpowers/specs/2026-08-01-stale-hook-registration-design.md` (Part 2 only; Part 1 is a separate repo and a separate plan)

---

## File Structure

- **Modify: `lib/actions.mjs:281-304`** — the `/api/launch` block: scope check moves ahead of `launchInteractive`, new `blocked` response, new `force` flag.
- **Modify: `lib/actions.test.mjs`** — the decision logic, with `launchInteractive` stubbed.
- **Modify: `public/app.js:556-573`** — `startPicker`'s response handling gains the blocked branch.

No new files. `lib/packs.mjs`, `lib/session-scope.mjs` and the repair endpoint are unchanged.

---

### Task 1: Make the launch decision testable

`/api/launch` currently calls `launchInteractive` directly (`lib/actions.mjs:296`), which opens a real Terminal window — untestable. Extract the decision so it can be tested without launching anything, changing no behaviour yet.

**Files:**
- Modify: `lib/actions.mjs:281-304`
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: `resolveSessionScope(path)` from `./session-scope.mjs`, `readProvisionRecord(path)` from `./packs.mjs` (both already imported).
- Produces: `export async function launchDecision({ path, force, resolveScope, readRecord })` returning `{ launch: true }` or `{ launch: false, blocked: 'missing-hooks', missing: [{command, source}], repairable: boolean }`.

- [ ] **Step 1: Write the failing test**

Append to `lib/actions.test.mjs` (the file already imports `test`, `assert`, and from `./actions.mjs`; extend that import to include `launchDecision`):

```js
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test lib/actions.test.mjs`
Expected: FAIL — `launchDecision is not a function`.

- [ ] **Step 3: Add `launchDecision` to `lib/actions.mjs`**

Place it above `createActionHandler`, beside the exported `worktreeTitle` helper:

```js
// Whether a launch may proceed. Injectable dependencies so the decision is
// testable without opening a Terminal window.
// A failure to resolve scope deliberately allows the launch: this guard exists
// to warn about missing gates, and must never become the reason forest cannot
// start a session.
export async function launchDecision({ path, force = false, resolveScope = resolveSessionScope, readRecord = readProvisionRecord }) {
  if (force) return { launch: true };
  let scope;
  try { scope = await resolveScope(path); } catch { return { launch: true }; }
  if (!scope?.missing?.length) return { launch: true };
  const record = await readRecord(path).catch(() => null);
  return {
    launch: false,
    blocked: 'missing-hooks',
    missing: scope.missing.map((h) => ({ command: h.command, source: h.source })),
    repairable: !!(record && Array.isArray(record.selections) && record.selections.length),
  };
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `node --test lib/actions.test.mjs`
Expected: PASS, 5 new tests.

- [ ] **Step 5: Prove the tests can fail (mutation check)**

Temporarily change `if (!scope?.missing?.length) return { launch: true };` to `return { launch: true };`. Re-run: the blocking tests must fail. Revert the mutation.

Expected: 3 failures while mutated, all green after reverting. A guard whose tests pass against a no-op guard is worthless.

- [ ] **Step 6: Hand back**

Do not commit. Report `launchDecision` added and tested; `/api/launch` not yet wired to it, so behaviour is unchanged.

---

### Task 2: Wire the guard into `/api/launch`

**Files:**
- Modify: `lib/actions.mjs:281-304`
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: `launchDecision` (Task 1).
- Produces: `/api/launch` accepting `force` in the body and returning the blocked payload.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test lib/actions.test.mjs`
Expected: FAIL on the first assertion — the route does not mention `launchDecision`.

- [ ] **Step 3: Rewrite the route body**

Replace lines 295-303 of `lib/actions.mjs` (from `ctx.journal.add({ cmd: 'claude', ... })` through the closing `sendJson`) with:

```js
        // Check BEFORE opening a terminal: a session loads its hook config at
        // start, so a worktree whose gates are missing produces a session that
        // silently runs ungated. Warning after the launch (which is what this
        // did) is too late to act on.
        const decision = await launchDecision({ path, force: !!body.force });
        if (!decision.launch) {
          ctx.journal.add({ cmd: `launch blocked: ${decision.missing.length} hook script(s) registered but missing`, cwd: path, mode });
          return sendJson(res, { ok: false, ...decision, provisioned });
        }

        ctx.journal.add({ cmd: 'claude', cwd: path, mode: 'guided' });
        const r = await launchInteractive({ worktreePath: path, app: ctx.config.terminalApp, title: worktreeTitle(path) });
        const scope = await resolveSessionScope(path);
        if (scope.missing.length) {
          ctx.journal.add({ cmd: `scope: ${scope.missing.length} hook script(s) registered but missing`, cwd: path, mode });
        }
        return r && r.ok
          ? sendJson(res, { ok: true, action: r.action, provisioned, scope: { active: scope.active.length, missing: scope.missing.map((h) => ({ command: h.command, source: h.source })) } })
          : sendJson(res, { error: (r && r.error) || 'failed to open Terminal' }, 500);
```

The `provisioned` result rides along on the blocked response so the picker can still report what it installed before the block.

- [ ] **Step 4: Run and watch it pass**

Run: `node --test lib/actions.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 165 tests (160 + 5 from Task 1). No existing test drives `/api/launch`, so nothing else should move.

- [ ] **Step 6: Hand back**

Do not commit. Report the route now blocks on missing hooks and honours `force`.

---

### Task 3: The picker dialog

**Files:**
- Modify: `public/app.js:556-573` (`startPicker`'s response handling)

**Interfaces:**
- Consumes: the blocked payload from Task 2; the existing `api()` helper (`app.js:10`), `toast()`, and `openPicker(path)`.
- Produces: nothing.

- [ ] **Step 1: Insert the blocked branch**

In `startPicker`, immediately after `const r = await api('/api/launch', ...)` and `btn.disabled = false`, before the existing `if (!r || !r.ok)` line, insert:

```js
  if (r && r.blocked === 'missing-hooks') {
    const names = r.missing
      .map((h) => (h.command.match(/([^/"']+\.sh)/) || [, h.command])[1])
      .filter((v, i, a) => a.indexOf(v) === i);
    const list = names.map((n) => `    ${n}`).join('\n');
    if (!r.repairable) {
      alert(
        `Launch blocked — ${r.missing.length} registered hook script(s) missing:\n\n${list}\n\n`
        + 'The gates are not running. Forest cannot repair this worktree: it has no '
        + 'provision record, so there is nothing to re-provision from. Pick packs in '
        + 'the launcher to provision it, or fix the wiring by hand.',
      );
      btn.disabled = false;
      return;
    }
    const repair = confirm(
      `Launch Claude with ${r.missing.length} hook script(s) missing?\n\n${list}\n\n`
      + 'The gates are not running.\n\n'
      + 'OK — repair first (re-runs the kit\'s installer), then launch.\n'
      + 'Cancel — launch anyway.',
    );
    if (repair) {
      const rep = await api('/api/worktree/repair', { path, mode: state.mode });
      if (!rep || rep.error) { toast(`Repair failed: ${(rep && rep.error) || 'server unreachable'}`); return; }
      toast(`Repaired · ${rep.scope.active} hooks active, ${rep.scope.missing} missing`);
    }
    const forced = await api('/api/launch', { path, selections: [], mode: state.mode, force: true });
    if (!forced || !forced.ok) { toast(`Launch failed: ${(forced && forced.error) || 'server unreachable'}`); return; }
    closePicker();
    toast(forced.action === 'focused' ? 'Claude already running — Terminal brought to front' : 'Launching Claude…');
    return;
  }
```

The forced re-launch sends `selections: []` deliberately — provisioning already ran on the first call, and re-sending the selections would provision twice.

- [ ] **Step 2: Verify the clean path is unchanged**

Run `bin/forest restart > /dev/null 2>&1 &`, wait for the port, open http://127.0.0.1:5577, and launch Claude into any worktree forest reports with `missing 0` (`web-test`'s `tech/WEBT-251473` qualifies). Close the Terminal window that opens.

Expected: no dialog, Terminal opens, the usual "Launching Claude…" toast.

- [ ] **Step 3: Verify the blocked path against a real broken worktree**

Build one rather than waiting for a kit to break. In a scratch worktree, register a hook whose script does not exist:

```bash
WT=$(mktemp -d)/wt   # any dir forest lists; simplest is a throwaway repo added via + repo
mkdir -p "$WT/.claude"
cat > "$WT/.claude/settings.json" <<'JSON'
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
  { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/does-not-exist.sh\"", "timeout": 10 } ] } ] } }
JSON
curl -s -X POST http://127.0.0.1:5577/api/worktree/scope -H 'content-type: application/json' -d "{\"path\":\"$WT\"}"
```

Expected: the scope call reports `missing` with one entry. Then launching that worktree from the UI must show the dialog naming `does-not-exist.sh`, and Cancel must still open the Terminal.

- [ ] **Step 4: Full suite and hand back**

Run: `npm test`
Expected: PASS, unchanged from Task 2 — no JS test covers `public/`.
Do not commit. Report both paths verified in the browser.

---

## Self-Review

**Spec coverage (Part 2 only):** scope check moved before the launch → Task 2. `blocked: "missing-hooks"` payload with `missing` and `repairable` → Task 1. `force: true` bypass → Tasks 1-2. Repair-then-launch and launch-anyway → Task 3. `repairable: false` falling back to the picker message → Task 3 Step 1. Badge and 🩹 button untouched → no task modifies `app.js:51` or `:88`. Part 1 (the kit forwarder) is deliberately absent: different repo, separate plan.

**Placeholder scan:** no TBD/TODO. Every code step carries literal code; every verification step carries the command and expected result.

**Type consistency:** `launchDecision({ path, force, resolveScope, readRecord })` returning `{ launch }` or `{ launch, blocked, missing, repairable }` is used identically in Tasks 1, 2 and 3. `missing` entries are `{ command, source }` throughout — Task 3 parses the filename out of `command`, and does not assume a `file` field, which `resolveSessionScope` exposes but `/api/launch` does not forward.

**One deliberate design choice worth re-stating:** a scope resolver that throws allows the launch (Task 1, Step 3). A guard that can make forest unable to start a session is worse than the problem it guards against; the test at Task 1 Step 1 pins that behaviour so it cannot be "fixed" into strictness by accident.

**Known deviation:** no commit steps, per the project's `never-commit` rule.
