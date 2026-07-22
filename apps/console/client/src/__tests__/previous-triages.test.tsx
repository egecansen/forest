import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreviousTriages } from '../components/PreviousTriages';
import type { RunSummary } from '../types';

const RUN: RunSummary = {
  runId: '03cbdc80-00a1-4eef-8a56-83ffc58dea11',
  projectPath: '/repo/web-test',
  targetUrl: 'https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=x',
  mode: 'triage',
  status: 'completed',
  startedAt: Date.now() - 60_000,
  findings: 3,
  tests: 2,
};

function stubHistoryFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PreviousTriages', () => {
  it('renders up to the last 8 runs from GET /api/history, with build label, status chip, and findings/tests meta', async () => {
    stubHistoryFetch([RUN]);
    render(<PreviousTriages onOpen={vi.fn()} />);
    expect(await screen.findByText('#2127')).toBeInTheDocument();
    expect(screen.getByText(/completed/i)).toBeInTheDocument();
    expect(screen.getByText(/3 findings/i)).toBeInTheDocument();
  });

  it('caps the list at 8 rows even when the API returns more', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...RUN, runId: `run-${i}`, targetUrl: `https://r.example/j/${i}?x=1` }));
    stubHistoryFetch(many);
    render(<PreviousTriages onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(8));
  });

  it('clicking a row opens it as a history tab via onOpen with the full run summary', async () => {
    stubHistoryFetch([RUN]);
    const onOpen = vi.fn();
    render(<PreviousTriages onOpen={onOpen} />);
    const row = await screen.findByText('#2127');
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(RUN);
  });

  it('renders nothing when there is no history', async () => {
    stubHistoryFetch([]);
    const { container } = render(<PreviousTriages onOpen={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders nothing (rather than throwing) when the response is not an array', async () => {
    stubHistoryFetch({ configured: true }); // shape mismatch, e.g. a differently-mocked /api/* stub
    const { container } = render(<PreviousTriages onOpen={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
