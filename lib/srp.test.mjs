import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxLabel, usernameFromToken, createSrpClient, loginSrp, srpDateWindow } from './srp.mjs';

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

// The user's own session lines use `tb108` — boxLabel now discards the
// datacenter letter entirely rather than preserving it, matching what they
// actually type by hand.
test('boxLabel: dc:id becomes tb<id> — the datacenter letter is dropped', () => {
  assert.equal(boxLabel({ testbox: 'x:161' }), 'tb161');
  assert.equal(boxLabel({ testbox: 'X:161' }), 'tb161');
});

test('boxLabel: the joined spellings become tb<id>', () => {
  assert.equal(boxLabel({ testbox: 'x161' }), 'tb161');
  assert.equal(boxLabel({ testbox: 'x-161' }), 'tb161');
  assert.equal(boxLabel({ testbox: 'x_161' }), 'tb161');
  assert.equal(boxLabel({ testbox: 'x 161' }), 'tb161');
});

// A real reservations table, screenshotted by the user, listed `xtbx200`
// (their cookies confirmed `tbSite=x`, `testBox=156` — SRP names a box
// `<dc>tbx<id>`). "tbx" is just more letters to the regex below, so this
// reduces to its trailing digits exactly like every other recognised shape.
test('boxLabel: the tbx infix, observed on a live SRP session, also becomes tb<id>', () => {
  assert.equal(boxLabel({ testbox: 'xtbx200' }), 'tb200');
  // A second datacenter letter: proves the digits, not the letters, are what
  // survive — this collapses to the SAME id a `y:200` reservation would, the
  // deliberate trade-off documented on boxLabel's own comment.
  assert.equal(boxLabel({ testbox: 'ytbx200' }), 'tb200');
});

test('boxLabel: already tb<id> (the shape the user types by hand) is unchanged', () => {
  assert.equal(boxLabel({ testbox: 'tb108' }), 'tb108');
  assert.equal(boxLabel({ testbox: 'TB108' }), 'tb108');
});

test('boxLabel: a name that merely contains "tbx" without the anchored letters+digits shape still passes through', () => {
  // The hyphens break the letters-then-optional-single-separator-then-digits
  // shape the regex requires — "tbx" sits inside a longer, differently-
  // shaped name, so this must fall all the way through to raw pass-through
  // rather than an unanchored search finding "...99" buried in the middle
  // and misreading it as a box id.
  assert.equal(boxLabel({ testbox: 'arama-preprod-tbx-99' }), 'arama-preprod-tbx-99');
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

test('listReservations: mints a token once, sends S-Access-Token, maps records, and pages until a page comes back empty', async () => {
  const fetchImpl = scriptFetch([
    minted,
    { status: 200, payload: { data: { records: [{ testbox: 'x161', status: 'OK', description: 'WEBT triage', endDate: '2026-08-18T18:00:00', connectionCommand: 'tb use x161' }], numberOfRecords: 1 } } },
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } }, // page 1: empty, ends the first call's loop
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } }, // the second top-level call's own page 0
  ]);
  const srp = createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', fetchImpl });
  const r = await srp.listReservations();
  assert.deepEqual(r.boxes, [{
    box: 'tb161', testbox: 'x161', status: 'OK', description: 'WEBT triage',
    endDate: '2026-08-18T18:00:00', connectionCommand: 'tb use x161',
  }]);
  assert.equal(fetchImpl.calls[0].url, `${BASE}/identification/v1/auth/refresh`);
  assert.deepEqual(fetchImpl.calls[0].body, { refreshToken: 'refresh' });
  assert.ok(fetchImpl.calls[1].url.startsWith(`${BASE}/reservation/v1/records?`));
  assert.ok(fetchImpl.calls[1].url.includes('username=egecan.sen'));
  assert.ok(fetchImpl.calls[1].url.includes('status=OK'));
  assert.ok(fetchImpl.calls[1].url.includes('page=0'));
  assert.ok(fetchImpl.calls[2].url.includes('page=1'), 'a non-empty page must fetch the next page');
  assert.equal(fetchImpl.calls[1].headers['S-Access-Token'], TOKEN);
  await srp.listReservations();
  assert.equal(fetchImpl.calls.length, 4, 'the access token is minted once and reused; the first call paged twice (1 record then empty), the second paged once (empty)');
});

