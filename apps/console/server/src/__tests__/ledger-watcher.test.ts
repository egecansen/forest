import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLedgerWatcher } from '../ledger-watcher.js';
import { runStore } from '../run-store.js';
import type { Cluster } from '../types.js';

/**
 * Fixture reasoning: kits/flaky-triage-kit/core/ledger.sh (read-only,
 * unmodified) is schema-agnostic — `ledger.sh init` only ever writes the bare
 * skeleton `{run:{}, clusters:[], events:[]}`. The concrete field shapes
 * below come from the kit's own `kernel.md` §8 ("State / ledger"), which is
 * the authoritative contract every `ledger.sh set` caller (the skill) is
 * documented to follow:
 *
 *   run:     { id, sReportUrl, build{name,@timestamp}, tb, startedBy }
 *   cluster: { id, signature, tier, bucket, fixVsBug, evidence,
 *              tests[ fqcn… ],
 *              status: proposed|selected|applied|green|deferred|flagged|resolved-upstream,
 *              diffRef, lineage(parentClusterId), greenProofScope }
 *   event:   { who, what(selected/applied/steered), when }
 *
 * `core/summary.sh` was cross-checked too: it reads `.clusters[].status` and
 * `.clusters[].tests` off exactly this shape. `core/rerun.sh`'s raw output
 * (`{tests:{<fqcn>:{pass,fail,skip,runs,confidence,cause}}}`) is a SEPARATE
 * contract (rerun.sh never calls ledger.sh) — the fixture below models
 * `greenProofScope` as a plain `{passes, runs}` object, which is the only
 * shape `ledger-watcher.ts` is willing to read opportunistically (see its
 * module header) — never the deeper rerun.sh per-test map.
 */
const baseLedger = {
  run: {
    id: 'run-2026-07-21-01',
    sReportUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
    build: { name: 'web-test-s4-flaky', '@timestamp': '2026-07-21T09:00:00Z' },
    tb: '161',
    startedBy: 'console',
  },
  clusters: [] as unknown[],
  events: [{ who: 'agent', what: 'selected', when: '2026-07-21T09:05:00Z' }],
};

function ledgerCluster(overrides: Record<string, unknown>) {
  return {
    id: 'onetrust',
    signature: 'ElementClickInterceptedException: onetrust-consent-sdk',
    tier: 'easy',
    bucket: 'easy-fix',
    fixVsBug: 'fix',
    evidence: { note: 'consent overlay intercepts clicks' },
    tests: ['com.sahibinden.web.CheckoutFlowTest#submitsWithConsentBanner'],
    status: 'proposed',
    diffRef: null,
    lineage: null,
    greenProofScope: null,
    ...overrides,
  };
}

const cfg = {
  projectPath: '/tmp/x',
  targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161',
  mode: 'triage' as const,
  permissionPolicy: 'confirm-applies' as const,
};

const CL: Cluster = {
  id: 'onetrust',
  title: 'OneTrust consent overlay intercepts clicks',
  bucket: 'easy-fix',
  tests: ['com.sahibinden.web.CheckoutFlowTest#submitsWithConsentBanner'],
  state: 'proposed',
};

async function waitFor(fn: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out waiting for condition');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

let dir: string;
let stops: Array<() => void> = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hektor-ledger-watcher-'));
  stops = [];
});

