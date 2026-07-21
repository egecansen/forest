import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClustersTab } from '../components/ClustersTab';
import type { Cluster } from '../types';

const CLUSTERS: Cluster[] = [
  { id: 'onetrust', title: 'OneTrust overlay intercepts clicks', bucket: 'easy-fix',
    tests: ['FooTest', 'BarTest'], state: 'verifying', passes: 2, runs: 3 },
  { id: 'gone-flag', title: 'Flag element removed from detail page', bucket: 'likely-bug',
    tests: ['BazTest'], state: 'app-bug', note: 'element gone in current DOM' },
];

describe('ClustersTab', () => {
  it('renders one row per cluster with bucket, tests, and state chip', () => {
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
});
