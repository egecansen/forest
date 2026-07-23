import { describe, expect, test } from 'vitest';
import { deriveRound } from '../run-round-logic';

describe('deriveRound', () => {
  test('round 1 when nothing terminal yet', () => {
    expect(deriveRound([{ state: 'proposed' }, { state: 'picked' }])).toBe(1);
  });
  test('advances a round after a terminal verdict lands', () => {
    expect(deriveRound([{ state: 'green' }, { state: 'proposed' }])).toBe(2);
  });
  test('empty clusters → round 1', () => {
    expect(deriveRound([])).toBe(1);
  });
  test('other terminal states (app-bug, skipped, error) also advance the round', () => {
    expect(deriveRound([{ state: 'app-bug' }])).toBe(2);
    expect(deriveRound([{ state: 'skipped' }])).toBe(2);
    expect(deriveRound([{ state: 'error' }])).toBe(2);
  });
  test('a lone "verifying" cluster (not yet terminal) stays round 1', () => {
    expect(deriveRound([{ state: 'verifying' }])).toBe(1);
  });
});
