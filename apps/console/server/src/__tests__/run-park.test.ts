import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStore } from '../run-store.js';
import { makeCanUseTool } from '../driver-can-use-tool.js';
import { pendingAnswers } from '../pending-answers.js';
import { saveRun } from '../persistence.js';
import { parkAllRuns, restoreParkedRuns } from '../run-park.js';
import type { DriverHandle } from '../driver.js';
import type { RunSnapshot } from '../types.js';

const cfg = {
  projectPath: '/tmp/x',
  targetUrl: 'https://r.example/j/1',
  testbox: 'tb161',
  mode: 'triage' as const,
  permissionPolicy: 'autonomous' as const,
};

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hektor-run-park-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeHandle(pauseSpy: () => void): DriverHandle {
  return Object.assign(() => {}, { pause: pauseSpy }) as DriverHandle;
}

describe('parkAllRuns', () => {
  it('parks a running run via its driver handle and persists it as paused', async () => {
    const run = runStore.create(cfg);
    run.setStatus('running');
    const runId = run.snapshot.config!.runId;
    const pauseSpy = vi.fn();

    await parkAllRuns([run], () => makeHandle(pauseSpy), dir);

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(run.snapshot.status).toBe('paused');
    const saved = JSON.parse(await fs.readFile(path.join(dir, `${runId}.json`), 'utf8')) as RunSnapshot;
    expect(saved.status).toBe('paused');
  });

  it('parks a real awaiting-input run (via the AskUserQuestion bridge) without the deny path flipping status back to running', async () => {
    const run = runStore.create(cfg);
    const canUseTool = makeCanUseTool(run);
    const pending = canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'pick?', header: 'h', multiSelect: false, options: [{ label: 'a' }] }] },
      {}
    );
    // let the bridge register the pending question and flip to awaiting-input
    await new Promise((r) => setTimeout(r, 0));
    expect(run.snapshot.status).toBe('awaiting-input');

    await parkAllRuns([run], () => undefined, dir);

    // the held canUseTool promise settles to a deny once rejectAll fires
    const result = await pending;
    expect(result.behavior).toBe('deny');
    // flush the microtask the deny resolution runs on, then assert the final
    // state was NOT clobbered back to 'running' by clearPendingQuestion.
    await new Promise((r) => setTimeout(r, 0));
    expect(run.snapshot.status).toBe('paused');
    expect(run.snapshot.pendingQuestion).toBeNull();

    const runId = run.snapshot.config!.runId;
    const saved = JSON.parse(await fs.readFile(path.join(dir, `${runId}.json`), 'utf8')) as RunSnapshot;
    expect(saved.status).toBe('paused');
  });

  it('does not touch an already-terminal run', async () => {
    const run = runStore.create(cfg);
    run.finish(true); // -> completed
    const runId = run.snapshot.config!.runId;

    await parkAllRuns([run], () => undefined, dir);

    expect(run.snapshot.status).toBe('completed');
    await expect(fs.readFile(path.join(dir, `${runId}.json`), 'utf8')).rejects.toThrow();
  });

});

function makeHistorySnapshot(runId: string, startedAt: number, status: RunSnapshot['status']): RunSnapshot {
  return {
    config: { projectPath: '/tmp/p', targetUrl: 'https://r.example', testbox: 'tb1', mode: 'triage', permissionPolicy: 'autonomous', runId },
    phases: [],
    activePhase: null,
    telemetry: { startedAt, elapsedMs: 0, tokens: 0, thinking: false },
    log: [],
    status,
    findings: [],
    files: [],
    tests: [],
    reportUrl: null,
    clusters: [],
    currentSubStage: null,
    pipelineStatus: null,
    pendingQuestion: null,
    sessionId: `sess-${runId}`,
  };
}

describe('restoreParkedRuns', () => {
  it('restores only paused snapshots, newest first, capped at the default limit of 10', async () => {
    for (let i = 0; i < 12; i++) {
      await saveRun(dir, makeHistorySnapshot(`paused-${i}`, i, 'paused'));
    }
    // terminal snapshots must never be restored
    await saveRun(dir, makeHistorySnapshot('done-1', 100, 'completed'));
    await saveRun(dir, makeHistorySnapshot('done-2', 101, 'failed'));

    const restored = await restoreParkedRuns(dir, runStore);

    expect(restored).toHaveLength(10);
    expect(restored.every((r) => r.snapshot.status === 'paused')).toBe(true);
    const restoredIds = restored.map((r) => r.snapshot.config!.runId).sort();
    const expectedIds = Array.from({ length: 10 }, (_, i) => `paused-${i + 2}`).sort(); // newest 10 of 0..11
    expect(restoredIds).toEqual(expectedIds);
    expect(restoredIds).not.toContain('done-1');
    expect(restoredIds).not.toContain('done-2');

    for (const r of restored) {
      expect(runStore.get(r.snapshot.config!.runId)).toBe(r);
    }
  });

  it('respects a custom limit', async () => {
    for (let i = 0; i < 5; i++) {
      await saveRun(dir, makeHistorySnapshot(`lim-${i}`, i, 'paused'));
    }
    const restored = await restoreParkedRuns(dir, runStore, { limit: 3 });
    expect(restored).toHaveLength(3);
    expect(restored.map((r) => r.snapshot.config!.runId).sort()).toEqual(['lim-2', 'lim-3', 'lim-4'].sort());
  });

  it('never double-restores the same id (guards an id already live in the store)', async () => {
    await saveRun(dir, makeHistorySnapshot('already-live', 1, 'paused'));
    const first = await restoreParkedRuns(dir, runStore);
    const second = await restoreParkedRuns(dir, runStore);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('invokes onRestored for each restored run (used to attach persistence)', async () => {
    await saveRun(dir, makeHistorySnapshot('with-hook', 1, 'paused'));
    const seen: string[] = [];
    await restoreParkedRuns(dir, runStore, { onRestored: (run) => seen.push(run.snapshot.config!.runId) });
    expect(seen).toEqual(['with-hook']);
  });
});
