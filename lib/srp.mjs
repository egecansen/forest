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
const LOGIN = 'identification/v1/auth/login';
const PAGE_SIZE = 50;
// A defensive cap, not an expected case: SRP's own Overview page pages until
// an empty page, and every real account's reservation history is nowhere
// near this many pages. Without a cap, a server that (by bug) never returns
// an empty page would hang this call forever instead of degrading like every
// other SRP failure here does.
const MAX_PAGES = 200;

// SRP's own timestamp format — local wall-clock time, milliseconds, and a
// colon-separated LOCAL utc offset (`+03:00`), never a literal `Z`. This is
// what the Go RFC3339 layout `2006-01-02T15:04:05Z07:00` SRP's records query
// parses against; an empty value (what forest sent before this) fails there
// as `parsing time "" as "2006-01-02T15:04:05Z07:00": cannot parse "" as
// "2006"` — a raw Go error surfaced verbatim instead of any reservations.
function srpTimestamp(ms) {
  const d = new Date(ms);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const offMin = -d.getTimezoneOffset(); // minutes EAST of UTC
  const sign = offMin >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offMin) / 60));
  const om = pad(Math.abs(offMin) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${oh}:${om}`;
}

// The date window SRP's own Overview page sends: one calendar year either
// side of now. Exported so its shape is directly testable without going
// through a full listReservations() + scripted fetch round trip.
export function srpDateWindow(nowMs) {
  const now = new Date(nowMs);
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - 1);
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + 1);
  return { startDate: srpTimestamp(start.getTime()), endDate: srpTimestamp(end.getTime()) };
}

// SRP's own `testbox` value, normalised to the `tb<id>` form the user's own
// session lines use by hand (`tb108`). Every recognised shape — the
// previously-used `dc:id` (`x:161`), the joined spellings (`x161`, `x-161`,
// `x_161`, `x 161`), and the `<dc>tbx<id>` infix a live SRP session showed
// (`xtbx200`) — reduces to just its trailing digits; the datacenter letter is
// discarded entirely. This is a deliberate simplification the user asked
// for, not an oversight: it means two datacenters that happen to share a
// numeric box id COLLAPSE to the same `tb<id>` and become indistinguishable
// here — flagged to the user rather than hidden, see this round's report. An
// unrecognised shape is still passed through UNCHANGED: a plausible looking
// wrong box in the prompt is worse than an odd-looking right one, and the
// prompt is editable before launch.
export function boxLabel(record) {
  const raw = String(record?.testbox ?? '').trim();
  if (!raw) return '';
  // One run of letters, then at most one separator (`:`, `-`, `_`, a space,
  // or none at all — the same pattern covers `dc:id`, the joined spellings,
  // AND the `tbx` infix, since "tbx" is just more letters to this regex),
  // then digits to the end. Only the digits ever survive into the output,
  // so which letters preceded them no longer matters.
  const m = raw.match(/^[a-z]+[:\-_ ]?(\d+)$/i);
  return m ? `tb${m[1]}` : raw;
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

// Shared by createSrpClient()'s internals and loginSrp() below — both make
// their own fetchImpl calls and both need the same "network problem, not an
// SRP-shaped rejection" sentence for them.
const netError = (e) => (e && (e.name === 'AbortError' || e.name === 'TimeoutError')
  ? { error: 'SRP request timed out' }
  : { error: `SRP unreachable (${e && e.message ? e.message : e}) — on the VPN?` });

// The login form's server-side half (Task 9, round 3): trades a username and
// password for the same {accessToken, refreshToken} pair the bookmarklet
// hands over, so the runtime credential store in lib/actions.mjs can treat
// both sources identically. Same contract as every other export here:
// nothing throws, fetchImpl is injected, and every failure is a sentence.
//
// The password lives only as this function's own argument, on its way into
// one JSON.stringify'd request body — it is read once, sent once, and goes
// out of scope the moment this function returns (or throws into the catch
// below). Nothing here stores it, logs it, or hands it to a caller.
//
// The response shape mirrors SRP's SPA exactly, read off the SPA's own
// bundle rather than guessed: tokens arrive EITHER nested under `data.data`
// or at the root of `data`, and callers must accept both.
export async function loginSrp({ baseUrl, username, password, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const base = trimSlashes(baseUrl);
  if (!base) return { error: 'set srpBaseUrl in config.json to log in to SRP' };
  let data;
  try {
    const res = await fetchImpl(`${base}/${LOGIN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) return { error: 'SRP rejected those credentials' };
    if (!res.ok) return { error: messageOf(data, `SRP returned ${res.status}`) };
  } catch (e) {
    return netError(e);
  }
  const envelope = data?.data ? data.data : data;
  const accessToken = envelope?.accessToken;
  const refreshToken = envelope?.refreshToken;
  // A 2xx response that doesn't actually carry both tokens (malformed body,
  // an SRP response shape this module doesn't know about yet) must still
  // read as a sentence, not as a silently-half-empty credential the caller
  // would go on to store.
  if (!accessToken || !refreshToken) return { error: messageOf(data, 'SRP returned no tokens') };
  return { accessToken, refreshToken };
}

