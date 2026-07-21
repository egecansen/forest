import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BuildsBoard } from '../components/BuildsBoard';

const ROWS = { fetchedAt: Date.now(), stale: false, builds: [
  { jobName: 'web-test-s4-flaky', number: 2127, building: false, result: 'FAILURE', timestamp: Date.now(),
    duration: 1, url: 'https://jenkins.example/job/web-test-s4-flaky/2127/', displayName: '#2127',
    params: { TAG: 'Bireysel' }, buildUser: 'egecan.sen', failedCount: 12,
    reportUrl: 'https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=x' },
  { jobName: 'web-test-s4-flaky', number: 2128, building: true, result: null, timestamp: Date.now(),
    duration: 0, url: 'https://jenkins.example/job/web-test-s4-flaky/2128/', displayName: '#2128',
    params: {}, buildUser: null, failedCount: 0, reportUrl: null },
] };

const HISTORY = [{ runId: 'r1', projectPath: '/x', targetUrl: ROWS.builds[0].reportUrl, mode: 'triage',
  status: 'completed', startedAt: 1, findings: 0, tests: 0 }];

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/history')) return new Response(JSON.stringify(HISTORY), { status: 200 });
    return new Response(JSON.stringify(ROWS), { status: 200 });
  }));
}

describe('BuildsBoard', () => {
  it('renders rows; Triage enabled only for red builds with a report', async () => {
    stubFetch();
    const onTriage = vi.fn();
    render(<BuildsBoard onTriage={onTriage} />);
    await waitFor(() => expect(screen.getByText('#2127')).toBeInTheDocument());
    const buttons = screen.getAllByRole('button', { name: /triage/i });
    const rowBtn = buttons.find((b) => !b.textContent?.includes('latest'))!;
    await userEvent.click(rowBtn);
    expect(onTriage).toHaveBeenCalledWith(ROWS.builds[0].reportUrl);
    await waitFor(() => expect(screen.getByText(/triaged · completed/)).toBeInTheDocument());
    // Assert the running/no-report row's triage button is disabled
    const runningRow = screen.getByText('#2128').closest('tr')!;
    const runningRowBtn = runningRow.querySelector('button')!;
    expect(runningRowBtn).toBeDisabled();
  });

  it('"Triage latest" picks the newest red build with a report', async () => {
    stubFetch();
    const onTriage = vi.fn();
    render(<BuildsBoard onTriage={onTriage} />);
    await waitFor(() => expect(screen.getByText('#2127')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /triage latest/i }));
    expect(onTriage).toHaveBeenCalledWith(ROWS.builds[0].reportUrl);
  });
});
