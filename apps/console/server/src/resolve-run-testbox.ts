import type { ConsoleConfig } from './console-config.js';
import { fetchBuildFacts } from './trackers/es.js';
import { fetchReservationRecords, toSrpReservations } from './trackers/srp.js';
import { resolveTestbox, type BoxRouting } from './testbox-routing.js';

/**
 * Orchestrates the box decision for a run the operator is about to start:
 * pull the build's `jiraTicket` + `testbox`es from ES, pull the operator's SRP
 * reservations (only if `srp` is configured), then route
 * ({@link resolveTestbox}). Read-only — nothing is reserved here; this feeds the
 * UI's testbox field so the operator can accept or override.
 *
 * SRP failures degrade to "no reservations" (the router then asks to reserve /
 * falls back to the user box) rather than blocking the run.
 */
export interface ResolveRunInput {
  jobName: string;
  buildNumber: number;
  /** Operator override typed into the UI; always wins when parseable. */
  userProvidedTestbox?: string | number | null;
  /** Whose reservations to read; defaults to `srp.username` then `jenkins.username`. */
  username?: string | null;
}

export async function resolveRunTestbox(
  cfg: Pick<ConsoleConfig, 'es' | 'srp' | 'jenkins'>,
  input: ResolveRunInput,
  fetchImpl: typeof fetch = fetch
): Promise<BoxRouting & { jiraTicket: string | null }> {
  const { jiraTicket, testboxes } = await fetchBuildFacts(
    cfg.es,
    input.jobName,
    input.buildNumber,
    fetchImpl
  );

  // An override already decides the box — skip the credentialed SRP call entirely.
  const hasOverride =
    input.userProvidedTestbox != null && /\d/.test(String(input.userProvidedTestbox));
  const username = input.username ?? cfg.srp?.username ?? cfg.jenkins?.username ?? null;
  let userReservations: ReturnType<typeof toSrpReservations> | undefined;
  if (!hasOverride && cfg.srp?.baseUrl && username) {
    try {
      const records = await fetchReservationRecords(cfg.srp, fetchImpl);
      userReservations = toSrpReservations(records, username);
    } catch {
      userReservations = undefined; // SRP down → degrade, don't block
    }
  }

  const routing = resolveTestbox({
    jiraTicket,
    reportTestboxes: testboxes,
    userProvidedTestbox: input.userProvidedTestbox,
    userReservations,
  });
  return { ...routing, jiraTicket };
}

/**
 * Parse `jobName` + `buildNumber` from an s-report URL whose path is
 * `.../<jobName>/<buildNumber>` (the shape `sReportUrl` builds). Returns null
 * when the tail isn't `<name>/<digits>`.
 */
export function parseReportUrl(targetUrl: string): { jobName: string; buildNumber: number } | null {
  let path: string;
  try {
    path = new URL(targetUrl).pathname;
  } catch {
    return null;
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const buildNumber = Number(parts[parts.length - 1]);
  const jobName = parts[parts.length - 2];
  if (!jobName || !Number.isSafeInteger(buildNumber) || buildNumber <= 0) return null;
  return { jobName, buildNumber };
}
