import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BuildsBoard } from '../components/BuildsBoard';

// #2127 — red (FAILURE), has a report, NOT yet triaged → NEEDS TRIAGE.
const NEEDS_TRIAGE = {
  jobName: 'web-test-s4-flaky', number: 2127, building: false, result: 'FAILURE', timestamp: Date.now(),
  duration: 125000, estimatedDuration: 600000, url: 'https://jenkins.example/job/web-test-s4-flaky/2127/',
  displayName: '#2127', params: { TAG: 'Bireysel', TESTBOX: '307', BRANCH: 'master', JIRA_TICKET: 'CI-123' },
  buildUser: 'egecan.sen', failedCount: 12,
  reportUrl: 'https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=x',
  stage: { current: null, failed: 'assert-flow', done: 3, total: 5 },
};

// #2128 — building, has a live stage → RUNNING (compact, no triage action).
const RUNNING = {
  jobName: 'web-test-s4-flaky', number: 2128, building: true, result: null, timestamp: Date.now(),
  duration: 0, estimatedDuration: 600000, url: 'https://jenkins.example/job/web-test-s4-flaky/2128/',
  displayName: '#2128', params: {}, buildUser: null, failedCount: 0, reportUrl: null,
  stage: { current: 'test', failed: null, done: 2, total: 5 },
};

// #2126 — red, already triaged (present in /api/history) → DONE ledger row.
const TRIAGED = {
  jobName: 'web-test-s4-flaky', number: 2126, building: false, result: 'FAILURE', timestamp: Date.now(),
  duration: 90000, estimatedDuration: 600000, url: 'https://jenkins.example/job/web-test-s4-flaky/2126/',
  displayName: '#2126', params: {}, buildUser: 'egecan.sen', failedCount: 4,
  reportUrl: 'https://report.example/web-test-s4-flaky/2126?buildStartTime=1&fullTestBuildName=y',
  stage: null,
};

const ROWS = { fetchedAt: Date.now(), stale: false, builds: [NEEDS_TRIAGE, RUNNING, TRIAGED] };

const HISTORY = [{ runId: 'r1', projectPath: '/x', targetUrl: TRIAGED.reportUrl, mode: 'triage',
  status: 'completed', startedAt: 1, findings: 0, tests: 0 }];

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/history')) return new Response(JSON.stringify(HISTORY), { status: 200 });
    return new Response(JSON.stringify(ROWS), { status: 200 });
  }));
}

describe('BuildsBoard', () => {
  it('partitions an untriaged red build into NEEDS TRIAGE with a working triage button + testbox prefill', async () => {
    stubFetch();
    const onTriage = vi.fn();
    render(<BuildsBoard onTriage={onTriage} />);
    await waitFor(() => expect(screen.getByText(/needs triage \(1\)/i)).toBeInTheDocument());
    expect(screen.getByText(/#2127.*web-test-s4-flaky/)).toBeInTheDocument();
    // fail meter shows the count
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    // failed-stage line
    expect(screen.getByText(/failed stage: assert-flow/i)).toBeInTheDocument();

    const triageBtn = screen.getByRole('button', { name: /^triage$/i });
    expect(triageBtn).toBeEnabled();
    await userEvent.click(triageBtn);
    expect(onTriage).toHaveBeenCalledWith(NEEDS_TRIAGE.reportUrl, 'tb307');
  });

  it('renders open-build and s-report actions with correct hrefs/targets', async () => {
    stubFetch();
    render(<BuildsBoard onTriage={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/needs triage \(1\)/i)).toBeInTheDocument());
    const card = screen.getByText(/#2127.*web-test-s4-flaky/).closest('article')!;
    const openBuild = within(card).getByRole('link', { name: /open build/i });
    expect(openBuild).toHaveAttribute('href', NEEDS_TRIAGE.url);
    expect(openBuild).toHaveAttribute('target', '_blank');
    expect(openBuild).toHaveAttribute('rel', expect.stringContaining('noreferrer'));

    const sReport = within(card).getByRole('link', { name: /s-report/i });
    expect(sReport).toHaveAttribute('href', NEEDS_TRIAGE.reportUrl);
    expect(sReport).toHaveAttribute('target', '_blank');
  });

  it('renders a building build as a compact RUNNING row with a stage line and no triage button', async () => {
    stubFetch();
    render(<BuildsBoard onTriage={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/running \(1\)/i)).toBeInTheDocument());
    expect(screen.getByText(/#2128.*web-test-s4-flaky/)).toBeInTheDocument();
    expect(screen.getByText(/stage: test.*2\/5/)).toBeInTheDocument();
    // No per-row triage action for a running build — the row itself has no
    // "triage" button (only the card in NEEDS TRIAGE, and the header's
    // "triage latest", offer one).
    const runningRow = screen.getByText(/#2128.*web-test-s4-flaky/).closest('.build-row-running') as HTMLElement;
    expect(within(runningRow).queryAllByRole('button', { name: /triage/i })).toHaveLength(0);
  });

  it('renders an already-triaged red build as a DONE ledger row with its chip, not in NEEDS TRIAGE', async () => {
    stubFetch();
    render(<BuildsBoard onTriage={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/done \(1\)/i)).toBeInTheDocument());
    expect(screen.getByText(/triaged · completed/)).toBeInTheDocument();
    expect(screen.getByText(/#2126.*web-test-s4-flaky/)).toBeInTheDocument();
    // NEEDS TRIAGE only counts the still-untriaged red build.
    expect(screen.getByText(/needs triage \(1\)/i)).toBeInTheDocument();
  });

  it('"triage latest" targets the first NEEDS TRIAGE build and passes its testbox', async () => {
    stubFetch();
    const onTriage = vi.fn();
    render(<BuildsBoard onTriage={onTriage} />);
    await waitFor(() => expect(screen.getByText(/needs triage \(1\)/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /triage latest/i }));
    expect(onTriage).toHaveBeenCalledWith(NEEDS_TRIAGE.reportUrl, 'tb307');
  });

  it('shows the clean-board message when nothing needs triage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/history')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ fetchedAt: Date.now(), stale: false, builds: [RUNNING] }), { status: 200 });
    }));
    render(<BuildsBoard onTriage={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/nothing needs triage/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /triage latest/i })).toBeDisabled();
  });

  it('paste-URL triage passes no testbox', async () => {
    stubFetch();
    const onTriage = vi.fn();
    render(<BuildsBoard onTriage={onTriage} />);
    await waitFor(() => expect(screen.getByText(/needs triage \(1\)/i)).toBeInTheDocument());
    const input = screen.getByPlaceholderText(/paste an s-report url/i);
    await userEvent.type(input, 'https://report.example/pasted?fullTestBuildName=z');
    await userEvent.click(screen.getByRole('button', { name: /triage url/i }));
    expect(onTriage).toHaveBeenCalledWith('https://report.example/pasted?fullTestBuildName=z');
  });
});
