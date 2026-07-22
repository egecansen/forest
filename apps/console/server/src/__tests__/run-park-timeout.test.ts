import { describe, it, expect, vi } from 'vitest';

// Mocks saveRun to hang forever (never resolves/rejects) while keeping every
// other persistence.js export real, so we can prove parkAllRuns' `timeoutMs`
// race genuinely bounds the batch instead of hanging on a stuck save —
// something a happy-path test against a real, fast temp dir can never prove.
vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return {
    ...actual,
    saveRun: vi.fn(() => new Promise<void>(() => {})),
  };
});

const { parkAllRuns } = await import('../run-park.js');
const { runStore } = await import('../run-store.js');

const cfg = {
  projectPath: '/tmp/x',
  targetUrl: 'https://r.example',
  testbox: 'tb161',
  mode: 'triage' as const,
  permissionPolicy: 'autonomous' as const,
};

describe('parkAllRuns timeout bound', () => {
  it('resolves within timeoutMs even when saveRun never settles', async () => {
    const run = runStore.create(cfg);
    run.setStatus('running');

    const start = Date.now();
    await parkAllRuns([run], () => undefined, '/irrelevant', { timeoutMs: 50 });
    const elapsed = Date.now() - start;

    // Bounded by the race, not by the (permanently pending) save.
    expect(elapsed).toBeLessThan(1000);
    // The park side effects (status force-set) still happened before the
    // save that's hanging — only the persistence write itself is stuck.
    expect(run.snapshot.status).toBe('paused');
  });
});
