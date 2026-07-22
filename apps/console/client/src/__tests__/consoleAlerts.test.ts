import { describe, it, expect } from 'vitest';
import { findLatestRateLimitWarning, isRateLimitLog, isRunLive, phaseWaitState } from '../consoleAlerts';
import type { LogEntry, PhaseState } from '../types';

describe('isRateLimitLog', () => {
  it('matches common rate-limit phrasing case-insensitively', () => {
    expect(isRateLimitLog('API rate limit reached, backing off')).toBe(true);
    expect(isRateLimitLog('RATE LIMIT exceeded for org')).toBe(true);
  });

  it('matches credit / out_of_credits phrasing', () => {
    expect(isRateLimitLog('Insufficient credits remaining on this workspace')).toBe(true);
    expect(isRateLimitLog('error: out_of_credits')).toBe(true);
  });

  it('does not match unrelated warnings', () => {
    expect(isRateLimitLog('flaky selector detected, retrying')).toBe(false);
    expect(isRateLimitLog('disk space low')).toBe(false);
  });
});

describe('findLatestRateLimitWarning', () => {
  const mk = (id: string, kind: LogEntry['kind'], text: string): LogEntry => ({
    id,
    ts: Number(id),
    kind,
    text,
  });

  it('returns null when there is no matching warn entry', () => {
    const log = [mk('1', 'info', 'starting up'), mk('2', 'warn', 'flaky selector')];
    expect(findLatestRateLimitWarning(log)).toBeNull();
  });

  it('ignores non-warn entries even if the text matches', () => {
    const log = [mk('1', 'error', 'rate limit hit')];
    expect(findLatestRateLimitWarning(log)).toBeNull();
  });

  it('returns the most recent matching warn entry', () => {
    const log = [
      mk('1', 'warn', 'rate limit hit once'),
      mk('2', 'info', 'retrying'),
      mk('3', 'warn', 'out_of_credits again'),
    ];
    expect(findLatestRateLimitWarning(log)?.id).toBe('3');
  });
});

describe('phaseWaitState', () => {
  const base: PhaseState = { id: 'verify', status: 'queued' };

  it('is not-started when undefined or queued', () => {
    expect(phaseWaitState(undefined)).toBe('not-started');
    expect(phaseWaitState({ ...base, status: 'queued' })).toBe('not-started');
  });

  it('is running when active or blocked', () => {
    expect(phaseWaitState({ ...base, status: 'active' })).toBe('running');
    expect(phaseWaitState({ ...base, status: 'blocked' })).toBe('running');
  });

  it('is settled when done, failed, or skipped', () => {
    expect(phaseWaitState({ ...base, status: 'done' })).toBe('settled');
    expect(phaseWaitState({ ...base, status: 'failed' })).toBe('settled');
    expect(phaseWaitState({ ...base, status: 'skipped' })).toBe('settled');
  });
});

describe('isRunLive', () => {
  it('is live for running/awaiting-input/paused/preparing, not read-only', () => {
    expect(isRunLive('running', false)).toBe(true);
    expect(isRunLive('awaiting-input', false)).toBe(true);
    expect(isRunLive('paused', false)).toBe(true);
    expect(isRunLive('preparing', false)).toBe(true);
  });

  it('is never live in read-only (history) view, regardless of status', () => {
    expect(isRunLive('running', true)).toBe(false);
    expect(isRunLive('completed', true)).toBe(false);
  });

  it('is never live once the run reaches a terminal status', () => {
    expect(isRunLive('completed', false)).toBe(false);
    expect(isRunLive('failed', false)).toBe(false);
    expect(isRunLive('cancelled', false)).toBe(false);
  });
});
