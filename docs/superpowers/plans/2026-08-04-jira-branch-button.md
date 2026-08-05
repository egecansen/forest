# "Branch → Jira" Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A button in the worktree drawer that writes the worktree's branch name into the Jira ticket's "Git Branch Name" text field, read-before-write.

**Architecture:** A new write helper in `lib/jira.mjs` (same conventions as `fetchSummary`: injectable fetch, never throws), one new POST route in `lib/actions.mjs` with the helper injectable into `createActionHandler`, a config key gating the whole feature, and a button in the description panel of `public/app.js`.

**Tech Stack:** Plain Node (`node:test` + `node:assert/strict` for tests), no dependencies, vanilla-JS frontend.

Spec: `docs/superpowers/specs/2026-08-04-jira-branch-button-design.md`

## Global Constraints

- **Never run `git commit` or `git push`.** The user commits themselves — every task ends with files left uncommitted plus a suggested message.
- No new npm dependencies.
- Error strings are actionable sentences shown verbatim in the drawer (name the fix, not just the failure) — the `lib/jira.mjs` house rule.
- The Jira field ID (`customfield_10041`) lives only in the user's local `config.json`, never in code or `config.example.json`.
- Run tests with `node --test lib/<file>.test.mjs` per task, `npm test` at the end.

---

### Task 1: Config key `jiraBranchFieldId`

**Files:**
- Modify: `lib/config.mjs` (DEFAULTS block, lines 25–33 area)
- Modify: `config.example.json`
- Test: `lib/config.test.mjs`

**Interfaces:**
- Produces: `config.jiraBranchFieldId` (string, default `''`, env `FOREST_JIRA_BRANCH_FIELD`) — read by Task 3's route and, via `/api/config`, by Task 4's button gating. Not a secret: must NOT be added to `SECRET_KEYS`.

- [ ] **Step 1: Write the failing test** (append to `lib/config.test.mjs`)

```js
test('jiraBranchFieldId: defaults empty, overridable from config.json', () => {
  assert.equal(mergeConfig({}).jiraBranchFieldId, '');
  assert.equal(mergeConfig({ jiraBranchFieldId: 'customfield_10041' }).jiraBranchFieldId, 'customfield_10041');
});
```

(If the file does not already import `mergeConfig`, add it to the existing import from `./config.mjs`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/config.test.mjs`
Expected: FAIL — `mergeConfig({}).jiraBranchFieldId` is `undefined`, not `''`.

- [ ] **Step 3: Implement** — in `lib/config.mjs`, after the `jiraEmail` line in `DEFAULTS`:

```js
  // The org's "which branch implements this ticket" text field, e.g.
  // customfield_10041. Empty = the drawer's Branch → Jira button is absent.
  jiraBranchFieldId: process.env.FOREST_JIRA_BRANCH_FIELD || '',
```

And in `config.example.json`, after `"jiraEmail": "",`:

```json
  "jiraBranchFieldId": "",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/config.test.mjs`
Expected: PASS (all existing tests too).

- [ ] **Step 5: Hand off (no commit)** — suggested message for the user: `feat(config): jiraBranchFieldId gates the Branch → Jira button`

---

### Task 2: `submitBranchField` in `lib/jira.mjs`

**Files:**
- Modify: `lib/jira.mjs`
- Test: `lib/jira.test.mjs`

**Interfaces:**
- Consumes: existing module-private `trimSlashes`, `authHeader`.
- Produces: `export async function submitBranchField(key, branch, { baseUrl, token, email, fieldId, force = false, fetchImpl = fetch, timeoutMs = 5000 } = {})` → `{ ok: true, already?: true } | { conflict: string } | { error: string }`. Never throws. Task 3 injects and calls exactly this signature.

- [ ] **Step 1: Write the failing tests** (append to `lib/jira.test.mjs`; the `STATUS` fixture already exists above)

```js
// ---- submitBranchField ----

const CFG = { baseUrl: 'https://jira.sahibinden.com', token: 'pat-123', fieldId: 'customfield_10041' };
const FIELD = (value) => async () => ({
  ok: true, status: 200, json: async () => ({ fields: { customfield_10041: value } }),
});
// A fetch that answers the read with `value`, then records the write.
function readThenWrite(value, calls) {
  return async (url, opts) => {
    calls.push({ url, opts });
    if (!opts.method) return FIELD(value)();
    return { ok: true, status: 204, json: async () => ({}) };
  };
}

test('submitBranchField: empty field → GET then PUT with the branch in the payload', async () => {
  const calls = [];
  const r = await submitBranchField('SHBDN-226230', 'tech/WEBT-226230', { ...CFG, fetchImpl: readThenWrite(null, calls) });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://jira.sahibinden.com/rest/api/2/issue/SHBDN-226230?fields=customfield_10041');
  assert.equal(calls[0].opts.method, undefined);
  assert.equal(calls[1].url, 'https://jira.sahibinden.com/rest/api/2/issue/SHBDN-226230');
  assert.equal(calls[1].opts.method, 'PUT');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer pat-123');
  assert.equal(calls[1].opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].opts.body), { fields: { customfield_10041: 'tech/WEBT-226230' } });
});

