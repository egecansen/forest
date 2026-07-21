import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveRun, MAX_PERSISTED_RUNS } from '../persistence.js';
import type { RunSnapshot } from '../types.js';

/**
 * Regression test for the unbounded-history fix: saveRun prunes the runs
 * dir to the newest MAX_PERSISTED_RUNS `*.json` files after every
 * successful save, mirroring the in-memory Run-store's MAX_RUNS cap so
 * on-disk history (and `GET /api/history`, which scans the whole dir)
 * can't grow without bound.
 *
 * Deliberately a separate file from persistence.test.ts (per the fix
 * brief) rather than added to it.
 */

const makeSnapshot = (runId: string, startedAt: number): RunSnapshot => ({
  config: {
    projectPath: '/tmp/my-project',
    targetUrl: 'https://example.com',
    testbox: 'tb1',
    mode: 'triage',
    permissionPolicy: 'autonomous',
    projectMode: 'new',
    runId,
  },
  phases: [],
  activePhase: null,
  telemetry: { startedAt, elapsedMs: 0, tokens: 0, thinking: false },
  log: [],
  status: 'completed',
  findings: [],
  files: [],
  tests: [],
  reportUrl: null,
  clusters: [],
  currentSubStage: null,
  pipelineStatus: null,
  pendingQuestion: null,
});

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hektor-demo-persistence-cap-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('saveRun on-disk history cap', () => {
  it('keeps only the newest MAX_PERSISTED_RUNS runs on disk, pruning the oldest first', async () => {
    const total = MAX_PERSISTED_RUNS + 15;
    for (let i = 0; i < total; i++) {
      // Strictly increasing startedAt values give a deterministic recency
      // order regardless of filesystem mtime resolution.
      await saveRun(dir, makeSnapshot(`run-${i}`, i));
    }

    const entries = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    expect(entries).toHaveLength(MAX_PERSISTED_RUNS);

    const survivingIndices = entries
      .map((n) => Number(n.replace(/^run-/, '').replace(/\.json$/, '')))
      .sort((a, b) => a - b);
    const expectedIndices = Array.from(
      { length: MAX_PERSISTED_RUNS },
      (_, i) => total - MAX_PERSISTED_RUNS + i
    );
    expect(survivingIndices).toEqual(expectedIndices);

    // No leftover temp files from the prune's own atomic-write machinery.
    const allEntries = await fs.readdir(dir);
    expect(allEntries.every((n) => n.endsWith('.json'))).toBe(true);
  });

  it('is a no-op under the cap: nothing is pruned while at or below MAX_PERSISTED_RUNS', async () => {
    await saveRun(dir, makeSnapshot('run-a', 1));
    await saveRun(dir, makeSnapshot('run-b', 2));

    const entries = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    expect(entries.sort()).toEqual(['run-a.json', 'run-b.json']);
  });

  it('a prune failure does not fail the save (tolerant of an unreadable sibling file)', async () => {
    // Plant a file that looks like a run file but isn't valid JSON — the
    // per-file recency lookup falls back to mtime for it rather than
    // throwing, so saveRun (and the prune it triggers) must still succeed.
    await fs.writeFile(path.join(dir, 'not-json.json'), '{ not valid', 'utf8');

    await expect(saveRun(dir, makeSnapshot('run-a', 1))).resolves.toBeUndefined();

    const entries = await fs.readdir(dir);
    expect(entries).toContain('run-a.json');
  });
});
