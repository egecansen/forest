import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveRun, listRuns, loadRun, isSafeRunId, resolveInsideRoot } from '../persistence.js';
import type { RunSnapshot } from '../types.js';

const makeSnapshot = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  config: {
    projectPath: '/tmp/my-project',
    targetUrl: 'https://example.com',
    testbox: 'tb1',
    mode: 'triage',
    permissionPolicy: 'autonomous',
    projectMode: 'new',
    runId: 'run-1',
  },
  phases: [],
  activePhase: null,
  telemetry: { startedAt: 1000, elapsedMs: 5000, tokens: 42, thinking: false },
  log: [],
  status: 'completed',
  findings: [{ id: 'f1', ts: 1, severity: 'high', area: 'auth', title: 'x' }],
  files: [],
  tests: [{ id: 't1', ts: 1, path: 'a.spec.ts', name: 'a', status: 'wrote' }],
  reportUrl: null,
  clusters: [],
  currentSubStage: null,
  pipelineStatus: null,
  pendingQuestion: null,
  ...overrides,
});

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hektor-demo-persistence-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('saveRun / listRuns / loadRun round trip', () => {
  it('saves a snapshot and loads it back byte-for-byte (structurally)', async () => {
    const snapshot = makeSnapshot();
    await saveRun(dir, snapshot);
    const loaded = await loadRun(dir, 'run-1');
    expect(loaded).toEqual(snapshot);
  });

  it('creates the runs directory on first write', async () => {
    const nested = path.join(dir, 'nested', 'runs');
    await saveRun(nested, makeSnapshot());
    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });

  it('writes atomically: no leftover temp file after a save', async () => {
    await saveRun(dir, makeSnapshot());
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['run-1.json']);
  });

  it('listRuns returns a RunSummary projection for a saved run', async () => {
    await saveRun(dir, makeSnapshot());
    const summaries = await listRuns(dir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      runId: 'run-1',
      projectPath: '/tmp/my-project',
      targetUrl: 'https://example.com',
      mode: 'triage',
      status: 'completed',
      startedAt: 1000,
      findings: 1,
      tests: 1,
    });
  });

  it('listRuns sorts newest-first by startedAt', async () => {
    await saveRun(dir, makeSnapshot({ config: { ...makeSnapshot().config!, runId: 'old' }, telemetry: { startedAt: 1000, elapsedMs: 0, tokens: 0, thinking: false } }));
    await saveRun(dir, makeSnapshot({ config: { ...makeSnapshot().config!, runId: 'newest' }, telemetry: { startedAt: 3000, elapsedMs: 0, tokens: 0, thinking: false } }));
    await saveRun(dir, makeSnapshot({ config: { ...makeSnapshot().config!, runId: 'middle' }, telemetry: { startedAt: 2000, elapsedMs: 0, tokens: 0, thinking: false } }));

    const summaries = await listRuns(dir);
    expect(summaries.map((s) => s.runId)).toEqual(['newest', 'middle', 'old']);
  });

  it('loadRun returns null for an unknown runId', async () => {
    const loaded = await loadRun(dir, 'does-not-exist');
    expect(loaded).toBeNull();
  });
});

describe('isSafeRunId', () => {
  it('accepts a real randomUUID() value', () => {
    expect(isSafeRunId(randomUUID())).toBe(true);
  });

  it('accepts a bare alphanumeric token with dashes/underscores', () => {
    expect(isSafeRunId('abc-123_XY')).toBe(true);
  });

  it.each([
    ['a traversal sequence', '../../etc'],
    ['an embedded slash', 'a/b'],
    ['bare dot-dot', '..'],
    ['an empty string', ''],
    ['an embedded dot', 'a.b'],
    ['an embedded space', 'a b'],
  ])('rejects %s (%j)', (_label, value) => {
    expect(isSafeRunId(value)).toBe(false);
  });
});

describe('path traversal defense (persistence layer)', () => {
  it('loadRun returns null for a traversal runId and never reads outside dir', async () => {
    // `dir` is a temp runs dir; plant a file just outside it (its parent)
    // that a `../<name>` runId would resolve to if traversal worked.
    const outsideName = `outside-secret-${randomUUID()}`;
    const outsidePath = path.join(path.dirname(dir), `${outsideName}.json`);
    await fs.writeFile(outsidePath, JSON.stringify({ leaked: true }), 'utf8');
    try {
      const loaded = await loadRun(dir, `../${outsideName}`);
      expect(loaded).toBeNull();
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('loadRun returns null for a deeply nested traversal runId', async () => {
    const loaded = await loadRun(dir, '../../../../../../etc/passwd');
    expect(loaded).toBeNull();
  });

  it('saveRun refuses to write when the snapshot runId escapes dir', async () => {
    const snapshot = makeSnapshot({ config: { ...makeSnapshot().config!, runId: '../escaped' } });
    await saveRun(dir, snapshot);
    // Nothing should have been written inside dir, and nothing outside it either.
    const outside = path.join(path.dirname(dir), 'escaped.json');
    await expect(fs.access(outside)).rejects.toThrow();
  });
});

describe('listRuns tolerance', () => {
  it('returns [] when the runs directory does not exist', async () => {
    const missing = path.join(dir, 'never-created');
    expect(await listRuns(missing)).toEqual([]);
  });

  it('skips a corrupt/partial JSON file instead of throwing', async () => {
    await saveRun(dir, makeSnapshot());
    await fs.writeFile(path.join(dir, 'corrupt-run.json'), '{ this is not valid json', 'utf8');

    const summaries = await listRuns(dir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].runId).toBe('run-1');
  });

  it('skips a JSON file with no config (nothing to key a summary by)', async () => {
    await saveRun(dir, makeSnapshot());
    await fs.writeFile(path.join(dir, 'no-config.json'), JSON.stringify({ status: 'idle' }), 'utf8');

    const summaries = await listRuns(dir);
    expect(summaries).toHaveLength(1);
  });

  it('ignores non-JSON files in the directory', async () => {
    await saveRun(dir, makeSnapshot());
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello', 'utf8');

    const summaries = await listRuns(dir);
    expect(summaries).toHaveLength(1);
  });
});

describe('resolveInsideRoot (Files-tab viewer path guard, F5)', () => {
  const root = '/tmp/proj';

  it('resolves a normal descendant path', () => {
    expect(resolveInsideRoot(root, 'tests/e2e/base.ts')).toBe(path.resolve(root, 'tests/e2e/base.ts'));
    expect(resolveInsideRoot(root, 'package.json')).toBe(path.resolve(root, 'package.json'));
  });

  it('rejects traversal that escapes the root', () => {
    expect(resolveInsideRoot(root, '../secrets.txt')).toBeNull();
    expect(resolveInsideRoot(root, '../../etc/passwd')).toBeNull();
    expect(resolveInsideRoot(root, 'a/../../b')).toBeNull();
  });

  it('rejects an absolute path (ignores root)', () => {
    expect(resolveInsideRoot(root, '/etc/passwd')).toBeNull();
  });

  it('rejects an empty path', () => {
    expect(resolveInsideRoot(root, '')).toBeNull();
  });

  it('does not treat a sibling dir with the same prefix as inside', () => {
    // `/tmp/proj-evil` must NOT count as inside `/tmp/proj`.
    expect(resolveInsideRoot(root, '../proj-evil/x')).toBeNull();
  });
});
