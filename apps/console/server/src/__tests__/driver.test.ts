import { describe, expect, it, vi } from 'vitest';
import { startDriver, inferPhase, makeDemoQueryFn, type QueryFn } from '../driver.js';
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

// A no-op ledger-watcher impl for tests that don't care about its lifecycle —
// keeps `cfg` (not a demo config) from spinning up a REAL fs.watch/poll timer
// against '/tmp/x' for the life of the test.
const noopLedgerWatcher = () => () => {};

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
    ]), { ledgerWatcherImpl: noopLedgerWatcher });
    await done;
    expect(run.snapshot.sessionId).toBe('sess-1');
    expect(run.snapshot.phases.find((p) => p.id === 'ingest')?.status).toBe('done');
    expect(run.snapshot.phases.find((p) => p.id === 'cluster')?.status).toBe('done');
    expect(run.snapshot.telemetry.costUsd).toBe(0.42);
    expect(run.snapshot.status).toBe('completed');
    expect(run.snapshot.log.some((l) => l.text.includes('ingest'))).toBe(true);
    // The agent's final result text lands on reportText (for the Report tab),
    // in addition to the existing success log entry.
    expect(run.snapshot.reportText).toBe('done');
    expect(run.snapshot.log.some((l) => l.kind === 'success' && l.text === 'done')).toBe(true);
  });

  it('a result with subtype error → run failed', async () => {
    const run = runStore.create(cfg);
    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'failed') r(); }));
    startDriver(run, scripted([msg({ type: 'result', subtype: 'error_during_execution' })]), { ledgerWatcherImpl: noopLedgerWatcher });
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
    }, { ledgerWatcherImpl: noopLedgerWatcher });

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
    ]), { ledgerWatcherImpl: noopLedgerWatcher });
    await done;

    // No two phases were ever simultaneously 'active'.
    expect(sawConcurrentActive).toBe(false);
    // 'fix' was set active exactly once — the second apply.sh (target already
    // 'done' by then) must be a no-op, not a regression back to 'active'.
    const fixActiveCount = phaseEvents.filter((e) => e.phaseId === 'fix' && e.status === 'active').length;
    expect(fixActiveCount).toBe(1);
  });
});

describe('driver ledger-watcher lifecycle', () => {
  it('starts the ledger watcher exactly once for a non-demo scripted run, and stops it on result-success end', async () => {
    const run = runStore.create(cfg);
    const stopFn = vi.fn();
    const ledgerWatcherImpl = vi.fn(() => stopFn);

    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'completed') r(); }));
    startDriver(run, scripted([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-lw-1' }),
      msg({ type: 'result', subtype: 'success', total_cost_usd: 0.1, usage: { output_tokens: 10 }, result: 'done' }),
    ]), { ledgerWatcherImpl });
    await done;
    // The 'completed' status event fires mid-loop (inside the `result`
    // branch), a few microtask-hops before the driver's stream loop actually
    // exhausts and unwinds into its `finally` (where stopLedgerWatcher()
    // lives) — give that unwind a tick to finish before asserting on it.
    await new Promise((r) => setTimeout(r, 0));

    expect(ledgerWatcherImpl).toHaveBeenCalledTimes(1);
    expect(ledgerWatcherImpl).toHaveBeenCalledWith(run, cfg.projectPath);
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  it('stops the ledger watcher on the run.stop()/abort path', async () => {
    const run = runStore.create(cfg);
    const stopFn = vi.fn();
    const ledgerWatcherImpl = vi.fn(() => stopFn);

    const running = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'running') r(); }));
    const handle = startDriver(run, () => {
      async function* gen() {
        yield msg({ type: 'system', subtype: 'init', session_id: 'sess-lw-2' });
        await new Promise(() => {}); // held open — the run is stopped from outside
      }
      return Object.assign(gen(), { interrupt: vi.fn(async () => {}) });
    }, { ledgerWatcherImpl });
    await running;

    expect(ledgerWatcherImpl).toHaveBeenCalledTimes(1);
    expect(stopFn).not.toHaveBeenCalled();

    handle(); // the driver's stop() — abort + run.stop() + eager stopLedgerWatcher()
    expect(stopFn).toHaveBeenCalledTimes(1);
    expect(run.snapshot.status).toBe('cancelled');
  });

  it('stops the ledger watcher on the pause path', async () => {
    const run = runStore.create(cfg);
    const stopFn = vi.fn();
    const ledgerWatcherImpl = vi.fn(() => stopFn);

    const running = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'running') r(); }));
    const handle = startDriver(run, () => {
      async function* gen() {
        yield msg({ type: 'system', subtype: 'init', session_id: 'sess-lw-3' });
        await new Promise(() => {}); // held open — the run is paused from outside
      }
      return Object.assign(gen(), { interrupt: vi.fn(async () => {}) });
    }, { ledgerWatcherImpl });
    await running;

    expect(ledgerWatcherImpl).toHaveBeenCalledTimes(1);
    expect(stopFn).not.toHaveBeenCalled();

    handle.pause(); // eager stopLedgerWatcher(), ahead of the stream actually unwinding
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT start the ledger watcher for demo:true config runs', async () => {
    const demoCfg = { ...cfg, demo: true };
    const run = runStore.create(demoCfg);
    const ledgerWatcherImpl = vi.fn(() => vi.fn());

    const awaitingInput = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'awaiting-input') r(); }));
    startDriver(run, makeDemoQueryFn(run), { ledgerWatcherImpl });
    await awaitingInput;

    expect(ledgerWatcherImpl).not.toHaveBeenCalled();
  });
});
