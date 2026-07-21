import { describe, it, expect } from 'vitest';
import { Run } from '../run-store.js';
import type { RunConfig } from '../types.js';

const cfg: RunConfig = {
  projectPath: '/tmp/app',
  targetUrl: 'https://example.com',
  testbox: 'tb1',
  mode: 'triage',
  permissionPolicy: 'autonomous',
  runId: 'log-coalesce-test',
};

const texts = (run: Run) => run.snapshot.log.map((l) => l.text);

describe('log coalescing (#11)', () => {
  it('folds a burst of same-file edits into one "Refining <file> ×N" line', () => {
    const run = new Run(cfg);
    run.log({ kind: 'info', text: 'Writing login.spec.ts' }, { verb: 'write', file: 'login.spec.ts' });
    for (let i = 0; i < 4; i++) {
      run.log({ kind: 'info', text: 'Editing login.spec.ts' }, { verb: 'edit', file: 'login.spec.ts' });
    }
    // Write stays its own line; the 4 edits collapse to a single evolving line.
    expect(texts(run)).toEqual(['Writing login.spec.ts', 'Refining login.spec.ts ×4']);
  });

  it('drops a read that only verifies the agent’s own just-written file', () => {
    const run = new Run(cfg);
    run.log({ kind: 'info', text: 'Writing a.ts' }, { verb: 'write', file: 'a.ts' });
    run.log({ kind: 'info', text: 'Reading a.ts' }, { verb: 'read', file: 'a.ts' });
    expect(texts(run)).toEqual(['Writing a.ts']); // read-after-own-write suppressed
  });

  it('keeps a read of a different file, and a standalone read', () => {
    const run = new Run(cfg);
    run.log({ kind: 'info', text: 'Writing a.ts' }, { verb: 'write', file: 'a.ts' });
    run.log({ kind: 'info', text: 'Reading b.ts' }, { verb: 'read', file: 'b.ts' });
    expect(texts(run)).toEqual(['Writing a.ts', 'Reading b.ts']);
  });

  it('a non-file-op entry between edits breaks the burst (no cross-run coalesce)', () => {
    const run = new Run(cfg);
    run.log({ kind: 'info', text: 'Editing a.ts' }, { verb: 'edit', file: 'a.ts' });
    run.log({ kind: 'bash', text: 'npx playwright test' }); // breaks the run
    run.log({ kind: 'info', text: 'Editing a.ts' }, { verb: 'edit', file: 'a.ts' });
    expect(texts(run)).toEqual(['Editing a.ts', 'npx playwright test', 'Editing a.ts']);
  });
});
