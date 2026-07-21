import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BuildsBoard } from '../components/BuildsBoard';

// This Jenkins sets verbose custom displayNames (real example from live
// data) — the board must render a terse "#<number> · <job>" headline from
// the numeric `number` field instead, keeping the verbose text only as a
// hover `title` (see Fix 1 in the console builds-board task).
// #2127 — red (FAILURE), has a report, NOT yet triaged → NEEDS TRIAGE.
const NEEDS_TRIAGE = {
  jobName: 'web-test-s4-flaky', number: 2127, building: false, result: 'FAILURE', timestamp: Date.now(),
  duration: 125000, estimatedDuration: 600000, url: 'https://jenkins.example/job/web-test-s4-flaky/2127/',
  displayName: 'Build : 2127 | Branch : tech/WEBT-251268 | TB : 307',
  params: { TAG: 'Bireysel', TESTBOX: '307', BRANCH: 'master', JIRA_TICKET: 'CI-123' },
  buildUser: 'egecan.sen', failedCount: 12,
  reportUrl: 'https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=x',
  stage: { current: null, failed: 'assert-flow', done: 3, total: 5 },
};

// #2128 — building, has a live stage → RUNNING (compact, no triage action).
const RUNNING = {
  jobName: 'web-test-s4-flaky', number: 2128, building: true, result: null, timestamp: Date.now(),
  duration: 0, estimatedDuration: 600000, url: 'https://jenkins.example/job/web-test-s4-flaky/2128/',
  displayName: 'Build : 2128 | Branch : tech/WEBT-251300 | TB : 161',
  params: {}, buildUser: null, failedCount: 0, reportUrl: null,
  stage: { current: 'test', failed: null, done: 2, total: 5 },
};

// #2126 — red, already triaged (present in /api/history) → DONE ledger row.
const TRIAGED = {
  jobName: 'web-test-s4-flaky', number: 2126, building: false, result: 'FAILURE', timestamp: Date.now(),
  duration: 90000, estimatedDuration: 600000, url: 'https://jenkins.example/job/web-test-s4-flaky/2126/',
  displayName: 'Build : 2126 | Branch : master | TB : 307',
  params: {}, buildUser: 'egecan.sen', failedCount: 4,
  reportUrl: 'https://report.example/web-test-s4-flaky/2126?buildStartTime=1&fullTestBuildName=y',
  stage: null,
};

// #2125 — clean, but belongs to a DIFFERENT Jenkins user → proves the
// "only mine" filter actually excludes non-matching builds (Fix 2).
const OTHER_USER = {
  jobName: 'web-test-s4-flaky', number: 2125, building: false, result: 'SUCCESS', timestamp: Date.now(),
  duration: 60000, estimatedDuration: 600000, url: 'https://jenkins.example/job/web-test-s4-flaky/2125/',
  displayName: 'Build : 2125 | Branch : master | TB : 307',
  params: {}, buildUser: 'someone.else', failedCount: 0, reportUrl: null, stage: null,
};

const ROWS = { fetchedAt: Date.now(), stale: false, builds: [NEEDS_TRIAGE, RUNNING, TRIAGED] };

const HISTORY = [{ runId: 'r1', projectPath: '/x', targetUrl: TRIAGED.reportUrl, mode: 'triage',
  status: 'completed', startedAt: 1, findings: 0, tests: 0 }];

/** `jenkinsUser` defaults to null (unconfigured/anonymous) — matching most
 *  existing tests, which don't care about the "only mine" filter. */
