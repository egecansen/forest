import { describe, it, expect } from 'vitest';
import {
  groupRecordings,
  latestScreenshotIndex,
  recordingUrl,
  formatBytes,
} from '../recordings-logic';
import type { Recording } from '../types';

const rec = (kind: Recording['kind'], relPath: string): Recording => ({
  id: relPath,
  kind,
  relPath,
  label: relPath,
  bytes: 0,
});

describe('groupRecordings', () => {
  it('partitions by kind', () => {
    const g = groupRecordings([
      rec('video', 'test-results/a/video.webm'),
      rec('trace', 'test-results/a/trace.zip'),
      rec('screenshot', 'test-results/a/02.png'),
      rec('screenshot', 'test-results/a/01.png'),
    ]);
    expect(g.videos).toHaveLength(1);
    expect(g.traces).toHaveLength(1);
    expect(g.screenshots).toHaveLength(2);
  });

  it('sorts screenshots ascending by relPath so the latest frame is last', () => {
    const g = groupRecordings([
      rec('screenshot', 'shots/step-10.png'),
      rec('screenshot', 'shots/step-01.png'),
      rec('screenshot', 'shots/step-02.png'),
    ]);
    expect(g.screenshots.map((s) => s.relPath)).toEqual([
      'shots/step-01.png',
      'shots/step-02.png',
      'shots/step-10.png',
    ]);
    expect(latestScreenshotIndex(g.screenshots)).toBe(2);
    expect(g.screenshots[latestScreenshotIndex(g.screenshots)].relPath).toBe('shots/step-10.png');
  });

  it('returns -1 as the latest index when there are no screenshots', () => {
    expect(latestScreenshotIndex([])).toBe(-1);
  });
});

describe('recordingUrl', () => {
  it('escapes the run id and the path query', () => {
    expect(recordingUrl('run 1', 'a b/trace.zip')).toBe(
      '/api/runs/run%201/recording?path=a%20b%2Ftrace.zip'
    );
  });
});

describe('formatBytes', () => {
  it('renders an em dash for empty/invalid sizes', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(-5)).toBe('—');
  });
  it('renders compact human sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1_500_000)).toBe('1.4 MB');
  });
});
