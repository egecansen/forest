# Ticket Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pick Jira tickets (current sprint or backlog, for any person) and SRP-reserved testboxes inside forest, then launch one Claude session in the repo's primary checkout seeded with a prompt that hands the work to `hektor-multi-ticket`.

**Architecture:** Two new server-side clients (`lib/jira-search.mjs`, `lib/srp.mjs`), each pure-ish with an injected `fetchImpl` and a nothing-throws contract; four new POST routes in the existing action router; one new browser module (`public/tickets.js`) for the modal; one shared ESM helper (`public/prompt.js`) that both the browser and a node test import. `/api/launch` gains an optional `prompt` that reaches `claude` as its first argument. Forest never creates per-ticket worktrees — the skill does.

**Tech Stack:** Node 20+ ESM (no dependencies), `node --test` + `node:assert/strict`, vanilla DOM + CSS custom properties in `public/`.

**Spec:** `docs/superpowers/specs/2026-08-18-ticket-launcher-design.md`

## Global Constraints

- **Nothing throws.** Every exported network function returns `{ error: '<sentence>' }` on failure; the sentence is printed verbatim in the UI and must name what to do about it. Copy the voice of `lib/jira.mjs`.
- **`fetchImpl` is injected** into every module that makes a network call, defaulting to global `fetch`. No test may touch the network.
- **Secrets never reach the browser.** `srpRefreshToken` joins `jiraToken` in `SECRET_KEYS` in `lib/config.mjs`.
- **Forest reads SRP; it creates at most a reservation.** No revoke, cancel, or extend calls anywhere.
- **No new provisioning path.** `/api/launch` stays the only launch route; per-ticket worktrees are `hektor-multi-ticket`'s job.
- **Route shape follows its neighbours:** `POST`, JSON body, `sendJson(res, obj, code)`, dependencies injected through `createActionHandler({...})` so tests can substitute them.
- **Commit style:** `feat(scope): …` / `test(scope): …` matching `git log` (`feat(actions):`, `fix(priorities):`).
- Ticket keys come back from search already in the project the issues live in (`SHBDN-…`). Do **not** run them through `jiraKey()`.

---

### Task 1: `lib/jira-search.mjs` — JQL builders, issue search, user search

**Files:**
- Create: `lib/jira-search.mjs`
- Create: `lib/jira-search.test.mjs`
- Modify: `lib/jira.mjs` (export the existing private `authHeader` so it is not duplicated)

**Interfaces:**
- Consumes: `authHeader({token, email})` from `lib/jira.mjs`.
- Produces:
  - `sprintJql(user) -> string`
  - `backlogJql(user) -> string`
  - `searchIssues(jql, {baseUrl, token, email, fetchImpl, timeoutMs, max}) -> {issues, total, truncated} | {error}` where an issue is `{key, summary, status, type, priority, updated}`
  - `searchUsers(q, opts) -> {people: [{name, displayName}]} | {error}`
  - `me(opts) -> {name, displayName} | {error}`
  - `createTicketCache({ttlMs, nowMs}) -> {get(key, fetcher, {force}) }`

- [ ] **Step 1: Write the failing test**

Create `lib/jira-search.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sprintJql, backlogJql, searchIssues, searchUsers, me, createTicketCache } from './jira-search.mjs';

const OPTS = { baseUrl: 'https://jira.example.com', token: 'pat', email: '' };

// A fetchImpl that records its calls and replays a canned response.
function fakeFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  impl.calls = calls;
  return impl;
}

const ISSUE = {
  key: 'SHBDN-253990',
  fields: {
    summary: 'CI - İlan detay Endeks Kozmetik Düzenlemeler',
    status: { name: 'In Progress' },
    issuetype: { name: 'Task' },
    priority: { name: 'Major' },
    updated: '2026-08-17T09:10:11.000+0300',
  },
};

// ---- JQL ----

test('sprintJql: quotes the user and asks only for open sprints, not-done', () => {
  assert.equal(
    sprintJql('egecan.sen'),
    'assignee = "egecan.sen" AND sprint in openSprints() AND statusCategory != Done ORDER BY rank',
  );
});

test('backlogJql: everything not in an open sprint, not-done, newest first', () => {
  assert.equal(
    backlogJql('egecan.sen'),
    'assignee = "egecan.sen" AND (sprint is EMPTY OR sprint not in openSprints()) AND statusCategory != Done ORDER BY updated DESC',
  );
});

test('JQL builders escape a quote in the username instead of breaking the query', () => {
  assert.ok(sprintJql('a"b').includes('"a\\"b"'));
});

// ---- searchIssues ----

test('searchIssues: maps fields, reports total and truncation', async () => {
  const fetchImpl = fakeFetch({ total: 43, issues: [ISSUE] });
  const r = await searchIssues(sprintJql('egecan.sen'), { ...OPTS, fetchImpl, max: 1 });
  assert.deepEqual(r.issues, [{
    key: 'SHBDN-253990',
    summary: 'CI - İlan detay Endeks Kozmetik Düzenlemeler',
    status: 'In Progress',
    type: 'Task',
    priority: 'Major',
    updated: '2026-08-17T09:10:11.000+0300',
  }]);
  assert.equal(r.total, 43);
  assert.equal(r.truncated, true, '43 matches behind 1 returned row must be visible to the caller');
  const url = fetchImpl.calls[0].url;
  assert.ok(url.startsWith('https://jira.example.com/rest/api/2/search?'), url);
  assert.ok(url.includes('maxResults=1'));
  assert.ok(decodeURIComponent(url).includes('summary,status,issuetype,priority,assignee,updated'));
});

test('searchIssues: a complete page is not truncated, missing fields do not throw', async () => {
  const r = await searchIssues('x', { ...OPTS, fetchImpl: fakeFetch({ total: 1, issues: [{ key: 'S-1', fields: {} }] }) });
  assert.equal(r.truncated, false);
  assert.deepEqual(r.issues, [{ key: 'S-1', summary: '', status: '', type: '', priority: '', updated: null }]);
});

test('searchIssues: config gaps name the key to set', async () => {
  assert.match((await searchIssues('x', { ...OPTS, baseUrl: '' })).error, /jiraBaseUrl/);
  assert.match((await searchIssues('x', { ...OPTS, token: '' })).error, /jiraToken/);
});

test('searchIssues: http statuses become sentences', async () => {
  assert.match((await searchIssues('x', { ...OPTS, fetchImpl: fakeFetch({}, { status: 400 }) })).error, /rejected the query/);
  assert.match((await searchIssues('x', { ...OPTS, fetchImpl: fakeFetch({}, { status: 401 }) })).error, /credentials/);
  assert.match((await searchIssues('x', { ...OPTS, fetchImpl: fakeFetch({}, { status: 500 }) })).error, /Jira returned 500/);
});

test('searchIssues: a timeout is a sentence, not a rejection', async () => {
  const boom = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  assert.match((await searchIssues('x', { ...OPTS, fetchImpl: boom })).error, /timed out/);
});

// ---- searchUsers / me ----

test('searchUsers: maps to name + displayName and drops inactive users', async () => {
  const fetchImpl = fakeFetch([
    { name: 'egecan.sen', displayName: 'Egecan Sen', active: true },
    { name: 'old.user', displayName: 'Old User', active: false },
  ]);
  const r = await searchUsers('sen', { ...OPTS, fetchImpl });
  assert.deepEqual(r.people, [{ name: 'egecan.sen', displayName: 'Egecan Sen' }]);
  assert.ok(fetchImpl.calls[0].url.includes('username=sen'));
});

test('me: reads the authenticated user', async () => {
  const r = await me({ ...OPTS, fetchImpl: fakeFetch({ name: 'egecan.sen', displayName: 'Egecan Sen' }) });
  assert.deepEqual(r, { name: 'egecan.sen', displayName: 'Egecan Sen' });
});

// ---- cache ----

test('createTicketCache: hits within the ttl, refetches after it, force bypasses', async () => {
  let now = 0, calls = 0;
  const cache = createTicketCache({ ttlMs: 60_000, nowMs: () => now });
  const fetcher = async () => ({ issues: [], total: ++calls });
  assert.equal((await cache.get('k', fetcher)).total, 1);
  assert.equal((await cache.get('k', fetcher)).total, 1, 'second call inside the ttl must be a hit');
  assert.equal((await cache.get('k', fetcher, { force: true })).total, 2, 'force must refetch');
  now = 60_001;
  assert.equal((await cache.get('k', fetcher)).total, 3, 'expired entry must refetch');
});

test('createTicketCache: errors are never cached', async () => {
  let calls = 0;
  const cache = createTicketCache({ nowMs: () => 0 });
  const fetcher = async () => { calls++; return { error: 'Jira returned 500' }; };
  await cache.get('k', fetcher);
  await cache.get('k', fetcher);
  assert.equal(calls, 2, 'a fixed config must take effect on the next click, not a minute later');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/jira-search.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/jira-search.mjs'`

