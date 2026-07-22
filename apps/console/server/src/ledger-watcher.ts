import fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import type { Run } from './run-store.js';
import type { Cluster, ClusterBucket, ClusterState, PhaseId } from './types.js';
import { PHASE_ORDER } from './types.js';

/**
 * server/src/ledger-watcher.ts — derives the console's cluster board from the
 * flaky-triage-kit's on-disk `ledger.json`, so the board stays live even when
 * the agent narrates instead of calling the `hektor-console` MCP tools
 * (`driver-mcp.ts`'s `set_clusters` / `cluster_status`). Those tools remain
 * the fast path for a live board; this watcher is the deterministic
 * fallback/reconciler derived from the kit's own ground-truth run state.
 *
 * ## Derived ledger schema (read-only research — kits/flaky-triage-kit)
 * `core/ledger.sh` is itself schema-agnostic: `init` only ever writes the
 * bare skeleton `{run:{}, clusters:[], events:[]}` (ledger.sh:16); every
 * concrete field is populated later by the skill via `ledger.sh set
 * '<jq-filter>'` calls that live OUTSIDE `core/` — none of `core/*.sh` call
 * `ledger.sh set` themselves (grepped the kit; confirmed absent). The
 * authoritative shape is documented in the kit's `kernel.md` §8
 * ("State / ledger (resumable · idempotent · auditable)"):
 *
 *   run:     { id, sReportUrl, build{name,@timestamp}, tb, startedBy }
 *   cluster: { id, signature, tier, bucket, fixVsBug, evidence,
 *              tests[ fqcn… ],
 *              status: proposed|selected|applied|green|deferred|flagged|resolved-upstream,
 *              diffRef, lineage(parentClusterId), greenProofScope }
 *   event:   { who, what(selected/applied/steered), when }   // provenance
 *
 * `core/summary.sh` corroborates `cluster.status` and `cluster.tests` (it
 * groups `.clusters[] | select(.status==st)` and counts `.tests|length`) and
 * shows a defensive label fallback chain `.recipe // .bucket // (.sig|etype)
 * // .tier_hint // "uncategorized"` — i.e. some clusters MAY also carry
 * `recipe`/`sig`/`tier_hint`, but those aren't part of the documented
 * contract above and aren't relied on here.
 *
 * `core/rerun.sh`'s raw output (`{tb, runs, runs_requested, ...,
 * tests:{<fqcn>:{pass,fail,skip,runs,confidence,cause}}}`) is NOT itself a
 * ledger shape — `rerun.sh` never touches `ledger.sh`. Whether/how its
 * numbers land inside a cluster's `greenProofScope` is entirely up to the
 * skill's jq filter and is not specified anywhere in the read-only kit. This
 * watcher only reads `greenProofScope` opportunistically (see
 * `derivePassRunCounts` below) when it already exposes the exact
 * `{passes, runs}` shape the console needs — it never invents a deeper join
 * across `evidence` / `tests` / `greenProofScope` that isn't proven to exist.
 *
 * The ledger keys state BY CLUSTER (not by test) — `cluster.id` is an
 * "agent-chosen slug", the same vocabulary the console's own `Cluster.id`
 * uses, and the same session's skill is expected to use one id consistently
 * across both the MCP tools and its `ledger.sh set` calls. So there is no
 * test->cluster rollup to do here (unlike a test-keyed ledger, which this
 * module does NOT need to handle).
 *
 * ## Cluster-status mapping (ledger `status` -> console `ClusterState`)
 * | ledger `cluster.status`                              | console `state` | why                                              |
 * |-------------------------------------------------------|------------------|--------------------------------------------------|
 * | proposed                                               | proposed         | direct match                                      |
 * | selected                                               | picked           | user chose this cluster to work on                |
 * | applied  (no usable `greenProofScope.{passes,runs}`)   | fixing           | fix landed in the tree, not yet evidenced verifying |
 * | applied  (`greenProofScope.{passes,runs}` both numbers)| verifying        | green-proof reruns are actively counting toward N |
 * | green                                                   | green            | direct match                                      |
 * | flagged                                                 | app-bug          | "suspected bug, TODO + evidence" ~ app-bug        |
 * | deferred                                                | skipped          | closest available — user didn't pursue this pass  |
 * | resolved-upstream                                       | green            | no distinct console state; "no longer a problem"  |
 * | anything else / unrecognized                            | (no update)      | never guess an unrecognized status                |
 *
 * Console's `error` state has no ledger source and is never produced by this
 * watcher — it stays exclusively an MCP-fast-path / driver-error state.
 *
 * ## Deliberately NOT derived on the v1 path (kit-contract gaps that shaped
 * the ORIGINAL v1-only watcher; v2 below closes most of these once a ledger
 * actually carries the richer shape):
 * - New clusters are never created from a v1 ledger (`run.setClusters` is
 *   never called for one). A v1 cluster has no `title` field at all
 *   (`signature`/`tier`/`bucket` are the closest fields but aren't
 *   human-phrased titles), so `updateCluster` only ever patches a cluster
 *   id the MCP fast path (`set_clusters`) has already published; an unknown
 *   id is skipped (mirroring `Run.updateCluster`'s own no-op-on-unknown-id).
 * - `bucket`, `title`, and `tests` are never overwritten from a v1 ledger.
 * - `run.{id,sReportUrl,build,tb,startedBy}` and `events[]` are out of
 *   scope on the v1 path — phase progress there is driven exclusively by
 *   `driver.ts`'s Bash-command inference (`inferPhase`/`advancePhase`).
 *
 * ## v2 (`run.version === 2` — kernel.md §8's "presentation contract")
 * A v2 ledger cluster is a FULL console-shaped record — `title`/`detail`
 * (human-phrased, kit-authored, ≤80/≤600 chars per `ledger.sh`), a `bucket`
 * drawn from the exact same six-value closed enum the console's
 * `ClusterBucket` uses, `passes`/`runs` at the cluster's own top level
 * (not nested under `greenProofScope`), and `tests[]` entries shaped
 * `{fqcn, status?}` where `status` (`red`/`green`/`skipped`) is present only
 * when that individual test's outcome is worth calling out. Because the
 * ledger now carries everything the console's `Cluster` needs, this watcher
 * treats it as authoritative and creates clusters, not just patches them:
 *
 * - `applyLedgerClustersV2` builds the FULL desired `Cluster[]` from every
 *   ledger cluster (dropping any malformed entry — missing id/title/status
 *   or an unrecognized bucket — rather than fabricate one; see
 *   `buildDesiredClusterV2`). If the current snapshot is missing ANY of
 *   those ids (a session's first v2 tick, most commonly), the whole desired
 *   array replaces the board in one authoritative `run.setClusters` call —
 *   this is the only path in the module that creates clusters. Once every
 *   ledger id is already present, it falls back to a per-cluster diff
 *   (`diffClusterV2`) and only calls `updateCluster` for an id whose mapped
 *   fields actually changed — same "diff before emit" discipline as the v1
 *   path, so an unchanged re-parse never re-emits an event.
 * - Status mapping mirrors the v1 table (`mapLedgerStatusV2`) with one
 *   difference: `applied`'s verifying/fixing split reads `passes`/`runs`
 *   directly off the cluster instead of `greenProofScope`.
 * - `divergent` is built from every `tests[]` entry that carries a
 *   `status` (dropped as `undefined`, not `[]`, when none do — so an
 *   already-converged cluster's patch/create never carries a spurious empty
 *   array). `tests` (the console field) is always the full fqcn list,
 *   regardless of which entries diverge.
 * - `events[]` with `what: 'phase-enter'` drive `run.setPhase` forward-only
 *   (`applyLedgerPhaseEvents` / `advancePhaseForward`): the LAST such event
 *   in the (append-only) array wins, its `phase` maps 1:1 onto the
 *   console's `PhaseId` except `confirm`→`cluster` (the kit's separate
 *   confirmation step folds into the console's single `cluster` phase), and
 *   advancing marks every earlier phase `done` — same forward-only
 *   semantics as `driver.ts`'s own `advancePhase` (duplicated locally as
 *   `advancePhaseForward` rather than imported: `driver.ts` already imports
 *   `startLedgerWatcher` FROM this module, so importing back would create a
 *   circular module dependency). A v1 ledger's `events[]` remains
 *   completely unread — v1 phase progress stays exclusively driver.ts's
 *   Bash-command inference, unchanged.
 *
 * ## Precedence
 * Watcher-driven and MCP-tool-driven updates both flow through the same
 * `Run.updateCluster` / `Run.setClusters` methods and are idempotent
 * (re-applying an identical patch is a harmless no-op event, since both the
 * v1 and v2 paths only call `updateCluster`/`setClusters` when the mapped
 * result actually differs from the cluster's current snapshot state).
 * Whichever source observes a change LAST wins — this watcher does not try
 * to order itself against MCP calls (e.g. a stale-but-just-changed ledger
 * read can in principle move a cluster backward relative to a slightly
 * newer MCP update). That is an accepted tradeoff: the ledger is ground
 * truth and the MCP path is the fast/live path, and both are expected to
 * converge on the same terminal ledger-recorded state.
 */

