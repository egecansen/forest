import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTools, clusterShape } from '../driver-mcp.js';
import { runStore } from '../run-store.js';

const cfg = {
  projectPath: '/tmp/x',
  targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161',
  mode: 'triage' as const,
  permissionPolicy: 'confirm-applies' as const,
};

describe('clusterShape (set_clusters input)', () => {
  it('accepts an optional detail up to 2000 chars', () => {
    const schema = z.object(clusterShape);
    const ok = schema.parse({
      id: 'onetrust',
      title: 'OneTrust overlay intercepts clicks',
      bucket: 'easy-fix',
      tests: ['com.x.FooTest'],
      detail: 'x'.repeat(2000),
    });
    expect(ok.detail).toHaveLength(2000);
  });

  it('rejects a detail longer than 2000 chars', () => {
    const schema = z.object(clusterShape);
    expect(() =>
      schema.parse({
        id: 'onetrust',
        title: 'OneTrust overlay intercepts clicks',
        bucket: 'easy-fix',
        tests: ['com.x.FooTest'],
        detail: 'x'.repeat(2001),
      })
    ).toThrow();
  });

  it('omitting detail is still valid (optional)', () => {
    const schema = z.object(clusterShape);
    const ok = schema.parse({
      id: 'onetrust',
      title: 'OneTrust overlay intercepts clicks',
      bucket: 'easy-fix',
      tests: ['com.x.FooTest'],
    });
    expect(ok.detail).toBeUndefined();
  });
});

describe('set_clusters tool handler', () => {
  it('publishes the detail field onto the run snapshot clusters', async () => {
    const run = runStore.create(cfg);
    const tools = buildTools(run);
    const setClusters = tools.find((t) => t.name === 'set_clusters')!;
    await setClusters.handler(
      {
        clusters: [
          {
            id: 'onetrust',
            title: 'OneTrust overlay intercepts clicks',
            bucket: 'easy-fix',
            tests: ['com.x.FooTest'],
            detail: 'Failing signature: ElementClickInterceptedException on ot-sdk-row. Broke because the consent banner now renders above the fold. Fix: dismiss it in setup.',
          },
        ],
      },
      {}
    );
    expect(run.snapshot.clusters).toHaveLength(1);
    expect(run.snapshot.clusters[0].detail).toBe(
      'Failing signature: ElementClickInterceptedException on ot-sdk-row. Broke because the consent banner now renders above the fold. Fix: dismiss it in setup.'
    );
    expect(run.snapshot.clusters[0].state).toBe('proposed');
  });

  it('omitting detail leaves it undefined on the cluster', async () => {
    const run = runStore.create(cfg);
    const tools = buildTools(run);
    const setClusters = tools.find((t) => t.name === 'set_clusters')!;
    await setClusters.handler(
      { clusters: [{ id: 'gone-flag', title: 'Flag removed', bucket: 'likely-bug', tests: ['BazTest'] }] },
      {}
    );
    expect(run.snapshot.clusters[0].detail).toBeUndefined();
  });
});
