import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jiraKey, browseUrl, composeDescription, fetchSummary, createSummaryCache, submitBranchField, readBranchField } from './jira.mjs';

// ---- jiraKey ----

test('jiraKey: re-keys the number onto the configured project', () => {
  assert.equal(jiraKey('WEBT-229553', 'SHBDN'), 'SHBDN-229553');
  assert.equal(jiraKey('SUI-238145', 'SHBDN'), 'SHBDN-238145');
});

test('jiraKey: passes the ticket through when no project key is configured', () => {
  assert.equal(jiraKey('WEBT-229553', ''), 'WEBT-229553');
  assert.equal(jiraKey('WEBT-229553', undefined), 'WEBT-229553');
});

test('jiraKey: already-correct keys survive a rewrite unchanged', () => {
  assert.equal(jiraKey('SHBDN-229553', 'SHBDN'), 'SHBDN-229553');
});

test('jiraKey: null ticket stays null', () => {
  assert.equal(jiraKey(null, 'SHBDN'), null);
  assert.equal(jiraKey('', 'SHBDN'), null);
});

test('jiraKey: a ticket with no trailing number is not rewritten', () => {
  // Nothing to re-key onto — inventing "SHBDN-undefined" would be worse than
  // leaving the value alone and letting the fetch 404 honestly.
  assert.equal(jiraKey('RELEASE', 'SHBDN'), 'RELEASE');
});

// ---- browseUrl ----

test('browseUrl: joins base and key', () => {
  assert.equal(
    browseUrl('https://jira.sahibinden.com', 'SHBDN-229553'),
    'https://jira.sahibinden.com/browse/SHBDN-229553',
  );
});

test('browseUrl: tolerates a trailing slash on the base', () => {
  assert.equal(
    browseUrl('https://jira.sahibinden.com///', 'SHBDN-229553'),
    'https://jira.sahibinden.com/browse/SHBDN-229553',
  );
});

test('browseUrl: null when either half is missing', () => {
  assert.equal(browseUrl('', 'SHBDN-1'), null);
  assert.equal(browseUrl('https://jira.example.com', null), null);
});

// ---- composeDescription ----

test('composeDescription: title line then link line', () => {
  const text = composeDescription({
    summary: 'CI - Ödeme Sayfası Kart ile Öde Componenti Dil Desteği - Arama',
    url: 'https://jira.sahibinden.com/browse/SHBDN-229553',
  });
  assert.equal(
    text,
    'CI - Ödeme Sayfası Kart ile Öde Componenti Dil Desteği - Arama\nhttps://jira.sahibinden.com/browse/SHBDN-229553',
  );
});

test('composeDescription: link alone when the summary is unavailable', () => {
  const url = 'https://jira.sahibinden.com/browse/SHBDN-229553';
  assert.equal(composeDescription({ summary: null, url }), url);
  assert.equal(composeDescription({ summary: '   ', url }), url);
});

test('composeDescription: empty for a branch with no ticket', () => {
  assert.equal(composeDescription({ summary: null, url: null }), '');
});

// ---- fetchSummary ----

const OK = (summary) => async () => ({
  ok: true, status: 200, json: async () => ({ fields: { summary } }),
});
const STATUS = (status) => async () => ({ ok: false, status, json: async () => ({}) });

test('fetchSummary: returns the summary and calls the right URL with a Bearer token', async () => {
  const calls = [];
  const r = await fetchSummary('SHBDN-229553', {
    baseUrl: 'https://jira.sahibinden.com/',
    token: 'pat-123',
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return (await OK('Kart ile Öde')(url, opts)); },
  });
  assert.deepEqual(r, { summary: 'Kart ile Öde' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://jira.sahibinden.com/rest/api/2/issue/SHBDN-229553?fields=summary');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer pat-123');
  assert.equal(calls[0].opts.headers.Accept, 'application/json');
});

test('fetchSummary: uses Basic auth when an email is configured', async () => {
  let seen = null;
  await fetchSummary('SHBDN-1', {
    baseUrl: 'https://x.atlassian.net',
    token: 'tok',
    email: 'me@example.com',
    fetchImpl: async (url, opts) => { seen = opts.headers.Authorization; return OK('t')(); },
  });
  assert.equal(seen, `Basic ${Buffer.from('me@example.com:tok').toString('base64')}`);
});

test('fetchSummary: unconfigured base URL and token are named, not thrown', async () => {
  const noBase = await fetchSummary('SHBDN-1', { baseUrl: '', token: 't', fetchImpl: OK('x') });
  assert.match(noBase.error, /jiraBaseUrl/);
  const noToken = await fetchSummary('SHBDN-1', { baseUrl: 'https://j', token: '', fetchImpl: OK('x') });
  assert.match(noToken.error, /jiraToken/);
});

test('fetchSummary: no key is not an error, just nothing to fetch', async () => {
  const r = await fetchSummary(null, { baseUrl: 'https://j', token: 't', fetchImpl: OK('x') });
  assert.deepEqual(r, { summary: null });
});

test('fetchSummary: 401 reports rejected credentials', async () => {
  const r = await fetchSummary('SHBDN-1', { baseUrl: 'https://j', token: 't', fetchImpl: STATUS(401) });
  assert.match(r.error, /credentials/);
  assert.match(r.error, /401/);
});

test('fetchSummary: 404 names the missing issue', async () => {
  const r = await fetchSummary('SHBDN-229553', { baseUrl: 'https://j', token: 't', fetchImpl: STATUS(404) });
  assert.match(r.error, /SHBDN-229553/);
  assert.match(r.error, /not found/);
});

test('fetchSummary: an unexpected status is reported verbatim', async () => {
  const r = await fetchSummary('SHBDN-1', { baseUrl: 'https://j', token: 't', fetchImpl: STATUS(500) });
  assert.match(r.error, /500/);
});

test('fetchSummary: a 200 with no summary field is not a crash', async () => {
  const r = await fetchSummary('SHBDN-1', {
    baseUrl: 'https://j', token: 't',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ fields: {} }) }),
  });
  assert.deepEqual(r, { summary: null });
});

