import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClustersTab } from '../components/ClustersTab';
import type { Cluster } from '../types';

const CLUSTERS: Cluster[] = [
  { id: 'onetrust', title: 'OneTrust overlay intercepts clicks', bucket: 'easy-fix',
    tests: ['FooTest', 'BarTest'], state: 'verifying', passes: 2, runs: 3,
    detail: 'Failing signature: ElementClickInterceptedException on ot-sdk-row. Broke because the consent banner now renders above the fold. Fix: dismiss it in setup.' },
  { id: 'gone-flag', title: 'Flag element removed from detail page', bucket: 'likely-bug',
    tests: ['BazTest'], state: 'app-bug', note: 'element gone in current DOM' },
];

describe('ClustersTab', () => {
  it('renders one row per cluster with bucket, tests, and state chip (collapsed by default)', () => {
    render(<ClustersTab clusters={CLUSTERS} />);
    expect(screen.getByText('OneTrust overlay intercepts clicks')).toBeInTheDocument();
    expect(screen.getByText(/verifying 2\/3/)).toBeInTheDocument();
    expect(screen.getByText(/app-bug/)).toBeInTheDocument();
    expect(screen.getByText(/2 tests/)).toBeInTheDocument();
  });

  it('shows an empty state before clustering', () => {
    render(<ClustersTab clusters={[]} />);
    expect(screen.getByText(/no clusters yet/i)).toBeInTheDocument();
  });

  it('auto-collapses every row by default: detail and the full test list are not shown', () => {
    render(<ClustersTab clusters={CLUSTERS} />);
    expect(screen.queryByText(/Failing signature/)).not.toBeInTheDocument();
    expect(screen.queryByText('FooTest')).not.toBeInTheDocument();
    for (const row of screen.getAllByRole('button', { name: /onetrust|gone-flag/ })) {
      expect(row).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('expanding a row (click) reveals the full title, detail paragraph, and complete test list', async () => {
    render(<ClustersTab clusters={CLUSTERS} />);
    const row = screen.getByRole('button', { name: /onetrust/i });
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Failing signature: ElementClickInterceptedException/)).toBeInTheDocument();
    expect(screen.getByText('FooTest')).toBeInTheDocument();
    expect(screen.getByText('BarTest')).toBeInTheDocument();
  });

  it('collapsing an expanded row hides the detail and test list again', async () => {
    render(<ClustersTab clusters={CLUSTERS} />);
    const row = screen.getByRole('button', { name: /onetrust/i });
    await userEvent.click(row);
    expect(screen.getByText('FooTest')).toBeInTheDocument();
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('FooTest')).not.toBeInTheDocument();
    expect(screen.queryByText(/Failing signature/)).not.toBeInTheDocument();
  });

  it('multiple rows can be expanded independently', async () => {
    render(<ClustersTab clusters={CLUSTERS} />);
    await userEvent.click(screen.getByRole('button', { name: /onetrust/i }));
    await userEvent.click(screen.getByRole('button', { name: /gone-flag/i }));
    expect(screen.getByText('FooTest')).toBeInTheDocument();
    expect(screen.getByText('BazTest', { selector: 'li' })).toBeInTheDocument();
  });

  it('a cluster without a detail expands fine with just the test list (no empty detail block)', async () => {
    render(<ClustersTab clusters={CLUSTERS} />);
    await userEvent.click(screen.getByRole('button', { name: /gone-flag/i }));
    expect(screen.getByText('BazTest', { selector: 'li' })).toBeInTheDocument();
    expect(screen.queryByText(/Failing signature/)).not.toBeInTheDocument();
  });

  it('the row toggle is keyboard-accessible (a native button, activatable via Enter)', async () => {
    render(<ClustersTab clusters={CLUSTERS} />);
    const row = screen.getByRole('button', { name: /onetrust/i });
    expect(row.tagName).toBe('BUTTON');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(row).toHaveAttribute('aria-expanded', 'true');
  });
});
