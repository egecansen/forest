import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProcessDrawer } from '../components/ProcessDrawer';

describe('ProcessDrawer', () => {
  it('describes the triage pipeline convergence scoreboard, not a QA deck', () => {
    render(<ProcessDrawer open onClose={() => {}} />);
    expect(screen.getByText(/convergence scoreboard/i)).toBeInTheDocument();
  });

  it('walks all six triage phases', () => {
    render(<ProcessDrawer open onClose={() => {}} />);
    expect(screen.getByText('Ingest')).toBeInTheDocument();
    expect(screen.getByText('Cluster')).toBeInTheDocument();
    expect(screen.getByText('Pick')).toBeInTheDocument();
    expect(screen.getByText('Fix')).toBeInTheDocument();
    expect(screen.getByText('Verify')).toBeInTheDocument();
    expect(screen.getByText('Report')).toBeInTheDocument();
  });
});