function stubFetch(jenkinsUser: string | null = null, builds: unknown = ROWS) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/history')) return new Response(JSON.stringify(HISTORY), { status: 200 });
    if (url.includes('/api/config')) return new Response(JSON.stringify({ configured: true, jenkinsUser }), { status: 200 });
    return new Response(JSON.stringify(builds), { status: 200 });
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
    // timing: 125000ms = 2m 5s
    expect(screen.getByText(/took 2m 5s/i)).toBeInTheDocument();
    // Check timing in the card context to avoid matching the running row
    const card = screen.getByText(/#2127.*web-test-s4-flaky/).closest('article')!;
    expect(within(card).getByText(/started \d{2}:\d{2}/)).toBeInTheDocument();

    const triageBtn = screen.getByRole('button', { name: /^triage$/i });
    expect(triageBtn).toBeEnabled();
    await userEvent.click(triageBtn);
    expect(onTriage).toHaveBeenCalledWith(NEEDS_TRIAGE.reportUrl, 'tb307');
  });

  it('renders terse "#<number> · <job>" headlines everywhere, keeping the full displayName only as a hover title', async () => {
    stubFetch();
    render(<BuildsBoard onTriage={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/needs triage \(1\)/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/running \(1\)/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/done \(1\)/i)).toBeInTheDocument());

    // NEEDS TRIAGE card headline.
    const cardTitle = screen.getByText('#2127 · web-test-s4-flaky');
    expect(cardTitle).toHaveAttribute('title', NEEDS_TRIAGE.displayName);

    // RUNNING row headline.
    const runningTitle = screen.getByText('#2128 · web-test-s4-flaky');
    expect(runningTitle).toHaveAttribute('title', RUNNING.displayName);

    // DONE row headline.
    const doneTitle = screen.getByText('#2126 · web-test-s4-flaky');
    expect(doneTitle).toHaveAttribute('title', TRIAGED.displayName);

    // The verbose custom displayName must never render as visible text.
    expect(screen.queryByText(/Build : \d+ \| Branch/)).not.toBeInTheDocument();
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
    const runningRow = screen.getByText(/#2128.*web-test-s4-flaky/).closest('.build-row-running') as HTMLElement;
    expect(runningRow).toBeInTheDocument();
    expect(within(runningRow).getByText(/stage: test.*2\/5/)).toBeInTheDocument();
    expect(within(runningRow).getByText('running', { selector: '.board-chip' })).toBeInTheDocument();
    // timing: estimatedDuration: 600000ms = 10m
    expect(within(runningRow).getByText(/~10m expected/)).toBeInTheDocument();
    expect(within(runningRow).getByText(/started \d{2}:\d{2}/)).toBeInTheDocument();
    // No per-row triage action for a running build — the row itself has no
    // "triage" button (only the card in NEEDS TRIAGE, and the header's
    // "triage latest", offer one).
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

  it('displays stale badge when data is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/history')) return new Response(JSON.stringify(HISTORY), { status: 200 });
      // Return stale data (server encountered an error but is serving cached builds)
      return new Response(JSON.stringify({ ...ROWS, stale: true }), { status: 200 });
    }));
    render(<BuildsBoard onTriage={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/stale — jenkins unreachable/i)).toBeInTheDocument());
  });

  it('hides the "only mine" checkbox when jenkinsUser is unknown (no Jenkins auth / anonymous)', async () => {
    stubFetch(null);
    render(<BuildsBoard onTriage={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/needs triage \(1\)/i)).toBeInTheDocument());
    expect(screen.queryByLabelText(/only mine/i)).not.toBeInTheDocument();
  });

  it('"only mine" checkbox filters rows to the authenticated Jenkins user\'s builds only', async () => {
    stubFetch('egecan.sen', { fetchedAt: Date.now(), stale: false, builds: [NEEDS_TRIAGE, RUNNING, TRIAGED, OTHER_USER] });
    render(<BuildsBoard onTriage={vi.fn()} />);
    const checkbox = await screen.findByLabelText(/only mine/i);

    // Before filtering: OTHER_USER ('someone.else') sits alongside TRIAGED
    // ('egecan.sen') in DONE, and NEEDS TRIAGE/RUNNING are both present.
    await waitFor(() => expect(screen.getByText(/done \(2\)/i)).toBeInTheDocument());
    expect(screen.getByText(/needs triage \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/running \(1\)/i)).toBeInTheDocument();

    await userEvent.click(checkbox);

    // Only builds whose buildUser === 'egecan.sen' remain: OTHER_USER drops
    // out of DONE, and RUNNING (buildUser: null) drops out entirely.
    await waitFor(() => expect(screen.getByText(/done \(1\)/i)).toBeInTheDocument());
    expect(screen.queryByText(/#2125 · web-test-s4-flaky/)).not.toBeInTheDocument();
    expect(screen.queryByText(/running \(/i)).not.toBeInTheDocument();
    expect(screen.getByText(/needs triage \(1\)/i)).toBeInTheDocument();
  });
});