export function createSrpClient({
  baseUrl, refreshToken, username = '', accessToken = null, fetchImpl = fetch, timeoutMs = 8000,
  // A function, not a captured value: the client is built once and lives for
  // the server's lifetime (see lib/actions.mjs's srpFor), but the date
  // window has to reflect "now" at EACH listReservations() call, potentially
  // days or weeks after construction.
  nowMs = () => Date.now(),
} = {}) {
  const base = trimSlashes(baseUrl);
  // Seeded from the bookmarklet's own accessToken when the caller has one —
  // SRP access tokens are short-lived but not instantly dead, so a caller
  // that already holds one skips the mint round trip for its first call
  // entirely. Falls back to null (minted on first use) exactly as before
  // when none is supplied. Re-minted once on a 401 either way.
  let access = accessToken || null;
  let pendingMint = null; // the in-flight mint(), shared by concurrent callers

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

  // Mint before anything else, because the username this client queries by
  // lives INSIDE the access token. One round trip, not a probe request.
  //
  // listReservations() and reserve() can both be fired in the same tick (the
  // modal does exactly this), and neither awaits the other before calling in.
  // Without sharing the in-flight promise, both would see `access === null`
  // and each mint their own token — a real race, not a hypothetical one.
  // `pendingMint` is cleared in `.finally` (success OR failure) so a rejected
  // mint never leaves later callers permanently awaiting a dead promise.
  async function ensureAccess() {
    if (!base) return { error: 'set srpBaseUrl in config.json to read testbox reservations' };
    // A still-valid (seeded or previously-minted) access token needs no
    // refresh token at all for the call it's about to make — only a re-mint
    // after a 401 does, and that path clears `access` and runs this function
    // again, reaching the check below with a clean slate.
    if (access) return { ok: true };
    if (!refreshToken) return { error: 'set srpRefreshToken (or FOREST_SRP_REFRESH_TOKEN) to read testbox reservations' };
    if (!pendingMint) pendingMint = mint().finally(() => { pendingMint = null; });
    try { access = await pendingMint; } catch (e) { return netError(e); }
    if (!access) return { error: 'SRP rejected the token — reconnect via the bookmarklet, or paste a fresh srpRefreshToken into config.json' };
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
        // Clear the pending-mint memo too: by this point ensureAccess() has
        // already resolved so it should be null anyway, but leaving that to
        // chance would let the retry await a mint that already settled to
        // the very token that just got rejected.
        access = null;
        pendingMint = null;
        const again = await ensureAccess();
        if (again.error) return again;
        return call(method, path, { params, body }, false);
      }
      if (res.status === 401) return { error: 'SRP rejected the token — reconnect via the bookmarklet, or paste a fresh srpRefreshToken into config.json' };
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
      const { startDate, endDate } = srpDateWindow(nowMs());
      // Paged the same way SRP's own Overview page pages itself: fetch until
      // a page comes back with no records. `status` stays 'OK' rather than
      // Overview's own 'OK,IN_APPROVEMENT,IN_QUEUE' — forest only wants
      // boxes that are actually usable right now, not ones still queued or
      // pending approval.
      const records = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await call('GET', RECORDS, {
          params: { username: user, status: 'OK', testbox: '', startDate, endDate, page, pageSize: PAGE_SIZE },
        });
        if (r.error) return { error: r.error };
        if (!r.ok) return { error: messageOf(r.data, `SRP returned ${r.status}`) };
        // A non-array `records` (malformed body, unexpected shape) reads as
        // an empty (and so loop-terminating) page rather than throwing —
        // /api/srp/boxes promises it never fails, and .map on the wrong
        // shape would break that promise right here.
        const raw = r.data?.data?.records;
        const pageRecords = Array.isArray(raw) ? raw : [];
        if (!pageRecords.length) break;
        records.push(...pageRecords);
      }
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
