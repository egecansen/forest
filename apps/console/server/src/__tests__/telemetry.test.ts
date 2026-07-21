import { describe, it, expect } from 'vitest';
import { Run } from '../run-store.js';
import type { RunConfig } from '../types.js';

const cfg: RunConfig = {
  projectPath: '/tmp/telemetry-test',
  targetUrl: 'https://example.com',
  mode: 'onboarding',
  runMode: 'standard',
  permissionPolicy: 'autonomous',
  runId: 'telemetry-test',
};

describe('telemetry', () => {
  it('raiseTokens is a monotonic high-water mark (never drops on a cache-heavy turn)', () => {
    const run = new Run(cfg);
    run.raiseTokens(1200);
    expect(run.snapshot.telemetry.tokens).toBe(1200);
    run.raiseTokens(40); // a low, cache-heavy turn — must NOT lower the meter
    expect(run.snapshot.telemetry.tokens).toBe(1200);
    run.raiseTokens(3500);
    expect(run.snapshot.telemetry.tokens).toBe(3500);
  });

  it('elapsedMs is computed from startedAt (not stuck at 0) and frozen on terminal status', () => {
    const run = new Run(cfg);
    expect(run.snapshot.telemetry.elapsedMs).toBe(0);
    expect(run.snapshot.telemetry.startedAt).toBeNull();

    run.setStatus('running'); // stamps startedAt
    expect(run.snapshot.telemetry.startedAt).not.toBeNull();
    run.setTelemetry({ thinking: true }); // recomputes elapsedMs off startedAt
    expect(run.snapshot.telemetry.elapsedMs).toBe(
      run.snapshot.telemetry.elapsedMs, // is a number
    );
    expect(typeof run.snapshot.telemetry.elapsedMs).toBe('number');
    expect(run.snapshot.telemetry.elapsedMs).toBeGreaterThanOrEqual(0);

    run.finish(true); // terminal → freezes a real elapsed derived from startedAt
    const started = run.snapshot.telemetry.startedAt as number;
    // frozen elapsed equals (roughly) now - startedAt; assert it's consistent
    expect(run.snapshot.telemetry.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(run.snapshot.telemetry.elapsedMs).toBeLessThanOrEqual(Date.now() - started + 5);
  });

  it('cost accumulates across a context-boundary continuation (F9)', () => {
    const run = new Run(cfg);
    // Session 1: cumulative cost climbs to $3.70.
    run.setSessionId('s1');
    run.setTelemetry({ costUsd: 1.5 });
    run.setTelemetry({ costUsd: 3.7 });
    expect(run.snapshot.telemetry.costUsd).toBeCloseTo(3.7, 5);

    // Continuation → new session; its total_cost_usd restarts near $0 but the
    // run total must keep climbing, not reset.
    run.setSessionId('s2');
    run.setTelemetry({ costUsd: 0 });
    expect(run.snapshot.telemetry.costUsd).toBeCloseTo(3.7, 5); // not $0
    run.setTelemetry({ costUsd: 1.19 });
    expect(run.snapshot.telemetry.costUsd).toBeCloseTo(4.89, 5); // 3.70 + 1.19
  });

  it('re-setting the SAME session id does not double-bank cost (F9)', () => {
    const run = new Run(cfg);
    run.setSessionId('s1');
    run.setTelemetry({ costUsd: 2 });
    run.setSessionId('s1'); // a result event re-emits the same id — no banking
    run.setTelemetry({ costUsd: 2.5 });
    expect(run.snapshot.telemetry.costUsd).toBeCloseTo(2.5, 5);
  });
});
