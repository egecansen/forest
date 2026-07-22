import { describe, expect, it } from 'vitest';
import { diffAnchorId, diffLineClass, parseUnifiedDiff } from '../worktree-diff';

const TWO_FILE_DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 1234567..89abcde 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,2 +1,2 @@',
  ' line one',
  '-line two',
  '+line TWO changed',
  'diff --git a/b/nested.txt b/b/nested.txt',
  'index abc..def 100644',
  '--- a/b/nested.txt',
  '+++ b/b/nested.txt',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('returns no segments for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('splits a multi-file diff into one segment per file, keyed by its b/ path', () => {
    const segments = parseUnifiedDiff(TWO_FILE_DIFF);
    expect(segments).toHaveLength(2);
    expect(segments[0].path).toBe('a.txt');
    expect(segments[1].path).toBe('b/nested.txt');
  });

  it('keeps every line of a file segment, including its diff --git header', () => {
    const segments = parseUnifiedDiff(TWO_FILE_DIFF);
    expect(segments[0].lines[0]).toBe('diff --git a/a.txt b/a.txt');
    expect(segments[0].lines).toContain('-line two');
    expect(segments[0].lines).toContain('+line TWO changed');
  });
});

describe('diffLineClass', () => {
  it('classifies additions and deletions, not the +++/--- file markers', () => {
    expect(diffLineClass('+added line')).toBe('add');
    expect(diffLineClass('-removed line')).toBe('del');
    expect(diffLineClass('+++ b/a.txt')).toBe('meta');
    expect(diffLineClass('--- a/a.txt')).toBe('meta');
  });

  it('classifies hunk headers and diff/index metadata', () => {
    expect(diffLineClass('@@ -1,2 +1,2 @@')).toBe('hunk');
    expect(diffLineClass('diff --git a/a.txt b/a.txt')).toBe('meta');
    expect(diffLineClass('index 1234567..89abcde 100644')).toBe('meta');
  });

  it('classifies unchanged context lines', () => {
    expect(diffLineClass(' line one')).toBe('context');
    expect(diffLineClass('')).toBe('context');
  });
});

describe('diffAnchorId', () => {
  it('produces a stable, DOM-safe id from a file path', () => {
    expect(diffAnchorId('src/components/Foo.tsx')).toBe('worktree-hunk-src-components-Foo-tsx');
  });

  it('produces the same id for the same path (used to both render and scroll to an anchor)', () => {
    expect(diffAnchorId('a/b.txt')).toBe(diffAnchorId('a/b.txt'));
  });
});
