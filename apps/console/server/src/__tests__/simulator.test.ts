import { describe, it, expect, vi } from 'vitest';
import { Run } from '../run-store.js';
import { wait, runSimulator } from '../simulator.js';
import { pendingAnswers } from '../pending-answers.js';
import type { RunConfig } from '../types.js';

const cfg: RunConfig = {
  projectPath: '/tmp/x',
  targetUrl: 'https://example.com',
  mode: 'onboarding',
  runMode: 'standard',
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
    // A full demo run calls wait() 100+ times; setMaxListeners(50) would
    // start warning/throwing well before that if each call leaked its
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
  it('simulator raises a question and resumes when answered', async () => {
    const run = new Run({ ...cfg, demo: true } as any);
    const p = runSimulator(run);
    await vi.waitFor(() => expect(run.snapshot.pendingQuestion).not.toBeNull(), { timeout: 20000 });
    const qid = run.snapshot.pendingQuestion!.questionId;
    expect(
      pendingAnswers.resolve(run.snapshot.config!.runId, qid, {
        [run.snapshot.pendingQuestion!.questions[0].question]: 'Proceed',
      })
    ).toBe(true);
    run.stop(); // end the sim early once we've confirmed resume
    await p;
  }, 25000);
});