test('fetchSummary: a thrown network error becomes an error string', async () => {
  const r = await fetchSummary('SHBDN-1', {
    baseUrl: 'https://j', token: 't',
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND jira'); },
  });
  assert.match(r.error, /ENOTFOUND/);
});

test('fetchSummary: an abort is reported as a timeout', async () => {
  const r = await fetchSummary('SHBDN-1', {
    baseUrl: 'https://j', token: 't',
    fetchImpl: async () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; },
  });
  assert.match(r.error, /timed out/);
});

// ---- createSummaryCache ----

test('summary cache: a hit does not re-fetch', async () => {
  const cache = createSummaryCache();
  let calls = 0;
  const opts = { baseUrl: 'https://j', token: 't', fetchImpl: async () => { calls++; return OK('Title')(); } };
  assert.deepEqual(await cache.get('SHBDN-1', opts), { summary: 'Title' });
  assert.deepEqual(await cache.get('SHBDN-1', opts), { summary: 'Title' });
  assert.equal(calls, 1);
});

test('summary cache: distinct keys are fetched separately', async () => {
  const cache = createSummaryCache();
  let calls = 0;
  const opts = { baseUrl: 'https://j', token: 't', fetchImpl: async (url) => { calls++; return OK(url)(); } };
  await cache.get('SHBDN-1', opts);
  await cache.get('SHBDN-2', opts);
  assert.equal(calls, 2);
});

test('summary cache: a failure is retried once its ttl expires, not before', async () => {
  let now = 1000;
  const cache = createSummaryCache({ failTtlMs: 60_000, nowMs: () => now });
  let calls = 0;
  const failing = { baseUrl: 'https://j', token: 't', fetchImpl: async () => { calls++; return STATUS(500)(); } };
  await cache.get('SHBDN-1', failing);
  await cache.get('SHBDN-1', failing);
  assert.equal(calls, 1, 'a fresh failure is served from cache');
  now += 60_001;
  await cache.get('SHBDN-1', failing);
  assert.equal(calls, 2, 'an expired failure is retried');
});

test('summary cache: a success is never re-fetched, however old', async () => {
  let now = 1000;
  const cache = createSummaryCache({ failTtlMs: 1, nowMs: () => now });
  let calls = 0;
  const opts = { baseUrl: 'https://j', token: 't', fetchImpl: async () => { calls++; return OK('Title')(); } };
  await cache.get('SHBDN-1', opts);
  now += 10_000_000;
  assert.deepEqual(await cache.get('SHBDN-1', opts), { summary: 'Title' });
  assert.equal(calls, 1);
});

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

// ---- readBranchField ----

test('readBranchField: returns the trimmed value from the right URL', async () => {
  const calls = [];
  const r = await readBranchField('SHBDN-226230', {
    ...CFG, fetchImpl: async (url, opts) => { calls.push({ url, opts }); return FIELD(' tech/WEBT-226230 ')(); },
  });
  assert.deepEqual(r, { value: 'tech/WEBT-226230' });
  assert.equal(calls[0].url, 'https://jira.sahibinden.com/rest/api/2/issue/SHBDN-226230?fields=customfield_10041');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer pat-123');
});

test('readBranchField: empty or whitespace-only reads as null', async () => {
  assert.deepEqual(await readBranchField('SHBDN-1', { ...CFG, fetchImpl: FIELD(null) }), { value: null });
  assert.deepEqual(await readBranchField('SHBDN-1', { ...CFG, fetchImpl: FIELD('   ') }), { value: null });
});

test('readBranchField: statuses, unconfigured pieces and timeouts match the house sentences', async () => {
  assert.match((await readBranchField('SHBDN-9', { ...CFG, fetchImpl: STATUS(404) })).error, /SHBDN-9 not found/);
  assert.match((await readBranchField('SHBDN-1', { ...CFG, fieldId: '' })).error, /jiraBranchFieldId/);
  const timeout = async () => { const e = new Error('x'); e.name = 'TimeoutError'; throw e; };
  assert.match((await readBranchField('SHBDN-1', { ...CFG, fetchImpl: timeout })).error, /timed out/);
});
