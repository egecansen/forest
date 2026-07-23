/**
 * client/src/run-round-logic.ts — a coarse "which pass are we on" hint for
 * the iterative cluster-first loop (cluster-from-report → pick → rerun
 * picked cluster → re-cluster each round). The board itself is already
 * ledger-driven and the pick already recurs; this is purely a legibility
 * derivation for the console UI — no server/schema change.
 *
 * Round is "1" until the first verdict lands, then "2+" — a minimal,
 * intentionally coarse counter (not a precise per-round tally). The
 * terminal set matches the driver's premature-end guard.
 */
const TERMINAL = new Set(['green', 'app-bug', 'skipped', 'error']);

export function deriveRound(clusters: { state: string }[]): number {
  return 1 + (clusters.some((c) => TERMINAL.has(c.state)) ? 1 : 0);
}
