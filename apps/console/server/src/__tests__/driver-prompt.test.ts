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

  it('instructs the agent to include a short detail per cluster in the refined set_clusters call', () => {
    const run = runStore.create(cfg);
    const prompt = buildPrompt(run.snapshot.config!, { resume: false });
    expect(prompt).toContain(
      '- As soon as core/cluster.sh gives you the mechanical first cut, call mcp__hektor-console__set_clusters with those provisional clusters (state defaults to proposed; short provisional titles are fine). After the confirmation rerun, when you have the final meaning-bucket table and BEFORE asking the pick, call set_clusters again with the refined table — it replaces the provisional one; include a short detail per cluster: the failing signature, why it broke, and the intended fix approach.'
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

  it('when mcpAvailable:false, omits mcp__hektor-console bullets but retains AskUserQuestion and ledger-discipline', () => {
    const run = runStore.create(cfg);
    const prompt = buildPrompt(run.snapshot.config!, { resume: false, mcpAvailable: false });
    expect(prompt).not.toContain('mcp__hektor-console');
    expect(prompt).toContain('AskUserQuestion');
    expect(prompt).toContain('NEVER end the session while verification is pending');
  });

  it('when mcpAvailable:true (default), includes mcp__hektor-console bullets', () => {
    const run = runStore.create(cfg);
    const prompt = buildPrompt(run.snapshot.config!, { resume: false, mcpAvailable: true });
    expect(prompt).toContain('mcp__hektor-console__set_clusters');
    expect(prompt).toContain('mcp__hektor-console__cluster_status');
  });

  it('default mcpAvailable (undefined) includes mcp__hektor-console bullets', () => {
    const run = runStore.create(cfg);
    const prompt = buildPrompt(run.snapshot.config!, { resume: false });
    expect(prompt).toContain('mcp__hektor-console__set_clusters');
    expect(prompt).toContain('mcp__hektor-console__cluster_status');
  });
});