const LEDGER_FILE = 'ledger.json';
const DEFAULT_INTERVAL_MS = 2000;

export interface LedgerWatcherOptions {
  /** Poll interval in ms. Defaults to 2000 per spec; overridable for tests. */
  intervalMs?: number;
  /**
   * Injectable `fs/promises`-shaped `stat`/`readFile` pair, defaulting to the
   * real module. Exists solely so tests can gate a tick mid-flight (e.g. to
   * reproduce the stop()-during-read race) without needing a real slow disk.
   */
  fsImpl?: {
    stat: (path: string) => Promise<{ mtimeMs: number }>;
    readFile: (path: string, encoding: 'utf8') => Promise<string>;
  };
}

/**
 * Starts polling `{dir}/ledger.json` for cluster state and reconciling it
 * onto `run`'s cluster board. Tolerant end-to-end: a missing file, a
 * mid-write partial-JSON read, or an unrecognized shape is skipped silently
 * and retried on the next tick — this must never throw or crash the driver.
 *
 * Returns a stop function; calling it clears the poll timer and closes the
 * best-effort `fs.watch` acceleration (if one was established). Safe to call
 * more than once.
 */
export function startLedgerWatcher(run: Run, dir: string, opts: LedgerWatcherOptions = {}): () => void {
  const ledgerPath = path.join(dir, LEDGER_FILE);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fsImpl = opts.fsImpl ?? fs;
  let lastMtimeMs: number | null = null;
  let inFlight = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      let stat: { mtimeMs: number };
      try {
        stat = await fsImpl.stat(ledgerPath);
      } catch {
        return; // absent — not yet created (or `dir` itself doesn't exist yet); retry next tick
      }
      // `stop()` may have fired while the stat above was in flight — a
      // stopped watcher must never go on to read/apply a cluster patch onto
      // a run that's no longer live (stopped/paused/finished).
      if (stopped) return;
      if (lastMtimeMs !== null && stat.mtimeMs === lastMtimeMs) return; // unchanged since last parse — skip

      let raw: string;
      try {
        raw = await fsImpl.readFile(ledgerPath, 'utf8');
      } catch {
        return; // vanished between stat and read — retry next tick
      }
      // Same race, this time around the (typically slower) read itself.
      if (stopped) return;

      let ledger: unknown;
      try {
        ledger = JSON.parse(raw);
      } catch {
        return; // partial/mid-write JSON — tolerate, retry next tick (mtime deliberately NOT advanced)
      }

      // Only commit the mtime once a parse has actually succeeded, so a
      // transient garbage read (same-second mtime on a non-atomic writer)
      // never gets treated as "already seen".
      lastMtimeMs = stat.mtimeMs;
      // Final re-check immediately before mutating the run's board — no
      // further awaits happen between here and applyLedger, but this is the
      // last chance to bail before the mutation actually lands.
      if (stopped) return;
      applyLedger(run, ledger);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => { void tick(); }, intervalMs);
  void tick(); // don't wait a full interval for the first read

  // Best-effort acceleration on top of the poll loop above: react as soon as
  // the directory changes instead of waiting up to `intervalMs`. Purely
  // additive — if `dir` doesn't exist yet or the platform refuses to watch
  // it, the interval poll is the sole (reliable) source of truth.
  let watcher: ReturnType<typeof fsWatch> | null = null;
  try {
    watcher = fsWatch(dir, (_event, filename) => {
      if (filename === null || filename === LEDGER_FILE) void tick();
    });
    watcher.on('error', () => { /* ignore — polling still covers us */ });
  } catch {
    watcher = null;
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    try { watcher?.close(); } catch { /* already closed / never opened */ }
  };
}

