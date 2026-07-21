import { describe, it, expect } from 'vitest';
import { Run } from '../run-store.js';
import { wait, runSimulator } from '../simulator.js';
import type { RunConfig } from '../types.js';

const cfg: RunConfig = {
  projectPath: '/tmp/x',
  targetUrl: 'https://example.com',
  testbox: 'tb1',
  mode: 'triage',
  permissionPolicy: 'autonomous',
  runId: 'r1',
};

describe('simulator wait()', () => {
  it('removes its stopped listener once the timeout resolves normally', async () => {
    const run = new Run(cfg);
    expect(run.listenerCount('stopped')).toBe(0);
    await wait(1, run);
    expect(run.listenerCount('stopped')).toBe(0);
  });

  it('does not accumulate stopped listeners across many sequential waits (regression for the leak)', async () => {
    const run = new Run(cfg);
    // Real runs call wait() several times per pass; setMaxListeners(50) would
    // start warning/throwing well before this many if each call leaked its
    // listener.
    for (let i = 0; i < 120; i++) {
      await wait(0, run);
    }
    expect(run.listenerCount('stopped')).toBe(0);
  });

  it('still resolves and clears its listener when the run is stopped mid-wait', async () => {
    const run = new Run(cfg);
    const pending = wait(10_000, run);
    run.stop();
    await pending;
    expect(run.listenerCount('stopped')).toBe(0);
  });
});

describe('runSimulator', () => {
  it('walks ingest → cluster to done, then finishes the run successfully', async () => {
    const run = new Run({ ...cfg, demo: true });
    await runSimulator(run);
    const ingest = run.snapshot.phases.find((p) => p.id === 'ingest');
    const cluster = run.snapshot.phases.find((p) => p.id === 'cluster');
    expect(ingest?.status).toBe('done');
    expect(cluster?.status).toBe('done');
    expect(run.snapshot.status).toBe('completed');
  });

  it('stops early (no crash) when the run is stopped mid-walk', async () => {
    const run = new Run({ ...cfg, demo: true });
    const p = runSimulator(run);
    run.stop();
    await p;
    expect(run.snapshot.status).toBe('cancelled');
  });
});
