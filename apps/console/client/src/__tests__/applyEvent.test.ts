import { describe, it, expect } from 'vitest';
import { applyEvent } from '../useRunStream';
import type { PhaseState, RunSnapshot } from '../types';

const base: RunSnapshot = {
  config: null, phases: [], activePhase: null,
  telemetry: { startedAt: null, elapsedMs: 0, tokens: 0, thinking: false },
  log: [], status: 'running', findings: [], files: [], tests: [],
  reportUrl: null, clusters: [], currentSubStage: null, pipelineStatus: null,
  pendingQuestion: null,
};

const basePhases: PhaseState[] = [
  { id: 'ingest', status: 'queued' },
  { id: 'cluster', status: 'queued' },
];

describe('applyEvent new variants', () => {
  it('clusters replaces the whole list', () => {
    const s = applyEvent(base, {
      type: 'clusters',
      clusters: [{ id: 'c1', title: 'X', bucket: 'easy-fix', tests: [], state: 'proposed' }],
    });
    expect(s.clusters).toHaveLength(1);
    expect(s.clusters[0].id).toBe('c1');
  });

  it('cluster adds then dedups by id', () => {
    let s = applyEvent(base, {
      type: 'cluster',
      cluster: { id: 'c-x', title: 'X', bucket: 'easy-fix', tests: [], state: 'proposed' },
    });
    s = applyEvent(s, {
      type: 'cluster',
      cluster: { id: 'c-x', title: 'X', bucket: 'easy-fix', tests: [], state: 'picked' },
    });
    expect(s.clusters).toHaveLength(1);
    expect(s.clusters[0].state).toBe('picked');
  });

  it('subStage updates currentSubStage', () => {
    const s = applyEvent(base, { type: 'subStage', subStage: 'pass-3' });
    expect(s.currentSubStage).toBe('pass-3');
  });

  it('nudging toggles the recovery-chip flag (#10)', () => {
    const on = applyEvent(base, { type: 'nudging', nudging: true });
    expect(on.nudging).toBe(true);
    const off = applyEvent(on, { type: 'nudging', nudging: false });
    expect(off.nudging).toBe(false);
  });
});

describe('applyEvent: snapshot', () => {
  it('replaces the entire state wholesale', () => {
    const incoming: RunSnapshot = {
      ...base,
      status: 'completed',
      log: [{ id: 'l1', ts: 1, kind: 'info', text: 'hi' }],
      telemetry: { startedAt: 5, elapsedMs: 100, tokens: 9, thinking: false },
    };
    const s = applyEvent(base, { type: 'snapshot', snapshot: incoming });
    expect(s).toBe(incoming);
    expect(s.status).toBe('completed');
    expect(s.log).toHaveLength(1);
  });
});

describe('applyEvent: log', () => {
  it('appends a new entry', () => {
    let s = applyEvent(base, { type: 'log', entry: { id: 'l1', ts: 1, kind: 'info', text: 'first' } });
    s = applyEvent(s, { type: 'log', entry: { id: 'l2', ts: 2, kind: 'bash', text: 'second' } });
    expect(s.log.map((e) => e.text)).toEqual(['first', 'second']);
  });

  it('replaces an entry in place by id (the live progress-bar case) instead of appending', () => {
    let s = applyEvent(base, {
      type: 'log',
      entry: { id: 'p1', ts: 1, kind: 'progress', text: 'chromium', progress: { percent: 10 } },
    });
    s = applyEvent(s, {
      type: 'log',
      entry: { id: 'a2', ts: 2, kind: 'info', text: 'unrelated' },
    });
    s = applyEvent(s, {
      type: 'log',
      entry: { id: 'p1', ts: 3, kind: 'progress', text: 'chromium', progress: { percent: 55 } },
    });

    expect(s.log).toHaveLength(2);
    // Position preserved (replaced at its original index, not moved to the end).
    expect(s.log[0]).toMatchObject({ id: 'p1', progress: { percent: 55 } });
    expect(s.log[1]).toMatchObject({ id: 'a2', text: 'unrelated' });
  });

  it('does not mutate the previous snapshot log array', () => {
    const prevLog = [{ id: 'l0', ts: 0, kind: 'info' as const, text: 'orig' }];
    const prev = { ...base, log: prevLog };
    const s = applyEvent(prev, { type: 'log', entry: { id: 'l1', ts: 1, kind: 'info', text: 'new' } });
    expect(prevLog).toHaveLength(1);
    expect(s.log).not.toBe(prevLog);
  });
});