interface MappedStatus {
  state: ClusterState;
  passes?: number;
  runs?: number;
}

/** See the module-header mapping table for the reasoning behind each case. */
function mapLedgerStatus(status: string, greenProofScope: unknown): MappedStatus | null {
  switch (status) {
    case 'proposed': return { state: 'proposed' };
    case 'selected': return { state: 'picked' };
    case 'applied': {
      const counts = derivePassRunCounts(greenProofScope);
      return counts ? { state: 'verifying', ...counts } : { state: 'fixing' };
    }
    case 'green': return { state: 'green' };
    case 'flagged': return { state: 'app-bug' };
    case 'deferred': return { state: 'skipped' };
    case 'resolved-upstream': return { state: 'green' };
    default: return null; // unrecognized ledger status — never guess
  }
}

/**
 * Opportunistic read of `cluster.greenProofScope` — only used when it
 * already exposes numeric `passes`/`runs` fields (the exact vocabulary the
 * console's `Cluster` type uses). Any other shape (missing, non-object,
 * non-numeric fields) yields `null` — never fabricated from
 * `evidence`/`tests`, whose shape isn't documented anywhere in the kit.
 */
function derivePassRunCounts(scope: unknown): { passes: number; runs: number } | null {
  if (!scope || typeof scope !== 'object') return null;
  const passes = (scope as Record<string, unknown>).passes;
  const runs = (scope as Record<string, unknown>).runs;
  if (typeof passes === 'number' && Number.isFinite(passes) && typeof runs === 'number' && Number.isFinite(runs)) {
    return { passes, runs };
  }
  return null;
}

