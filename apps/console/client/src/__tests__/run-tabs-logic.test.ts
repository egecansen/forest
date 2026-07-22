import { describe, expect, it } from 'vitest';
import {
  extractBuildNumber,
  shortRunId,
  tabLabel,
  tabDotTone,
  isTabClosable,
  nextActiveAfterClose,
  liveRunsSummary,
  hasLiveNonTerminalTab,
} from '../run-tabs-logic';

describe('extractBuildNumber', () => {
  it('extracts the numeric path segment right before the query string', () => {
    expect(
      extractBuildNumber('https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=x')
    ).toBe('2127');
  });
  it('returns null when the last path segment is not purely numeric', () => {
    expect(extractBuildNumber('https://report.example/web-test-s4-flaky?buildStartTime=1')).toBeNull();
  });
  it('returns null for an unparseable URL', () => {
    expect(extractBuildNumber('not a url')).toBeNull();
  });
});

describe('shortRunId', () => {
  it('takes the first 8 characters', () => {
    expect(shortRunId('03cbdc80-00a1-4eef-8a56-83ffc58dea11')).toBe('03cbdc80');
  });
});

describe('tabLabel', () => {
  it('prefers the build number when parseable', () => {
    expect(
      tabLabel({ runId: '03cbdc80-00a1-4eef-8a56-83ffc58dea11', targetUrl: 'https://r.example/j/2127?x=1' })
    ).toBe('#2127');
  });
  it('falls back to the short run id when the URL has no numeric segment', () => {
    expect(
      tabLabel({ runId: '03cbdc80-00a1-4eef-8a56-83ffc58dea11', targetUrl: 'https://r.example/demo' })
    ).toBe('#03cbdc80');
  });
});

describe('tabDotTone', () => {
  it('is always outline for history tabs, regardless of status', () => {
    expect(tabDotTone('history', 'running')).toBe('outline');
    expect(tabDotTone('history', 'completed')).toBe('outline');
    expect(tabDotTone('history', null)).toBe('outline');
  });
  it('is accent for running/preparing live tabs', () => {
    expect(tabDotTone('live', 'running')).toBe('accent');
    expect(tabDotTone('live', 'preparing')).toBe('accent');
  });
  it('is warn for awaiting-input live tabs', () => {
    expect(tabDotTone('live', 'awaiting-input')).toBe('warn');
  });
  it('is muted for terminal, paused, idle, or unknown (null) live tabs', () => {
    expect(tabDotTone('live', 'completed')).toBe('muted');
    expect(tabDotTone('live', 'failed')).toBe('muted');
    expect(tabDotTone('live', 'cancelled')).toBe('muted');
    expect(tabDotTone('live', 'paused')).toBe('muted');
    expect(tabDotTone('live', 'idle')).toBe('muted');
    expect(tabDotTone('live', null)).toBe('muted');
  });
});

describe('isTabClosable', () => {
  it('history tabs are always closable', () => {
    expect(isTabClosable('history', 'running')).toBe(true);
    expect(isTabClosable('history', null)).toBe(true);
  });
  it('live tabs are closable only once terminal', () => {
    expect(isTabClosable('live', 'running')).toBe(false);
    expect(isTabClosable('live', 'awaiting-input')).toBe(false);
    expect(isTabClosable('live', 'paused')).toBe(false);
    expect(isTabClosable('live', 'completed')).toBe(true);
    expect(isTabClosable('live', 'failed')).toBe(true);
    expect(isTabClosable('live', 'cancelled')).toBe(true);
  });
  it('an unknown (null) live status is treated as terminal/closable', () => {
    expect(isTabClosable('live', null)).toBe(true);
  });
});

describe('nextActiveAfterClose', () => {
  it('activates the tab to the left of the one closed', () => {
    expect(nextActiveAfterClose(['a', 'b', 'c'], 1)).toBe('a');
  });
  it('activates the tab that slides into the closed slot when closing the first tab', () => {
    expect(nextActiveAfterClose(['a', 'b', 'c'], 0)).toBe('b');
  });
  it('activates the new last tab when closing the last one', () => {
    expect(nextActiveAfterClose(['a', 'b', 'c'], 2)).toBe('b');
  });
  it('returns null when closing the only open tab', () => {
    expect(nextActiveAfterClose(['a'], 0)).toBeNull();
  });
});

describe('liveRunsSummary', () => {
  const tabs = [
    { runId: 'a', kind: 'live' as const },
    { runId: 'b', kind: 'live' as const },
    { runId: 'h', kind: 'history' as const },
  ];

  it('counts only live, non-terminal tabs', () => {
    const statuses: Record<string, string | null> = { a: 'running', b: 'completed', h: 'running' };
    const summary = liveRunsSummary(tabs, (id) => statuses[id] as any);
    expect(summary.count).toBe(1);
    expect(summary.needsYou).toBe(false);
    expect(summary.focusRunId).toBe('a');
  });

  it('flags needsYou and focuses the awaiting-input run first', () => {
    const statuses: Record<string, string | null> = { a: 'running', b: 'awaiting-input' };
    const summary = liveRunsSummary(tabs, (id) => statuses[id] as any);
    expect(summary.count).toBe(2);
    expect(summary.needsYou).toBe(true);
    expect(summary.focusRunId).toBe('b');
  });

  it('is zero/false/null when nothing is live', () => {
    const summary = liveRunsSummary(tabs, () => 'completed' as any);
    expect(summary).toEqual({ count: 0, needsYou: false, focusRunId: null });
  });
});

describe('hasLiveNonTerminalTab', () => {
  it('is true when a live tab has a non-terminal status', () => {
    const tabs = [{ runId: 'a', kind: 'live' as const }];
    expect(hasLiveNonTerminalTab(tabs, () => 'running' as any)).toBe(true);
  });
  it('is false when every live tab is terminal', () => {
    const tabs = [{ runId: 'a', kind: 'live' as const }, { runId: 'b', kind: 'live' as const }];
    const statuses: Record<string, string> = { a: 'completed', b: 'failed' };
    expect(hasLiveNonTerminalTab(tabs, (id) => statuses[id] as any)).toBe(false);
  });
  it('ignores history tabs entirely', () => {
    const tabs = [{ runId: 'h', kind: 'history' as const }];
    expect(hasLiveNonTerminalTab(tabs, () => null)).toBe(false);
  });
  it('treats an unknown (null) status as non-terminal (safer default for the unload guard)', () => {
    const tabs = [{ runId: 'a', kind: 'live' as const }];
    expect(hasLiveNonTerminalTab(tabs, () => null)).toBe(true);
  });
});
