import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConflictDialog } from '../components/ConflictDialog';

describe('ConflictDialog', () => {
  it('renders the conflict message and both actions', () => {
    render(<ConflictDialog conflictRunId="run-a" onView={vi.fn()} onStartAnyway={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/fight over one working tree/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view running triage/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start anyway/i })).toBeInTheDocument();
  });

  it('"view running triage" calls onView', async () => {
    const onView = vi.fn();
    render(<ConflictDialog conflictRunId="run-a" onView={onView} onStartAnyway={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /view running triage/i }));
    expect(onView).toHaveBeenCalledTimes(1);
  });

  it('"start anyway (risky)" calls onStartAnyway', async () => {
    const onStartAnyway = vi.fn();
    render(<ConflictDialog conflictRunId="run-a" onView={vi.fn()} onStartAnyway={onStartAnyway} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /start anyway/i }));
    expect(onStartAnyway).toHaveBeenCalledTimes(1);
  });

  it('closing (✕ or escape) calls onClose', async () => {
    const onClose = vi.fn();
    render(<ConflictDialog conflictRunId="run-a" onView={vi.fn()} onStartAnyway={vi.fn()} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