test('submitBranchField: field already holds the branch → no write', async () => {
  const calls = [];
  const r = await submitBranchField('SHBDN-1', 'tech/WEBT-1', { ...CFG, fetchImpl: readThenWrite('tech/WEBT-1', calls) });
  assert.deepEqual(r, { ok: true, already: true });
  assert.equal(calls.length, 1, 'an equal value must not be re-written');
});

test('submitBranchField: a different value without force → conflict, no write', async () => {
  const calls = [];
  const r = await submitBranchField('SHBDN-1', 'tech/WEBT-1', { ...CFG, fetchImpl: readThenWrite('tech/OLD-9', calls) });
  assert.deepEqual(r, { conflict: 'tech/OLD-9' });
  assert.equal(calls.length, 1, 'a conflict must not overwrite');
});

test('submitBranchField: force overwrites a different value', async () => {
  const calls = [];
  const r = await submitBranchField('SHBDN-1', 'tech/WEBT-1', { ...CFG, force: true, fetchImpl: readThenWrite('tech/OLD-9', calls) });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 2);
});

test('submitBranchField: a whitespace-only field counts as empty', async () => {
  const calls = [];
  const r = await submitBranchField('SHBDN-1', 'tech/WEBT-1', { ...CFG, fetchImpl: readThenWrite('   ', calls) });
  assert.deepEqual(r, { ok: true });
});

test('submitBranchField: unconfigured pieces are named, not thrown', async () => {
  assert.match((await submitBranchField('SHBDN-1', 'b', { ...CFG, baseUrl: '' })).error, /jiraBaseUrl/);
  assert.match((await submitBranchField('SHBDN-1', 'b', { ...CFG, token: '' })).error, /jiraToken/);
  assert.match((await submitBranchField('SHBDN-1', 'b', { ...CFG, fieldId: '' })).error, /jiraBranchFieldId/);
  assert.match((await submitBranchField(null, 'b', CFG)).error, /ticket/);
  assert.match((await submitBranchField('SHBDN-1', '', CFG)).error, /branch/);
});

test('submitBranchField: read failures use the fetchSummary sentences', async () => {
  assert.match((await submitBranchField('SHBDN-1', 'b', { ...CFG, fetchImpl: STATUS(401) })).error, /credentials.*401/);
  assert.match((await submitBranchField('SHBDN-9', 'b', { ...CFG, fetchImpl: STATUS(404) })).error, /SHBDN-9 not found/);
});

test('submitBranchField: a failed write is reported too', async () => {
  const impl = async (url, opts) => (opts.method ? STATUS(500)() : FIELD(null)());
  assert.match((await submitBranchField('SHBDN-1', 'b', { ...CFG, fetchImpl: impl })).error, /500/);
});

test('submitBranchField: timeout and network errors become sentences', async () => {
  const abort = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  assert.match((await submitBranchField('SHBDN-1', 'b', { ...CFG, fetchImpl: abort })).error, /timed out/);
  const down = async () => { throw new Error('getaddrinfo ENOTFOUND jira'); };
  assert.match((await submitBranchField('SHBDN-1', 'b', { ...CFG, fetchImpl: down })).error, /ENOTFOUND/);
});
```

Also add `submitBranchField` to the import at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/jira.test.mjs`
Expected: FAIL — `submitBranchField` is not exported.

- [ ] **Step 3: Implement** — append to `lib/jira.mjs`:

