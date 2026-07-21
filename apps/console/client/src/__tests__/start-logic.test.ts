import { describe, it, expect } from 'vitest';
import { projectBasename, relativeTime } from '../start-logic';

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
