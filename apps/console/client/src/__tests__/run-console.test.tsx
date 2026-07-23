import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunConsole } from '../components/RunConsole';
import type { RunConfig, RunSnapshot } from '../types';

function stubConfigFetch(json: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/config')) return new Response(JSON.stringify(json), { status: 200 });
    // Any other fetch (e.g. the Files-tab worktree poll) — a generic empty ok
    // response is enough; these tests don't assert on it.
    return new Response(JSON.stringify({ files: [], diff: '', truncated: false }), { status: 200 });
  }));
}

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

describe('RunConsole selenoid link', () => {
  it('only a config selenoidUrl (no live detection yet) → link uses the config url', async () => {
    stubConfigFetch({ configured: true, selenoidUrl: 'https://selenoid.example/ui/#/sessions' });
    const snap = snapshot({ status: 'running' });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly={false} staticSnapshot={snap} />);
    const link = await screen.findByRole('link', { name: /watch live/i });
    expect(link).toHaveAttribute('href', 'https://selenoid.example/ui/#/sessions');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('a detected snapshot.selenoidUrl is PREFERRED over the static config url when both are present', async () => {
    stubConfigFetch({ configured: true, selenoidUrl: 'https://selenoid.example/ui/#/sessions' });
    const snap = snapshot({ status: 'running', selenoidUrl: 'https://selenoid.example/ui/#/sessions/live-abc123' });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly={false} staticSnapshot={snap} />);
    const link = await screen.findByRole('link', { name: /watch live/i });
    expect(link).toHaveAttribute('href', 'https://selenoid.example/ui/#/sessions/live-abc123');
  });

  it('a detected snapshot.selenoidUrl shows the link even when the config has none at all', async () => {
    stubConfigFetch({ configured: true });
    const snap = snapshot({ status: 'running', selenoidUrl: 'https://selenoid.example/ui/#/sessions/live-abc123' });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly={false} staticSnapshot={snap} />);
    const link = await screen.findByRole('link', { name: /watch live/i });
    expect(link).toHaveAttribute('href', 'https://selenoid.example/ui/#/sessions/live-abc123');
  });

  it('also shows the link while awaiting-input', async () => {
    stubConfigFetch({ configured: true, selenoidUrl: 'https://selenoid.example/ui/#/sessions' });
    const snap = snapshot({ status: 'awaiting-input' });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly={false} staticSnapshot={snap} />);
    expect(await screen.findByRole('link', { name: /watch live/i })).toBeInTheDocument();
  });

  it('hides the link once the run is no longer running/awaiting-input', async () => {
    stubConfigFetch({ configured: true, selenoidUrl: 'https://selenoid.example/ui/#/sessions' });
    const snap = snapshot({ status: 'completed' });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly={false} staticSnapshot={snap} />);
    // Give the config fetch a tick to resolve before asserting absence.
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /watch live/i })).not.toBeInTheDocument();
  });

  it('hides the link entirely when NEITHER a detected nor a config selenoidUrl is present', async () => {
    stubConfigFetch({ configured: true });
    const snap = snapshot({ status: 'running' });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly={false} staticSnapshot={snap} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /watch live/i })).not.toBeInTheDocument();
  });

  it('hides the link in readOnly mode (history snapshots) even with a detected url and status running', async () => {
    stubConfigFetch({ configured: true, selenoidUrl: 'https://selenoid.example/ui/#/sessions' });
    const snap = snapshot({ status: 'running', selenoidUrl: 'https://selenoid.example/ui/#/sessions/live-abc123' });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly staticSnapshot={snap} />);
    // Wait for config fetch, then verify the selenoid link is not rendered because
    // readOnly mode (history snapshots) should never show live links.
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /watch live/i })).not.toBeInTheDocument();
  });
});

describe('RunConsole files tab badge', () => {
  it('counts only files — a populated tests array never inflates the badge (worktree endpoint unmocked here, so it falls back to snapshot.files.length)', () => {
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

  it('prefers the worktree file count over snapshot.files.length once the endpoint resolves', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/worktree')) {
        return new Response(
          JSON.stringify({
            files: [{ status: 'M', path: 'a' }, { status: 'M', path: 'b' }, { status: 'A', path: 'c' }],
            diff: '',
            truncated: false,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ configured: false }), { status: 200 });
    }));
    const snap = snapshot({ files: [{ id: 'f1', ts: 1, path: 'x', kind: 'created' }] });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly staticSnapshot={snap} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /files/i })).toHaveTextContent('3'));
  });

  it('falls back to snapshot.files.length when the worktree endpoint is unavailable (e.g. a history run whose repo moved)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const snap = snapshot({
      files: [
        { id: 'f1', ts: 1, path: 'x', kind: 'created' },
        { id: 'f2', ts: 2, path: 'y', kind: 'created' },
      ],
    });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly staticSnapshot={snap} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.getByRole('tab', { name: /files/i })).toHaveTextContent('2');
  });
});

describe('RunConsole paused run controls', () => {
  // Live gap: a run parked as `paused` (e.g. the driver's premature-end
  // guard — see driver.ts's result-success handler) must never leave the
  // operator stuck. The header always needs a way OUT of paused, not just a
  // way to continue it.
  it('a paused run renders BOTH resume and stop — never resume-only with no way out', async () => {
    const onResume = vi.fn();
    const onStop = vi.fn();
    const snap = snapshot({ status: 'paused' });
    render(
      <RunConsole
        config={CONFIG}
        onNew={() => {}}
        readOnly={false}
        staticSnapshot={snap}
        onResume={onResume}
        onStop={onStop}
      />
    );

    const resumeBtn = screen.getByRole('button', { name: /^resume$/i });
    const stopBtn = screen.getByRole('button', { name: /^stop$/i });
    expect(resumeBtn).toBeInTheDocument();
    expect(stopBtn).toBeInTheDocument();

    await userEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledTimes(1);

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('RunConsole onStatusChange', () => {
  it('reports the (static/live) snapshot status upward, so a host can track it without its own WS', () => {
    const onStatusChange = vi.fn();
    const snap = snapshot({ status: 'awaiting-input' });
    render(<RunConsole config={CONFIG} onNew={() => {}} readOnly staticSnapshot={snap} onStatusChange={onStatusChange} />);
    expect(onStatusChange).toHaveBeenCalledWith('awaiting-input');
  });
});
