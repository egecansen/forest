/**
 * Box-routing for a triage run, keyed on the build's Jira ticket prefix.
 *
 * The s-report carries two facts per FAILED doc — `jiraTicket` (build-level)
 * and `testbox` — which is enough to decide which box to rerun on:
 *
 *  - `DEP-*`   → a preprod DEDICATED run. Rerun on the box the run itself used
 *                (the report's `testbox`); a dedicated box is never silently swapped.
 *  - `SHBDN-*` → a dev-branch run with no dedicated box. Resolve one, in order:
 *                an explicit user choice → a box the user already holds in SRP
 *                (`reservation/v1/records`, status "OK") → else a fresh reservation.
 *
 * An explicit `userProvidedTestbox` always wins (operator override, even for DEP-).
 * Pure + deterministic — the credentialed SRP/report fetches happen upstream and
 * feed this their results.
 */

export type TicketClass = 'preprod-dedicated' | 'dev-branch' | 'unknown';

/** One row of SRP `reservation/v1/records` (only the fields we route on). */
export interface SrpReservation {
  testbox: string; // e.g. "xtbx215"
  status: string; // "OK" when usable
}

export interface BoxRoutingInput {
  /** Build-level Jira ticket from the report (e.g. "DEP-11495", "SHBDN-253190"). */
  jiraTicket?: string | null;
  /** `testbox` values across the report's FAILED docs (numeric, "xtbxNNN", or "tbNNN"). */
  reportTestboxes?: Array<string | number>;
  /** Explicit operator override — always wins when present and parseable. */
  userProvidedTestbox?: string | number | null;
  /** The current user's SRP reservations (`reservation/v1/records`). */
  userReservations?: SrpReservation[];
}

export type BoxRouting =
  | {
      status: 'resolved';
      testbox: string; // canonical "tbNNN" (matches RunConfig.testbox)
      id: number;
      ticketClass: TicketClass;
      source: 'user' | 'report-dedicated' | 'srp-reservation';
      /** Other OK reservations the user holds, when we picked one of several. */
      alternatives?: string[];
      note?: string;
    }
  | { status: 'needs-reservation'; ticketClass: 'dev-branch'; reason: string }
  | { status: 'unresolved'; ticketClass: TicketClass; reason: string };

/** DEP-* → preprod-dedicated · SHBDN-* → dev-branch · anything else → unknown. */
export function classifyTicket(jiraTicket?: string | null): TicketClass {
  if (!jiraTicket) return 'unknown';
  const t = jiraTicket.trim().toUpperCase();
  if (/^DEP-\d+/.test(t)) return 'preprod-dedicated';
  if (/^SHBDN-\d+/.test(t)) return 'dev-branch';
  return 'unknown';
}

/** "xtbx215" | "tb161" | 230 | "230" → 215 / 161 / 230; unparseable → null. */
function toId(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const m = String(v).match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const tb = (id: number): string => `tb${id}`;

/** Most-frequent parseable id in the list (ties → first seen); null if none. */
function modeId(values: Array<string | number> | undefined): number | null {
  if (!values || values.length === 0) return null;
  const counts = new Map<number, number>();
  const order: number[] = [];
  for (const v of values) {
    const id = toId(v);
    if (id === null) continue;
    if (!counts.has(id)) order.push(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const id of order) {
    const c = counts.get(id) ?? 0;
    if (c > bestCount) {
      best = id;
      bestCount = c;
    }
  }
  return best;
}

function okReservationIds(reservations: SrpReservation[] | undefined): number[] {
  if (!reservations) return [];
  const ids: number[] = [];
  for (const r of reservations) {
    if (r.status?.toUpperCase() !== 'OK') continue;
    const id = toId(r.testbox);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Decide the testbox for a triage run. See the file header for the policy.
 */
export function resolveTestbox(input: BoxRoutingInput): BoxRouting {
  const ticketClass = classifyTicket(input.jiraTicket);

  // 1) Explicit operator override always wins.
  const userId = toId(input.userProvidedTestbox);
  if (userId !== null) {
    return { status: 'resolved', testbox: tb(userId), id: userId, ticketClass, source: 'user' };
  }

  const reservedIds = okReservationIds(input.userReservations);
  const reportId = modeId(input.reportTestboxes);

  // 2) DEP-* → the dedicated box the run used (the report's testbox).
  if (ticketClass === 'preprod-dedicated') {
    if (reportId !== null) {
      return {
        status: 'resolved',
        testbox: tb(reportId),
        id: reportId,
        ticketClass,
        source: 'report-dedicated',
      };
    }
    return {
      status: 'unresolved',
      ticketClass,
      reason:
        'DEP- (preprod dedicated) run but the report carries no testbox — cannot infer the dedicated box.',
    };
  }

  // 3) SHBDN-* → a box the user already holds, else reserve one.
  if (ticketClass === 'dev-branch') {
    if (reservedIds.length > 0) {
      // Prefer a held box that also appears in the report, else the first held box.
      const picked = reportId !== null && reservedIds.includes(reportId) ? reportId : reservedIds[0];
      const alternatives = reservedIds.filter((i) => i !== picked).map(tb);
      return {
        status: 'resolved',
        testbox: tb(picked),
        id: picked,
        ticketClass,
        source: 'srp-reservation',
        ...(alternatives.length ? { alternatives } : {}),
      };
    }
    return {
      status: 'needs-reservation',
      ticketClass,
      reason: 'SHBDN- (dev-branch) run and the user holds no OK SRP reservation — reserve a box.',
    };
  }

  // 4) Unknown ticket prefix — prefer a held box, else fall back to the report box with a note.
  if (reservedIds.length > 0) {
    const picked = reservedIds[0];
    return {
      status: 'resolved',
      testbox: tb(picked),
      id: picked,
      ticketClass,
      source: 'srp-reservation',
      note: 'Unrecognized ticket prefix — defaulted to the user’s reserved box.',
      ...(reservedIds.length > 1 ? { alternatives: reservedIds.slice(1).map(tb) } : {}),
    };
  }
  if (reportId !== null) {
    return {
      status: 'resolved',
      testbox: tb(reportId),
      id: reportId,
      ticketClass,
      source: 'report-dedicated',
      note: 'Unrecognized ticket prefix — defaulted to the report’s testbox; confirm it is correct.',
    };
  }
  return {
    status: 'unresolved',
    ticketClass,
    reason: 'No ticket prefix match, no user box, no reservation, and no testbox in the report.',
  };
}
