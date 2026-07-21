import { describe, expect, it } from 'vitest';
import { runStore } from '../run-store.js';
import type { ServerEvent } from '../types.js';

const cfg = { projectPath: '/tmp/x', targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161', mode: 'triage' as const, permissionPolicy: 'confirm-applies' as const };

describe('Run.setReportText', () => {
  it('sets snapshot.reportText and emits a reportText event', () => {
    const run = runStore.create(cfg);
    const events: ServerEvent[] = [];
    run.on('event', (e: ServerEvent) => events.push(e));

    run.setReportText('1 cluster fixed and verified green, 0 escalations.');

    expect(run.snapshot.reportText).toBe('1 cluster fixed and verified green, 0 escalations.');
    expect(events).toContainEqual({
      type: 'reportText',
      reportText: '1 cluster fixed and verified green, 0 escalations.',
    });
  });
});
