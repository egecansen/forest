import type { RunConfig, RunSnapshot } from './types.js';

export interface ActiveRunRef {
  runId: string;
  status: RunSnapshot['status'];
  config: RunConfig;
}

/**
 * Guards POST /api/runs: two triage runs against the SAME resolved
 * `projectPath` would fight over one working tree + ledger, so an active
 * (non-terminal) run already occupying it blocks a new one there — unless
 * the caller passes `override: true`. A different `projectPath` never
 * conflicts; concurrent runs across different repos are the normal case.
 *
 * Returns the conflicting run's id (for the 409 body's `conflictRunId`), or
 * `null` when the new run may proceed.
 */
export function findRunConflict(
  activeRuns: ActiveRunRef[],
  projectPath: string,
  override: boolean
): string | null {
  if (override) return null;
  const hit = activeRuns.find((r) => r.config.projectPath === projectPath);
  return hit ? hit.runId : null;
}
