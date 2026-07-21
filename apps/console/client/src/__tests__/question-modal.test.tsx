import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuestionModal } from '../components/QuestionModal';
import type { PendingQuestion } from '../types';

const single: PendingQuestion = {
  questionId: 'q1',
  questions: [
    {
      question: 'A or B?',
      header: 'Pick one',
      options: [{ label: 'A' }, { label: 'B' }],
      multiSelect: false,
    },
  ],
};

const multi: PendingQuestion = {
  questionId: 'q2',
  questions: [
    {
      question: 'Which clusters?',
      header: 'Pick any',
      options: [{ label: 'X' }, { label: 'Y' }],
      multiSelect: true,
    },
  ],
};

describe('QuestionModal — free-text answers', () => {
  it('renders a free-text input per question with the expected placeholder', () => {
    render(<QuestionModal question={single} onSubmit={vi.fn()} />);
    expect(screen.getByPlaceholderText('…or type your own answer')).toBeInTheDocument();
  });

  it('single-select: typing an answer (no option picked) enables submit and carries the text', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuestionModal question={single} onSubmit={onSubmit} />);
    const submit = screen.getByRole('button', { name: /send answer/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('…or type your own answer'), 'my own take');
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('q1', { 'A or B?': 'my own take' });
  });

  it('single-select: picking an option then typing yields the typed text, and clears the picked style', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuestionModal question={single} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByText('A'));
    expect(screen.getByText('A').closest('button')).toHaveClass('is-picked');

    await userEvent.type(screen.getByPlaceholderText('…or type your own answer'), 'actually neither');
    expect(screen.getByText('A').closest('button')).not.toHaveClass('is-picked');

    await userEvent.click(screen.getByRole('button', { name: /send answer/i }));
    expect(onSubmit).toHaveBeenCalledWith('q1', { 'A or B?': 'actually neither' });
  });

  it('single-select: typing then picking an option clears the typed text and uses the option', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuestionModal question={single} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText('…or type your own answer') as HTMLInputElement;
    await userEvent.type(input, 'draft answer');
    await userEvent.click(screen.getByText('B'));
    expect(input.value).toBe('');

    await userEvent.click(screen.getByRole('button', { name: /send answer/i }));
    expect(onSubmit).toHaveBeenCalledWith('q1', { 'A or B?': 'B' });
  });

  it('multi-select: typed text merges with picked labels into an array', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuestionModal question={multi} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByText('X'));
    await userEvent.type(screen.getByPlaceholderText('…or type your own answer'), 'extra one');

    await userEvent.click(screen.getByRole('button', { name: /send answer/i }));
    expect(onSubmit).toHaveBeenCalledWith('q2', { 'Which clusters?': ['X', 'extra one'] });
  });

  it('multi-select: free text alone (no picks) is enough to enable submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuestionModal question={multi} onSubmit={onSubmit} />);
    const submit = screen.getByRole('button', { name: /send answer/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('…or type your own answer'), 'solo answer');
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('q2', { 'Which clusters?': ['solo answer'] });
  });
});