describe('applyEvent: phase', () => {
  it('merges partial updates onto the matching phase and tracks activePhase', () => {
    const prev = { ...base, phases: basePhases };
    let s = applyEvent(prev, {
      type: 'phase',
      phaseId: 'ingest',
      status: 'active',
      stage: 'compiling config',
      progress: 10,
      startedAt: 1000,
      reviewerVerdict: 'pending',
      reviewerCycles: 0,
    });

    const ingest = () => s.phases.find((p) => p.id === 'ingest')!;
    expect(ingest()).toMatchObject({
      status: 'active', stage: 'compiling config', progress: 10, startedAt: 1000,
      reviewerVerdict: 'pending', reviewerCycles: 0,
    });
    expect(s.activePhase).toBe('ingest');
    // Untouched phase is unaffected.
    expect(s.phases.find((p) => p.id === 'cluster')).toMatchObject({ status: 'queued' });

    // A follow-up progress-only update (stage/reviewer omitted) must preserve
    // the previously-set stage/reviewer fields, not clobber them with undefined.
    s = applyEvent(s, { type: 'phase', phaseId: 'ingest', status: 'active', progress: 50 });
    expect(ingest()).toMatchObject({
      status: 'active', stage: 'compiling config', progress: 50,
      reviewerVerdict: 'pending', reviewerCycles: 0,
    });
    expect(s.activePhase).toBe('ingest');

    // Finishing the active phase clears activePhase and stamps endedAt.
    s = applyEvent(s, { type: 'phase', phaseId: 'ingest', status: 'done', endedAt: 2000 });
    expect(ingest()).toMatchObject({ status: 'done', endedAt: 2000, stage: 'compiling config', progress: 50 });
    expect(s.activePhase).toBeNull();

    // Activating a different phase moves activePhase without touching ingest.
    s = applyEvent(s, { type: 'phase', phaseId: 'cluster', status: 'active', stage: 'wiring fixtures' });
    expect(s.activePhase).toBe('cluster');
    expect(ingest()).toMatchObject({ status: 'done', stage: 'compiling config' });
  });

  it('is a no-op for a phaseId not present in state', () => {
    const prev = { ...base, phases: basePhases };
    const s = applyEvent(prev, { type: 'phase', phaseId: 'report', status: 'active' });
    expect(s.phases).toEqual(basePhases);
    // 'report' becomes activePhase even though it has no matching phase row —
    // matches current reducer behavior (activePhase tracking is independent
    // of whether the phases array contains that id).
    expect(s.activePhase).toBe('report');
  });
});

describe('applyEvent: telemetry', () => {
  it('shallow-merges the telemetry patch, preserving untouched fields', () => {
    let s = applyEvent(base, { type: 'telemetry', telemetry: { tokens: 100 } });
    expect(s.telemetry).toMatchObject({ tokens: 100, elapsedMs: 0, thinking: false, startedAt: null });

    s = applyEvent(s, { type: 'telemetry', telemetry: { thinking: true, costUsd: 0.5 } });
    expect(s.telemetry).toMatchObject({ tokens: 100, thinking: true, costUsd: 0.5 });
  });
});

describe('applyEvent: status', () => {
  it('sets status verbatim', () => {
    const s = applyEvent(base, { type: 'status', status: 'failed' });
    expect(s.status).toBe('failed');
  });
});