/**
 * Version dispatch — the single entry point `tick()` calls once a ledger
 * read has parsed successfully. `run.version === 2` (kernel.md §8's
 * "presentation contract") gets the full v2 consumer (cluster creation +
 * divergence + phase events, see module header); everything else (missing
 * `run`, missing/non-2 `version`) falls through to the original v1 path
 * completely unchanged — a v1 ledger's behavior here is byte-identical to
 * before v2 existed.
 */
function applyLedger(run: Run, ledger: unknown): void {
  if (!ledger || typeof ledger !== 'object') return;
  const runField = (ledger as Record<string, unknown>).run;
  const version = runField && typeof runField === 'object' ? (runField as Record<string, unknown>).version : undefined;
  if (version === 2) {
    applyLedgerV2(run, ledger as Record<string, unknown>);
  } else {
    applyLedgerClusters(run, ledger);
  }
}

/**
 * Reconciles `ledger.clusters[]` onto `run.snapshot.clusters`, diffing
 * against the cluster's CURRENT snapshot state (not a separately-tracked
 * "last applied" cache) — that current state already reflects whichever
 * source (this watcher or an MCP tool call) wrote it last, so an unchanged
 * mapped result never re-emits an `updateCluster` call.
 *
 * v1 path only — see `applyLedgerV2` for the `run.version === 2` consumer.
 */
function applyLedgerClusters(run: Run, ledger: unknown): void {
  if (!ledger || typeof ledger !== 'object') return;
  const clusters = (ledger as Record<string, unknown>).clusters;
  if (!Array.isArray(clusters)) return;

  for (const raw of clusters) {
    if (!raw || typeof raw !== 'object') continue;
    const id = (raw as Record<string, unknown>).id;
    const status = (raw as Record<string, unknown>).status;
    if (typeof id !== 'string' || typeof status !== 'string') continue;

    // Never fabricate a new cluster — only patch one the MCP fast path
    // (`set_clusters`) has already published. See module header.
    const existing = run.snapshot.clusters.find((c) => c.id === id);
    if (!existing) continue;

    const mapped = mapLedgerStatus(status, (raw as Record<string, unknown>).greenProofScope);
    if (!mapped) continue;

    const patch: Partial<Cluster> = {};
    if (existing.state !== mapped.state) patch.state = mapped.state;
    if (mapped.passes !== undefined && existing.passes !== mapped.passes) patch.passes = mapped.passes;
    if (mapped.runs !== undefined && existing.runs !== mapped.runs) patch.runs = mapped.runs;

    if (Object.keys(patch).length > 0) run.updateCluster(id, patch);
  }
}

// ─── v2 (`run.version === 2`) ──────────────────────────────────────────────
// See the module header's "v2" section for the full design rationale.

/** The console's closed `ClusterBucket` enum — identical six values to the
 *  kit's own `BUCKETS` list in `core/ledger.sh`, so a v2 ledger's `bucket`
 *  needs no remapping, only validation. */