```js
// -> { ok: true, already?: true } | { conflict: string } | { error: string }
//
// Read-before-write: the one extra GET buys never silently clobbering a value
// someone else put in the field. `force` is the caller saying the user has
// seen the conflict and chosen to overwrite.
function statusError(status, key) {
  if (status === 401 || status === 403) return { error: `Jira rejected the credentials (${status})` };
  if (status === 404) return { error: `${key} not found in Jira` };
  return { error: `Jira returned ${status}` };
}

export async function submitBranchField(key, branch, { baseUrl, token, email, fieldId, force = false, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!key) return { error: 'this worktree has no ticket to submit to' };
  if (!branch) return { error: 'this worktree has no branch to submit' };
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to submit the branch' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to submit the branch' };
  if (!fieldId) return { error: 'set jiraBranchFieldId in config.json to submit the branch' };

  const issueUrl = `${trimSlashes(baseUrl)}/rest/api/2/issue/${encodeURIComponent(key)}`;
  const headers = { Authorization: authHeader({ token, email }), Accept: 'application/json' };
  try {
    const read = await fetchImpl(`${issueUrl}?fields=${encodeURIComponent(fieldId)}`, {
      headers, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!read.ok) return statusError(read.status, key);
    const held = String((await read.json())?.fields?.[fieldId] ?? '').trim();
    if (held === branch) return { ok: true, already: true };
    if (held && !force) return { conflict: held };
    const write = await fetchImpl(issueUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { [fieldId]: branch } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!write.ok) return statusError(write.status, key);
    return { ok: true };
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return { error: 'Jira request timed out' };
    return { error: String(e && e.message ? e.message : e) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/jira.test.mjs`
Expected: PASS.

- [ ] **Step 5: Refactor** — `fetchSummary`'s inline status handling (its three `if (!res.ok)` lines) now duplicates `statusError`. Replace them with `if (!res.ok) return statusError(res.status, key);` and re-run `node --test lib/jira.test.mjs` — the existing 401/404/500 tests must still pass.

- [ ] **Step 6: Hand off (no commit)** — suggested message: `feat(jira): submitBranchField writes the branch into the ticket's branch field`

---

### Task 3: `POST /api/jira/submit-branch` route

**Files:**
- Modify: `lib/actions.mjs` (imports at top; new route after the `/api/description/save` block, ~line 357)
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: `submitBranchField(key, branch, opts)` from Task 2; `jiraKey` from `lib/jira.mjs`; existing `findWorktree`, `sendJson`, `ctx.cachedSnapshot`, `ctx.journal`.
- Produces: `POST /api/jira/submit-branch` body `{ path, force? }` → JSON `{ key, branch, ...result }` where result is Task 2's return; 404 `{ error: 'unknown worktree' }`; 400 `{ error }` when the worktree has no ticket branch. `createActionHandler` gains an injectable `submitBranch` (Task 4's button calls the route, not the function).

