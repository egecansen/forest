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

// Like `scripted`, but a step may be a side-effect function instead of a
// message — run synchronously in-place in the generator's iteration order.
// Needed to interleave an external state change (e.g. the pick bridge
// completing) at an EXACT point in the stream: the scripted generator here
// yields with no real awaits between messages, so a stream fully drains
// across microtasks well before any timer-based race (setTimeout) could land
// a side effect mid-stream.
function scriptedWithHooks(steps: Array<Record<string, unknown> | (() => void)>): QueryFn {
  return () => {
    async function* gen() {
      for (const step of steps) {
        if (typeof step === 'function') { step(); continue; }
        yield step;
      }
    }
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

  describe('inferPhase — execution vs inspection', () => {
    it('a core script merely READ (not executed) infers no phase', () => {
      expect(inferPhase("sed -n '1,120p' core/rerun.sh")).toBe(null);
      expect(inferPhase('cat core/ingest.sh')).toBe(null);
      expect(inferPhase('grep -n foo core/apply.sh')).toBe(null);
    });

    it('a core script actually EXECUTED (first token of a segment) infers its phase', () => {
      expect(inferPhase('./core/rerun.sh a,b tb161')).toBe('verify');
      expect(inferPhase('"$KIT/ingest.sh" url > f.json')).toBe('ingest');
      expect(inferPhase('cat x.json | ./core/cluster.sh')).toBe('cluster');
    });

    it('recognizes execution in every segment of a pipeline/sequence, from whichever segment runs it', () => {
      // inspection segment first, execution segment second — still recognized
      expect(inferPhase('cat core/apply.sh && ./core/apply.sh onetrust')).toBe('fix');
      expect(inferPhase('grep foo core/rerun.sh; ./core/rerun.sh a,b tb161')).toBe('verify');
      expect(inferPhase('cat core/ingest.sh || "$KIT/ingest.sh" url')).toBe('ingest');
      expect(inferPhase('cat core/summary.sh\n"$KIT/summary.sh" < ledger.json')).toBe('report');
    });

    it('a `cd <path> && …` segment split still finds the execution in the later segment', () => {
      expect(inferPhase('cd "$KIT" && ./core/rerun.sh a,b tb161')).toBe('verify');
    });

    it('strips leading env assignments before checking the first token', () => {
      expect(inferPhase('KIT=/path/to/kit; "$KIT/ingest.sh" "https://x" > fails.json')).toBe('ingest');
      expect(inferPhase('FOO=bar BAZ=qux ./core/apply.sh onetrust')).toBe('fix');
    });

    it('strips optional runner prefixes (bash, sh, ., source) before checking the script token', () => {
      expect(inferPhase('bash core/rerun.sh a,b tb161')).toBe('verify');
      expect(inferPhase('sh core/apply.sh onetrust')).toBe('fix');
      expect(inferPhase('. core/rerun.sh a,b tb161')).toBe('verify');
      expect(inferPhase('source core/ingest.sh url')).toBe('ingest');
    });

    it('an inspection command with a runner-prefix-like first word (e.g. "sh" as an unrelated arg) still requires the SCRIPT token to be the core script', () => {
      // "sh" is a runner prefix, so this executes core/rerun.sh — verify.
      expect(inferPhase('sh core/rerun.sh')).toBe('verify');
      // but a plain inspection command never matches regardless of args.
      expect(inferPhase('cat notes.txt core/rerun.sh')).toBe(null);
    });

    it('dom-capture.sh and dom-on-failure.sh execution both infer verify', () => {
      expect(inferPhase('./core/dom-capture.sh onetrust')).toBe('verify');
      expect(inferPhase('./core/dom-on-failure.sh onetrust')).toBe('verify');
    });

    it('unrelated commands and empty/whitespace-only commands infer no phase', () => {
      expect(inferPhase('echo hello')).toBe(null);
      expect(inferPhase('   ')).toBe(null);
      expect(inferPhase('')).toBe(null);
    });
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
    // Simulate the pick having already completed (via the question bridge) —
    // this test is exercising the forward-only guard across fix/verify, which
    // now only advance once 'pick' is done (see the pick-gating describe block).
    run.setPhase('pick', 'done');
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

describe('completion honesty — unverified clusters park the run as paused', () => {
  it('a cluster still verifying when the result succeeds parks the run as paused, not completed', async () => {
    const run = runStore.create(cfg);
    const done = new Promise<void>((r) =>
      run.on('event', (e) => { if (e.type === 'status' && (e.status === 'paused' || e.status === 'completed')) r(); })
    );
    startDriver(run, scriptedWithHooks([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-unverified' }),
      () => run.setClusters([{ id: 'c1', title: 'flaky selector', bucket: 'selector', tests: ['t1'], state: 'proposed' }]),
      () => run.updateCluster('c1', { state: 'verifying', passes: 1, runs: 3 }),
      msg({ type: 'result', subtype: 'success', total_cost_usd: 0.1, usage: { output_tokens: 10 }, result: 'partial scoreboard' }),
    ]), { ledgerWatcherImpl: noopLedgerWatcher });
    await done;

    expect(run.snapshot.status).toBe('paused');
    expect(run.isStopped()).toBe(false);
    expect(
      run.snapshot.log.some(
        (l) => l.kind === 'warn' && l.text.includes('1 cluster(s) unverified') && l.text.includes('paused')
      )
    ).toBe(true);
    expect(run.snapshot.phases.find((p) => p.id === 'report')?.status).not.toBe('done');
    expect(run.snapshot.reportText).toBe('partial scoreboard');
  });

  it('a cluster left picked or fixing also parks the run as paused', async () => {
    const run = runStore.create(cfg);
    const done = new Promise<void>((r) =>
      run.on('event', (e) => { if (e.type === 'status' && (e.status === 'paused' || e.status === 'completed')) r(); })
    );
    startDriver(run, scriptedWithHooks([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-unverified-2' }),
      () => run.setClusters([
        { id: 'c1', title: 'flaky selector', bucket: 'selector', tests: ['t1'], state: 'proposed' },
        { id: 'c2', title: 'vrt drift', bucket: 'vrt', tests: ['t2'], state: 'proposed' },
      ]),
      () => run.updateCluster('c1', { state: 'fixing' }),
      () => run.updateCluster('c2', { state: 'picked' }),
      msg({ type: 'result', subtype: 'success', total_cost_usd: 0.1, usage: { output_tokens: 10 }, result: 'partial scoreboard' }),
    ]), { ledgerWatcherImpl: noopLedgerWatcher });
    await done;

    expect(run.snapshot.status).toBe('paused');
    expect(
      run.snapshot.log.some((l) => l.kind === 'warn' && l.text.includes('2 cluster(s) unverified'))
    ).toBe(true);
  });

  it('all clusters terminal (green/app-bug/skipped/proposed-only) still completes as today', async () => {
    const run = runStore.create(cfg);
    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'completed') r(); }));
    startDriver(run, scriptedWithHooks([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-verified' }),
      () => run.setClusters([
        { id: 'c1', title: 'fixed selector', bucket: 'selector', tests: ['t1'], state: 'green' },
        { id: 'c2', title: 'real app bug', bucket: 'likely-bug', tests: ['t2'], state: 'app-bug' },
        { id: 'c3', title: 'not picked', bucket: 'infra', tests: ['t3'], state: 'skipped' },
        { id: 'c4', title: 'never picked', bucket: 'easy-fix', tests: ['t4'], state: 'proposed' },
      ]),
      msg({ type: 'result', subtype: 'success', total_cost_usd: 0.1, usage: { output_tokens: 10 }, result: 'full scoreboard' }),
    ]), { ledgerWatcherImpl: noopLedgerWatcher });
    await done;

    expect(run.snapshot.status).toBe('completed');
    expect(run.snapshot.phases.find((p) => p.id === 'report')?.status).toBe('done');
    expect(run.snapshot.reportText).toBe('full scoreboard');
    expect(run.snapshot.log.some((l) => l.kind === 'warn' && l.text.includes('unverified'))).toBe(false);
  });
});

