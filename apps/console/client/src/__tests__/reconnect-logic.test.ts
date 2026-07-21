import { describe, it, expect } from 'vitest';
import { isTerminalStatus, nextBackoffDelay } from '../useRunStream';

describe('isTerminalStatus', () => {
  it('treats completed/failed/cancelled as terminal', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it('treats idle/preparing/running/paused as non-terminal', () => {
    expect(isTerminalStatus('idle')).toBe(false);
    expect(isTerminalStatus('preparing')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('paused')).toBe(false);
  });
});

describe('nextBackoffDelay', () => {
  it('doubles from a 1s base', () => {
    expect(nextBackoffDelay(0)).toBe(1000);
    expect(nextBackoffDelay(1)).toBe(2000);
    expect(nextBackoffDelay(2)).toBe(4000);
  });

  it('caps at 8s and stays capped for further attempts', () => {
    expect(nextBackoffDelay(3)).toBe(8000);
    expect(nextBackoffDelay(4)).toBe(8000);
    expect(nextBackoffDelay(10)).toBe(8000);
  });
});
