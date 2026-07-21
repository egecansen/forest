import { describe, expect, it, vi } from 'vitest';
import { startDriver, inferPhase, type QueryFn } from '../driver.js';
import { runStore } from '../run-store.js';

const cfg = { projectPath: '/tmp/x', targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161', mode: 'triage' as const, permissionPolicy: 'confirm-applies' as const };

const msg = (m: Record<string, unknown>) => m;
function scripted(messages: Record<string, unknown>[]): QueryFn {
  return () => {
    async function* gen() { for (const m of messages) yield m; }
    return Object.assign(gen(), { interrupt: vi.fn(async () => {}) });
  };
}

describe('driver core', () => {
  it('maps SDK stream → session id, phases, log, telemetry, finish', async () => {
    const run = runStore.create(cfg);
    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'completed') r(); }));
    startDriver(run, scripted([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'KIT=…; "$KIT/ingest.sh" "https://r.example/…" > fails.json' } },
      ] } }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/cluster.sh" < fails.json' } },
      ] } }),
      msg({ type: 'result', subtype: 'success', total_cost_usd: 0.42, usage: { output_tokens: 1000 }, result: 'done' }),
    ]));
    await done;
    expect(run.snapshot.sessionId).toBe('sess-1');
    expect(run.snapshot.phases.find((p) => p.id === 'ingest')?.status).toBe('done');
    expect(run.snapshot.phases.find((p) => p.id === 'cluster')?.status).toBe('done');
    expect(run.snapshot.telemetry.costUsd).toBe(0.42);
    expect(run.snapshot.status).toBe('completed');
    expect(run.snapshot.log.some((l) => l.text.includes('ingest'))).toBe(true);
  });

  it('a result with subtype error → run failed', async () => {
    const run = runStore.create(cfg);
    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'failed') r(); }));
    startDriver(run, scripted([msg({ type: 'result', subtype: 'error_during_execution' })]));
    await done;
    expect(run.snapshot.status).toBe('failed');
  });

  it('inferPhase maps core scripts to phases', () => {
    expect(inferPhase('"$KIT/ingest.sh" url')).toBe('ingest');
    expect(inferPhase('bash core/rerun.sh a,b tb161')).toBe('verify');
    expect(inferPhase('"$KIT/apply.sh"')).toBe('fix');
    expect(inferPhase('"$KIT/compile.sh"')).toBe('fix');
    expect(inferPhase('"$KIT/summary.sh" < ledger.json')).toBe('report');
    expect(inferPhase('ls -la')).toBe(null);
  });

  it('pause + resultless stream end lands on paused status', async () => {
    const run = runStore.create(cfg);
    let pauseResolve: () => void;
    const pausePromise = new Promise<void>((r) => { pauseResolve = r; });

    const handle = startDriver(run, () => {
      async function* gen() {
        yield msg({ type: 'system', subtype: 'init', session_id: 'sess-pause-test' });
        // Wait until pause() is called, then end stream without result
        await pausePromise;
      }
      return Object.assign(gen(), { interrupt: vi.fn(async () => {}) });
    });

    // Wait for run to enter 'running' state, then call pause, then verify final status
    const done = new Promise<void>((r) => {
      const handleStatus = (e: any) => {
        if (e.type === 'status' && e.status === 'paused') {
          run.off('event', handleStatus);
          r();
        }
      };
      run.on('event', handleStatus);
    });

    // Give init a moment to set status to 'running', then pause and resolve the stream
    await new Promise((r) => setTimeout(r, 50));
    handle.pause();
    pauseResolve!();

    await done;
    expect(run.snapshot.status).toBe('paused');
  });

  it('advancePhase is forward-only: a repeated core script never regresses an already-done phase', async () => {
    const run = runStore.create(cfg);
    const phaseEvents: Array<{ phaseId: string; status: string }> = [];
    const activeSet = new Set<string>();
    let sawConcurrentActive = false;
    run.on('event', (e: any) => {
      if (e.type !== 'phase') return;
      phaseEvents.push({ phaseId: e.phaseId, status: e.status });
      if (e.status === 'active') {
        if (activeSet.size > 0 && !activeSet.has(e.phaseId)) sawConcurrentActive = true;
        activeSet.add(e.phaseId);
      } else {
        activeSet.delete(e.phaseId);
      }
    });

    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'completed') r(); }));
    // init -> ingest.sh -> cluster.sh -> apply.sh (fix cluster-a) -> rerun.sh (verify cluster-a)
    // -> apply.sh (fix cluster-b, a SECOND core-script fix run interleaved after verify started) -> result
    startDriver(run, scripted([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-fwd' }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/ingest.sh" "https://r.example/…" > fails.json' } },
      ] } }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/cluster.sh" < fails.json' } },
      ] } }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/apply.sh" cluster-a' } },
      ] } }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/rerun.sh" cluster-a tb161' } },
      ] } }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/apply.sh" cluster-b' } },
      ] } }),
      msg({ type: 'result', subtype: 'success', total_cost_usd: 0.1, usage: { output_tokens: 10 }, result: 'done' }),
    ]));
    await done;

    // No two phases were ever simultaneously 'active'.
    expect(sawConcurrentActive).toBe(false);
    // 'fix' was set active exactly once — the second apply.sh (target already
    // 'done' by then) must be a no-op, not a regression back to 'active'.
    const fixActiveCount = phaseEvents.filter((e) => e.phaseId === 'fix' && e.status === 'active').length;
    expect(fixActiveCount).toBe(1);
  });
});