describe('post-pick phase gating', () => {
  it('a rerun.sh EXECUTED before any AskUserQuestion does not advance verify (or pick) — the kit\'s early confirmation rerun leaves cluster/ingest as the visible active phase', async () => {
    const run = runStore.create(cfg);
    // No `result` message here on purpose: a success result unconditionally
    // advances 'report' (forcing every earlier phase 'done'), which would
    // mask exactly the gating behavior this test verifies. The stream simply
    // ends — the driver's "stream ended without a result" path lands on
    // 'failed', which is enough to observe the settled phase snapshot.
    const finished = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'failed') r(); }));
    startDriver(run, scripted([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-gate-1' }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/ingest.sh" "https://r.example/…" > fails.json' } },
      ] } }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/cluster.sh" < fails.json' } },
      ] } }),
      // The kit's real loop runs a confirmation rerun EARLY, before the pick —
      // a genuine execution, not an inspection. It must not advance 'verify'.
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/rerun.sh" cluster-a tb161' } },
      ] } }),
    ]), { ledgerWatcherImpl: noopLedgerWatcher });
    await finished;

    expect(run.snapshot.phases.find((p) => p.id === 'pick')?.status).toBe('queued');
    expect(run.snapshot.phases.find((p) => p.id === 'verify')?.status).toBe('queued');
    // ingest/cluster inferences are ungated and still progressed normally:
    // ingest completed, cluster is the current active phase (nothing gated
    // ever advanced past it).
    expect(run.snapshot.phases.find((p) => p.id === 'ingest')?.status).toBe('done');
    expect(run.snapshot.phases.find((p) => p.id === 'cluster')?.status).toBe('active');
  });

  it('after the bridge completes the pick, a subsequent apply.sh/rerun.sh advances fix/verify normally', async () => {
    const run = runStore.create(cfg);
    // Track phase events rather than final snapshot state: the scripted
    // stream ends in a success `result`, which unconditionally advances
    // 'report' (forcing every earlier phase to 'done') — the same as any
    // completed run. What this test actually needs to prove is that fix/
    // verify each went 'active' — and did so only AFTER the pick's 'done'.
    const phaseEvents: Array<{ phaseId: string; status: string }> = [];
    run.on('event', (e: any) => { if (e.type === 'phase') phaseEvents.push({ phaseId: e.phaseId, status: e.status }); });
    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'completed') r(); }));
    startDriver(run, scriptedWithHooks([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-gate-2' }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/ingest.sh" "https://r.example/…" > fails.json' } },
      ] } }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/cluster.sh" < fails.json' } },
      ] } }),
      // Early confirmation rerun (pre-pick): gated, no-op for 'verify'.
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/rerun.sh" cluster-a tb161' } },
      ] } }),
      // The pick bridge completes here, exactly between the early
      // confirmation rerun and the post-pick apply/rerun — the same
      // `setPhase('pick', 'done')` call driver-can-use-tool.ts makes once the
      // operator answers.
      () => run.setPhase('pick', 'done'),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/apply.sh" cluster-a' } },
      ] } }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/rerun.sh" cluster-a tb161' } },
      ] } }),
      msg({ type: 'result', subtype: 'success', total_cost_usd: 0.05, usage: { output_tokens: 5 }, result: 'done' }),
    ]), { ledgerWatcherImpl: noopLedgerWatcher });

    await done;

    // fix and verify each went 'active' exactly once — the gated early
    // rerun.sh never triggered them.
    expect(phaseEvents.filter((e) => e.phaseId === 'fix' && e.status === 'active')).toHaveLength(1);
    expect(phaseEvents.filter((e) => e.phaseId === 'verify' && e.status === 'active')).toHaveLength(1);
    // ...and only AFTER the pick was marked 'done'.
    const pickDoneIdx = phaseEvents.findIndex((e) => e.phaseId === 'pick' && e.status === 'done');
    const fixActiveIdx = phaseEvents.findIndex((e) => e.phaseId === 'fix' && e.status === 'active');
    const verifyActiveIdx = phaseEvents.findIndex((e) => e.phaseId === 'verify' && e.status === 'active');
    expect(pickDoneIdx).toBeGreaterThanOrEqual(0);
    expect(fixActiveIdx).toBeGreaterThan(pickDoneIdx);
    expect(verifyActiveIdx).toBeGreaterThan(fixActiveIdx);
    // Final state: the run completed normally end to end.
    expect(run.snapshot.phases.find((p) => p.id === 'report')?.status).toBe('done');
  });
});

