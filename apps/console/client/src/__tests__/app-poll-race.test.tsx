import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import type { RunConfig } from '../types';

// RunConsole is mocked out entirely — the real one opens a live WS via
// useRunStream, unavailable in jsdom (see run-console.test.tsx's readOnly/
// staticSnapshot convention, and build-cards-report.md's note that a full
// App-level RTL test needs exactly this kind of stub). The mock exposes a
// button that fires `onStatusChange` on demand, standing in for the active
// tab's own live stream reporting a status change.
vi.mock('../components/RunConsole', () => ({
  RunConsole: ({ onStatusChange }: { onStatusChange?: (status: string) => void }) => (
    <div data-testid="mock-run-console">
      <button type="button" onClick={() => onStatusChange?.('completed')}>
        mark-completed
      </button>
    </div>
  ),
}));

const CONFIG: RunConfig = {
  projectPath: '/repo/web-test',
  targetUrl: 'https://report.example/web-test-s4-flaky/2127?fullTestBuildName=y&buildStartTime=1',
  testbox: 'tb161',
  mode: 'triage',
  permissionPolicy: 'confirm-applies',
  runId: 'r1',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App poll-vs-active-tab status race', () => {
  it("does not let a stale /api/runs poll regress the ACTIVE tab's status once its own stream reports completion", async () => {
    // Every /api/runs response (both the on-load reconnect fetch and every
    // later poll tick) returns the SAME stale 'running' status for r1 —
    // modeling a poll that was already in flight before the active tab's WS
    // reported completion.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/runs')) {
          return new Response(JSON.stringify([{ runId: 'r1', status: 'running', config: CONFIG }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    // Capture ONLY the freshness-poll effect's setInterval call (its 10s
    // period) so it can be invoked on demand instead of waiting on a real
    // timer — passing every other interval (e.g. @testing-library/dom's own
    // internal polling inside `waitFor`) through to the real implementation.
    const realSetInterval = window.setInterval.bind(window);
    const pollCallbacks: Array<() => unknown> = [];
    vi.spyOn(window, 'setInterval').mockImplementation(((cb: () => unknown, ms?: number, ...rest: unknown[]) => {
      if (ms === 10_000) {
        pollCallbacks.push(cb);
        return 0 as unknown as ReturnType<typeof window.setInterval>;
      }
      return realSetInterval(cb as TimerHandler, ms, ...rest);
    }) as typeof window.setInterval);

    render(<App />);

    // On-load reconnect fetch adopts r1 as the (only, active) live tab, and
    // the freshness-poll effect registers its interval.
    await screen.findByTestId('mock-run-console');
    await waitFor(() => expect(pollCallbacks.length).toBeGreaterThan(0));

    // The active tab's own stream reports completion.
    await userEvent.click(screen.getByRole('button', { name: 'mark-completed' }));
    expect(screen.getByRole('button', { name: /close tab/i })).toBeInTheDocument();
    expect(document.querySelector('.run-tab-dot.tone-muted')).toBeInTheDocument();
    expect(document.querySelector('.run-tab-dot.tone-accent')).not.toBeInTheDocument();

    // A stale 10s poll tick lands AFTER — it must not regress the active tab
    // back to 'running'.
    await act(async () => {
      await pollCallbacks[pollCallbacks.length - 1]();
    });

    expect(screen.getByRole('button', { name: /close tab/i })).toBeInTheDocument();
    expect(document.querySelector('.run-tab-dot.tone-muted')).toBeInTheDocument();
    expect(document.querySelector('.run-tab-dot.tone-accent')).not.toBeInTheDocument();
  });
});