describe('applyEvent: finding', () => {
  it('appends findings in arrival order without dedup at the reducer level', () => {
    let s = applyEvent(base, {
      type: 'finding',
      finding: { id: 'f1', ts: 1, severity: 'critical', area: 'checkout', title: 'double charge' },
    });
    s = applyEvent(s, {
      type: 'finding',
      finding: { id: 'f2', ts: 2, severity: 'low', area: 'a11y', title: 'missing aria' },
    });
    expect(s.findings.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(s.findings[0]).toMatchObject({ severity: 'critical', area: 'checkout' });
  });
});

describe('applyEvent: file', () => {
  it('appends file changes', () => {
    let s = applyEvent(base, {
      type: 'file',
      file: { id: 'fc1', ts: 1, path: 'tests/e2e/specs/a.spec.ts', kind: 'created' },
    });
    s = applyEvent(s, {
      type: 'file',
      file: { id: 'fc2', ts: 2, path: 'tests/e2e/specs/a.spec.ts', kind: 'modified' },
    });
    expect(s.files.map((f) => f.kind)).toEqual(['created', 'modified']);
  });
});

describe('applyEvent: test', () => {
  it('appends test artifacts', () => {
    let s = applyEvent(base, {
      type: 'test',
      test: { id: 't1', ts: 1, path: 'tests/e2e/specs/a.spec.ts', name: 'a.spec.ts', status: 'wrote' },
    });
    s = applyEvent(s, {
      type: 'test',
      test: { id: 't2', ts: 2, path: 'tests/e2e/specs/b.spec.ts', name: 'b.spec.ts', status: 'updated' },
    });
    expect(s.tests.map((t) => t.name)).toEqual(['a.spec.ts', 'b.spec.ts']);
    expect(s.tests[1].status).toBe('updated');
  });
});

describe('applyEvent: report', () => {
  it('sets reportUrl and a later report replaces it (scalar, not appended)', () => {
    let s = applyEvent(base, { type: 'report', reportUrl: '/api/runs/r1/report' });
    expect(s.reportUrl).toBe('/api/runs/r1/report');
    s = applyEvent(s, { type: 'report', reportUrl: '/api/runs/r1/report-v2' });
    expect(s.reportUrl).toBe('/api/runs/r1/report-v2');
  });
});

describe('applyEvent: pipelineStatus', () => {
  it('sets and clears pipelineStatus', () => {
    let s = applyEvent(base, { type: 'pipelineStatus', pipelineStatus: 'phase-3-active' });
    expect(s.pipelineStatus).toBe('phase-3-active');
    s = applyEvent(s, { type: 'pipelineStatus', pipelineStatus: null });
    expect(s.pipelineStatus).toBeNull();
  });
});

describe('applyEvent: question', () => {
  it('question event sets pendingQuestion', () => {
    const q = { questionId: 'r1-q1', questions: [{ question: 'A?', header: 'H', options: [{ label: 'A' }], multiSelect: false }] };
    const next = applyEvent(base, { type: 'question', question: q } as any);
    expect(next.pendingQuestion).toEqual(q);
  });

  it('questionResolved clears pendingQuestion', () => {
    const start = { ...base, pendingQuestion: { questionId: 'r1-q1', questions: [] } } as any;
    const next = applyEvent(start, { type: 'questionResolved', questionId: 'r1-q1' } as any);
    expect(next.pendingQuestion).toBeNull();
  });
});

describe('phase activeMs streaming (F15)', () => {
  it('merges activeMs from a phase event and keeps the prior value when absent', () => {
    const withPhases = { ...base, phases: basePhases.map((p) => ({ ...p })) };
    let s = applyEvent(withPhases, { type: 'phase', phaseId: 'ingest', status: 'done', activeMs: 4321 });
    expect(s.phases.find((p) => p.id === 'ingest')?.activeMs).toBe(4321);
    s = applyEvent(s, { type: 'phase', phaseId: 'ingest', status: 'done' });
    expect(s.phases.find((p) => p.id === 'ingest')?.activeMs).toBe(4321);
  });
});