// A live SRP session showed this exact failure before the fix: an empty
// date param hit SRP's Go backend as `parsing time "" as
// "2006-01-02T15:04:05Z07:00": cannot parse "" as "2006"`, so nobody ever
// saw a testbox.
test('srpDateWindow: one calendar year either side of the injected now, SRP\'s own local-offset format', () => {
  const fixedNow = new Date(2026, 7, 18, 17, 39, 38, 123).getTime(); // Aug 18 2026, local wall-clock
  const { startDate, endDate } = srpDateWindow(fixedNow);
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;
  assert.match(startDate, shape, 'must be local time + milliseconds + a colon-separated offset, never a literal Z');
  assert.match(endDate, shape);
  assert.equal(startDate.slice(0, 10), '2025-08-18', 'one year before the injected now');
  assert.equal(endDate.slice(0, 10), '2027-08-18', 'one year after the injected now');
});

test('listReservations: sends the date window and an empty testbox, not the empty defaults that made SRP 400', async () => {
  const fixedNow = new Date(2026, 7, 18, 17, 39, 38, 123).getTime();
  const fetchImpl = scriptFetch([minted, { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } }]);
  const srp = createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', fetchImpl, nowMs: () => fixedNow });
  await srp.listReservations();
  const url = new URL(fetchImpl.calls[1].url);
  const { startDate, endDate } = srpDateWindow(fixedNow);
  assert.equal(url.searchParams.get('startDate'), startDate);
  assert.equal(url.searchParams.get('endDate'), endDate);
  assert.equal(url.searchParams.get('testbox'), '', 'sent, empty — SRP expects the key present');
  assert.equal(url.searchParams.get('status'), 'OK');
  assert.equal(url.searchParams.get('page'), '0');
  assert.equal(url.searchParams.get('pageSize'), '50');
});

test('concurrent operations share one in-flight mint, not one each', async () => {
  // listReservations() and reserve() fired from the modal in the same tick,
  // neither awaiting the other, must not each mint their own token: the
  // script has exactly one mint plus one record-fetch per call — a fourth
  // call (a second mint) would starve the queue and throw "unexpected call".
  const fetchImpl = scriptFetch([
    minted,
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } },
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } },
  ]);
  const srp = createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', fetchImpl });
  const [a, b] = await Promise.all([srp.listReservations(), srp.listReservations()]);
  assert.deepEqual(a.boxes, []);
  assert.deepEqual(b.boxes, []);
  assert.equal(fetchImpl.calls[0].url, `${BASE}/identification/v1/auth/refresh`);
  assert.equal(fetchImpl.calls.length, 3, 'exactly one refresh call, shared by both operations');
});

test('listReservations: accessToken nested under data is accepted', async () => {
  const fetchImpl = scriptFetch([
    { status: 200, payload: { data: { accessToken: TOKEN } } },
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } },
  ]);
  const r = await createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', fetchImpl }).listReservations();
  assert.deepEqual(r.boxes, []);
});

test('listReservations: a malformed records field (not an array) reads as no boxes, never a throw', async () => {
  // A 2xx response whose data.data.records is not an array must not escape
  // as an unhandled throw — /api/srp/boxes promises it will never fail, and
  // that promise is only as good as this module's own defenses.
  const fetchImpl = scriptFetch([
    minted,
    { status: 200, payload: { data: { records: { not: 'an array' } } } },
  ]);
  const r = await createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', fetchImpl }).listReservations();
  assert.deepEqual(r, { boxes: [] });
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

// ---- accessToken seeding (Task 9 follow-up: the bookmarklet hands over
// SRP's own access token too, not just the refresh token) ----

test('a seeded accessToken skips the mint round trip entirely', async () => {
  const fetchImpl = scriptFetch([
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } },
  ]);
  const srp = createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', accessToken: TOKEN, fetchImpl });
  const r = await srp.listReservations();
  assert.deepEqual(r.boxes, []);
  assert.equal(fetchImpl.calls.length, 1, 'no mint call — only the records fetch');
  assert.equal(fetchImpl.calls[0].headers['S-Access-Token'], TOKEN);
});

test('a seeded accessToken works even when its paired refresh token is blank — the first call never needs it', async () => {
  const fetchImpl = scriptFetch([
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } },
  ]);
  const srp = createSrpClient({ baseUrl: BASE, refreshToken: '', accessToken: TOKEN, fetchImpl });
  const r = await srp.listReservations();
  assert.deepEqual(r.boxes, []);
  assert.equal(fetchImpl.calls.length, 1);
});

// Seeded tokens must be shaped like real JWTs in these two tests: SRP's
// rejection (401) is what makes a token "stale", not its shape — forest still
// reads a username out of it locally before ever calling the API, so a
// non-JWT stand-in fails at that earlier step instead of exercising the 401
// path this test is actually about.
const STALE_TOKEN = jwt({ username: 'egecan.sen', stale: true });

