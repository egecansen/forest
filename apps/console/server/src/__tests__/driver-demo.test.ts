import { describe, expect, it } from 'vitest';
import { startDriver, makeDemoQueryFn } from '../driver.js';
import { pendingAnswers } from '../pending-answers.js';
import { runStore } from '../run-store.js';
import type { ServerEvent } from '../types.js';

const cfg = {
  projectPath: '/tmp/demo-project',
  targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=demo',
  testbox: 'tb161',
  mode: 'triage' as const,
  permissionPolicy: 'confirm-applies' as const,
  demo: true,
};

describe('demo driver', () => {
  it('walks init → clusters → a REAL AskUserQuestion bridge round-trip → green → completed', async () => {
    const run = runStore.create(cfg);
    const runId = run.snapshot.config!.runId;

    const awaitingInput = new Promise<void>((resolve) => {
      run.on('event', (e: ServerEvent) => {
        if (e.type === 'status' && e.status === 'awaiting-input') resolve();
      });
    });
    startDriver(run, makeDemoQueryFn(run));
    await awaitingInput;

    // The demo published a cluster directly (mirroring the real session's
    // set_clusters MCP tool) before asking the pick.
    expect(run.snapshot.clusters).toHaveLength(1);
    expect(run.snapshot.clusters[0]).toMatchObject({ id: 'onetrust', state: 'proposed' });

    // The question is a genuine pendingQuestion — not just a logged tool_use.
    const q = run.snapshot.pendingQuestion!;
    expect(q.questions[0].options.map((o) => o.label)).toEqual(['onetrust']);
    expect(run.snapshot.phases.find((p) => p.id === 'pick')?.status).toBe('active');

    const completed = new Promise<void>((resolve) => {
      run.on('event', (e: ServerEvent) => {
        if (e.type === 'status' && e.status === 'completed') resolve();
      });
    });
    // Answer through the same registry the HTTP `/answer` route uses for a
    // real operator answer — proves the bridge, not a shortcut around it.
    const resolved = pendingAnswers.resolve(runId, q.questionId, {
      [q.questions[0].question]: ['onetrust'],
    });
    expect(resolved).toBe(true);
    await completed;

    expect(run.snapshot.pendingQuestion).toBeNull();
    expect(run.snapshot.phases.find((p) => p.id === 'pick')?.status).toBe('done');
    expect(run.snapshot.clusters[0].state).toBe('green');
    expect(run.snapshot.status).toBe('completed');
  });

  it('stopping the run while it awaits the demo question unblocks the bridge instead of hanging', async () => {
    const run = runStore.create(cfg);
    const awaitingInput = new Promise<void>((resolve) => {
      run.on('event', (e: ServerEvent) => {
        if (e.type === 'status' && e.status === 'awaiting-input') resolve();
      });
    });
    const handle = startDriver(run, makeDemoQueryFn(run));
    await awaitingInput;

    handle(); // the driver's stop() — calls run.stop(), which rejects the pending answer

    expect(run.snapshot.status).toBe('cancelled');
    expect(run.snapshot.pendingQuestion).toBeNull();
  });
});