const CLUSTER_BUCKETS = new Set<string>(['easy-fix', 'selector', 'vrt', 'app-change', 'infra', 'likely-bug']);

/** The three per-test outcomes a v2 `tests[].status` entry may carry. */
const DIVERGENT_TEST_STATUSES = new Set<string>(['red', 'green', 'skipped']);

/** Ledger phase vocabulary (`core/ledger.sh`'s `PHASES`) → console `PhaseId`.
 *  `confirm` is the only non-identity mapping: the kit's separate
 *  confirmation step folds into the console's single `cluster` phase. */
const LEDGER_PHASE_TO_CONSOLE: Record<string, PhaseId> = {
  ingest: 'ingest',
  confirm: 'cluster',
  cluster: 'cluster',
  pick: 'pick',
  fix: 'fix',
  verify: 'verify',
  report: 'report',
};

function applyLedgerV2(run: Run, ledger: Record<string, unknown>): void {
  const clusters = ledger.clusters;
  if (Array.isArray(clusters)) applyLedgerClustersV2(run, clusters);
  const events = ledger.events;
  if (Array.isArray(events)) applyLedgerPhaseEvents(run, events);
}

/** See mapLedgerStatus's v1 counterpart for the reasoning behind each case —
 *  identical table, except `applied`'s pass/run pair is read straight off
 *  the v2 cluster instead of a nested `greenProofScope`. */
function mapLedgerStatusV2(status: string, passes: unknown, runs: unknown): MappedStatus | null {
  switch (status) {
    case 'proposed': return { state: 'proposed' };
    case 'selected': return { state: 'picked' };
    case 'applied': {
      const counts =
        typeof passes === 'number' && Number.isFinite(passes) && typeof runs === 'number' && Number.isFinite(runs)
          ? { passes, runs }
          : null;
      return counts ? { state: 'verifying', ...counts } : { state: 'fixing' };
    }
    case 'green': return { state: 'green' };
    case 'flagged': return { state: 'app-bug' };
    case 'deferred': return { state: 'skipped' };
    case 'resolved-upstream': return { state: 'green' };
    default: return null; // unrecognized ledger status — never guess
  }
}

/**
 * Maps one raw v2 ledger cluster onto a full console `Cluster`, or `null`
 * when it's missing a field the console's type requires (`id`/`title`/
 * `status`) or carries a `bucket` outside the closed enum — malformed
 * entries are dropped rather than fabricated into a guessed shape, same
 * "never guess" discipline as the v1 path.
 */
function buildDesiredClusterV2(raw: Record<string, unknown>): Cluster | null {
  const id = raw.id;
  const title = raw.title;
  const bucket = raw.bucket;
  const status = raw.status;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof status !== 'string') return null;
  if (typeof bucket !== 'string' || !CLUSTER_BUCKETS.has(bucket)) return null;

  const mapped = mapLedgerStatusV2(status, raw.passes, raw.runs);
  if (!mapped) return null;

  const testsRaw = Array.isArray(raw.tests) ? raw.tests : [];
  const tests: string[] = [];
  const divergent: { fqcn: string; status: 'red' | 'green' | 'skipped' }[] = [];
  for (const t of testsRaw) {
    if (!t || typeof t !== 'object') continue;
    const fqcn = (t as Record<string, unknown>).fqcn;
    if (typeof fqcn !== 'string') continue;
    tests.push(fqcn);
    const testStatus = (t as Record<string, unknown>).status;
    if (typeof testStatus === 'string' && DIVERGENT_TEST_STATUSES.has(testStatus)) {
      divergent.push({ fqcn, status: testStatus as 'red' | 'green' | 'skipped' });
    }
  }

  const detail = typeof raw.detail === 'string' ? raw.detail : undefined;

  return {
    id,
    title,
    bucket: bucket as ClusterBucket,
    tests,
    state: mapped.state,
    ...(detail !== undefined ? { detail } : {}),
    ...(mapped.passes !== undefined ? { passes: mapped.passes } : {}),
    ...(mapped.runs !== undefined ? { runs: mapped.runs } : {}),
    // Only carry `divergent` when at least one test actually diverges — an
    // already-converged cluster's create/patch never gets a spurious `[]`.
    ...(divergent.length > 0 ? { divergent } : {}),
  };
}

