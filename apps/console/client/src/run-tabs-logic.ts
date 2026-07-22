import type { RunConfig, RunSnapshot } from './types';
import { isTerminalStatus } from './useRunStream';

export type TabKind = 'live' | 'history';

/**
 * Minimal RunConfig-shaped data needed to render a tab-strip entry: always
 * carries `runId`/`projectPath`/`targetUrl` (enough for the tab label + the
 * build-number extraction below); everything else is only known once the
 * run's full config has loaded. A live tab always has the full `RunConfig`
 * the moment it's created (started here, adopted from the server's active
 * list, or fetched for the conflict dialog's "view running triage"); a
 * history tab only has the light `RunSummary` fields until its full
 * snapshot fetch resolves.
 */
export type TabRunConfig = Pick<RunConfig, 'runId' | 'projectPath' | 'targetUrl'> & Partial<RunConfig>;

export type OpenRunTab =
  | { runId: string; kind: 'live'; config: RunConfig }
  | { runId: string; kind: 'history'; config: TabRunConfig };

export type TabDotTone = 'accent' | 'warn' | 'muted' | 'outline';

/**
 * The build number from a triage report URL's path — the last path segment
 * when it's purely numeric (e.g. `.../web-test-s4-flaky/2127?...` -> "2127",
 * mirroring server/src/trackers/es.ts's sReportUrl shape). Returns null when
 * the URL doesn't parse, or its last path segment isn't purely numeric.
 */
export function extractBuildNumber(targetUrl: string): string | null {
  try {
    const u = new URL(targetUrl);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments.at(-1);
    return last && /^[0-9]+$/.test(last) ? last : null;
  } catch {
    return null;
  }
}

/** First 8 characters of a runId (a randomUUID) — a short, still-distinguishable
 *  fallback tab label when the target URL has no parseable build number. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

/** `#<build>` when the target URL carries a parseable build number, else
 *  `#<short-id>` — the tab strip's label for one open run. */
export function tabLabel(config: { runId: string; targetUrl: string }): string {
  const build = extractBuildNumber(config.targetUrl);
  return `#${build ?? shortRunId(config.runId)}`;
}

/**
 * Visual tone for a tab's status dot. History tabs are always the outline
 * tone, regardless of the (necessarily terminal) run's status. A live tab's
 * `status` is `null` when it isn't known yet (not yet streamed/polled) —
 * treated the same as a terminal status (muted), the safer default for a
 * purely decorative dot.
 */
export function tabDotTone(kind: TabKind, status: RunSnapshot['status'] | null): TabDotTone {
  if (kind === 'history') return 'outline';
  if (status === 'running' || status === 'preparing') return 'accent';
  if (status === 'awaiting-input') return 'warn';
  return 'muted';
}

/**
 * A history tab is always closable. A live tab is closable only once its run
 * has actually reached a terminal status — closing a still-running tab would
 * silently orphan it with no way back to its console. An unknown (`null`)
 * status is treated as terminal here (mirrors tabDotTone's bias).
 */
export function isTabClosable(kind: TabKind, status: RunSnapshot['status'] | null): boolean {
  if (kind === 'history') return true;
  return status == null || isTerminalStatus(status);
}

/**
 * Which runId should become active after closing the tab at `closedIndex` —
 * the tab that was immediately to its left, else the tab that slides into
 * that slot, else `null` when no tabs remain (caller falls back to board/start).
 */
export function nextActiveAfterClose(runIds: string[], closedIndex: number): string | null {
  const remaining = runIds.filter((_, i) => i !== closedIndex);
  if (remaining.length === 0) return null;
  const idx = Math.min(Math.max(0, closedIndex - 1), remaining.length - 1);
  return remaining[idx];
}

export interface LiveRunsSummary {
  count: number;
  needsYou: boolean;
  /** The tab to jump to on a header-indicator (or start-screen banner) click:
   *  the first awaiting-input live run if any, else just the first live run. */
  focusRunId: string | null;
}

/**
 * Summarizes the currently-live (non-terminal) tabs for the header indicator
 * and the start-screen "N triage(s) running" banner: how many, whether any
 * needs the operator, and which to focus on click. `statusFor` is injected
 * so this stays pure/testable without a real status map.
 */
export function liveRunsSummary(
  tabs: Array<{ runId: string; kind: TabKind }>,
  statusFor: (runId: string) => RunSnapshot['status'] | null
): LiveRunsSummary {
  let count = 0;
  let firstLiveRunId: string | null = null;
  let firstNeedsYouRunId: string | null = null;
  for (const t of tabs) {
    if (t.kind !== 'live') continue;
    const status = statusFor(t.runId);
    if (status == null || isTerminalStatus(status)) continue;
    count += 1;
    if (firstLiveRunId == null) firstLiveRunId = t.runId;
    if (status === 'awaiting-input' && firstNeedsYouRunId == null) firstNeedsYouRunId = t.runId;
  }
  return {
    count,
    needsYou: firstNeedsYouRunId != null,
    focusRunId: firstNeedsYouRunId ?? firstLiveRunId,
  };
}

/**
 * True while at least one live (non-terminal) tab is open — arms the
 * beforeunload guard. An unknown (`null`) status is treated as NON-terminal
 * here — the opposite bias from tabDotTone/isTabClosable above: failing to
 * warn about an actually-live run risks silently orphaning it, whereas a
 * falsely-armed guard is just a minor annoyance.
 */
export function hasLiveNonTerminalTab(
  tabs: Array<{ kind: TabKind; runId: string }>,
  statusFor: (runId: string) => RunSnapshot['status'] | null
): boolean {
  return tabs.some((t) => {
    if (t.kind !== 'live') return false;
    const status = statusFor(t.runId);
    return status == null || !isTerminalStatus(status);
  });
}
