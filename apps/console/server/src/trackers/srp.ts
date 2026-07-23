import type { SrpReservation } from '../testbox-routing.js';

/**
 * SRP (testbox reservation) tracker.
 *
 * SRP authenticates with an LDAP-backed **session cookie**, and its API lives
 * behind an origin a localhost web client can't reach cross-origin (CORS) — so
 * the call is made **server-side** with the operator's SRP session cookie passed
 * as a `Cookie:` header. The cookie is a config secret (`srp.cookie`) and is
 * redacted from run logs like the Jenkins token (see redact.ts).
 *
 * `reservation/v1/records` returns every reservation; `toSrpReservations` narrows
 * to the current user and hands `resolveTestbox` the `{testbox,status}` rows it
 * routes on (it keeps only status "OK").
 */
export interface SrpConfig {
  /** API base up to (but not including) `reservation/v1/records` — the gateway
   *  root the SRP SPA calls (from devtools → Network), e.g.
   *  `https://srp.ngntest.sahibindenlocal.net/<gateway>`. */
  baseUrl: string;
  /** The operator's SRP session cookie (`name=value; …`) — a secret. */
  cookie?: string;
  /** Username whose reservations to keep; defaults to the caller-supplied one. */
  username?: string;
}

/** One `reservation/v1/records` row (only the fields we use). */
export interface SrpReservationRecord {
  username: string;
  testbox: string; // "xtbx215"
  status: string; // "OK" when usable
  startDate?: string;
  endDate?: string;
  expectedEndDate?: string;
  description?: string;
}

interface SrpRecordsEnvelope {
  data?: { records?: SrpReservationRecord[]; numberOfRecords?: number };
  error?: unknown;
}

/** GET `${baseUrl}/reservation/v1/records` with the user's SRP session cookie. */
export async function fetchReservationRecords(
  cfg: SrpConfig,
  fetchImpl: typeof fetch = fetch
): Promise<SrpReservationRecord[]> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cfg.cookie) headers.Cookie = cfg.cookie;
  const res = await fetchImpl(`${base}/reservation/v1/records`, { headers });
  if (!res.ok) throw new Error(`srp reservations: HTTP ${res.status}`);
  const body = (await res.json()) as SrpRecordsEnvelope;
  return body.data?.records ?? [];
}

/**
 * The given user's reservations, mapped to what `resolveTestbox` consumes.
 * Filters by `username` (case-insensitive) so a shared endpoint can't leak
 * someone else's box into routing; `status` is passed through (routing keeps
 * only "OK").
 */
export function toSrpReservations(
  records: SrpReservationRecord[],
  username: string
): SrpReservation[] {
  const me = username.trim().toLowerCase();
  return records
    .filter((r) => (r.username ?? '').trim().toLowerCase() === me)
    .map((r) => ({ testbox: r.testbox, status: r.status }));
}

// ── Outward actions (reserve / release) ───────────────────────────────────
// SRP is the one shared resource this console mutates. Both calls are gated
// behind an explicit operator confirm at the endpoint (never auto-fired), and
// go server-side with the session cookie.
//
// PAYLOAD NOTE: SRP's SPA exposes the action verbs (revoke / cancel / extend /
// assign) but its minified bundle hides the exact request bodies. The shapes
// below are best-evidence from the verbs + the `records` row shape; confirm
// them against ONE devtools capture of a real reserve/release before trusting
// against live SRP — it's a localized change here, and nothing fires without a
// deliberate click, so a wrong shape fails loudly rather than mis-reserving.

export interface SrpActionResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function srpPost(
  cfg: SrpConfig,
  pathAndQuery: string,
  body: unknown,
  fetchImpl: typeof fetch
): Promise<SrpActionResult> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.cookie) headers.Cookie = cfg.cookie;
  const res = await fetchImpl(`${base}/${pathAndQuery}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const respBody = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body: respBody };
}

export interface ReserveOptions {
  /** A specific box (e.g. "xtbx52" / "tb52" / "52"); omit for "any free box". */
  testbox?: string;
  durationHours?: number;
  description?: string;
}

/** Reserve a testbox (create a `reservation/v1/records` entry). */
export async function reserveTestbox(
  cfg: SrpConfig,
  opts: ReserveOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<SrpActionResult> {
  return srpPost(
    cfg,
    'reservation/v1/records',
    {
      // omit testbox → SRP picks a free one; else normalize to xtbxNNN form.
      ...(opts.testbox ? { testbox: normalizeBox(opts.testbox) } : {}),
      durationHours: opts.durationHours ?? 24,
      description: opts.description ?? 'hektor triage',
    },
    fetchImpl
  );
}

/** Release a reservation the operator holds, by its record id (`revoke`). */
export async function releaseTestbox(
  cfg: SrpConfig,
  reservationId: string,
  fetchImpl: typeof fetch = fetch
): Promise<SrpActionResult> {
  return srpPost(cfg, 'reservation/v1/acts', { action: 'revoke', id: reservationId }, fetchImpl);
}

/** "tb52" | "52" | "xtbx52" → "xtbx52" (SRP's canonical form). */
export function normalizeBox(value: string): string {
  const m = String(value).match(/(\d+)/);
  return m ? `xtbx${m[1]}` : value;
}
