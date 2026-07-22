import { describe, it, expect } from 'vitest';
import { runStore } from '../run-store.js';
import { makeRedactor } from '../redact.js';
import type { RunSnapshot } from '../types.js';

const baseConfig = {
  projectPath: '/tmp/proj',
  targetUrl: 'https://r.example/j/1',
  testbox: 'tb1',
  mode: 'triage' as const,
  permissionPolicy: 'autonomous' as const,
  runId: 'restore-run-1',
};

function makeSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    config: { ...baseConfig },
    phases: [{ id: 'ingest', status: 'done' }, { id: 'cluster', status: 'active' }] as RunSnapshot['phases'],
    activePhase: 'cluster',
    telemetry: { startedAt: 1000, elapsedMs: 5000, tokens: 42, thinking: false },
    log: [{ id: 'l1', ts: 1, kind: 'info', text: 'hello' }],
    status: 'paused',
    findings: [],
    files: [],
    tests: [],
    reportUrl: null,
    clusters: [{ id: 'c1', title: 'x', bucket: 'easy-fix', tests: [], state: 'picked' }],
    currentSubStage: null,
    pipelineStatus: null,
    pendingQuestion: null,
    sessionId: 'sdk-session-abc',
    ...overrides,
  };
}

describe('RunStore.restore', () => {
  it('restores a persisted snapshot as an active, paused run seeded from the snapshot', () => {
    const snapshot = makeSnapshot();
    const run = runStore.restore(snapshot);

    expect(run).not.toBeNull();
    expect(run!.snapshot.status).toBe('paused');
    expect(run!.snapshot.sessionId).toBe('sdk-session-abc');
    expect(run!.snapshot.clusters).toEqual(snapshot.clusters);
    expect(run!.snapshot.phases).toEqual(snapshot.phases);
    expect(run!.snapshot.log).toEqual(snapshot.log);
    expect(run!.snapshot.telemetry).toEqual(snapshot.telemetry);

    // registered in the store, listed as active (non-terminal)
    expect(runStore.get(snapshot.config!.runId)).toBe(run);
    expect(runStore.listActive().some((r) => r.runId === snapshot.config!.runId)).toBe(true);
  });

  it('forces status paused even if the persisted snapshot was not (defensive)', () => {
    const snapshot = makeSnapshot({
      config: { ...baseConfig, runId: 'restore-run-force-paused' },
      status: 'running',
    });
    const run = runStore.restore(snapshot);
    expect(run!.snapshot.status).toBe('paused');
  });

  it('clears any stale pendingQuestion — a restored run can never answer it', () => {
    const snapshot = makeSnapshot({
      config: { ...baseConfig, runId: 'restore-run-pending-q' },
      pendingQuestion: {
        questionId: 'q1',
        questions: [{ question: 'q', header: 'h', multiSelect: false, options: [{ label: 'a' }] }],
      },
    });
    const run = runStore.restore(snapshot);
    expect(run!.snapshot.pendingQuestion).toBeNull();
  });

  it('passes the redactor through to the restored run (future log()/setPendingQuestion calls redact)', () => {
    const SECRET = 'sekret-token-123';
    const redactor = makeRedactor([SECRET]);
    const snapshot = makeSnapshot({ config: { ...baseConfig, runId: 'restore-run-redactor' } });
    const run = runStore.restore(snapshot, redactor);
    run!.log({ kind: 'info', text: `token ${SECRET}` });
    expect(run!.snapshot.log[run!.snapshot.log.length - 1].text).toBe('token «redacted»');
  });

  it('does not double-restore an id that is already live', () => {
    const snapshot = makeSnapshot({ config: { ...baseConfig, runId: 'restore-run-dup' } });
    const first = runStore.restore(snapshot);
    const second = runStore.restore(snapshot);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('returns null for a snapshot with no config', () => {
    const snapshot = makeSnapshot({ config: null });
    expect(runStore.restore(snapshot)).toBeNull();
  });
});

describe('RunStore.all', () => {
  it('lists every run currently held, regardless of status', () => {
    const run = runStore.create({
      projectPath: '/tmp/a',
      targetUrl: 'https://r.example',
      testbox: 'tb1',
      mode: 'triage',
      permissionPolicy: 'autonomous',
    });
    expect(runStore.all()).toContain(run);
  });
});