afterEach(async () => {
  for (const stop of stops) stop();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('startLedgerWatcher', () => {
  it('parses the ledger once it appears after the watcher has already started', async () => {
    const run = runStore.create(cfg);
    run.setClusters([CL]);

    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    // No ledger.json yet — must not throw, must not touch the cluster.
    await new Promise((r) => setTimeout(r, 50));
    expect(run.snapshot.clusters[0].state).toBe('proposed');

    await fs.writeFile(
      path.join(dir, 'ledger.json'),
      JSON.stringify({ ...baseLedger, clusters: [ledgerCluster({ status: 'selected' })] }),
      'utf8'
    );

    await waitFor(() => run.snapshot.clusters[0].state === 'picked');
    expect(run.snapshot.clusters[0].state).toBe('picked');
  });

  it('tolerates a mid-write / partial-JSON ledger and recovers once the write completes', async () => {
    const run = runStore.create(cfg);
    run.setClusters([CL]);

    const ledgerPath = path.join(dir, 'ledger.json');
    // Half-written JSON, as a reader could observe mid-`mv` or mid-write.
    await fs.writeFile(ledgerPath, '{"run":{}, "clusters": [ { "id": "onetrust", "stat', 'utf8');

    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    await new Promise((r) => setTimeout(r, 80));
    // Garbage must never crash the watcher or mutate the board.
    expect(run.snapshot.clusters[0].state).toBe('proposed');

    await fs.writeFile(
      ledgerPath,
      JSON.stringify({ ...baseLedger, clusters: [ledgerCluster({ status: 'green' })] }),
      'utf8'
    );

    await waitFor(() => run.snapshot.clusters[0].state === 'green');
    expect(run.snapshot.clusters[0].state).toBe('green');
  });

  it('a ledger state change produces exactly one updateCluster call — no spam on unchanged re-parse', async () => {
    const run = runStore.create(cfg);
    run.setClusters([CL]);
    const updateSpy = vi.spyOn(run, 'updateCluster');

    const ledgerPath = path.join(dir, 'ledger.json');
    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    await fs.writeFile(
      ledgerPath,
      JSON.stringify({ ...baseLedger, clusters: [ledgerCluster({ status: 'selected' })] }),
      'utf8'
    );
    await waitFor(() => updateSpy.mock.calls.length === 1);
    expect(run.snapshot.clusters[0].state).toBe('picked');

    // Several more polling ticks with the file untouched (mtime unchanged).
    await new Promise((r) => setTimeout(r, 120));
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // Rewrite with IDENTICAL semantic content (new mtime, same status) — the
    // file changed on disk, but the diff-against-current-snapshot check must
    // still suppress a redundant updateCluster call.
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({ ...baseLedger, clusters: [ledgerCluster({ status: 'selected' })] }),
      'utf8'
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // A genuine further state change DOES produce a second call.
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({ ...baseLedger, clusters: [ledgerCluster({ status: 'applied' })] }),
      'utf8'
    );
    await waitFor(() => updateSpy.mock.calls.length === 2);
    expect(run.snapshot.clusters[0].state).toBe('fixing');
  });

  it('maps "applied" + a derivable greenProofScope to verifying with pass counts', async () => {
    const run = runStore.create(cfg);
    run.setClusters([CL]);

    await fs.writeFile(
      path.join(dir, 'ledger.json'),
      JSON.stringify({
        ...baseLedger,
        clusters: [ledgerCluster({ status: 'applied', greenProofScope: { passes: 2, runs: 3 } })],
      }),
      'utf8'
    );

    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    await waitFor(() => run.snapshot.clusters[0].state === 'verifying');
    expect(run.snapshot.clusters[0]).toMatchObject({ state: 'verifying', passes: 2, runs: 3 });
  });

  it('never creates a new cluster from the ledger — unknown ids are skipped', async () => {
    const run = runStore.create(cfg); // no clusters published yet

    await fs.writeFile(
      path.join(dir, 'ledger.json'),
      JSON.stringify({ ...baseLedger, clusters: [ledgerCluster({ status: 'green' })] }),
      'utf8'
    );

    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    await new Promise((r) => setTimeout(r, 80));
    expect(run.snapshot.clusters).toHaveLength(0);
  });

  it('stop() ends polling — no timer leak after stop', async () => {
    const run = runStore.create(cfg);
    run.setClusters([CL]);
    const updateSpy = vi.spyOn(run, 'updateCluster');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    const ledgerPath = path.join(dir, 'ledger.json');
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({ ...baseLedger, clusters: [ledgerCluster({ status: 'selected' })] }),
      'utf8'
    );

    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    await waitFor(() => updateSpy.mock.calls.length === 1);
    expect(run.snapshot.clusters[0].state).toBe('picked');

    stop();
    // The returned stop function must actually clear the poll timer (and,
    // per its implementation, close the best-effort fs.watch accelerator).
    expect(clearIntervalSpy).toHaveBeenCalled();

    // Change the ledger again after stop() — a leaked timer (or a still-open
    // fs.watch) would pick this up within several would-be poll intervals; a
    // correctly-stopped watcher must not.
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({ ...baseLedger, clusters: [ledgerCluster({ status: 'green' })] }),
      'utf8'
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(run.snapshot.clusters[0].state).toBe('picked');
  });

  it('stop() mid-tick — a read already in flight when stop() is called must not apply to the (now stopped) run', async () => {
    const run = runStore.create(cfg);
    run.setClusters([CL]);
    const updateSpy = vi.spyOn(run, 'updateCluster');

    const ledgerPath = path.join(dir, 'ledger.json');
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({ ...baseLedger, clusters: [ledgerCluster({ status: 'selected' })] }),
      'utf8'
    );

    // A controllable fsImpl: `stat` behaves normally, but `readFile` blocks on
    // a gate the test controls — this puts a tick's `await fsImpl.readFile`
    // exactly where `stop()` needs to land to reproduce the race.
    let releaseRead: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const fsImpl = {
      stat: fs.stat,
      readFile: async (p: string, enc: 'utf8') => {
        await gate;
        return fs.readFile(p, enc);
      },
    };

    const stop = startLedgerWatcher(run, dir, { intervalMs: 20, fsImpl });

    // Give the first (immediate) tick time to reach and block on the gated
    // readFile — it must be in flight before we call stop().
    await new Promise((r) => setTimeout(r, 50));
    expect(updateSpy).not.toHaveBeenCalled();

    stop(); // stop mid-read: the run is now "stopped" from the watcher's POV
    releaseRead(); // let the in-flight read complete
    await new Promise((r) => setTimeout(r, 100));

    // The tick must have abandoned the stale in-flight read instead of
    // applying it to a stopped watcher.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(run.snapshot.clusters[0].state).toBe('proposed');
  });
});
