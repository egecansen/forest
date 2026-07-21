import type { Run } from './run-store.js';

/**
 * Temporary triage-shaped placeholder run body, used by `demo: true` runs and
 * by tests until Task 9 wires up the real Agent SDK driver (see driver.ts).
 * Walks the first two triage phases (ingest, cluster) with a couple of log
 * lines, then finishes successfully. Honours run.isStopped() so it can be
 * interrupted mid-flight.
 */
export async function runSimulator(run: Run): Promise<void> {
  run.setStatus('running');
  run.setTelemetry({ thinking: true });

  const cfg = run.snapshot.config;
  run.log({ kind: 'active', text: `Ingesting failures for ${cfg?.targetUrl ?? 'report'}` });
  await wait(200, run);
  if (run.isStopped()) return;

  run.setPhase('ingest', 'active', { stage: 'pulling FAILED docs', progress: 50 });
  await wait(200, run);
  if (run.isStopped()) return;
  run.log({ kind: 'success', text: 'pinned the build, pulled FAILED docs from the report' });
  run.setPhase('ingest', 'done', { progress: 100, stage: 'ingest complete' });

  if (run.isStopped()) return;
  run.setPhase('cluster', 'active', { stage: 'grouping by root cause', progress: 50 });
  await wait(200, run);
  if (run.isStopped()) return;
  run.log({ kind: 'success', text: 'grouped failures into root-cause clusters' });
  run.setPhase('cluster', 'done', { progress: 100, stage: 'cluster complete' });

  run.setTelemetry({ thinking: false });
  run.finish(true);
  run.log({ kind: 'success', text: 'Run completed successfully.' });
}

// Exported for unit testing (see __tests__/simulator.test.ts) — verifying
// the 'stopped' listener doesn't leak needs direct access to this helper
// rather than driving a full runSimulator() pass.
export function wait(ms: number, run: Run): Promise<void> {
  return new Promise((resolve) => {
    const onStop = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      // Normal (non-stop) resolution: the 'stopped' listener registered
      // below never fired, so it's still attached to `run` — drop it here.
      run.off('stopped', onStop);
      resolve();
    }, ms);
    run.once('stopped', onStop);
  });
}
