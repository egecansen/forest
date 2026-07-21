import type { LogEntry, PhaseState, RunSnapshot } from './types';

/**
 * True when a log entry's text reads like the engine hit a rate limit or ran
 * out of API credits — the run isn't dead, but it may stall until the
 * limit resets or billing is fixed. Case-insensitive; matches loosely on
 * purpose since the exact wording varies by SDK/CLI version.
 */
export function isRateLimitLog(text: string): boolean {
  return /rate limit|credit|out_of_credits/i.test(text);
}

/**
 * Scans the log (newest-first) for the most recent `warn` entry that reads
 * as a rate-limit/credit warning. Returns `null` when there isn't one.
 */
export function findLatestRateLimitWarning(log: LogEntry[]): LogEntry | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind === 'warn' && isRateLimitLog(entry.text)) return entry;
  }
  return null;
}

/** The most recent `error` log entry, or null — used to summarize a failed run. */
export function findLatestError(log: LogEntry[]): LogEntry | null {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].kind === 'error') return log[i];
  }
  return null;
}

/** Tone for the run-status pill / footer, so terminal states don't read as "live". */
export function runStatusTone(status: RunSnapshot['status']): 'live' | 'ok' | 'error' | 'stopped' | 'warn' | 'idle' {
  switch (status) {
    case 'running':
    case 'preparing':
      return 'live';
    case 'completed':
      return 'ok';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'stopped';
    case 'paused':
    case 'awaiting-input':
      return 'warn';
    default:
      return 'idle';
  }
}

/** Where a phase sits relative to "has it had a chance to produce output yet". */
export type PhaseWaitState = 'not-started' | 'running' | 'settled';

export function phaseWaitState(state: PhaseState | undefined): PhaseWaitState {
  if (!state || state.status === 'queued') return 'not-started';
  if (state.status === 'active' || state.status === 'blocked') return 'running';
  return 'settled'; // done | failed | skipped
}
