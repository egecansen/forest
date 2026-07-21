import { describe, it, expect } from 'vitest';
import { costSplit, contextGauge, formatDuration, phaseDurationLabel } from '../telemetry-format';
import type { PhaseState, Telemetry } from '../types';

const baseTelem: Telemetry = { startedAt: 0, elapsedMs: 0, tokens: 0, thinking: false };

describe('costSplit (#14) — real SDK cost preferred over token estimate', () => {
  it('splits previous / this-session / total from real costUsd + priorCostUsd', () => {
    const c = costSplit({ ...baseTelem, costUsd: 0.52, priorCostUsd: 0.42, tokens: 9_600_000 });
    expect(c.estimated).toBe(false);
    expect(c.prior).toBeCloseTo(0.42, 5);
    expect(c.current).toBeCloseTo(0.1, 5); // total − prior, NOT tokens×rate
    expect(c.total).toBeCloseTo(0.52, 5);
  });

  it('falls back to a token estimate only when no SDK cost is present (e.g. simulator)', () => {
    const c = costSplit({ ...baseTelem, tokens: 1_000_000, priorTokens: 0 });
    expect(c.estimated).toBe(true);
    expect(c.current).toBeCloseTo(0.7, 5); // 1M × $0.70/1M
  });
});

describe('contextGauge (#14) — occupancy against the real window, not the lifetime sum', () => {
  it('is null until we have an occupancy reading (no false NEAR from tokens)', () => {
    expect(contextGauge({ ...baseTelem, tokens: 9_600_000 })).toBeNull();
  });

  it('reports occupancy / window and a level scaled to the real window', () => {
    const g = contextGauge({ ...baseTelem, contextTokens: 187_000, contextWindow: 200_000, tokens: 9_600_000 })!;
    expect(g.tokens).toBe(187_000);
    expect(g.window).toBe(200_000);
    expect(g.level).toBe('danger'); // 93% full
  });

  it('the SAME occupancy is NOT "near" in a 1M window', () => {
    const g = contextGauge({ ...baseTelem, contextTokens: 187_000, contextWindow: 1_000_000 })!;
    expect(g.level).toBe('normal'); // 18.7% of a 1M window
  });
});

describe('phaseDurationLabel (#14) — completed phases show real work time', () => {
  const now = 1_000_000;
  const runStart = 900_000;
  const mk = (p: Partial<PhaseState>): PhaseState => ({ id: 'scaffold', status: 'queued', ...p });

  it('a carried prior-session phase shows its real activeMs, not "carried"/"0s"', () => {
    // done in a prior session: ledger stamps predate this run (clamp would flatten
    // to 0s/carried) — but activeMs carries the true duration.
    const label = phaseDurationLabel(mk({ status: 'done', activeMs: 199_000, startedAt: 1, endedAt: 2 }), { now, runStart });
    expect(label.text).toBe('3m 19s');
    expect(label.carried).toBe(false);
  });

  it('a this-session completed phase (no activeMs yet) uses its clamped span', () => {
    const label = phaseDurationLabel(mk({ status: 'done', startedAt: 940_000, endedAt: 985_000 }), { now, runStart });
    expect(label.text).toBe('45s');
  });

  it('a terminal phase with neither activeMs nor an in-run end still reads "carried"', () => {
    const label = phaseDurationLabel(mk({ status: 'done' }), { now, runStart });
    expect(label.carried).toBe(true);
    expect(label.text).toBe('carried');
  });

  it('a queued phase reads "—"', () => {
    expect(phaseDurationLabel(mk({ status: 'queued' }), { now, runStart }).text).toBe('—');
  });

  it('an active phase ticks its live elapsed', () => {
    const label = phaseDurationLabel(mk({ status: 'active', startedAt: 940_000 }), { now, runStart });
    expect(label.text).toBe('1m 00s'); // now − start = 60s
  });
});

describe('phaseDurationLabel — carried durations from the ledger', () => {
  const runStart = 1_000_000;
  const now = runStart + 16_000;

  it('shows the historical duration on carried phases when the ledger provides one', () => {
    const state = { id: 'scaffold', status: 'done', endedAt: runStart - 999, carriedDurationMs: 2_210_000 } as any;
    const r = phaseDurationLabel(state, { now, runStart });
    expect(r.carried).toBe(true);
    expect(r.text).toBe(`carried · ${formatDuration(2_210_000)}`);
  });

  it('still reads plain "carried" when no duration is known', () => {
    const state = { id: 'scaffold', status: 'done', endedAt: runStart - 999 } as any;
    expect(phaseDurationLabel(state, { now, runStart })).toEqual({ text: 'carried', carried: true });
  });

  it('real observed activeMs still wins over the ledger duration', () => {
    const state = { id: 'scaffold', status: 'done', activeMs: 5_000, carriedDurationMs: 2_210_000 } as any;
    expect(phaseDurationLabel(state, { now, runStart }).text).toBe(formatDuration(5_000));
  });
});
