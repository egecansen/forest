import { describe, it, expect } from 'vitest';
import { continueSubmitState, modeNote, projectBasename, relativeTime } from '../start-logic';
import type { ProjectState } from '../types';

const withState = (o: Partial<ProjectState> = {}): ProjectState => ({
  installed: true, hasState: true, currentPhase: 5, pipelineStatus: 'in-progress',
  journeys: 4, findings: 2, tests: 3, targetUrl: 'https://x', runMode: 'standard', ...o,
});

describe('continueSubmitState', () => {
  it('blocks Continue when there is no resumable state', () => {
    expect(continueSubmitState('continue', withState({ hasState: false })).blocked).toBe(true);
  });
  it('allows Continue with state, and never blocks New', () => {
    expect(continueSubmitState('continue', withState()).blocked).toBe(false);
    expect(continueSubmitState('new', withState({ hasState: false })).blocked).toBe(false);
    expect(continueSubmitState('continue', null).blocked).toBe(false);
  });
});

describe('modeNote', () => {
  it('continue onboarding = resume note with phase', () => {
    expect(modeNote('continue', 'onboarding', withState())).toContain('5/8');
    expect(modeNote('continue', 'onboarding', withState())!.toLowerCase()).toContain('resume');
  });
  it('continue non-onboarding = fresh-pass note', () => {
    expect(modeNote('continue', 'bug-discovery', withState())!.toLowerCase()).toContain('fresh');
  });
  it('new on an existing run = re-onboard warning', () => {
    expect(modeNote('new', 'onboarding', withState())!.toLowerCase()).toContain('re-onboard');
  });
  it('returns null when there is nothing to say', () => {
    expect(modeNote('new', 'onboarding', withState({ hasState: false }))).toBeNull();
    expect(modeNote('continue', 'onboarding', null)).toBeNull();
  });
});

describe('projectBasename', () => {
  it('returns the last path segment', () => {
    expect(projectBasename('/Users/me/projects/my-app')).toBe('my-app');
  });
  it('tolerates a trailing slash', () => {
    expect(projectBasename('/Users/me/projects/my-app/')).toBe('my-app');
  });
  it('falls back to the input for a rootless string', () => {
    expect(projectBasename('')).toBe('');
  });
});

describe('relativeTime', () => {
  const now = 1_000_000;
  it('renders an em dash for a null timestamp', () => {
    expect(relativeTime(null, now)).toBe('—');
  });
  it('renders "just now" for a few seconds ago', () => {
    expect(relativeTime(now - 2_000, now)).toBe('just now');
  });
  it('renders minutes for sub-hour gaps', () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });
  it('renders hours for sub-day gaps', () => {
    expect(relativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago');
  });
  it('renders days for sub-month gaps', () => {
    expect(relativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });
  it('never returns a negative-looking duration for a future timestamp', () => {
    expect(relativeTime(now + 10_000, now)).toBe('just now');
  });
});
