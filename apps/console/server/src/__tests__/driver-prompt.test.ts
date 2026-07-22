import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../driver-prompt.js';
import { runStore } from '../run-store.js';

const cfg = {
  projectPath: '/tmp/x',
  targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161',
  mode: 'triage' as const,
  permissionPolicy: 'confirm-applies' as const,
};

describe('buildPrompt', () => {
  it('instructs the agent never to end the session while verification is pending', () => {
    const run = runStore.create(cfg);
    const prompt = buildPrompt(run.snapshot.config!, { resume: false });
    expect(prompt).toContain(
      "- NEVER end the session while verification is pending: do not background the green-proof run and stop — wait for it, collect per-test verdicts, and update cluster_status for every picked cluster to green / app-bug / error BEFORE your final message. Your final message must be the converge scoreboard, not a status update."
    );
  });

  it('extends the resume line to ask the agent to collect in-flight verification results first', () => {
    const run = runStore.create(cfg);
    const prompt = buildPrompt(run.snapshot.config!, { resume: true });
    const lines = prompt.split('\n');
    expect(lines[0]).toBe(
      'Resume the in-progress flaky triage below from its last state (re-read ledger.json). If verification runs were left in flight, collect their results first (check the gradle output / ledger), then continue.'
    );
  });
});
