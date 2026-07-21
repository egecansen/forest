import type { Recording } from './types';

export interface GroupedRecordings {
  videos: Recording[];
  traces: Recording[];
  /** Ascending by relPath — the "latest" (highest-sorting) frame is last. */
  screenshots: Recording[];
}

/**
 * Partition a flat recordings list by kind. Screenshots are sorted ascending by
 * `relPath` so the newest-landing frame (highest-sorting path) is last — that's
 * what the near-live "watch from behind" view treats as the current frame.
 */
export function groupRecordings(recordings: Recording[]): GroupedRecordings {
  const videos: Recording[] = [];
  const traces: Recording[] = [];
  const screenshots: Recording[] = [];
  for (const r of recordings) {
    if (r.kind === 'video') videos.push(r);
    else if (r.kind === 'trace') traces.push(r);
    else if (r.kind === 'screenshot') screenshots.push(r);
  }
  screenshots.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { videos, traces, screenshots };
}

/** Index of the "latest" screenshot (highest-sorting relPath), or -1 if none. */
export function latestScreenshotIndex(screenshots: Recording[]): number {
  return screenshots.length - 1;
}

/** URL for the single-file serving route; both the runId and path are escaped. */
export function recordingUrl(runId: string, relPath: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/recording?path=${encodeURIComponent(relPath)}`;
}

/** Compact, human byte size (e.g. "1.4 MB"). 0/negative → "—". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
