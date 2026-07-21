import { describe, it, expect } from 'vitest';
import { terminalActions } from '../terminal-actions';

describe('terminalActions', () => {
  it('completed → coverage (recommended) / bugs / companion, clear tone', () => {
    const v = terminalActions('completed', 'onboarding');
    expect(v?.tone).toBe('clear');
    expect(v?.actions.map((a) => a.mode)).toEqual(['coverage-expansion', 'bug-discovery', 'companion']);
    expect(v?.actions.find((a) => a.mode === 'coverage-expansion')?.recommended).toBe(true);
  });

  it('failed → retry uses the run\'s current mode, plus repair, error tone', () => {
    const v = terminalActions('failed', 'coverage-expansion');
    expect(v?.tone).toBe('error');
    expect(v?.actions[0]).toMatchObject({ mode: 'coverage-expansion', recommended: true });
    expect(v?.actions.some((a) => a.mode === 'repair')).toBe(true);
  });

  it('cancelled → a single continue action using the current mode', () => {
    const v = terminalActions('cancelled', 'onboarding');
    expect(v?.tone).toBe('neutral');
    expect(v?.actions).toHaveLength(1);
    expect(v?.actions[0]).toMatchObject({ mode: 'onboarding' });
  });

  it('non-terminal statuses return null', () => {
    for (const s of ['idle', 'preparing', 'running', 'awaiting-input', 'paused'] as const) {
      expect(terminalActions(s, 'onboarding')).toBeNull();
    }
  });
});

describe('terminalActions — blocked pipeline (F20)', () => {
  it('completed run with a blocked pipeline offers resume, not "suite delivered"', () => {
    const v = terminalActions('completed', 'onboarding', 'blocked');
    expect(v?.title).toContain('blocked');
    expect(v?.tone).toBe('error');
    expect(v?.actions).toHaveLength(1);
    expect(v?.actions[0]).toMatchObject({ mode: 'onboarding', recommended: true });
  });

  it('completed run with an in-progress pipeline offers continue, neutral tone', () => {
    const v = terminalActions('completed', 'onboarding', 'in-progress');
    expect(v?.title).toContain('unfinished');
    expect(v?.tone).toBe('neutral');
    expect(v?.actions[0]?.mode).toBe('onboarding');
  });

  it('completed run with a completed (or absent) pipeline keeps the delivered panel', () => {
    expect(terminalActions('completed', 'onboarding', 'completed')?.title).toContain('delivered');
    expect(terminalActions('completed', 'onboarding', null)?.title).toContain('delivered');
  });
});
