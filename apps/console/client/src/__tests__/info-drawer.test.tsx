import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InfoDrawer } from '../components/InfoDrawer';

describe('InfoDrawer', () => {
  it('describes hektor as a flaky-triage console, not the old QA pipeline', () => {
    render(<InfoDrawer open onClose={() => {}} />);
    expect(screen.getByText(/flaky-triage console/i)).toBeInTheDocument();
  });

  it('lists what it never does instead of the old five modes', () => {
    render(<InfoDrawer open onClose={() => {}} />);
    expect(screen.getByText('what it never does')).toBeInTheDocument();
    expect(screen.queryByText(/^modes$/i)).not.toBeInTheDocument();
  });
});