test('a seeded accessToken that 401s clears and re-mints exactly once from refreshToken', async () => {
  const fetchImpl = scriptFetch([
    { status: 401, payload: { error: { code: 401, message: 'Invalid token' } } },
    minted,
    { status: 200, payload: { data: { records: [], numberOfRecords: 0 } } },
  ]);
  const srp = createSrpClient({ baseUrl: BASE, refreshToken: 'refresh', accessToken: STALE_TOKEN, fetchImpl });
  const r = await srp.listReservations();
  assert.deepEqual(r.boxes, []);
  assert.equal(fetchImpl.calls.length, 3, 'the stale seeded token 401s once, then one mint, then the retried call');
  assert.equal(fetchImpl.calls[0].headers['S-Access-Token'], STALE_TOKEN);
  assert.equal(fetchImpl.calls[2].headers['S-Access-Token'], TOKEN);
});

test('a seeded accessToken that 401s, whose refresh token is also rejected, gives up with the bookmarklet sentence', async () => {
  const fetchImpl = scriptFetch([
    { status: 401, payload: {} },
    { status: 401, payload: {} }, // the re-mint attempt itself is refused
  ]);
  const srp = createSrpClient({ baseUrl: BASE, refreshToken: 'stale-refresh', accessToken: STALE_TOKEN, fetchImpl });
  const r = await srp.listReservations();
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(r.error, /reconnect via the bookmarklet/);
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

// ---- loginSrp (Task 9, round 3: log in once inside forest) ----

test('loginSrp: posts to identification/v1/auth/login with the username/password body', async () => {
  const fetchImpl = scriptFetch([{ status: 200, payload: { data: { accessToken: 'a1', refreshToken: 'r1' } } }]);
  const r = await loginSrp({ baseUrl: BASE, username: 'ege', password: 'hunter2', fetchImpl });
  assert.deepEqual(r, { accessToken: 'a1', refreshToken: 'r1' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, `${BASE}/identification/v1/auth/login`);
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.deepEqual(fetchImpl.calls[0].body, { username: 'ege', password: 'hunter2' });
});

test('loginSrp: accepts tokens nested under data.data (SRP\'s own envelope: {data, error})', async () => {
  const fetchImpl = scriptFetch([{ status: 200, payload: { data: { accessToken: 'a2', refreshToken: 'r2' } } }]);
  const r = await loginSrp({ baseUrl: BASE, username: 'ege', password: 'hunter2', fetchImpl });
  assert.deepEqual(r, { accessToken: 'a2', refreshToken: 'r2' });
});

test('loginSrp: accepts tokens at the root of the response', async () => {
  const fetchImpl = scriptFetch([{ status: 200, payload: { accessToken: 'a3', refreshToken: 'r3' } }]);
  const r = await loginSrp({ baseUrl: BASE, username: 'ege', password: 'hunter2', fetchImpl });
  assert.deepEqual(r, { accessToken: 'a3', refreshToken: 'r3' });
});

test('loginSrp: 401 and 403 both read as a credentials-rejected sentence', async () => {
  for (const status of [401, 403]) {
    const fetchImpl = scriptFetch([{ status, payload: { error: { message: 'nope' } } }]);
    const r = await loginSrp({ baseUrl: BASE, username: 'ege', password: 'wrong', fetchImpl });
    assert.match(r.error, /SRP rejected those credentials/);
  }
});

test('loginSrp: another failing status carries SRPs own message, or falls back to the status', async () => {
  const withMessage = scriptFetch([{ status: 500, payload: { error: { message: 'auth service down' } } }]);
  assert.match((await loginSrp({ baseUrl: BASE, username: 'ege', password: 'p', fetchImpl: withMessage })).error, /auth service down/);
  const withoutMessage = scriptFetch([{ status: 503, payload: {} }]);
  assert.match((await loginSrp({ baseUrl: BASE, username: 'ege', password: 'p', fetchImpl: withoutMessage })).error, /SRP returned 503/);
});

test('loginSrp: a network throw reads as unreachable, not a crash', async () => {
  const boom = async () => { throw new Error('getaddrinfo ENOTFOUND srp.example.net'); };
  const r = await loginSrp({ baseUrl: BASE, username: 'ege', password: 'p', fetchImpl: boom });
  assert.match(r.error, /SRP unreachable/);
});

test('loginSrp: missing srpBaseUrl names the key, and never touches the network', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  const r = await loginSrp({ baseUrl: '', username: 'ege', password: 'p', fetchImpl });
  assert.match(r.error, /srpBaseUrl/);
});

test('loginSrp: a 2xx response with no tokens in either shape is a sentence, not a throw', async () => {
  const fetchImpl = scriptFetch([{ status: 200, payload: { data: {} } }]);
  const r = await loginSrp({ baseUrl: BASE, username: 'ege', password: 'p', fetchImpl });
  assert.ok(r.error, 'must not silently resolve with undefined tokens');
});
