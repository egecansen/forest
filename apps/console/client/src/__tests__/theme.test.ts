import { describe, it, expect } from 'vitest';
import { normalizeTheme } from '../theme';

describe('normalizeTheme', () => {
  it('accepts light', () => expect(normalizeTheme('light')).toBe('light'));
  it('accepts dark', () => expect(normalizeTheme('dark')).toBe('dark'));
  it('defaults everything else to dark', () => {
    expect(normalizeTheme(null)).toBe('dark');
    expect(normalizeTheme(undefined)).toBe('dark');
    expect(normalizeTheme('emerald')).toBe('dark');
    expect(normalizeTheme(1)).toBe('dark');
  });
});