- [ ] **Step 1: Write the failing tests** (append to `lib/actions.test.mjs`, after the description-route tests)

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/actions.test.mjs`
Expected: FAIL — the route 404s (`unknown worktree` never reached; the handler falls through to its catch-all), and `submitBranch` is not an accepted option.

- [ ] **Step 3: Implement** — in `lib/actions.mjs`:

Change the import (line 14) to:

```js
import { createSummaryCache, jiraKey, submitBranchField } from './jira.mjs';
```

Change the handler signature (line 215) to:

```js
export function createActionHandler({ launch = launchInteractive, resolveScope = resolveSessionScope, submitBranch = submitBranchField } = {}) {
```

Add the route directly after the `/api/description/save` block:

```js
      // Writes the branch name into the ticket's branch field (the drawer's
      // "Branch → Jira" button). Journalled only when Jira actually changed.
      if (url === '/api/jira/submit-branch') {
        const { path, force } = body;
        const w = findWorktree(await ctx.cachedSnapshot(), path);
        if (!w) return sendJson(res, { error: 'unknown worktree' }, 404);
        if (!w.branch || !w.ticket) return sendJson(res, { error: 'this worktree has no ticket branch to submit' }, 400);
        const key = jiraKey(w.ticket, ctx.config.jiraProjectKey);
        const r = await submitBranch(key, w.branch, {
          baseUrl: ctx.config.jiraBaseUrl, token: ctx.config.jiraToken, email: ctx.config.jiraEmail,
          fieldId: ctx.config.jiraBranchFieldId, force: Boolean(force),
        });
        if (r.ok && !r.already) ctx.journal.add({ cmd: `jira: set Git Branch Name on ${key} → ${w.branch}`, cwd: w.repoPath, mode });
        return sendJson(res, { key, branch: w.branch, ...r });
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/actions.test.mjs`
Expected: PASS.

- [ ] **Step 5: Hand off (no commit)** — suggested message: `feat(actions): /api/jira/submit-branch fills the ticket's Git Branch Name`

---

### Task 4: Drawer button + local config + live check

**Files:**
- Modify: `public/app.js` (description section, ~lines 353–378)
- Modify: `config.json` (user's local file — gitignored/uncommitted)

**Interfaces:**
- Consumes: `POST /api/jira/submit-branch` from Task 3; existing client helpers `findWorktree(path)`, `api()`, `toast()`, `esc()`, `state.config` (which `/api/config` already populates — `jiraBranchFieldId` is not in `SECRET_KEYS`, so it arrives free).
- Produces: `#desc-jira-branch` button, class `desc-flat` (existing style — no CSS change).

- [ ] **Step 1: Add the button to `renderDescription`** — replace the reading-mode `controls` branch:

```js
    : `<button id="desc-edit" class="desc-flat">Edit</button>${jiraBranchButton(path, d)}`;
```

and add above `renderDescription`:

```js
// Rendered only when everything the click needs exists: a ticket to write to,
// a branch to write, and a configured field to write into. Anything less and
// the feature simply is not there — no disabled button to explain.
function jiraBranchButton(path, d) {
  const branch = findWorktree(path)?.branch;
  if (!d.ticket || !branch || !state.config?.jiraBranchFieldId) return '';
  return `<button id="desc-jira-branch" class="desc-flat"
    title="Write ${esc(branch)} into ${esc(d.ticket)}'s Git Branch Name field">Branch → Jira</button>`;
}
```

- [ ] **Step 2: Wire the click** — in `renderDescription`, after the `const edit = $('#desc-edit'); …` line (still before `if (!editing) return;`):

```js
  const jiraBtn = $('#desc-jira-branch');
  if (jiraBtn) jiraBtn.onclick = async () => {
    let r = await api('/api/jira/submit-branch', { path });
    if (r && r.conflict) {
      if (!confirm(`${d.ticket}'s Git Branch Name already holds "${r.conflict}" — overwrite?`)) return;
      r = await api('/api/jira/submit-branch', { path, force: true });
    }
    if (!r || r.error) { toast(`Jira: ${(r && r.error) || 'server unreachable'}`); return; }
    toast(r.already ? `Git Branch Name already set on ${r.key}` : `Git Branch Name set on ${r.key}`);
  };
```

- [ ] **Step 3: Point the local config at the real field** — in the user's `config.json`, after `"jiraProjectKey": "SHBDN",` add:

```json
  "jiraBranchFieldId": "customfield_10041",
```

- [ ] **Step 4: Full suite**

Run: `npm test`
Expected: PASS, no leaked tmpdirs reported.

- [ ] **Step 5: Live check** — restart the forest server (the user's `npm start`, or ask the user to restart), hard-refresh the dashboard, open the `tech/WEBT-226230` drawer. The button must appear next to Edit. Clicking it must toast **"Git Branch Name already set on SHBDN-226230"** — the field already holds this exact value from earlier today, so the read-before-write short-circuit is what a correct implementation shows.

- [ ] **Step 6: Hand off (no commit)** — suggested message: `feat(app): Branch → Jira button in the drawer's description row`

---

## Phase 2 tasks (empty-field highlight + priority colors — spec Phase 2)

### Task 5: `readBranchField` + refactor `submitBranchField` (lib/jira.mjs, TDD)
### Task 6: `POST /api/jira/branch-field` route (lib/actions.mjs, injectable `readBranch`, TDD)
### Task 7: `lib/priorities.mjs` store mirroring descriptions.mjs (TDD)
### Task 8: stamp `priority` onto snapshot worktrees (lib/discover.mjs, TDD)
### Task 9: `POST /api/worktree/priority` route (validate color set, TDD)
### Task 10: UI — attn dot on the button, prio dots + row stripe, drawer swatches (public/app.js, public/style.css)
### Task 11: full suite, server restart, Playwright live check (set a color, see dot+stripe; open a drawer whose ticket has an empty field, see the amber dot)

Code shapes for every task are specified in the spec's Phase 2 section; test
style mirrors the Phase 1 tasks above (node:test, injected fetch/stubs,
withRepo tmpdir fixtures).

## Suggested commit sequence (user runs these)

1. `feat(config): jiraBranchFieldId gates the Branch → Jira button`
2. `feat(jira): submitBranchField writes the branch into the ticket's branch field`
3. `feat(actions): /api/jira/submit-branch fills the ticket's Git Branch Name`
4. `feat(app): Branch → Jira button in the drawer's description row`

(Or one commit for the lot — the tasks are small.)
