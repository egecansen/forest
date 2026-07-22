import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilesTab } from '../components/FilesTab';
import type { FileChange, TestArtifact, WorktreeResult } from '../types';

const DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 111..222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,2 +1,2 @@',
  ' line one',
  '-line two',
  '+line TWO changed',
].join('\n');

const WORKTREE_OK: WorktreeResult = {
  files: [
    { status: 'M', path: 'a.txt' },
    { status: 'A', path: 'b.txt' },
  ],
  diff: DIFF,
  truncated: false,
};

function stubWorktreeFetch(result: WorktreeResult | 'reject' = WORKTREE_OK) {
  const fn = vi.fn(async () => {
    if (result === 'reject') throw new Error('network error');
    return new Response(JSON.stringify(result), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView — the click-to-scroll interaction
  // needs a stub so it doesn't throw.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('FilesTab — working-tree diff (primary content)', () => {
  it('fetches the worktree once and renders the summary line + name-status list', async () => {
    stubWorktreeFetch();
    render(<FilesTab files={[]} tests={[]} runId="r1" live={false} />);
    expect(await screen.findByText(/2 files changed in the working tree — review before committing/)).toBeInTheDocument();
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();
  });

  it('renders the unified diff with +/- line tinting classes', async () => {
    stubWorktreeFetch();
    render(<FilesTab files={[]} tests={[]} runId="r1" live={false} />);
    await screen.findByText(/files changed/);
    const added = screen.getByText('+line TWO changed');
    expect(added).toHaveClass('diff-add');
    const removed = screen.getByText('-line two');
    expect(removed).toHaveClass('diff-del');
    const hunk = screen.getByText('@@ -1,2 +1,2 @@');
    expect(hunk).toHaveClass('diff-hunk');
  });

  it('clicking a name-status entry scrolls to its diff hunk', async () => {
    stubWorktreeFetch();
    render(<FilesTab files={[]} tests={[]} runId="r1" live={false} />);
    await screen.findByText(/files changed/);
    await userEvent.click(screen.getByRole('button', { name: /a\.txt/ }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('shows a clean-tree message when the working tree has no changes', async () => {
    stubWorktreeFetch({ files: [], diff: '', truncated: false });
    render(<FilesTab files={[]} tests={[]} runId="r1" live={false} />);
    expect(await screen.findByText(/0 files changed in the working tree/)).toBeInTheDocument();
  });

  it('shows a truncated notice when the diff was capped', async () => {
    stubWorktreeFetch({ ...WORKTREE_OK, truncated: true });
    render(<FilesTab files={[]} tests={[]} runId="r1" live={false} />);
    await screen.findByText(/files changed/);
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it('falls back to an unavailable message when the fetch fails, without crashing', async () => {
    stubWorktreeFetch('reject');
    render(<FilesTab files={[]} tests={[]} runId="r1" live={false} />);
    expect(await screen.findByText(/unavailable/i)).toBeInTheDocument();
  });
});

describe('FilesTab — poll vs fetch-once', () => {
  it('polls the worktree endpoint every 10s while the run is live', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubWorktreeFetch();
    render(<FilesTab files={[]} tests={[]} runId="r1" live />);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('fetches only once for a finished/history (non-live) run', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubWorktreeFetch();
    render(<FilesTab files={[]} tests={[]} runId="r1" live={false} />);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('FilesTab — agent-touched files (secondary section)', () => {
  const FILES: FileChange[] = [
    { id: 'f1', ts: 1, path: 'tests/e2e/specs/a.spec.ts', kind: 'created' },
  ];
  const TESTS: TestArtifact[] = [
    { id: 't1', ts: 1, path: 'tests/e2e/specs/a.spec.ts', name: 'a.spec.ts', status: 'wrote' },
  ];

  it('is absent when snapshot.files is empty', async () => {
    stubWorktreeFetch();
    render(<FilesTab files={[]} tests={[]} runId="r1" live={false} />);
    await screen.findByText(/files changed/);
    expect(screen.queryByText(/agent-touched files/i)).not.toBeInTheDocument();
  });

  it('renders as a small secondary section when snapshot.files is non-empty', async () => {
    stubWorktreeFetch();
    render(<FilesTab files={FILES} tests={TESTS} runId="r1" live={false} />);
    await screen.findByText(/files changed/);
    expect(screen.getByText(/agent-touched files/i)).toBeInTheDocument();
    expect(screen.getByText('tests/e2e/specs/a.spec.ts')).toBeInTheDocument();
  });
});
