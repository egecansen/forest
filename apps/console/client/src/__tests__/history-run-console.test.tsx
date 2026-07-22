import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HistoryRunConsole } from '../components/HistoryRunConsole';
import type { RunConfig, RunSnapshot } from '../types';

const CONFIG: RunConfig = {
  projectPath: '/repo/web-test',
  targetUrl: 'https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=x',
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
    log: [],
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HistoryRunConsole', () => {
  it('fetches GET /api/history/:runId and renders RunConsole read-only with the fetched snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/history/r1')) return new Response(JSON.stringify(snapshot()), { status: 200 });
        return new Response(JSON.stringify({ configured: false }), { status: 200 });
      })
    );
    render(<HistoryRunConsole runId="r1" onNew={vi.fn()} onOpenHistory={vi.fn()} />);
    expect(await screen.findByText(/archived · read-only/i)).toBeInTheDocument();
  });

  it('shows a loading state before the fetch resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // never resolves
    render(<HistoryRunConsole runId="r1" onNew={vi.fn()} onOpenHistory={vi.fn()} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows a fallback when the run has no recoverable config', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(snapshot({ config: null })), { status: 200 })));
    const onNew = vi.fn();
    render(<HistoryRunConsole runId="r1" onNew={onNew} onOpenHistory={vi.fn()} backLabel="back to board" />);
    expect(await screen.findByText(/no recoverable configuration/i)).toBeInTheDocument();
    await screen.findByRole('button', { name: /back to board/i });
  });

  it('refetches when the runId prop changes (switching tabs)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/history/r1')) return new Response(JSON.stringify(snapshot({ config: { ...CONFIG, runId: 'r1' } })), { status: 200 });
      if (url.includes('/api/history/r2')) return new Response(JSON.stringify(snapshot({ config: { ...CONFIG, runId: 'r2', projectPath: '/repo/other' } })), { status: 200 });
      return new Response(JSON.stringify({ configured: false }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<HistoryRunConsole runId="r1" onNew={vi.fn()} onOpenHistory={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/history/r1')));
    rerender(<HistoryRunConsole runId="r2" onNew={vi.fn()} onOpenHistory={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/history/r2')));
  });
});
