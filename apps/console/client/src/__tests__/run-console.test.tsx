import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunConsole } from '../components/RunConsole';
import type { RunConfig, RunSnapshot } from '../types';

const CONFIG: RunConfig = {
  projectPath: '/repo/web-test',
  targetUrl: 'https://report.example/x?fullTestBuildName=y&buildStartTime=1',
  testbox: 'tb161',
  mode: 'triage',
  permissionPolicy: 'confirm-applies',
  runId: 'r1',
};

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    config: CONFIG,
    phases: [],
    activePhase: null,
    telemetry: { startedAt: null, elapsedMs: 0, tokens: 0, thinking: false },
    log: [{ id: 'l1', ts: 1, kind: 'info', text: 'hello' }],
    status: 'completed',
    findings: [],
    files: [],
    tests: [],
    reportUrl: null,
    clusters: [],
    currentSubStage: null,
    pipelineStatus: null,
    pendingQuestion: null,
    ...overrides,
  };
}

// RunConsole is rendered `readOnly` with a `staticSnapshot` throughout — this
// keeps `useRunStream` from opening a real WebSocket (unavailable in jsdom),
// matching how the app itself renders a persisted, non-live run. The exact
// "does the auto-switch fight a manual pick" decision is unit-tested in
// isolation in run-console-logic.test.ts (shouldAutoSwitchToClusters); these
// tests cover the tab's wiring end to end.

describe('RunConsole clusters tab', () => {
  it('shows a cluster-count badge and auto-selects Clusters when the snapshot already has some', async () => {
    const snap = snapshot({
      clusters: [{ id: 'onetrust', title: 'OneTrust overlay', bucket: 'easy-fix', tests: ['A'], state: 'proposed' }],
    });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly staticSnapshot={snap} />);
    // Auto-switched to Clusters already (first non-empty arrival, on mount) —
    // its content is visible without an extra click.
    expect(await screen.findByText('OneTrust overlay')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /clusters/i })).toHaveTextContent('1');
    expect(screen.getByRole('tab', { name: /clusters/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('defaults to Log with no clusters, and a manual pick is honored', async () => {
    const snap = snapshot({ clusters: [] });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly staticSnapshot={snap} />);
    expect(screen.getByRole('tab', { name: /log/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /clusters/i })).not.toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('tab', { name: /timeline/i }));
    expect(screen.getByRole('tab', { name: /timeline/i })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('RunConsole files tab badge', () => {
  it('counts only files — a populated tests array never inflates the badge', () => {
    const snap = snapshot({
      files: [
        { id: 'f1', ts: 1, path: 'tests/e2e/specs/a.spec.ts', kind: 'created' },
        { id: 'f2', ts: 2, path: 'tests/e2e/specs/b.spec.ts', kind: 'created' },
      ],
      tests: [
        { id: 't1', ts: 1, path: 'tests/e2e/specs/a.spec.ts', name: 'a.spec.ts', status: 'wrote' },
        { id: 't2', ts: 2, path: 'tests/e2e/specs/b.spec.ts', name: 'b.spec.ts', status: 'wrote' },
        { id: 't3', ts: 3, path: 'tests/e2e/specs/c.spec.ts', name: 'c.spec.ts', status: 'wrote' },
      ],
    });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly staticSnapshot={snap} />);
    expect(screen.getByRole('tab', { name: /files/i })).toHaveTextContent('2');
  });
});
