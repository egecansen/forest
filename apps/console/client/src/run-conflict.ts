/**
 * Thrown by App's startRun when POST /api/runs 409s with a `conflictRunId`
 * (server/src/run-conflict.ts's same-projectPath guard) — carries the
 * conflicting run's id so the caller can offer "view running triage" /
 * "start anyway (risky)" instead of just showing a dead-end error message.
 */
export class RunConflictError extends Error {
  readonly conflictRunId: string;

  constructor(conflictRunId: string) {
    super('a triage is already running in this repo — two agents would fight over one working tree and ledger');
    this.name = 'RunConflictError';
    this.conflictRunId = conflictRunId;
  }
}
