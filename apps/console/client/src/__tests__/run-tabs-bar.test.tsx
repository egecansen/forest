import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunTabsBar } from '../components/RunTabsBar';
import type { OpenRunTab } from '../run-tabs-logic';
import type { RunSnapshot } from '../types';

const liveTab = (runId: string, targetUrl = `https://r.example/j/${runId}?x=1`): OpenRunTab => ({
  runId,
  kind: 'live',
  config: {
    runId,
    projectPath: `/repo/${runId}`,
    targetUrl,
    testbox: 'tb161',
    mode: 'triage',
    permissionPolicy: 'confirm-applies',
  },
});

const historyTab = (runId: string): OpenRunTab => ({
  runId,
  kind: 'history',
  config: { runId, projectPath: `/repo/${runId}`, targetUrl: `https://r.example/j/${runId}?x=1` },
});

describe('RunTabsBar', () => {
  it('renders a tab per open run with its label and activates on click', async () => {
    const onActivate = vi.fn();
    const tabs = [liveTab('a', 'https://r.example/j/2127?x=1'), liveTab('b', 'https://r.example/j/2128?x=1')];
    render(
      <RunTabsBar
        tabs={tabs}
        activeRunId="a"
        boardActive={false}
        statusFor={() => 'running'}
        onActivate={onActivate}
        onClose={vi.fn()}
        onBoard={vi.fn()}
        onNew={vi.fn()}
      />
    );
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /#2127/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /#2128/ })).toHaveAttribute('aria-selected', 'false');

    await userEvent.click(screen.getByRole('tab', { name: /#2128/ }));
    expect(onActivate).toHaveBeenCalledWith('b');
  });

  it('shows a board tab-like button and a + new button', () => {
    render(
      <RunTabsBar
        tabs={[liveTab('a')]}
        activeRunId="a"
        boardActive={false}
        statusFor={() => 'running'}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onBoard={vi.fn()}
        onNew={vi.fn()}
      />
    );
    expect(screen.getByRole('tab', { name: /board/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ new/i })).toBeInTheDocument();
  });

  it('gives a running live tab no close button, but shows one for a terminal live tab and always for a history tab', () => {
    const tabs = [liveTab('running-one'), liveTab('done-one'), historyTab('past-one')];
    const statuses: Record<string, RunSnapshot['status']> = { 'running-one': 'running', 'done-one': 'completed' };
    render(
      <RunTabsBar
        tabs={tabs}
        activeRunId="running-one"
        boardActive={false}
        statusFor={(id) => statuses[id] ?? null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onBoard={vi.fn()}
        onNew={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /close tab #running-/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close tab #done-/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close tab #past-/i })).toBeInTheDocument();
  });

  it('closing a tab calls onClose with its runId', async () => {
    const onClose = vi.fn();
    render(
      <RunTabsBar
        tabs={[historyTab('h1')]}
        activeRunId="h1"
        boardActive={false}
        statusFor={() => null}
        onActivate={vi.fn()}
        onClose={onClose}
        onBoard={vi.fn()}
        onNew={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /close tab/i }));
    expect(onClose).toHaveBeenCalledWith('h1');
  });

  it('reflects the awaiting-input dot tone distinctly from running/terminal/history', () => {
    const tabs = [liveTab('running-one'), liveTab('waiting-one'), liveTab('done-one'), historyTab('past-one')];
    const statuses: Record<string, RunSnapshot['status']> = {
      'running-one': 'running',
      'waiting-one': 'awaiting-input',
      'done-one': 'completed',
    };
    render(
      <RunTabsBar
        tabs={tabs}
        activeRunId="running-one"
        boardActive={false}
        statusFor={(id) => statuses[id] ?? null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onBoard={vi.fn()}
        onNew={vi.fn()}
      />
    );
    expect(document.querySelector('.run-tab-dot.tone-accent')).toBeInTheDocument();
    expect(document.querySelector('.run-tab-dot.tone-warn')).toBeInTheDocument();
    expect(document.querySelector('.run-tab-dot.tone-muted')).toBeInTheDocument();
    expect(document.querySelector('.run-tab-dot.tone-outline')).toBeInTheDocument();
  });

  it('shows the header live-run indicator with a count, and needs-you wording when any tab awaits input', () => {
    const tabs = [liveTab('a'), liveTab('b')];
    const statuses: Record<string, RunSnapshot['status']> = { a: 'running', b: 'awaiting-input' };
    render(
      <RunTabsBar
        tabs={tabs}
        activeRunId="a"
        boardActive={false}
        statusFor={(id) => statuses[id] ?? null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onBoard={vi.fn()}
        onNew={vi.fn()}
      />
    );
    expect(screen.getByText(/2 running/i)).toBeInTheDocument();
    expect(screen.getByText(/needs you/i)).toBeInTheDocument();
  });

  it('hides the live-run indicator when nothing is live', () => {
    render(
      <RunTabsBar
        tabs={[historyTab('h1')]}
        activeRunId="h1"
        boardActive={false}
        statusFor={() => null}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onBoard={vi.fn()}
        onNew={vi.fn()}
      />
    );
    expect(screen.queryByText(/running/i)).not.toBeInTheDocument();
  });

  it('clicking the live-run indicator activates the needs-you run', async () => {
    const onActivate = vi.fn();
    const tabs = [liveTab('a'), liveTab('b')];
    const statuses: Record<string, RunSnapshot['status']> = { a: 'running', b: 'awaiting-input' };
    render(
      <RunTabsBar
        tabs={tabs}
        activeRunId="a"
        boardActive={false}
        statusFor={(id) => statuses[id] ?? null}
        onActivate={onActivate}
        onClose={vi.fn()}
        onBoard={vi.fn()}
        onNew={vi.fn()}
      />
    );
    await userEvent.click(screen.getByText(/2 running/i));
    expect(onActivate).toHaveBeenCalledWith('b');
  });

  it('clicking board/+new fires their callbacks', async () => {
    const onBoard = vi.fn();
    const onNew = vi.fn();
    render(
      <RunTabsBar
        tabs={[liveTab('a')]}
        activeRunId="a"
        boardActive={false}
        statusFor={() => 'running'}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onBoard={onBoard}
        onNew={onNew}
      />
    );
    await userEvent.click(screen.getByRole('tab', { name: /board/i }));
    expect(onBoard).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /\+ new/i }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});