- [ ] **Step 3: Export `authHeader` from `lib/jira.mjs`**

In `lib/jira.mjs`, change the private helper to an export (one word; no other edit):

```js
export function authHeader({ token, email }) {
  if (email) return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  return `Bearer ${token}`;
}
```

- [ ] **Step 4: Write the implementation**

Create `lib/jira-search.mjs`:

```js
// lib/jira-search.mjs — listing a person's tickets, not resolving one branch's
//
// The sibling of jira.mjs: same nothing-throws contract, same injected fetch,
// but it answers "what is this person working on" instead of "what is this
// ticket called". Board-agnostic on purpose — SHBDN has 83 boards, and
// openSprints() filtered by assignee answers "their current sprint" without
// forest having to know which board that is.

import { authHeader } from './jira.mjs';

const trimSlashes = (s) => String(s ?? '').replace(/\/+$/, '');
const FIELDS = 'summary,status,issuetype,priority,assignee,updated';

// JQL string literals: a quote or backslash in a username would otherwise end
// the literal early and hand Jira a query we did not write.
const quote = (s) => `"${String(s ?? '').replace(/["\\]/g, '\\$&')}"`;

export const sprintJql = (user) =>
  `assignee = ${quote(user)} AND sprint in openSprints() AND statusCategory != Done ORDER BY rank`;

export const backlogJql = (user) =>
  `assignee = ${quote(user)} AND (sprint is EMPTY OR sprint not in openSprints()) AND statusCategory != Done ORDER BY updated DESC`;

function statusError(status) {
  if (status === 400) return { error: 'Jira rejected the query (400) — check the assignee name' };
  if (status === 401 || status === 403) return { error: `Jira rejected the credentials (${status})` };
  return { error: `Jira returned ${status}` };
}

function failure(e) {
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return { error: 'Jira request timed out' };
  return { error: String(e && e.message ? e.message : e) };
}

const mapIssue = (i) => ({
  key: i?.key ?? '',
  summary: i?.fields?.summary ?? '',
  status: i?.fields?.status?.name ?? '',
  type: i?.fields?.issuetype?.name ?? '',
  priority: i?.fields?.priority?.name ?? '',
  updated: i?.fields?.updated ?? null,
});

