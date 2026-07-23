import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLedgerWatcher } from '../ledger-watcher.js';
import { runStore } from '../run-store.js';
import type { Cluster } from '../types.js';

/**
 * v2 ledger fixture — kernel.md §8's "presentation contract" shape
 * (`run.version: 2`; clusters carry human-phrased `title`/`detail`, a closed
 * `bucket` enum, `passes`/`runs` at the cluster's top level instead of a
 * nested `greenProofScope`, and `tests[]` entries that may carry a
 * `status` when they diverge from the cluster's own life-cycle `status`).
 * Exactly the fixture given in the Task 5 brief.
 */
const V2 = {
  run: { version: 2 },
  clusters: [
    {
      id: 'c1-selectors',
      title: 'Relocated selectors',
      detail: 'blog anchor moved to href/blog',
      bucket: 'selector',
      status: 'applied',
      passes: 2,
      runs: 3,
      tests: [{ fqcn: 'com.x.FooTest#a', status: 'green' }, { fqcn: 'com.x.BarTest' }],
    },
    {
      id: 'c2-vrt',
      title: 'VRT drift',
      bucket: 'vrt',
      status: 'proposed',
      tests: [{ fqcn: 'com.x.VrtTest', vrt: 'https://vrt-x.example/compare/9' }],
    },
  ],
  events: [
    { who: 'u', what: 'phase-enter', when: '2026-07-22T10:00:00Z', phase: 'confirm' },
    { who: 'u', what: 'phase-enter', when: '2026-07-22T10:05:00Z', phase: 'verify' },
  ],
};

/**
 * A v1 ledger (no `run.version`) — same shape the pre-existing
 * `ledger-watcher.test.ts` fixture (`baseLedger` + `ledgerCluster()`) uses,
 * reproduced here (rather than imported across test files) so this file
 * stays self-contained. Exercises the version-dispatch fork: anything that
 * isn't `run.version === 2` must fall through to the untouched v1 path,
 * which never fabricates a cluster the console hasn't already published.
 */
const V1 = {
  run: {
    id: 'run-2026-07-21-01',
    sReportUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
    build: { name: 'web-test-s4-flaky', '@timestamp': '2026-07-21T09:00:00Z' },
    tb: '161',
    startedBy: 'console',
  },
  clusters: [
    {
      id: 'onetrust',
      signature: 'ElementClickInterceptedException: onetrust-consent-sdk',
      tier: 'easy',
      bucket: 'easy-fix',
      fixVsBug: 'fix',
      evidence: { note: 'consent overlay intercepts clicks' },
      tests: ['com.sahibinden.web.CheckoutFlowTest#submitsWithConsentBanner'],
      status: 'green',
      diffRef: null,
      lineage: null,
      greenProofScope: null,
    },
  ],
  events: [{ who: 'agent', what: 'selected', when: '2026-07-21T09:05:00Z' }],
};

const cfg = {
  projectPath: '/tmp/x',
  targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161',
  mode: 'triage' as const,
  permissionPolicy: 'confirm-applies' as const,
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hektor-ledger-watcher-v2-'));
  stops = [];
});