describe('live token telemetry', () => {
  it('bumps the token meter on assistant messages carrying usage, ahead of the final result', async () => {
    const run = runStore.create(cfg);
    const tokensDuringRun: number[] = [];
    run.on('event', (e: any) => {
      if (e.type === 'telemetry' && typeof e.telemetry?.tokens === 'number') tokensDuringRun.push(e.telemetry.tokens);
    });
    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'completed') r(); }));
    startDriver(run, scripted([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-tok-1' }),
      msg({ type: 'assistant', message: { usage: { output_tokens: 120 }, content: [{ type: 'text', text: 'thinking…' }] } }),
      msg({ type: 'assistant', message: { usage: { output_tokens: 80 }, content: [{ type: 'text', text: 'more thinking…' }] } }),
      msg({ type: 'result', subtype: 'success', total_cost_usd: 0.05, usage: { output_tokens: 500 }, result: 'done' }),
    ]), { ledgerWatcherImpl: noopLedgerWatcher });
    await done;

    // The meter moved DURING the run (bumped by each assistant message's
    // usage), not just once at the final result.
    expect(tokensDuringRun).toContain(120);
    expect(tokensDuringRun).toContain(200); // 120 + 80, cumulative bump
    // The final result's raiseTokens is the authoritative high-water mark.
    expect(run.snapshot.telemetry.tokens).toBe(500);
  });

  it('an assistant message with no usage is handled gracefully (no bump, no throw)', async () => {
    const run = runStore.create(cfg);
    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'completed') r(); }));
    startDriver(run, scripted([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-tok-2' }),
      msg({ type: 'assistant', message: { content: [{ type: 'text', text: 'no usage on this one' }] } }),
      msg({ type: 'result', subtype: 'success', total_cost_usd: 0.01, usage: { output_tokens: 42 }, result: 'done' }),
    ]), { ledgerWatcherImpl: noopLedgerWatcher });
    await done;

    expect(run.snapshot.telemetry.tokens).toBe(42);
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
