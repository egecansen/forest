import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HistoryModal } from '../components/HistoryModal';
import type { RunSummary } from '../types';

const RUN: RunSummary = {
  runId: 'r1',
  projectPath: '/repo/web-test',
  targetUrl: 'https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=x',
  mode: 'triage',
  status: 'completed',
  startedAt: Date.now() - 60_000,
  findings: 1,
  tests: 2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HistoryModal', () => {
  it('clicking a row calls onOpen with the FULL run summary (not just the runId) and closes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([RUN]), { status: 200 })));
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<HistoryModal onOpen={onOpen} onClose={onClose} />);
    const row = await screen.findByText('web-test');
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(RUN);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
