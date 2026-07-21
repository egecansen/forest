import fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import type { Run } from './run-store.js';
import type { Cluster, ClusterState } from './types.js';

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
 * ## Deliberately NOT derived (kit-contract gaps — flag these for the
 * planned kit-contract project rather than fabricate a mapping):
 * - New clusters are never created from the ledger (`run.setClusters` is
 *   never called by this module). The console's `Cluster.title` ("one-line
 *   cause, human phrasing") has no ledger equivalent — `signature`/`tier`/
 *   `bucket` are the closest fields but are not human-phrased titles, and
 *   guessing one would violate "do not fabricate". So `updateCluster` here
 *   only ever patches a cluster id the MCP fast path (`set_clusters`) has
 *   already published; a ledger cluster id unknown to the console is
 *   skipped (mirroring `Run.updateCluster`'s own no-op-on-unknown-id).
 * - `bucket`, `title`, and `tests` are never overwritten from the ledger:
 *   the ledger's `bucket` vocabulary isn't documented to match the
 *   console's closed `ClusterBucket` enum, and there is no ledger
 *   equivalent of `title` at all.
 * - `run.{id,sReportUrl,build,tb,startedBy}` and `events[]` are out of
 *   scope — the console's phase progress is already driven by
 *   `driver.ts`'s Bash-command inference (`inferPhase`), not the ledger.
 *
 * ## Precedence
 * Watcher-driven and MCP-tool-driven updates both flow through the same
 * `Run.updateCluster` / `Run.setClusters` methods and are idempotent
 * (re-applying an identical patch is a harmless no-op event, since
 * `applyLedgerClusters` below only calls `updateCluster` when the mapped
 * fields actually differ from the cluster's current snapshot state).
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
      // Final re-check immediately before mutating the run's cluster board —
      // no further awaits happen between here and applyLedgerClusters, but
      // this is the last chance to bail before the mutation actually lands.
      if (stopped) return;
      applyLedgerClusters(run, ledger);
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
 * Reconciles `ledger.clusters[]` onto `run.snapshot.clusters`, diffing
 * against the cluster's CURRENT snapshot state (not a separately-tracked
 * "last applied" cache) — that current state already reflects whichever
 * source (this watcher or an MCP tool call) wrote it last, so an unchanged
 * mapped result never re-emits an `updateCluster` call.
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
