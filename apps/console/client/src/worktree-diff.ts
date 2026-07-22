/**
 * Pure helpers for rendering a unified `git diff` without a diff library —
 * split into per-file segments (so a name-status click can scroll to the
 * right hunk) and a per-line classification for +/- tinting.
 */

export interface DiffSegment {
  /** The file's `b/` (post-change) path, used as the segment's scroll anchor key. */
  path: string;
  lines: string[];
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/** Splits a unified multi-file diff into one segment per file, in order. Any
 *  text before the first `diff --git` header (shouldn't normally occur) is
 *  dropped rather than crashing on a headerless blob. */
export function parseUnifiedDiff(diff: string): DiffSegment[] {
  if (!diff) return [];
  const lines = diff.split('\n');
  const segments: DiffSegment[] = [];
  let current: DiffSegment | null = null;
  for (const line of lines) {
    const m = FILE_HEADER.exec(line);
    if (m) {
      current = { path: m[2], lines: [line] };
      segments.push(current);
      continue;
    }
    current?.lines.push(line);
  }
  return segments;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

/** Classifies one diff line for +/- tinting. Order matters: the `+++`/`---`
 *  file markers must be checked before the plain `+`/`-` content prefixes. */
export function diffLineClass(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('rename ')
  ) {
    return 'meta';
  }
  return 'context';
}

/** A stable, DOM-safe anchor id for a file path — every non-alphanumeric run
 *  becomes a single `-`, so the same path always maps to the same id whether
 *  it's used to render the anchor or to scroll to it. */
export function diffAnchorId(path: string): string {
  return `worktree-hunk-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}
