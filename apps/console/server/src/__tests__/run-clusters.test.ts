import { describe, expect, it } from 'vitest';
import { runStore } from '../run-store.js';
import type { Cluster, ServerEvent } from '../types.js';

const cfg = { projectPath: '/tmp/x', targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161', mode: 'triage' as const, permissionPolicy: 'confirm-applies' as const };
const CL: Cluster = { id: 'onetrust', title: 'OneTrust overlay intercepts clicks', bucket: 'easy-fix',
  tests: ['com.x.FooTest'], state: 'proposed' };

describe('Run cluster state', () => {
  it('setClusters replaces + emits, updateCluster merges + emits', () => {
    const run = runStore.create(cfg);
    const events: ServerEvent[] = [];
    run.on('event', (e: ServerEvent) => events.push(e));
    run.setClusters([CL]);
    expect(run.snapshot.clusters).toHaveLength(1);
    run.updateCluster('onetrust', { state: 'verifying', passes: 2, runs: 3 });
    expect(run.snapshot.clusters[0]).toMatchObject({ state: 'verifying', passes: 2 });
    expect(events.some((e) => e.type === 'clusters')).toBe(true);
    expect(events.some((e) => e.type === 'cluster' && e.cluster.state === 'verifying')).toBe(true);
  });
  it('updateCluster on unknown id is a no-op', () => {
    const run = runStore.create(cfg);
    run.updateCluster('nope', { state: 'green' });
    expect(run.snapshot.clusters).toHaveLength(0);
  });
});
