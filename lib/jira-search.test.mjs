import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sprintJql, backlogJql, searchIssues, searchUsers, me, createTicketCache, fetchIssueDetail } from './jira-search.mjs';

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

// ---- fetchIssueDetail (the Cursor-brief round: summary + description in one call) ----

test('fetchIssueDetail: fetches summary,description on the single-issue endpoint', async () => {
  const fetchImpl = fakeFetch({ key: 'SHBDN-1', fields: { summary: 'Fix the thing', description: 'Steps to reproduce:\n1. Do X' } });
  const r = await fetchIssueDetail('SHBDN-1', { ...OPTS, fetchImpl });
  assert.deepEqual(r, { summary: 'Fix the thing', description: 'Steps to reproduce:\n1. Do X' });
  assert.match(fetchImpl.calls[0].url, /\/rest\/api\/2\/issue\/SHBDN-1\?fields=summary%2Cdescription/);
});

test('fetchIssueDetail: a missing description field reads as empty, not a throw', async () => {
  const fetchImpl = fakeFetch({ key: 'SHBDN-1', fields: { summary: 'Fix the thing' } });
  const r = await fetchIssueDetail('SHBDN-1', { ...OPTS, fetchImpl });
  assert.deepEqual(r, { summary: 'Fix the thing', description: '' });
});

test('fetchIssueDetail: a Jira error status degrades to a sentence, never throws', async () => {
  const fetchImpl = fakeFetch({}, { status: 404 });
  const r = await fetchIssueDetail('SHBDN-999', { ...OPTS, fetchImpl });
  assert.match(r.error, /404/);
});

test('fetchIssueDetail: no key, no baseUrl, no token are each a named sentence, no network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  assert.match((await fetchIssueDetail('', { ...OPTS, fetchImpl })).error, /ticket key/);
  assert.match((await fetchIssueDetail('SHBDN-1', { token: 'pat', email: '', fetchImpl })).error, /jiraBaseUrl/);
  assert.match((await fetchIssueDetail('SHBDN-1', { baseUrl: OPTS.baseUrl, email: '', fetchImpl })).error, /jiraToken/);
  assert.equal(called, false);
});

test('fetchIssueDetail: a network throw reads as a sentence, not a crash', async () => {
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND jira.example.com'); };
  const r = await fetchIssueDetail('SHBDN-1', { ...OPTS, fetchImpl });
  assert.match(r.error, /ENOTFOUND/);
});