afterEach(async () => {
  for (const stop of stops) stop();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('startLedgerWatcher — v2 (run.version: 2)', () => {
  it('(a) creates both clusters via setClusters from an empty snapshot, mapping status/passes/runs/divergent', async () => {
    const run = runStore.create(cfg); // no clusters published yet — nothing for the console to "update"
    const setClustersSpy = vi.spyOn(run, 'setClusters');

    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(V2), 'utf8');
    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    await waitFor(() => run.snapshot.clusters.length === 2);
    expect(setClustersSpy).toHaveBeenCalledTimes(1);

    const c1 = run.snapshot.clusters.find((c) => c.id === 'c1-selectors')!;
    const c2 = run.snapshot.clusters.find((c) => c.id === 'c2-vrt')!;

    expect(c1).toMatchObject({
      id: 'c1-selectors',
      title: 'Relocated selectors',
      detail: 'blog anchor moved to href/blog',
      bucket: 'selector',
      state: 'verifying', // applied + a usable passes/runs pair
      passes: 2,
      runs: 3,
      tests: ['com.x.FooTest#a', 'com.x.BarTest'],
      divergent: [{ fqcn: 'com.x.FooTest#a', status: 'green' }],
    });

    expect(c2).toMatchObject({
      id: 'c2-vrt',
      title: 'VRT drift',
      bucket: 'vrt',
      state: 'proposed',
      tests: ['com.x.VrtTest'],
      vrt: [{ fqcn: 'com.x.VrtTest', url: 'https://vrt-x.example/compare/9' }],
    });
    // c2's lone test never carries a `status` — no divergence to report.
    expect(c2.divergent).toBeUndefined();
    // c1's tests never carry a `vrt` field — no VRT entries to report.
    expect(c1.vrt).toBeUndefined();
  });

  it('(b) a subsequent tick with byte-identical content makes zero further cluster calls', async () => {
    const run = runStore.create(cfg);
    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(V2), 'utf8');
    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);
    await waitFor(() => run.snapshot.clusters.length === 2);

    const setClustersSpy = vi.spyOn(run, 'setClusters');
    const updateSpy = vi.spyOn(run, 'updateCluster');

    // Rewrite identical content — a fresh mtime forces a re-parse, but the
    // diff-against-current-snapshot check must suppress every call.
    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(V2), 'utf8');
    await new Promise((r) => setTimeout(r, 120));

    expect(setClustersSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('(c) a single cluster status change produces exactly one updateCluster call', async () => {
    const run = runStore.create(cfg);
    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(V2), 'utf8');
    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);
    await waitFor(() => run.snapshot.clusters.length === 2);

    const setClustersSpy = vi.spyOn(run, 'setClusters');
    const updateSpy = vi.spyOn(run, 'updateCluster');

    const changed = {
      ...V2,
      clusters: [V2.clusters[0], { ...V2.clusters[1], status: 'selected' }],
    };
    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(changed), 'utf8');

    await waitFor(() => updateSpy.mock.calls.length === 1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(setClustersSpy).not.toHaveBeenCalled(); // both ids already known — never a full replace

    const c2 = run.snapshot.clusters.find((c) => c.id === 'c2-vrt')!;
    expect(c2.state).toBe('picked');
  });

  it('(d) phase-enter events drive setPhase forward-only to verify, and never regress on re-read', async () => {
    const run = runStore.create(cfg);
    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(V2), 'utf8');
    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    const phase = (id: string) => run.snapshot.phases.find((p) => p.id === id)?.status;

    await waitFor(() => phase('verify') === 'active');
    expect(phase('ingest')).toBe('done');
    expect(phase('cluster')).toBe('done'); // 'confirm' event maps to console 'cluster'
    expect(phase('pick')).toBe('done');
    expect(phase('fix')).toBe('done');
    expect(phase('verify')).toBe('active');
    expect(phase('report')).toBe('queued');

    // Re-write byte-identical content (new mtime, same latest phase-enter) —
    // forward-only means this must never regress 'verify' back to 'queued'
    // or re-emit redundant phase transitions.
    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(V2), 'utf8');
    await new Promise((r) => setTimeout(r, 120));
    expect(phase('verify')).toBe('active');
    expect(phase('report')).toBe('queued');
  });

  it('(e) a v1 fixture (no run.version) takes the existing guarded path — no cluster creation', async () => {
    const run = runStore.create(cfg); // no clusters published

    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(V1), 'utf8');
    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    await new Promise((r) => setTimeout(r, 80));
    expect(run.snapshot.clusters).toHaveLength(0);
    // v1 never drives phases from the ledger either — that stays the
    // driver's Bash-command inference (inferPhase/advancePhase).
    expect(run.snapshot.phases.every((p) => p.status === 'queued')).toBe(true);
  });

  it('(f) full-replace never drops a cluster that is only TEMPORARILY invalid/missing this tick', async () => {
    // Snapshot already shows two valid clusters (e.g. from a prior tick).
    const A: Cluster = {
      id: 'a-selectors',
      title: 'A cluster (old)',
      bucket: 'selector',
      tests: ['com.x.ATest'],
      state: 'proposed',
    };
    const B: Cluster = {
      id: 'b-vrt',
      title: 'B cluster',
      bucket: 'vrt',
      tests: ['com.x.BTest'],
      state: 'proposed',
    };
    const run = runStore.create(cfg);
    run.setClusters([A, B]);

    const setClustersSpy = vi.spyOn(run, 'setClusters');

    // This tick's ledger: A changed (still valid) + brand-new C (valid) —
    // together these miss an id (C) and trigger the full-replace branch.
    // B is entirely absent from this read (the "transiently absent from the
    // raw read" case called out in the finding) — it must NOT be dropped.
    const ledgerTick = {
      run: { version: 2 },
      clusters: [
        { id: 'a-selectors', title: 'A cluster (old)', bucket: 'selector', status: 'selected', tests: [{ fqcn: 'com.x.ATest' }] },
        { id: 'c-new', title: 'C cluster (new)', bucket: 'easy-fix', status: 'proposed', tests: [{ fqcn: 'com.x.CTest' }] },
      ],
      events: [],
    };
    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(ledgerTick), 'utf8');

    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    await waitFor(() => run.snapshot.clusters.length === 3);
    expect(setClustersSpy).toHaveBeenCalledTimes(1);

    const ids = run.snapshot.clusters.map((c) => c.id).sort();
    expect(ids).toEqual(['a-selectors', 'b-vrt', 'c-new']);

    const a = run.snapshot.clusters.find((c) => c.id === 'a-selectors')!;
    expect(a.state).toBe('picked'); // updated by this tick's ledger

    const c = run.snapshot.clusters.find((c) => c.id === 'c-new')!;
    expect(c.state).toBe('proposed'); // newly created by this tick's ledger

    // B was carried forward verbatim — never dropped, never re-derived.
    const b = run.snapshot.clusters.find((c) => c.id === 'b-vrt')!;
    expect(b).toEqual(B);
  });

  it('(g) regression: full-create from an empty snapshot has zero phantom carry-forwards', async () => {
    const run = runStore.create(cfg); // no clusters published — nothing to carry forward
    const setClustersSpy = vi.spyOn(run, 'setClusters');

    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(V2), 'utf8');
    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    await waitFor(() => run.snapshot.clusters.length === 2);
    expect(setClustersSpy).toHaveBeenCalledTimes(1);

    const calledWith = setClustersSpy.mock.calls[0][0];
    expect(calledWith).toHaveLength(2);
    expect(calledWith.map((c) => c.id).sort()).toEqual(['c1-selectors', 'c2-vrt']);
  });

  it('(h) a reordered-but-set-equal tests array does not trigger a spurious updateCluster', async () => {
    // Seeded snapshot cluster whose `tests` order differs from the ledger's
    // — same fqcn set, different array order — everything else identical to
    // what the ledger tick will map to.
    const seeded: Cluster = {
      id: 'c1-selectors',
      title: 'Relocated selectors',
      detail: 'blog anchor moved to href/blog',
      bucket: 'selector',
      tests: ['com.x.BarTest', 'com.x.FooTest#a'], // reversed vs. V2's ledger order
      state: 'verifying',
      passes: 2,
      runs: 3,
      divergent: [{ fqcn: 'com.x.FooTest#a', status: 'green' }],
    };
    const run = runStore.create(cfg);
    run.setClusters([seeded]);

    const setClustersSpy = vi.spyOn(run, 'setClusters');
    const updateSpy = vi.spyOn(run, 'updateCluster');

    // Ledger carries only c1-selectors, tests in the opposite order (see V2
    // fixture: FooTest#a then BarTest) — same set, no other field changed.
    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify({ ...V2, clusters: [V2.clusters[0]] }), 'utf8');

    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    // Give the watcher several ticks to have processed the file — since no
    // real change should be detected, we can't waitFor a call; wait a fixed
    // settle window instead.
    await new Promise((r) => setTimeout(r, 120));

    expect(updateSpy).not.toHaveBeenCalled();
    expect(setClustersSpy).not.toHaveBeenCalled();
    // Order is left untouched — no patch was applied.
    expect(run.snapshot.clusters[0].tests).toEqual(['com.x.BarTest', 'com.x.FooTest#a']);
  });

  it('(i) a reordered-but-set-equal vrt array does not trigger a spurious updateCluster', async () => {
    // Seeded snapshot cluster whose `vrt` order differs from the ledger's —
    // same fqcn/url set, different array order — everything else identical
    // to what the ledger tick will map to.
    const seeded: Cluster = {
      id: 'c2-vrt',
      title: 'VRT drift',
      bucket: 'vrt',
      tests: ['com.x.VrtTest', 'com.x.VrtTest2'],
      state: 'proposed',
      vrt: [
        { fqcn: 'com.x.VrtTest2', url: 'https://vrt-x.example/compare/2' },
        { fqcn: 'com.x.VrtTest', url: 'https://vrt-x.example/compare/9' },
      ],
    };
    const run = runStore.create(cfg);
    run.setClusters([seeded]);

    const setClustersSpy = vi.spyOn(run, 'setClusters');
    const updateSpy = vi.spyOn(run, 'updateCluster');

    // Ledger carries the same cluster, `vrt` entries in the opposite order,
    // no other field changed.
    const ledgerTick = {
      run: { version: 2 },
      clusters: [
        {
          id: 'c2-vrt',
          title: 'VRT drift',
          bucket: 'vrt',
          status: 'proposed',
          tests: [
            { fqcn: 'com.x.VrtTest', vrt: 'https://vrt-x.example/compare/9' },
            { fqcn: 'com.x.VrtTest2', vrt: 'https://vrt-x.example/compare/2' },
          ],
        },
      ],
      events: [],
    };
    await fs.writeFile(path.join(dir, 'ledger.json'), JSON.stringify(ledgerTick), 'utf8');

    const stop = startLedgerWatcher(run, dir, { intervalMs: 20 });
    stops.push(stop);

    // No real change should be detected, so we can't waitFor a call; wait a
    // fixed settle window instead.
    await new Promise((r) => setTimeout(r, 120));

    expect(updateSpy).not.toHaveBeenCalled();
    expect(setClustersSpy).not.toHaveBeenCalled();
    // Order is left untouched — no patch was applied.
    expect(run.snapshot.clusters[0].vrt).toEqual([
      { fqcn: 'com.x.VrtTest2', url: 'https://vrt-x.example/compare/2' },
      { fqcn: 'com.x.VrtTest', url: 'https://vrt-x.example/compare/9' },
    ]);
  });
});
