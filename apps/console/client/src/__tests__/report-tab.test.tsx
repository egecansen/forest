import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReportTab } from '../components/ReportTab';
import type { Cluster, Telemetry } from '../types';

const CLUSTERS: Cluster[] = [
  { id: 'onetrust', title: 'OneTrust consent overlay intercepts clicks', bucket: 'easy-fix', tests: ['A'], state: 'green' },
  { id: 'flaky-wait', title: 'Missing explicit wait on checkout submit', bucket: 'selector', tests: ['B', 'C'], state: 'app-bug' },
  { id: 'infra-timeout', title: 'CI runner timed out mid-suite', bucket: 'infra', tests: ['D'], state: 'error' },
  { id: 'low-value', title: 'Deprecated legacy nav test', bucket: 'vrt', tests: ['E'], state: 'skipped' },
];

const TELEMETRY: Telemetry = {
  startedAt: 1,
  elapsedMs: 125_000, // 2m 05s
  tokens: 45_231,      // 45.2k
  thinking: false,
  costUsd: 1.234,       // $1.23
};

describe('ReportTab — not finished', () => {
  it('shows a simple empty state, with no suite-era copy', () => {
    render(
      <ReportTab reportUrl={null} reportReady={false} reportIsReal={false} clusters={[]} reportText={undefined} telemetry={TELEMETRY} />
    );
    expect(screen.getByText(/scoreboard lands here when the run completes/i)).toBeInTheDocument();
    expect(screen.queryByText(/end-to-end suite/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/8 phases/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/phase viii/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/qa summary deck/i)).not.toBeInTheDocument();
  });
});

describe('ReportTab — finished (triage, non-real report)', () => {
  it('renders a cluster scoreboard (green/app-bug/error/skipped counts)', () => {
    render(
      <ReportTab
        reportUrl={null}
        reportReady
        reportIsReal={false}
        clusters={CLUSTERS}
        reportText="1 cluster fixed and verified green, 1 escalated as an app bug."
        telemetry={TELEMETRY}
      />
    );
    const scoreboard = screen.getByText(/cluster scoreboard/i).closest('div')!;
    expect(scoreboard).toBeInTheDocument();
  });

  it('renders slim per-cluster outcome rows — id, bucket, state chip, tests-count — NOT the full duplicated table', () => {
    render(
      <ReportTab
        reportUrl={null}
        reportReady
        reportIsReal={false}
        clusters={CLUSTERS}
        reportText="done"
        telemetry={TELEMETRY}
      />
    );
    // ids + bucket + chip + count are present:
    expect(screen.getByText('onetrust')).toBeInTheDocument();
    expect(screen.getByText('easy-fix')).toBeInTheDocument();
    expect(screen.getByText(/✅ green/)).toBeInTheDocument();
    expect(screen.getAllByText('1 test').length).toBeGreaterThan(0);
    expect(screen.getByText('flaky-wait')).toBeInTheDocument();
    expect(screen.getByText('2 tests')).toBeInTheDocument();
    // The full cluster titles (and the detail/expand affordance) are NOT
    // duplicated here — those live in the Clusters tab now.
    expect(screen.queryByText(/OneTrust consent overlay intercepts clicks/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Missing explicit wait on checkout submit/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /onetrust/i })).not.toBeInTheDocument();
  });

  it('renders **bold**, `inline code`, and bullet lines as real elements, not literal markup', () => {
    render(
      <ReportTab
        reportUrl={null}
        reportReady
        reportIsReal={false}
        clusters={CLUSTERS}
        reportText={'**Result**: fixed `onetrust.spec.ts`\n\n- one cluster went green\n- one escalated as an app bug'}
        telemetry={TELEMETRY}
      />
    );
    const bold = screen.getByText('Result');
    expect(bold.tagName).toBe('STRONG');
    const code = screen.getByText('onetrust.spec.ts');
    expect(code.tagName).toBe('CODE');
    expect(screen.getByText('one cluster went green').closest('li')).toBeInTheDocument();
    expect(screen.getByText('one escalated as an app bug').closest('li')).toBeInTheDocument();
    // No literal, unrendered markdown syntax should leak through as raw text.
    expect(screen.queryByText(/\*\*Result\*\*/)).not.toBeInTheDocument();
    expect(screen.queryByText(/`onetrust\.spec\.ts`/)).not.toBeInTheDocument();
  });

  it('falls back to a plain message when there is no reportText', () => {
    render(
      <ReportTab reportUrl={null} reportReady reportIsReal={false} clusters={CLUSTERS} reportText={undefined} telemetry={TELEMETRY} />
    );
    expect(screen.getByText(/agent finished without a final message/i)).toBeInTheDocument();
  });

  it('shows the footer line: elapsed, tokens, cost, and a nudge to review the working-tree diff', () => {
    render(
      <ReportTab reportUrl={null} reportReady reportIsReal={false} clusters={CLUSTERS} reportText="done" telemetry={TELEMETRY} />
    );
    expect(
      screen.getByText('took 2m 05s · 45.2k tok · $1.23 — review the working-tree diff in Files before committing.')
    ).toBeInTheDocument();
  });

  it('deletes all suite-era copy from the finished view', () => {
    render(
      <ReportTab reportUrl={null} reportReady reportIsReal={false} clusters={CLUSTERS} reportText="done" telemetry={TELEMETRY} />
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
        telemetry={TELEMETRY}
      />
    );
    const iframe = screen.getByTitle(/qa summary deck/i);
    expect(iframe).toHaveAttribute('src', '/api/runs/r1/report');
  });
});
