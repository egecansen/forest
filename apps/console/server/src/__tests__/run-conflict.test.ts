import { describe, expect, it } from 'vitest';
import { findRunConflict, type ActiveRunRef } from '../run-conflict.js';

const activeAt = (runId: string, projectPath: string): ActiveRunRef => ({
  runId,
  status: 'running',
  config: {
    runId,
    projectPath,
    targetUrl: 'https://report.example/web-test-s4-flaky/1?buildStartTime=1&fullTestBuildName=x',
    testbox: 'tb161',
    mode: 'triage',
    permissionPolicy: 'confirm-applies',
    projectMode: 'new',
  },
});

describe('findRunConflict', () => {
  it('returns the conflicting runId when an active run already occupies the same projectPath', () => {
    const active = [activeAt('run-a', '/repo/one')];
    expect(findRunConflict(active, '/repo/one', false)).toBe('run-a');
  });

  it('allows a different projectPath to run concurrently (no conflict)', () => {
    const active = [activeAt('run-a', '/repo/one')];
    expect(findRunConflict(active, '/repo/two', false)).toBeNull();
  });

  it('override:true bypasses a same-projectPath conflict', () => {
    const active = [activeAt('run-a', '/repo/one')];
    expect(findRunConflict(active, '/repo/one', true)).toBeNull();
  });

  it('no active runs at all -> no conflict', () => {
    expect(findRunConflict([], '/repo/one', false)).toBeNull();
  });

  it('picks the matching run out of several active runs at different paths', () => {
    const active = [activeAt('run-a', '/repo/one'), activeAt('run-b', '/repo/two'), activeAt('run-c', '/repo/three')];
    expect(findRunConflict(active, '/repo/two', false)).toBe('run-b');
    expect(findRunConflict(active, '/repo/four', false)).toBeNull();
  });
});