/**
 * Builds the full desired `Cluster[]` from `ledger.clusters` and either
 * CREATES the board (`run.setClusters`, full authoritative replace — the
 * only place in this module that fabricates new clusters) when the current
 * snapshot is missing any ledger cluster id, or diffs each one individually
 * (`run.updateCluster`) once every id is already known. See module header.
 */
function applyLedgerClustersV2(run: Run, clustersRaw: unknown[]): void {
  const desired: Cluster[] = [];
  for (const raw of clustersRaw) {
    if (!raw || typeof raw !== 'object') continue;
    const cluster = buildDesiredClusterV2(raw as Record<string, unknown>);
    if (cluster) desired.push(cluster);
  }
  // Nothing usable this tick (empty/all-malformed) — never wipe an existing
  // board over what might be a transient/partial ledger state.
  if (desired.length === 0) return;

  const currentIds = new Set(run.snapshot.clusters.map((c) => c.id));
  const missesAnId = desired.some((c) => !currentIds.has(c.id));
  if (missesAnId) {
    run.setClusters(desired);
    return;
  }

  for (const d of desired) {
    const existing = run.snapshot.clusters.find((c) => c.id === d.id)!;
    const patch = diffClusterV2(existing, d);
    if (Object.keys(patch).length > 0) run.updateCluster(d.id, patch);
  }
}

/** Field-by-field diff of a desired v2-mapped cluster against its current
 *  snapshot state — only changed fields land in the patch, so an unchanged
 *  re-parse never re-emits an `updateCluster` call (same discipline as the
 *  v1 path's inline diff). Array fields (`tests`, `divergent`) compare by
 *  serialized equality; `divergent`'s "no divergence" case is normalized to
 *  `[]` on both sides so `undefined` and `[]` never register as a diff. */
function diffClusterV2(existing: Cluster, desired: Cluster): Partial<Cluster> {
  const patch: Partial<Cluster> = {};
  if (existing.title !== desired.title) patch.title = desired.title;
  if (existing.bucket !== desired.bucket) patch.bucket = desired.bucket;
  if (existing.state !== desired.state) patch.state = desired.state;
  if (existing.detail !== desired.detail) patch.detail = desired.detail;
  if (existing.passes !== desired.passes) patch.passes = desired.passes;
  if (existing.runs !== desired.runs) patch.runs = desired.runs;
  if (JSON.stringify(existing.tests) !== JSON.stringify(desired.tests)) patch.tests = desired.tests;
  if (JSON.stringify(existing.divergent ?? []) !== JSON.stringify(desired.divergent ?? [])) {
    patch.divergent = desired.divergent;
  }
  return patch;
}

/**
 * Drives `run.setPhase` forward-only off `events[]`'s `phase-enter` entries:
 * the LAST matching event in the array wins (the ledger's `event`
 * subcommand only ever appends, so array order is chronological), its
 * `phase` maps through `LEDGER_PHASE_TO_CONSOLE`, and advancing is a no-op
 * when that console phase is already reached — so re-reading an unchanged
 * (or now-stale/earlier) latest event never regresses or re-emits.
 */
function applyLedgerPhaseEvents(run: Run, events: unknown[]): void {
  let latest: PhaseId | null = null;
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const what = (raw as Record<string, unknown>).what;
    const phase = (raw as Record<string, unknown>).phase;
    if (what !== 'phase-enter' || typeof phase !== 'string') continue;
    const mapped = LEDGER_PHASE_TO_CONSOLE[phase];
    if (mapped) latest = mapped;
  }
  if (latest) advancePhaseForward(run, latest);
}

/**
 * Local equivalent of `driver.ts`'s `advancePhase`: mark every phase before
 * `next` as `done` and activate `next`, forward-only (a no-op once `next`
 * has already reached `done`). Duplicated rather than imported — see the
 * module header's v2 section for why importing from `driver.ts` here would
 * create a circular module dependency.
 */
function advancePhaseForward(run: Run, next: PhaseId): void {
  const order = PHASE_ORDER;
  const target = order.indexOf(next);
  const targetPhase = run.snapshot.phases.find((p) => p.id === next);
  if (!targetPhase || targetPhase.status === 'done') return;
  for (let i = 0; i < target; i++) {
    const cur = run.snapshot.phases.find((p) => p.id === order[i]);
    if (cur && (cur.status === 'active' || cur.status === 'queued')) run.setPhase(order[i], 'done');
  }
  if (targetPhase.status !== 'active') run.setPhase(next, 'active');
}