async function getJson(url, { token, email, fetchImpl = fetch, timeoutMs = 8000 }) {
  const res = await fetchImpl(url, {
    headers: { Authorization: authHeader({ token, email }), Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return { httpError: statusError(res.status) };
  return { data: await res.json() };
}

// -> { issues, total, truncated } | { error }
export async function searchIssues(jql, { baseUrl, token, email, fetchImpl = fetch, timeoutMs = 8000, max = 100 } = {}) {
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to list tickets' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to list tickets' };
  const url = `${trimSlashes(baseUrl)}/rest/api/2/search`
    + `?jql=${encodeURIComponent(jql)}`
    + `&maxResults=${encodeURIComponent(max)}`
    + `&fields=${encodeURIComponent(FIELDS)}`;
  try {
    const { httpError, data } = await getJson(url, { token, email, fetchImpl, timeoutMs });
    if (httpError) return httpError;
    const issues = (data?.issues ?? []).map(mapIssue);
    const total = Number.isFinite(data?.total) ? data.total : issues.length;
    // A silently capped list reads as "that's all of it" — say so instead.
    return { issues, total, truncated: total > issues.length };
  } catch (e) { return failure(e); }
}

// -> { people: [{name, displayName}] } | { error }
export async function searchUsers(q, { baseUrl, token, email, fetchImpl = fetch, timeoutMs = 8000, max = 10 } = {}) {
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to search people' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to search people' };
  const url = `${trimSlashes(baseUrl)}/rest/api/2/user/search`
    + `?username=${encodeURIComponent(q)}&maxResults=${encodeURIComponent(max)}`;
  try {
    const { httpError, data } = await getJson(url, { token, email, fetchImpl, timeoutMs });
    if (httpError) return httpError;
    const people = (Array.isArray(data) ? data : [])
      .filter((u) => u && u.active !== false)
      .map((u) => ({ name: u.name, displayName: u.displayName || u.name }));
    return { people };
  } catch (e) { return failure(e); }
}

// -> { name, displayName } | { error }
export async function me({ baseUrl, token, email, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to identify you' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to identify you' };
  try {
    const { httpError, data } = await getJson(`${trimSlashes(baseUrl)}/rest/api/2/myself`, { token, email, fetchImpl, timeoutMs });
    if (httpError) return httpError;
    return { name: data?.name ?? '', displayName: data?.displayName || data?.name || '' };
  } catch (e) { return failure(e); }
}

// Successes memoise briefly so re-opening the modal costs nothing. Failures
// are NOT cached: fixing a token in config.json must take effect on the next
// click, not a minute later.
export function createTicketCache({ ttlMs = 60_000, nowMs = () => Date.now() } = {}) {
  const hits = new Map(); // key -> { result, at }
  return {
    async get(key, fetcher, { force = false } = {}) {
      const cached = hits.get(key);
      if (!force && cached && nowMs() - cached.at < ttlMs) return cached.result;
      const result = await fetcher();
      if (!result.error) hits.set(key, { result, at: nowMs() });
      return result;
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test lib/jira-search.test.mjs lib/jira.test.mjs`
Expected: PASS, including the untouched `jira.test.mjs` suite.

- [ ] **Step 6: Commit**

```bash
git add lib/jira-search.mjs lib/jira-search.test.mjs lib/jira.mjs
git commit -m "feat(jira): sprint/backlog search, user search, short-lived ticket cache"
```

---

### Task 2: `/api/jira/tickets` and `/api/jira/people` routes

**Files:**
- Modify: `lib/actions.mjs` (imports, `createActionHandler` signature, two new route blocks next to the existing `/api/jira/*` routes near line 378)
- Modify: `lib/actions.test.mjs` (append a `// ---- /api/jira/tickets ----` section)

**Interfaces:**
- Consumes: `sprintJql`, `backlogJql`, `searchIssues`, `searchUsers`, `me`, `createTicketCache` from Task 1.
- Produces:
  - `POST /api/jira/tickets {scope:'sprint'|'backlog', assignee, refresh?}` → `{ok:true, scope, jql, issues, total, truncated}` | `{error}` (400 on bad scope / missing assignee)
  - `POST /api/jira/people {q}` → `{ok:true, people, me?}` | `{error}`
  - New `createActionHandler` deps: `searchTickets`, `searchPeople`, `whoami`.

- [ ] **Step 1: Write the failing test**

Append to `lib/actions.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/actions.test.mjs`
Expected: FAIL — the routes 404, so `body.ok` is undefined and the first assertion trips.

- [ ] **Step 3: Write the implementation**

In `lib/actions.mjs`, add the import beside the existing `jira.mjs` one:

```js
import { sprintJql, backlogJql, searchIssues, searchUsers, me, createTicketCache } from './jira-search.mjs';
```

Extend the factory signature and its per-handler state:

```js
export function createActionHandler({
  launch = launchInteractive, resolveScope = resolveSessionScope,
  submitBranch = submitBranchField, readBranch = readBranchField,
  searchTickets = searchIssues, searchPeople = searchUsers, whoami = me,
} = {}) {
  const summaries = createSummaryCache();
  // One cache per handler, like `summaries` above: survives modal opens, never
  // leaks between tests.
  const tickets = createTicketCache();
```

Add both routes directly after the existing `/api/jira/branch-field` block:

```js
      // The Tickets modal's list. Two scopes, two JQLs, never merged: "current
      // sprint" has to keep meaning the active-sprint set.
      if (url === '/api/jira/tickets') {
        const { scope = 'sprint', assignee, refresh = false } = body;
        if (scope !== 'sprint' && scope !== 'backlog') return sendJson(res, { error: `unknown scope: ${scope}` }, 400);
        const user = String(assignee ?? '').trim();
        if (!user) return sendJson(res, { error: 'pick a person to list tickets for' }, 400);
        const jql = scope === 'sprint' ? sprintJql(user) : backlogJql(user);
        const opts = { baseUrl: ctx.config.jiraBaseUrl, token: ctx.config.jiraToken, email: ctx.config.jiraEmail };
        const r = await tickets.get(`${scope}:${user}`, () => searchTickets(jql, opts), { force: Boolean(refresh) });
        if (r.error) return sendJson(res, { error: r.error });
        return sendJson(res, { ok: true, scope, jql, ...r });
      }

      // The person picker. An empty query is "who am I" — the modal's first
      // paint — and must not spend a user search on it.
      if (url === '/api/jira/people') {
        const q = String(body.q ?? '').trim();
        const opts = { baseUrl: ctx.config.jiraBaseUrl, token: ctx.config.jiraToken, email: ctx.config.jiraEmail };
        if (!q) {
          const r = await whoami(opts);
          if (r.error) return sendJson(res, { error: r.error });
          return sendJson(res, { ok: true, me: r, people: [r] });
        }
        const r = await searchPeople(q, opts);
        if (r.error) return sendJson(res, { error: r.error });
        return sendJson(res, { ok: true, people: r.people });
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — the whole suite, previous 304 tests plus the new ones.

- [ ] **Step 5: Commit**

```bash
git add lib/actions.mjs lib/actions.test.mjs
git commit -m "feat(actions): /api/jira/tickets and /api/jira/people routes"
```

---

### Task 3: `public/prompt.js` — the seeded prompt

**Files:**
- Create: `public/prompt.js`
- Create: `public/prompt.test.mjs`

**Interfaces:**
- Produces: `composeTicketPrompt({tickets, boxes, waveSize, base}) -> string`. Imported by the browser (Task 5) and by the node test. It must stay free of DOM references for that reason.

- [ ] **Step 1: Write the failing test**

Create `public/prompt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeTicketPrompt } from './prompt.js';

test('two or more tickets: the multi-ticket skill wording, one line per input', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['SHBDN-253990', 'SHBDN-254664'], boxes: ['x:161', 'x:230'] }),
    'Hektor, multi-ticket: SHBDN-253990, SHBDN-254664\n'
    + 'boxes: x:161, x:230\n'
    + 'waves of 3, base origin/master',
  );
});

test('one ticket routes to hektor-from-jira, which is what that skill says to do', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['SHBDN-253990'], boxes: ['x:161'] }),
    'Hektor, work SHBDN-253990 — box x:161',
  );
});

test('one ticket, two boxes: both are named', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['S-1'], boxes: ['x:161', 'x:230'] }),
    'Hektor, work S-1 — boxes x:161, x:230',
  );
});

test('wave size and base are overridable', () => {
  const p = composeTicketPrompt({ tickets: ['A-1', 'A-2'], boxes: ['x:1'], waveSize: 2, base: 'origin/release' });
  assert.match(p, /waves of 2, base origin\/release/);
});

test('no tickets is an empty prompt — nothing to launch', () => {
  assert.equal(composeTicketPrompt({ tickets: [], boxes: ['x:1'] }), '');
  assert.equal(composeTicketPrompt(), '');
});

test('empty entries are dropped rather than rendered as blanks', () => {
  assert.equal(
    composeTicketPrompt({ tickets: ['A-1', '', null, 'A-2'], boxes: ['x:1', ''] }),
    'Hektor, multi-ticket: A-1, A-2\nboxes: x:1\nwaves of 3, base origin/master',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test public/prompt.test.mjs`
Expected: FAIL — `Cannot find module '.../public/prompt.js'`

- [ ] **Step 3: Write the implementation**

Create `public/prompt.js`:

```js
// public/prompt.js — the first message of a ticket-launched session.
//
// Plain ESM with no DOM references so the browser and `node --test` can import
// the same file: the prompt is the contract between forest and the Hektor
// skills, and a second copy of it would drift.

export function composeTicketPrompt({ tickets = [], boxes = [], waveSize = 3, base = 'origin/master' } = {}) {
  const keys = (tickets || []).filter(Boolean);
  const list = (boxes || []).filter(Boolean);
  if (!keys.length) return '';
  // hektor-multi-ticket says it adds nothing for a single ticket, so one
  // ticket addresses hektor-from-jira instead.
  if (keys.length === 1) {
    const box = list.length ? ` — ${list.length > 1 ? 'boxes' : 'box'} ${list.join(', ')}` : '';
    return `Hektor, work ${keys[0]}${box}`;
  }
  return [
    `Hektor, multi-ticket: ${keys.join(', ')}`,
    `boxes: ${list.join(', ')}`,
    `waves of ${waveSize}, base ${base}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test public/prompt.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add public/prompt.js public/prompt.test.mjs
git commit -m "feat(launch): compose the seeded ticket prompt"
```

---

### Task 4: `/api/launch` carries a prompt into the session

**Files:**
- Modify: `lib/terminal.mjs` (`launchClaudeSession`)
- Modify: `lib/agents.mjs` (`launchInteractive`, line 45)
- Modify: `lib/actions.mjs` (`/api/launch` block, near line 710)
- Modify: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `POST /api/launch {…, prompt?}` → response gains `promptSent: boolean`. `launchClaudeSession({worktreePath, app, title, prompt})` and `launchInteractive({worktreePath, app, title, prompt})`.

- [ ] **Step 1: Write the failing test**

Append to `lib/actions.test.mjs` (reuse the file's existing `WT_PATH`, `fakeRes`, `noRealHome`):

```js
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
  await createActionHandler({
    launch: async () => ({ ok: true, action: 'focused' }),
    resolveScope: noRealHome,
  })({ url: '/api/launch' }, res, submitCtx(), async () => ({ path: WT_PATH, selections: [], prompt: 'Hektor, work A-1' }));
  const body = JSON.parse(res.body);
  assert.equal(body.action, 'focused');
  assert.equal(body.promptSent, false, 'silently dropping the ticket list would look like a launch');
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
```

Create `lib/terminal.test.mjs` (the module has no test file yet):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The launcher writes a .command file and hands it to `open`. We cannot run
// Terminal in a test, so assert on the script it writes.
test('launchClaudeSession quotes the prompt into the claude invocation', async () => {
  const { launchClaudeSession } = await import('./terminal.mjs');
  let written = null;
  const r = await launchClaudeSession({
    worktreePath: '/tmp/forest-test-wt',
    prompt: "Hektor, work A-1 — box x:161's pool",
    openImpl: (file) => { written = file; return { ok: true }; },
  });
  assert.equal(r.action, 'launched');
  const script = await readFile(written, 'utf8');
  assert.match(script, /claude 'Hektor, work A-1 — box x:161'\\''s pool'/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/actions.test.mjs lib/terminal.test.mjs`
Expected: FAIL — `seen[0].prompt` is `undefined`; `openImpl` is not a parameter yet.

- [ ] **Step 3: Implement — `lib/terminal.mjs`**

`launchScriptFile` gains an injectable opener (so the test above can observe the file without launching Terminal), and `launchClaudeSession` gains `prompt`:

```js
async function launchScriptFile({ cwd, body, app = 'Terminal', title, openImpl = null }) {
  try {
    const label = title || basename(cwd);
    const dir = join(tmpdir(), 'forest-launch', `${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${safeName(label)}.command`);
    const setTitle = `printf '\\033]0;%s\\007' ${shQuote(label)}`;
    const script = `#!/bin/zsh\ncd ${shQuote(cwd)}\nrm -rf ${shQuote(dir)}\n${setTitle}\n${body}\n`;
    await writeFile(file, script, { mode: 0o755 });
    if (openImpl) return openImpl(file);
    return await new Promise((resolve) => {
      execFile('open', ['-a', app, file], (err) => resolve({ ok: !err, error: err ? String(err) : null }));
    });
  } catch (e) { return { ok: false, error: String(e) }; }
}
```

Note the injected opener also skips the `rm -rf` self-delete, which only runs when the script itself is executed — that is why the test can read the file back.

```js
// `prompt`, when given, becomes claude's first message: the session opens
// already knowing why it was opened. Quoted, never interpolated raw — a
// ticket summary can contain anything.
export async function launchClaudeSession({ worktreePath, app = 'Terminal', title, prompt = '', openImpl = null }) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lock = sessionLock(worktreePath);
  if (sessionAlive(lock)) {
    const ok = await bringAppFront(app);
    return { ok, action: 'focused' };
  }
  const claude = prompt ? `claude ${shQuote(prompt)}` : 'claude';
  const body = `echo $$ > ${shQuote(lock)}\n${claude}\nrm -f ${shQuote(lock)}`;
  const r = await launchScriptFile({ cwd: worktreePath, body, app, title, openImpl });
  return { ok: r.ok, action: 'launched', error: r.error };
}
```

- [ ] **Step 4: Implement — `lib/agents.mjs`**

```js
export function launchInteractive({ worktreePath, app = 'Terminal', title, prompt = '' }) {
  // One Claude session per worktree: reuse (front) if alive, else launch.
  return launchClaudeSession({ worktreePath, app, title, prompt });
}
```

- [ ] **Step 5: Implement — `lib/actions.mjs` `/api/launch`**

Replace the journal line and launch call at the end of the `/api/launch` block:

```js
        const prompt = String(body.prompt ?? '');
        ctx.journal.add({ cmd: prompt ? `claude ${shQuote(prompt)}` : 'claude', cwd: path, mode: 'guided' });
        const r = await launch({ worktreePath: path, app: ctx.config.terminalApp, title: worktreeTitle(path), prompt });
```

and add `promptSent` to the success response — a focused session never receives it:

```js
        return r && r.ok
          ? sendJson(res, {
            ok: true, action: r.action, provisioned,
            promptSent: Boolean(prompt) && r.action === 'launched',
            scope: { active: scope.active.length, missing: scope.missing.map((h) => ({ command: h.command, source: h.source })) },
          })
          : sendJson(res, { error: (r && r.error) || 'failed to open Terminal' }, 500);
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 7: Commit**

```bash
git add lib/terminal.mjs lib/agents.mjs lib/actions.mjs lib/actions.test.mjs lib/terminal.test.mjs
git commit -m "feat(launch): optional prompt seeds the session; focused sessions report promptSent:false"
```

---

### Task 5: The Tickets modal (Jira half, boxes from config)

**Files:**
- Create: `public/tickets.js`
- Modify: `public/index.html` (modal markup after the `#picker` block)
- Modify: `public/app.js` (import + init, repo-header button, Escape close, `render()` header)
- Modify: `public/style.css` (append a `/* ---- tickets modal ---- */` block)
- Modify: `lib/config.mjs` (`testboxes` default)
- Modify: `config.example.json` (document `testboxes`)

**Interfaces:**
- Consumes: `POST /api/jira/tickets`, `POST /api/jira/people` (Task 2); `composeTicketPrompt` (Task 3); `POST /api/launch` with `prompt` (Task 4).
- Produces: `initTickets({api, toast, esc, state})` and `openTickets({repoPath, repo, primaryPath})` from `public/tickets.js`.

- [ ] **Step 1: `lib/config.mjs` — the fallback box list**

Add to `DEFAULTS`, after `jiraBranchFieldId`:

```js
  // Fallback box list for the Tickets modal, used when SRP is unreachable or
  // unconfigured. Format is the `dc:id` the Hektor skills expect: "x:161".
  testboxes: splitList(process.env.FOREST_TESTBOXES) || [],
```

- [ ] **Step 2: Modal markup in `public/index.html`**

Insert after the `#picker` modal's closing `</div>`:

```html
  <div id="tickets" class="modal hidden">
    <div class="modal-card tickets-card">
      <h3>Tickets</h3>
      <p class="picker-sub" id="tk-sub"></p>
      <div class="tk-head">
        <button id="tk-person" class="tk-person" type="button" title="Change person">…</button>
        <input id="tk-person-q" class="tk-person-q hidden" type="text" placeholder="search people…" autocomplete="off" spellcheck="false" />
        <div id="tk-people" class="tk-people hidden"></div>
        <button id="tk-refresh" class="btn-ghost tk-refresh" type="button" title="Refetch from Jira">↻</button>
      </div>
      <div class="tk-tabs">
        <button id="tk-tab-sprint" class="tk-tab on" type="button" data-scope="sprint">Sprint</button>
        <button id="tk-tab-backlog" class="tk-tab" type="button" data-scope="backlog">Backlog</button>
        <input id="tk-filter" class="tk-filter" type="text" placeholder="filter…" autocomplete="off" spellcheck="false" />
      </div>
      <div id="tk-body" class="tk-body"></div>
      <div id="tk-boxes" class="tk-boxes"></div>
      <textarea id="tk-prompt" class="tk-prompt" rows="3" spellcheck="false"></textarea>
      <div class="modal-actions">
        <span id="tk-count" class="pk-count"></span>
        <button id="tk-cancel" class="btn-ghost">Cancel</button>
        <button id="tk-start" class="btn-accent">Start session</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: `public/tickets.js`**

```js
// public/tickets.js — the Tickets modal: pick a person, pick their tickets,
// pick boxes, launch ONE session seeded with the prompt.
//
// Its own module because app.js already owns every other modal and is 1150
// lines. Dependencies arrive through initTickets() rather than being imported
// back out of app.js, so the seam stays one-way.

import { composeTicketPrompt } from './prompt.js';

let D = null;                                   // { api, toast, esc, state }
let target = null;                              // { repoPath, repo, primaryPath }
let scope = 'sprint';
let person = null;                              // { name, displayName }
let lists = { sprint: null, backlog: null };    // scope -> { issues, total, truncated }
let filter = '';
const pickedTickets = new Set();
const pickedBoxes = new Set();

const $ = (s) => document.querySelector(s);
const PERSON_KEY = 'forest-jira-person';
const boxKey = (repoPath) => `forest-boxes:${repoPath}`;

export function initTickets(deps) {
  D = deps;
  $('#tk-cancel').onclick = close;
  $('#tickets').addEventListener('click', (e) => { if (e.target.id === 'tickets') close(); });
  $('#tk-refresh').onclick = () => load({ refresh: true });
  $('#tk-start').onclick = start;
  $('#tk-filter').oninput = (e) => { filter = e.target.value.toLowerCase(); renderList(); };
  $('#tk-person').onclick = openPersonSearch;
  $('#tk-person-q').oninput = debounce(searchPeople, 250);
  document.querySelectorAll('.tk-tab').forEach((t) => {
    t.onclick = () => { scope = t.dataset.scope; syncTabs(); load(); };
  });
  $('#tk-body').addEventListener('change', (e) => {
    if (!e.target.classList.contains('tk-cb')) return;
    toggle(pickedTickets, e.target.dataset.key, e.target.checked);
    renderFooter();
  });
  $('#tk-boxes').addEventListener('change', (e) => {
    if (!e.target.classList.contains('tk-box-cb')) return;
    toggle(pickedBoxes, e.target.dataset.box, e.target.checked);
    localStorage.setItem(boxKey(target.repoPath), JSON.stringify([...pickedBoxes]));
    renderFooter();
  });
}

export async function openTickets(t) {
  target = t;
  pickedTickets.clear();
  pickedBoxes.clear();
  lists = { sprint: null, backlog: null };
  filter = '';
  scope = 'sprint';
  $('#tk-filter').value = '';
  $('#tk-sub').textContent = `${t.repo} · session starts in ${t.primaryPath}`;
  syncTabs();
  $('#tickets').classList.remove('hidden');
  renderBoxes();
  renderFooter();
  await ensurePerson();
  await load();
}

export function closeTickets() { close(); }

function close() { $('#tickets').classList.add('hidden'); $('#tk-people').classList.add('hidden'); }

const toggle = (set, v, on) => (on ? set.add(v) : set.delete(v));

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function syncTabs() {
  document.querySelectorAll('.tk-tab').forEach((t) => t.classList.toggle('on', t.dataset.scope === scope));
}

// ---- person ----

async function ensurePerson() {
  if (person) return;
  try { person = JSON.parse(localStorage.getItem(PERSON_KEY)) || null; } catch { person = null; }
  if (!person) {
    const r = await D.api('/api/jira/people', { q: '' });
    if (r.error) { $('#tk-person').textContent = 'no person'; D.toast(`Error: ${r.error}`); return; }
    person = r.me;
  }
  $('#tk-person').textContent = person.displayName || person.name;
}

function openPersonSearch() {
  const q = $('#tk-person-q');
  q.classList.remove('hidden');
  q.value = '';
  q.focus();
}

async function searchPeople() {
  const q = $('#tk-person-q').value.trim();
  const box = $('#tk-people');
  if (q.length < 2) { box.classList.add('hidden'); return; }
  const r = await D.api('/api/jira/people', { q });
  if (r.error) { box.classList.add('hidden'); D.toast(`Error: ${r.error}`); return; }
  box.innerHTML = (r.people || []).map((p) =>
    `<button type="button" class="tk-person-hit" data-name="${D.esc(p.name)}" data-label="${D.esc(p.displayName)}">${D.esc(p.displayName)} <span class="tk-dim">${D.esc(p.name)}</span></button>`).join('')
    || '<div class="tk-empty">no match</div>';
  box.classList.remove('hidden');
  box.querySelectorAll('.tk-person-hit').forEach((b) => {
    b.onclick = () => {
      person = { name: b.dataset.name, displayName: b.dataset.label };
      localStorage.setItem(PERSON_KEY, JSON.stringify(person));
      $('#tk-person').textContent = person.displayName;
      box.classList.add('hidden');
      $('#tk-person-q').classList.add('hidden');
      lists = { sprint: null, backlog: null };
      pickedTickets.clear();
      load();
    };
  });
}

// ---- tickets ----

async function load({ refresh = false } = {}) {
  if (!person) return;
  if (lists[scope] && !refresh) { renderList(); return; }
  $('#tk-body').innerHTML = '<div class="tk-empty">loading…</div>';
  const r = await D.api('/api/jira/tickets', { scope, assignee: person.name, refresh });
  if (r.error) {
    $('#tk-body').innerHTML = `<div class="tk-empty tk-err">${D.esc(r.error)}</div>`;
    return;
  }
  lists[scope] = r;
  syncCounts();
  renderList();
}

function syncCounts() {
  for (const s of ['sprint', 'backlog']) {
    const el = $(`#tk-tab-${s}`);
    const n = lists[s] ? lists[s].total : null;
    el.textContent = n === null ? (s === 'sprint' ? 'Sprint' : 'Backlog') : `${s === 'sprint' ? 'Sprint' : 'Backlog'} ${n}`;
  }
}

function renderList() {
  const data = lists[scope];
  if (!data) return;
  const rows = data.issues.filter((i) =>
    !filter || i.key.toLowerCase().includes(filter) || (i.summary || '').toLowerCase().includes(filter));
  $('#tk-body').innerHTML = rows.length
    ? rows.map((i) => `<label class="tk-item">
        <input type="checkbox" class="tk-cb" data-key="${D.esc(i.key)}" ${pickedTickets.has(i.key) ? 'checked' : ''} />
        <span class="tk-key">${D.esc(i.key)}</span>
        <span class="tk-status">${D.esc(i.status)}</span>
        <span class="tk-summary">${D.esc(i.summary)}</span>
      </label>`).join('')
      + (data.truncated ? `<div class="tk-empty">showing ${data.issues.length} of ${data.total}</div>` : '')
    : `<div class="tk-empty">no tickets in the ${scope === 'sprint' ? 'current sprint' : 'backlog'} for ${D.esc(person.displayName)}</div>`;
}

// ---- boxes (config fallback; SRP arrives in a later task) ----

function renderBoxes() {
  const configured = (D.state.config && D.state.config.testboxes) || [];
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(boxKey(target.repoPath))) || []; } catch { saved = []; }
  saved.filter((b) => configured.includes(b)).forEach((b) => pickedBoxes.add(b));
  $('#tk-boxes').innerHTML = configured.length
    ? `<div class="tk-boxes-h">Boxes</div>${configured.map((b) => `<label class="tk-box">
        <input type="checkbox" class="tk-box-cb" data-box="${D.esc(b)}" ${pickedBoxes.has(b) ? 'checked' : ''} />
        <span>${D.esc(b)}</span>
      </label>`).join('')}`
    : '<div class="tk-empty">no testboxes configured — add "testboxes": ["x:161"] to config.json</div>';
}

// ---- footer + launch ----

function renderFooter() {
  const tickets = [...pickedTickets];
  const boxes = [...pickedBoxes];
  $('#tk-prompt').value = composeTicketPrompt({ tickets, boxes });
  const ready = tickets.length > 0 && boxes.length > 0;
  $('#tk-start').disabled = !ready;
  $('#tk-start').textContent = tickets.length > 1 ? 'Start multi-ticket session' : 'Start ticket session';
  $('#tk-count').textContent = !tickets.length ? 'pick at least one ticket'
    : !boxes.length ? 'pick at least one testbox'
      : `${tickets.length} ticket(s) · ${boxes.length} box(es)`;
}

function savedSelections(path) {
  let sel = {};
  try { sel = JSON.parse(localStorage.getItem(`forest-skills:${path}`)) || {}; } catch { sel = {}; }
  return Object.entries(sel).map(([pack, v]) => ({ pack, skills: v.skills || [], kits: v.kits || [], hooks: !!v.hooks }));
}

async function start() {
  const prompt = $('#tk-prompt').value.trim();
  if (!prompt) return;
  const btn = $('#tk-start');
  btn.disabled = true;
  const r = await D.api('/api/launch', {
    path: target.primaryPath,
    selections: savedSelections(target.primaryPath),
    prompt,
    mode: D.state.mode,
  });
  btn.disabled = false;
  if (r && r.error) { D.toast(`Error: ${r.error}`); return; }
  // A launch that was blocked by a gate keeps the modal open: the ticket list
  // is expensive to reassemble and the user has to act on the block first.
  if (r && r.blocked) { D.toast(`Launch blocked: ${r.blocked} — start this repo from its row to resolve it`); return; }
  close();
  if (r && r.promptSent === false && r.action === 'focused') {
    await navigator.clipboard.writeText(prompt).catch(() => {});
    D.toast(`Session already running in ${target.repo} — ticket list NOT sent, copied to the clipboard instead`);
    return;
  }
  D.toast(`Launching Claude with ${pickedTickets.size} ticket(s)…`);
}
```

- [ ] **Step 4: Wire it up in `public/app.js`**

At the top, beside the other module-level code:

```js
import { initTickets, openTickets, closeTickets } from './tickets.js';
```

In `render()`, add the button to the repo-group header, after the `prune` button and before `${removeBtn}`:

```js
<button class="repo-tickets" data-act="repo-tickets" data-path="${encodeURIComponent(r.repoPath)}" title="Start a session from Jira tickets in ${esc(r.repo)}">tickets</button>
```

In `doAction`, add the branch (it is a repo path, not a worktree path, so it must not fall through to the worktree lookups):

```js
  if (act === 'repo-tickets') {
    const repo = state.snapshot.repos.find((r) => r.repoPath === path);
    const primary = repo && repo.worktrees.find((w) => w.isPrimary);
    if (!primary) { toast('no primary checkout for this repo'); return; }
    openTickets({ repoPath: repo.repoPath, repo: repo.repo, primaryPath: primary.path });
    return;
  }
```

In the boot sequence where `initSkills`-style wiring happens (the same function that runs `$('#pk-cancel').onclick = …`), add:

```js
  initTickets({ api, toast, esc, state });
```

In the Escape handler, add the modal so it closes with everything else:

```js
    if (e.key === 'Escape') { $('#palette').classList.add('hidden'); closeDrawer(); $('#newwt').classList.add('hidden'); $('#picker').classList.add('hidden'); $('#finishwt').classList.add('hidden'); closeTickets(); }
```

- [ ] **Step 5: Styles in `public/style.css`**

Append:

```css
/* ---- tickets modal ---- */
.tickets-card { width: 680px; max-width: 96vw; }
.tk-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; position: relative; }
.tk-person { padding: 6px 12px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 8px; cursor: pointer; font: 13px var(--font-ui); }
.tk-person:hover { border-color: var(--accent); }
.tk-person-q { flex: 1; padding: 6px 10px; font: 13px var(--font-mono); color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
.tk-people { position: absolute; top: 36px; left: 0; z-index: 5; width: 320px; max-height: 220px; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; box-shadow: 0 8px 24px var(--shadow); }
.tk-person-hit { display: block; width: 100%; text-align: left; padding: 7px 10px; border: 0; background: none; color: var(--ink); font: 13px var(--font-ui); cursor: pointer; }
.tk-person-hit:hover { background: var(--panel-2); }
.tk-dim { color: var(--muted); font-family: var(--font-mono); font-size: 11.5px; }
.tk-refresh { margin-left: auto; padding: 5px 10px; }
.tk-tabs { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.tk-tab { padding: 6px 12px; border: 1px solid var(--line); background: var(--bg); color: var(--muted); border-radius: 8px; cursor: pointer; font: 12px var(--font-ui); }
.tk-tab.on { border-color: var(--accent); color: var(--accent); background: var(--accent-weak); }
.tk-filter { margin-left: auto; padding: 6px 10px; font: 12px var(--font-mono); color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
.tk-body { max-height: 42vh; overflow: auto; margin: 0 -6px 10px; padding: 0 6px; }
.tk-body .tk-item { display: flex; align-items: baseline; gap: 9px; margin: 0; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.tk-body .tk-item:hover { background: var(--panel-2); }
.tk-cb, .tk-box-cb { accent-color: var(--accent); flex: none; }
.tk-key { font: 12px var(--font-mono); color: var(--accent); flex: none; }
.tk-status { font-size: 11px; color: var(--muted); flex: none; min-width: 84px; }
.tk-summary { font-size: 13px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-empty { color: var(--muted); font-size: 12.5px; padding: 8px 2px; }
.tk-err { color: var(--danger); }
.tk-boxes { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 8px 2px; border-top: 1px solid var(--line); }
.tk-boxes-h { font: 10px var(--font-ui); text-transform: uppercase; letter-spacing: .07em; color: var(--muted); width: 100%; }
.tk-body .tk-box, .tk-boxes .tk-box { display: inline-flex; align-items: center; gap: 7px; margin: 0; font: 12px var(--font-mono); color: var(--ink); cursor: pointer; }
.tk-prompt { width: 100%; margin: 8px 0 4px; padding: 8px 10px; font: 12px var(--font-mono); color: var(--ink); background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; resize: vertical; }
```

- [ ] **Step 6: Document the config key in `config.example.json`**

Add alongside the Jira keys:

```json
  "testboxes": ["x:161", "x:230"],
```

- [ ] **Step 7: Verify in the browser**

Run: `npm start` (or reload if it is already running on :5577)

Check, in order:
1. Each repo group header shows a `tickets` button. Click the one on `web-test`.
2. The modal opens; the person button shows your display name; the Sprint tab fills and its label becomes `Sprint 12`.
3. Click Backlog → a second list loads and the label becomes `Backlog 43`. Click Sprint again → **no new request** (cached); ↻ refetches.
4. Type in the filter → rows narrow by key and summary.
5. Tick two tickets and one box → the prompt textarea shows the three-line multi-ticket form and the footer reads `2 ticket(s) · 1 box(es)`; untick to one ticket → the prompt becomes the single-ticket form and the button relabels.
6. With no box ticked, Start is disabled and the footer says `pick at least one testbox`.
7. Escape closes the modal.
8. DevTools console: no errors.

- [ ] **Step 8: Run the full suite and commit**

Run: `npm test`
Expected: PASS (no server-side behaviour changed in this task).

```bash
git add public/tickets.js public/index.html public/app.js public/style.css lib/config.mjs config.example.json
git commit -m "feat(tickets): repo-scoped Jira ticket picker that launches one seeded session"
```

---

### Task 6: `lib/srp.mjs` — reservations client

**Files:**
- Create: `lib/srp.mjs`
- Create: `lib/srp.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `boxLabel(record) -> string`
  - `usernameFromToken(accessToken, override) -> string | null`
  - `createSrpClient({baseUrl, refreshToken, username, fetchImpl, timeoutMs}) -> {listReservations(), reserve({description, expectedEndDate, expectedState}), currentUser()}`
  - `listReservations()` → `{boxes: [{box, testbox, status, description, endDate, connectionCommand}]} | {error}`
  - `reserve(...)` → `{ok:true}` | `{queued:true, message}` | `{error}`

- [ ] **Step 1: Write the failing test**

Create `lib/srp.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxLabel, usernameFromToken, createSrpClient } from './srp.mjs';

const BASE = 'https://srp.example.net/api';

// A JWT is header.payload.signature; only the payload is read, never verified.
function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
}

// Scripted fetch: an array of [matcher, response] consumed in order.
function scriptFetch(steps) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    const step = steps.shift();
    if (!step) throw new Error(`unexpected call: ${url}`);
    return { ok: step.status >= 200 && step.status < 300, status: step.status, json: async () => step.payload ?? {} };
  };
  impl.calls = calls;
  return impl;
}

const TOKEN = jwt({ username: 'egecan.sen' });
const minted = { status: 200, payload: { accessToken: TOKEN } };

// ---- boxLabel ----

test('boxLabel: already dc:id passes through, lowercased', () => {
  assert.equal(boxLabel({ testbox: 'x:161' }), 'x:161');
  assert.equal(boxLabel({ testbox: 'X:161' }), 'x:161');
});

test('boxLabel: the joined spellings become dc:id', () => {
  assert.equal(boxLabel({ testbox: 'x161' }), 'x:161');
  assert.equal(boxLabel({ testbox: 'x-161' }), 'x:161');
  assert.equal(boxLabel({ testbox: 'x_161' }), 'x:161');
  assert.equal(boxLabel({ testbox: 'x 161' }), 'x:161');
});

test('boxLabel: an unrecognised shape is passed through untouched', () => {
  // Guessing here would put a plausible-looking WRONG box in the prompt. The
  // prompt is editable precisely so this case stays correctable.
  assert.equal(boxLabel({ testbox: 'preprod-arama-01' }), 'preprod-arama-01');
  assert.equal(boxLabel({}), '');
});

// ---- usernameFromToken ----

test('usernameFromToken: reads the payload, prefers the explicit override', () => {
  assert.equal(usernameFromToken(TOKEN), 'egecan.sen');
  assert.equal(usernameFromToken(TOKEN, 'someone.else'), 'someone.else');
  assert.equal(usernameFromToken(jwt({ sub: 'from.sub' })), 'from.sub');
  assert.equal(usernameFromToken(jwt({ name: 'from.name' })), 'from.name');
  assert.equal(usernameFromToken('not-a-jwt'), null);
});

// ---- client ----

test('listReservations: mints a token once, sends S-Access-Token, maps records', async () => {
  const fetchImpl = scriptFetch([
    minted,
    { status: 200, payload: { data: { records: [{ testbox: 'x161', status: 'OK', description: 'WEBT triage', endDate: '2026-08-18T18:00:00', connectionCommand: 'tb use x161' }], numberOfRecords: 1 } } },
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } },
  ]);
  const srp = createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', fetchImpl });
  const r = await srp.listReservations();
  assert.deepEqual(r.boxes, [{
    box: 'x:161', testbox: 'x161', status: 'OK', description: 'WEBT triage',
    endDate: '2026-08-18T18:00:00', connectionCommand: 'tb use x161',
  }]);
  assert.equal(fetchImpl.calls[0].url, `${BASE}/identification/v1/auth/refresh`);
  assert.deepEqual(fetchImpl.calls[0].body, { refreshToken: 'refresh' });
  assert.ok(fetchImpl.calls[1].url.startsWith(`${BASE}/reservation/v1/records?`));
  assert.ok(fetchImpl.calls[1].url.includes('username=egecan.sen'));
  assert.ok(fetchImpl.calls[1].url.includes('status=OK'));
  assert.equal(fetchImpl.calls[1].headers['S-Access-Token'], TOKEN);
  await srp.listReservations();
  assert.equal(fetchImpl.calls.length, 3, 'the access token is minted once and reused');
});

test('listReservations: accessToken nested under data is accepted', async () => {
  const fetchImpl = scriptFetch([
    { status: 200, payload: { data: { accessToken: TOKEN } } },
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } },
  ]);
  const r = await createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', fetchImpl }).listReservations();
  assert.deepEqual(r.boxes, []);
});

test('a 401 re-mints once and retries; a second 401 gives up with an actionable sentence', async () => {
  const fetchImpl = scriptFetch([
    minted,
    { status: 401, payload: { error: { code: 401, message: 'Invalid token' } } },
    minted,
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } },
  ]);
  const srp = createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', fetchImpl });
  assert.deepEqual((await srp.listReservations()).boxes, []);

  const giveUp = scriptFetch([minted, { status: 401, payload: {} }, minted, { status: 401, payload: {} }]);
  const r = await createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', fetchImpl: giveUp }).listReservations();
  assert.match(r.error, /srpRefreshToken/);
});

test('missing config is a sentence naming the key', async () => {
  assert.match((await createSrpClient({ baseUrl: '', refreshToken: 'r' }).listReservations()).error, /srpBaseUrl/);
  assert.match((await createSrpClient({ baseUrl: BASE, refreshToken: '' }).listReservations()).error, /srpRefreshToken/);
});

test('an unreachable host reads as unreachable, not as a crash', async () => {
  const boom = async () => { throw new Error('getaddrinfo ENOTFOUND srp.example.net'); };
  const r = await createSrpClient({ baseUrl: BASE, refreshToken: 'r', fetchImpl: boom }).listReservations();
  assert.match(r.error, /SRP unreachable/);
});

test('reserve: posts the SRP shape and reports success', async () => {
  const fetchImpl = scriptFetch([minted, { status: 200, payload: { data: {} } }]);
  const srp = createSrpClient({ baseUrl: BASE, refreshToken: 'r', fetchImpl });
  const r = await srp.reserve({ description: 'SHBDN-1, SHBDN-2', expectedEndDate: '2026-08-18 18:00', expectedState: 5 });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(fetchImpl.calls[1].body, {
    description: 'SHBDN-1, SHBDN-2',
    expectedEndDate: '2026-08-18 18:00',
    status: 'OK',
    expectedState: 5,
    username: 'egecan.sen',
  });
});

test('reserve: 441 and 442 are queued, not failed', async () => {
  for (const status of [441, 442]) {
    const fetchImpl = scriptFetch([minted, { status, payload: { error: { message: 'no free box' } } }]);
    const r = await createSrpClient({ baseUrl: BASE, refreshToken: 'r', fetchImpl })
      .reserve({ description: 'd', expectedEndDate: 'x', expectedState: 5 });
    assert.equal(r.queued, true, `${status} must read as queued`);
    assert.match(r.message, /no free box/);
  }
});

test('reserve: a server error carries SRPs own message', async () => {
  const fetchImpl = scriptFetch([minted, { status: 500, payload: { error: { message: 'pool manager down' } } }]);
  const r = await createSrpClient({ baseUrl: BASE, refreshToken: 'r', fetchImpl })
    .reserve({ description: 'd', expectedEndDate: 'x', expectedState: 5 });
  assert.match(r.error, /pool manager down/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/srp.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/srp.mjs'`

- [ ] **Step 3: Write the implementation**

Create `lib/srp.mjs`:

```js
// lib/srp.mjs — the user's reserved testboxes, read from SRP
//
// SRP is the reservation portal (srp.ngntest.sahibindenlocal.net): a JSON API
// behind the header `S-Access-Token`, with the envelope
// {data, error:{code,message}}. Forest reads reservations and can create one.
// It never revokes, cancels or extends — freeing a shared box by misclick
// during someone's run costs more than the convenience is worth.
//
// Same contract as jira.mjs: nothing throws, every failure is a sentence, and
// fetch is injected so the whole module tests without a network.

const trimSlashes = (s) => String(s ?? '').replace(/\/+$/, '');

const RECORDS = 'reservation/v1/records';
const REFRESH = 'identification/v1/auth/refresh';

// SRP's own `testbox` value, normalised to the `dc:id` form the Hektor skills
// expect. An unrecognised shape is passed through UNCHANGED: a plausible
// looking wrong box in the prompt is worse than an odd-looking right one, and
// the prompt is editable before launch.
export function boxLabel(record) {
  const raw = String(record?.testbox ?? '').trim();
  if (!raw) return '';
  if (/^[a-z]+:\d+$/i.test(raw)) return raw.toLowerCase();
  const m = raw.match(/^([a-z]+)[-_ ]?(\d+)$/i);
  return m ? `${m[1].toLowerCase()}:${m[2]}` : raw;
}

// Payload-only decode. Validating the signature is the server's job; forest
// only needs the name to ask "which reservations are mine".
export function usernameFromToken(accessToken, override = '') {
  if (override) return override;
  try {
    const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf8'));
    for (const k of ['username', 'sub', 'name']) {
      if (typeof payload[k] === 'string' && payload[k].trim()) return payload[k].trim();
    }
  } catch { /* not a JWT we can read */ }
  return null;
}

const messageOf = (data, fallback) => String(data?.error?.message || fallback);

export function createSrpClient({ baseUrl, refreshToken, username = '', fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const base = trimSlashes(baseUrl);
  let access = null; // minted on first use, re-minted once on a 401

  async function mint() {
    const res = await fetchImpl(`${base}/${REFRESH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return data?.accessToken || data?.data?.accessToken || null;
  }

  const netError = (e) => (e && (e.name === 'AbortError' || e.name === 'TimeoutError')
    ? { error: 'SRP request timed out' }
    : { error: `SRP unreachable (${e && e.message ? e.message : e}) — on the VPN?` });

  // Mint before anything else, because the username this client queries by
  // lives INSIDE the access token. One round trip, not a probe request.
  async function ensureAccess() {
    if (!base) return { error: 'set srpBaseUrl in config.json to read testbox reservations' };
    if (!refreshToken) return { error: 'set srpRefreshToken (or FOREST_SRP_REFRESH_TOKEN) to read testbox reservations' };
    if (access) return { ok: true };
    try { access = await mint(); } catch (e) { return netError(e); }
    if (!access) return { error: 'SRP rejected the token — paste a fresh srpRefreshToken into config.json' };
    return { ok: true };
  }

  // -> { ok, status, data } | { error }. Assumes ensureAccess() already ran.
  // Handles the one re-mint: a token expires far more often than it is wrong,
  // and a user who has to restart forest for that would rightly call it broken.
  async function call(method, path, { params = null, body = null } = {}, allowRemint = true) {
    try {
      const qs = params ? `?${new URLSearchParams(params)}` : '';
      const res = await fetchImpl(`${base}/${path}${qs}`, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'S-Access-Token': access },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && allowRemint) {
        access = null;
        const again = await ensureAccess();
        if (again.error) return again;
        return call(method, path, { params, body }, false);
      }
      if (res.status === 401) return { error: 'SRP rejected the token — paste a fresh srpRefreshToken into config.json' };
      return { status: res.status, ok: res.ok, data };
    } catch (e) { return netError(e); }
  }

  function currentUser() { return usernameFromToken(access, username); }

  return {
    currentUser,

    // -> { boxes: [...] } | { error }
    async listReservations() {
      const auth = await ensureAccess();
      if (auth.error) return { error: auth.error };
      const user = currentUser();
      if (!user) return { error: 'could not read your SRP username from the token — set srpUsername in config.json' };
      const r = await call('GET', RECORDS, { params: { username: user, status: 'OK', page: 0, pageSize: 50 } });
      if (r.error) return { error: r.error };
      if (!r.ok) return { error: messageOf(r.data, `SRP returned ${r.status}`) };
      const records = r.data?.data?.records ?? [];
      return {
        boxes: records.map((rec) => ({
          box: boxLabel(rec),
          testbox: rec.testbox ?? '',
          status: rec.status ?? '',
          description: rec.description ?? '',
          endDate: rec.endDate ?? rec.expectedEndDate ?? null,
          connectionCommand: rec.connectionCommand ?? '',
        })).filter((b) => b.box),
      };
    },

    // -> { ok: true } | { queued: true, message } | { error }
    async reserve({ description, expectedEndDate, expectedState = 5 }) {
      const auth = await ensureAccess();
      if (auth.error) return { error: auth.error };
      const user = currentUser();
      if (!user) return { error: 'could not read your SRP username from the token — set srpUsername in config.json' };
      const r = await call('POST', RECORDS, { body: { description, expectedEndDate, status: 'OK', expectedState, username: user } });
      if (r.error) return { error: r.error };
      // 441/442 are SRP's queue codes: the request stands, there is just no
      // free box yet.
      if (r.status === 441 || r.status === 442) return { queued: true, message: messageOf(r.data, 'queued, waiting for a box') };
      if (!r.ok) return { error: messageOf(r.data, `SRP returned ${r.status}`) };
      return { ok: true };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/srp.test.mjs`
Expected: PASS (12 tests). Each scripted `fetchImpl` is consumed exactly: one
mint plus one API call per operation, and one extra mint+retry pair on the 401
path.

- [ ] **Step 5: Commit**

```bash
git add lib/srp.mjs lib/srp.test.mjs
git commit -m "feat(srp): read testbox reservations, create one, never release"
```

---

### Task 7: `/api/srp/boxes` and `/api/srp/reserve` routes

**Files:**
- Modify: `lib/config.mjs` (`srpBaseUrl`, `srpRefreshToken`, `srpUsername`, `SECRET_KEYS`)
- Modify: `lib/config.test.mjs` (secret stripping)
- Modify: `lib/actions.mjs` (import, factory dep, two routes)
- Modify: `lib/actions.test.mjs`
- Modify: `config.example.json`

**Interfaces:**
- Consumes: `createSrpClient` from Task 6.
- Produces:
  - `POST /api/srp/boxes {}` → `{ok:true, boxes, source:'srp'}` | `{ok:true, boxes, source:'config', reason}`
  - `POST /api/srp/reserve {description, expectedEndDate, expectedState}` → `{ok:true}` | `{queued:true, message}` | `{error}`
  - New `createActionHandler` dep: `srpClient` (a factory taking the config).

- [ ] **Step 1: Write the failing test**

Append to `lib/actions.test.mjs`:

```js
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

const callSrp = (url, body, deps, ctx = srpCtx()) => {
  const res = fakeRes();
  return createActionHandler(deps)({ url }, res, ctx, async () => body).then(() => res);
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
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.source, 'config');
  assert.deepEqual(body.boxes, [{ box: 'x:999' }]);
  assert.match(body.reason, /unreachable/, 'the ticket half of the modal must keep working, with the reason visible');
});

test('/api/srp/boxes: no SRP config falls back without pretending to have called it', async () => {
  const res = await callSrp('/api/srp/boxes', {}, {}, srpCtx({ srpRefreshToken: '' }));
  const body = JSON.parse(res.body);
  assert.equal(body.source, 'config');
  assert.match(body.reason, /srpRefreshToken/);
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
```

Append to `lib/config.test.mjs`:

```js
test('publicConfig strips the SRP refresh token as well as the Jira token', async () => {
  const { mergeConfig, publicConfig } = await import('./config.mjs');
  const pub = publicConfig(mergeConfig({ jiraToken: 'j', srpRefreshToken: 's', srpBaseUrl: 'https://srp/api' }));
  assert.equal(pub.jiraToken, undefined);
  assert.equal(pub.srpRefreshToken, undefined);
  assert.equal(pub.srpBaseUrl, 'https://srp/api', 'the base url is not a secret and the modal needs it');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/actions.test.mjs lib/config.test.mjs`
Expected: FAIL — routes 404; `srpRefreshToken` is not stripped.

- [ ] **Step 3: Implement — `lib/config.mjs`**

Add to `DEFAULTS`:

```js
  // SRP — the testbox reservation portal. The refresh token is pasted once
  // from SRP's own localStorage; forest exchanges it for a short-lived access
  // token in memory, so no LDAP password is ever stored.
  srpBaseUrl: process.env.FOREST_SRP_URL || '',
  srpRefreshToken: process.env.FOREST_SRP_REFRESH_TOKEN || '',
  // Normally read out of the access token; set only if that fails.
  srpUsername: process.env.FOREST_SRP_USERNAME || '',
```

and extend the secret list:

```js
const SECRET_KEYS = ['jiraToken', 'srpRefreshToken'];
```

- [ ] **Step 4: Implement — `lib/actions.mjs`**

Import and dependency:

```js
import { createSrpClient } from './srp.mjs';
```

```js
export function createActionHandler({
  launch = launchInteractive, resolveScope = resolveSessionScope,
  submitBranch = submitBranchField, readBranch = readBranchField,
  searchTickets = searchIssues, searchPeople = searchUsers, whoami = me,
  srpClient = createSrpClient,
} = {}) {
```

Routes, after the `/api/jira/people` block:

```js
      // The Tickets modal's box list. This route never fails: a box list is
      // not worth breaking a ticket picker over, so every SRP problem
      // degrades to config.testboxes with the reason attached.
      if (url === '/api/srp/boxes') {
        const fallback = {
          ok: true, source: 'config',
          boxes: (ctx.config.testboxes || []).map((box) => ({ box })),
        };
        if (!ctx.config.srpBaseUrl || !ctx.config.srpRefreshToken) {
          return sendJson(res, { ...fallback, reason: 'set srpBaseUrl and srpRefreshToken in config.json to read your reservations' });
        }
        const client = srpClient({
          baseUrl: ctx.config.srpBaseUrl, refreshToken: ctx.config.srpRefreshToken, username: ctx.config.srpUsername,
        });
        const r = await client.listReservations();
        if (r.error) return sendJson(res, { ...fallback, reason: r.error });
        return sendJson(res, { ok: true, source: 'srp', boxes: r.boxes });
      }

      if (url === '/api/srp/reserve') {
        const description = String(body.description ?? '').trim();
        const expectedEndDate = String(body.expectedEndDate ?? '').trim();
        if (!description) return sendJson(res, { error: 'a reservation needs a description' }, 400);
        if (!expectedEndDate) return sendJson(res, { error: 'a reservation needs an end date' }, 400);
        const client = srpClient({
          baseUrl: ctx.config.srpBaseUrl, refreshToken: ctx.config.srpRefreshToken, username: ctx.config.srpUsername,
        });
        ctx.journal.add({ cmd: `srp: reserve a box for ${description}`, cwd: ctx.forestRoot, mode });
        const r = await client.reserve({ description, expectedEndDate, expectedState: Number(body.expectedState ?? 5) });
        if (r.error) return sendJson(res, { error: r.error });
        if (r.queued) return sendJson(res, { ok: true, queued: true, message: r.message });
        return sendJson(res, { ok: true });
      }
```

- [ ] **Step 5: Document the keys in `config.example.json`**

```json
  "srpBaseUrl": "https://srp.ngntest.sahibindenlocal.net/api",
  "srpRefreshToken": "",
  "srpUsername": "",
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/config.mjs lib/config.test.mjs lib/actions.mjs lib/actions.test.mjs config.example.json
git commit -m "feat(actions): /api/srp/boxes and /api/srp/reserve, with config fallback"
```

---

### Task 8: The modal's box row switches to SRP, with inline reserve

**Files:**
- Modify: `public/tickets.js` (`renderBoxes`, plus a reserve form)
- Modify: `public/style.css` (append to the tickets block)

**Interfaces:**
- Consumes: `POST /api/srp/boxes`, `POST /api/srp/reserve` (Task 7).
- Produces: nothing new — the launch path is unchanged.

- [ ] **Step 1: Replace `renderBoxes` in `public/tickets.js`**

Add module state beside the others:

```js
let boxes = [];        // [{ box, description, endDate, … }]
let boxSource = 'config';
```

Replace the whole `renderBoxes` function with a loader and a renderer:

```js
async function loadBoxes() {
  $('#tk-boxes').innerHTML = '<div class="tk-empty">reading your SRP reservations…</div>';
  const r = await D.api('/api/srp/boxes', {});
  boxes = (r && r.boxes) || [];
  boxSource = (r && r.source) || 'config';
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(boxKey(target.repoPath))) || []; } catch { saved = []; }
  const live = new Set(boxes.map((b) => b.box));
  saved.filter((b) => live.has(b)).forEach((b) => pickedBoxes.add(b));
  renderBoxes(r && r.reason);
  renderFooter();
}

function renderBoxes(reason) {
  const head = `<div class="tk-boxes-h">Boxes ${boxSource === 'srp' ? '(SRP)' : '(config fallback)'}</div>`;
  const note = reason ? `<div class="tk-empty">${D.esc(reason)}</div>` : '';
  if (!boxes.length) {
    $('#tk-boxes').innerHTML = head + note + reserveFormHtml();
    wireReserve();
    return;
  }
  $('#tk-boxes').innerHTML = head + note + boxes.map((b) => `<label class="tk-box">
      <input type="checkbox" class="tk-box-cb" data-box="${D.esc(b.box)}" ${pickedBoxes.has(b.box) ? 'checked' : ''} />
      <span>${D.esc(b.box)}</span>
      ${b.endDate ? `<span class="tk-dim">until ${D.esc(String(b.endDate).replace('T', ' ').slice(0, 16))}</span>` : ''}
      ${b.description ? `<span class="tk-dim">${D.esc(b.description)}</span>` : ''}
    </label>`).join('');
}

// Offered only when the user holds nothing: reserving a shared resource is an
// explicit act, never a side effect of opening a modal.
function reserveFormHtml() {
  const end = new Date();
  end.setHours(18, 0, 0, 0);
  const stamp = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')} 18:00`;
  return `<div class="tk-reserve">
    <input id="tk-res-desc" type="text" value="${D.esc([...pickedTickets].join(', '))}" placeholder="what is this box for" />
    <input id="tk-res-end" type="text" value="${D.esc(stamp)}" title="expected end date" />
    <select id="tk-res-state">
      <option value="5" selected>Data Sane</option>
      <option value="4">Data Inserted</option>
      <option value="3">Data Updated</option>
      <option value="2">On</option>
      <option value="1">Off</option>
    </select>
    <button id="tk-res-go" class="btn-ghost" type="button">Reserve a box</button>
  </div>`;
}

function wireReserve() {
  const go = $('#tk-res-go');
  if (!go) return;
  go.onclick = async () => {
    const description = $('#tk-res-desc').value.trim();
    if (!description) { D.toast('a reservation needs a description'); return; }
    go.disabled = true;
    const r = await D.api('/api/srp/reserve', {
      description,
      expectedEndDate: $('#tk-res-end').value.trim(),
      expectedState: Number($('#tk-res-state').value),
    });
    go.disabled = false;
    if (r && r.error) { D.toast(`Error: ${r.error}`); return; }
    D.toast(r && r.queued ? `SRP: ${r.message}` : 'Reserved — refreshing your boxes');
    setTimeout(loadBoxes, 1500);
  };
}
```

In `openTickets`, replace the `renderBoxes();` call with `await loadBoxes();`, and in `initTickets` extend the ↻ handler so it refreshes both halves:

```js
  $('#tk-refresh').onclick = () => { load({ refresh: true }); loadBoxes(); };
```

- [ ] **Step 2: Styles**

Append to `public/style.css`:

```css
.tk-reserve { display: flex; align-items: center; gap: 8px; width: 100%; flex-wrap: wrap; }
.tk-reserve input, .tk-reserve select { padding: 6px 9px; font: 12px var(--font-mono); color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
.tk-reserve #tk-res-desc { flex: 1; min-width: 180px; }
```

- [ ] **Step 3: Verify in the browser**

Run: `npm start`, open the Tickets modal on `web-test`.

Check:
1. With `srpRefreshToken` unset: the header reads `Boxes (config fallback)`, the reason names the missing key, and `config.testboxes` are listed and selectable.
2. With a real `srpRefreshToken` in `config.json` (restart the server after editing): the header reads `Boxes (SRP)` and your actual reservations appear with their end dates.
3. **Confirm the box labels.** If a label does not read as `dc:id` (e.g. `x:161`), that is the case Task 6's `boxLabel` deliberately passes through — read the real `testbox` value from the response in DevTools' Network tab, then update the regex and its test in `lib/srp.mjs` / `lib/srp.test.mjs`.
4. Hold no reservations (or point at a user who holds none): the reserve row appears, prefilled with the selected ticket keys.
5. Console: no errors.

- [ ] **Step 4: Run the full suite and commit**

Run: `npm test`

```bash
git add public/tickets.js public/style.css
git commit -m "feat(tickets): boxes come from SRP reservations, with inline reserve"
```

---

## Verification

After Task 8, the end-to-end path is: `tickets` on a repo header → person → Sprint/Backlog → tick two tickets → tick two SRP boxes → the prompt preview shows the multi-ticket form → **Start multi-ticket session** → a Terminal opens in the repo's primary checkout running `claude 'Hektor, multi-ticket: …'` → the skill provisions one worktree per ticket, which appear as forest rows on the next snapshot.

Run once more at the end:

```bash
npm test          # every suite
npm start         # manual pass over the checks in Tasks 5 and 8
```
