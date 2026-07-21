import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReportTab } from '../components/ReportTab';
import type { Cluster } from '../types';

const CLUSTERS: Cluster[] = [
  { id: 'onetrust', title: 'OneTrust consent overlay intercepts clicks', bucket: 'easy-fix', tests: ['A'], state: 'green' },
  { id: 'flaky-wait', title: 'Missing explicit wait on checkout submit', bucket: 'selector', tests: ['B', 'C'], state: 'app-bug' },
  { id: 'infra-timeout', title: 'CI runner timed out mid-suite', bucket: 'infra', tests: ['D'], state: 'error' },
  { id: 'low-value', title: 'Deprecated legacy nav test', bucket: 'vrt', tests: ['E'], state: 'skipped' },
];

describe('ReportTab — not finished', () => {
  it('shows a simple empty state, with no suite-era copy', () => {
    render(
      <ReportTab reportUrl={null} reportReady={false} reportIsReal={false} clusters={[]} reportText={undefined} />
    );
    expect(screen.getByText(/scoreboard lands here when the run completes/i)).toBeInTheDocument();
    expect(screen.queryByText(/end-to-end suite/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/8 phases/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/phase viii/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/qa summary deck/i)).not.toBeInTheDocument();
  });
});

describe('ReportTab — finished (triage, non-real report)', () => {
  it('renders a cluster scoreboard (green/app-bug/error/skipped counts) and the cluster rows', () => {
    render(
      <ReportTab
        reportUrl={null}
        reportReady
        reportIsReal={false}
        clusters={CLUSTERS}
        reportText="1 cluster fixed and verified green, 1 escalated as an app bug."
      />
    );
    // Scoreboard counts.
    const scoreboard = screen.getByText(/cluster scoreboard/i).closest('div')!;
    expect(scoreboard).toBeInTheDocument();
    // Cluster rows (reused from ClustersTab) are present.
    expect(screen.getByText(/OneTrust consent overlay intercepts clicks/)).toBeInTheDocument();
    expect(screen.getByText(/Missing explicit wait on checkout submit/)).toBeInTheDocument();
    expect(screen.getByText(/CI runner timed out mid-suite/)).toBeInTheDocument();
    expect(screen.getByText(/Deprecated legacy nav test/)).toBeInTheDocument();
  });

  it('renders the agent final message from reportText, mono/preformatted', () => {
    render(
      <ReportTab
        reportUrl={null}
        reportReady
        reportIsReal={false}
        clusters={CLUSTERS}
        reportText="1 cluster fixed and verified green, 1 escalated as an app bug."
      />
    );
    const pre = screen.getByText(/1 cluster fixed and verified green/).closest('pre');
    expect(pre).toBeInTheDocument();
  });

  it('deletes all suite-era copy from the finished view', () => {
    render(
      <ReportTab reportUrl={null} reportReady reportIsReal={false} clusters={CLUSTERS} reportText="done" />
    );
    expect(screen.queryByText(/end-to-end suite/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/8 phases/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/phase viii/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tests written/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Findings$/i)).not.toBeInTheDocument();
  });
});

describe('ReportTab — real served deck', () => {
  it('iframes the real report when reportIsReal and a reportUrl are both present', () => {
    render(
      <ReportTab
        reportUrl="/api/runs/r1/report"
        reportReady
        reportIsReal
        clusters={CLUSTERS}
        reportText="done"
      />
    );
    const iframe = screen.getByTitle(/qa summary deck/i);
    expect(iframe).toHaveAttribute('src', '/api/runs/r1/report');
  });
});
