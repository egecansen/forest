import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Run } from './run-store.js';
import type { Cluster, PhaseId, QuestionSpec } from './types.js';
import { PHASE_ORDER } from './types.js';
import { buildPrompt } from './driver-prompt.js';
import { makeCanUseTool } from './driver-can-use-tool.js';
import { hektorMcpServer } from './driver-mcp.js';
import { pendingAnswers } from './pending-answers.js';
import { startLedgerWatcher } from './ledger-watcher.js';

export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) =>
  AsyncIterable<Record<string, unknown>> & { interrupt?: () => Promise<void> };
export type DriverHandle = (() => void) & { pause: () => void };

// Core script -> phase mapping. A core-script mention only counts when a
// segment's FIRST command token names the script itself — not when the
// script merely appears as an argument further along (see inferPhase below).
const SCRIPT_PHASE: Array<[string, PhaseId]> = [
  ['ingest.sh', 'ingest'],
  ['cluster.sh', 'cluster'],
  ['apply.sh', 'fix'],
  ['compile.sh', 'fix'],
  ['rerun.sh', 'verify'],
  ['dom-capture.sh', 'verify'],
  ['dom-on-failure.sh', 'verify'],
  ['summary.sh', 'report'],
];

// Optional interpreter / source-builtin prefixes: `bash core/rerun.sh` and
// `. core/rerun.sh` (source) still execute the script named in the NEXT
// token, not the prefix itself.
const RUNNER_PREFIXES = new Set(['bash', 'sh', '.', 'source']);

// A bare leading env assignment (`FOO=bar cmd`, or a whole segment that is
// just `KIT=…`) — stripped so the segment's real command token is found.
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)$/;

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return token.slice(1, -1);
  }
  return token;
}

function scriptPhaseForToken(token: string): PhaseId | null {
  const bare = stripQuotes(token);
  for (const [script, phase] of SCRIPT_PHASE) {
    if (bare === script || bare.endsWith(`/${script}`)) return phase;
  }
  return null;
}

/**
 * A single pipeline/sequence segment maps to a phase only if its first
 * command token — the thing actually run — is a core script (optionally
 * after a runner prefix and/or leading env assignments). A core script named
 * later in the segment (an argument to `sed`/`cat`/`grep`, i.e. inspection
 * rather than execution) does not count.
 */
function inferSegmentPhase(segment: string): PhaseId | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  if (RUNNER_PREFIXES.has(tokens[i])) i++;
  if (i >= tokens.length) return null;
  return scriptPhaseForToken(tokens[i]);
}

/**
 * Maps a Bash tool-use command to the pipeline phase it EXECUTES, not merely
 * mentions. `sed -n '1,120p' core/rerun.sh` (reading the script to plan) must
 * NOT infer 'verify' — only a segment whose first command token is one of the
 * core scripts counts as running it. The command is split on pipeline/
 * sequence separators (`|`, `&&`, `||`, `;`, newline) so `cd kit && ./core/
 * rerun.sh …` and `cat x.json | ./core/cluster.sh` are still recognized from
 * whichever segment actually runs the script.
 */
export function inferPhase(command: string): PhaseId | null {
  const segments = command.split(/\|\||&&|\||;|\r?\n/);
  for (const segment of segments) {
    const phase = inferSegmentPhase(segment);
    if (phase) return phase;
  }
  return null;
}

/**
 * Advance the pipeline: mark `next` active and every earlier phase done.
 *
 * Forward-only: if `next` is already 'done', this is a complete no-op. Core
 * scripts can interleave (apply.sh -> fix, rerun.sh -> verify, then a second
 * apply.sh for the next cluster) — without this guard, that second apply.sh
 * would regress the already-'done' `fix` phase back to 'active' while
 * `verify` stayed 'active', producing a backwards jump and two active phases
 * at once.
 */
function advancePhase(run: Run, next: PhaseId) {
  const order = PHASE_ORDER;
  const target = order.indexOf(next);
  const targetPhase = run.snapshot.phases.find((p) => p.id === next)!;
  if (targetPhase.status === 'done') return;
  for (let i = 0; i < target; i++) {
    const cur = run.snapshot.phases.find((p) => p.id === order[i])!;
    if (cur.status === 'active' || cur.status === 'queued') run.setPhase(order[i], 'done');
  }
  if (targetPhase.status !== 'active') run.setPhase(next, 'active');
}

/**
 * Phases that must not be inferred into 'active' from a core-script Bash
 * execution until the cluster 'pick' has actually completed. The kit's real
 * loop runs a confirmation `rerun.sh` EARLY, before clustering/pick — a
 * genuine execution of it there must leave the pipeline's visible active
 * phase at 'ingest'/'cluster', not jump ahead to 'verify'. 'pick' completes
 * only via the AskUserQuestion bridge (driver-can-use-tool.ts / the demo
 * driver's own bridge), which explicitly calls `setPhase('pick', 'done')`.
 */
const GATED_ON_PICK = new Set<PhaseId>(['fix', 'verify', 'report']);

function pickIsDone(run: Run): boolean {
  return run.snapshot.phases.find((p) => p.id === 'pick')?.status === 'done';
}

// The real SDK's `query()` takes a strongly-typed `Options` (and returns a
// `Query` — an AsyncGenerator<SDKMessage, void> with several control methods
// beyond `interrupt`). `QueryFn` deliberately types both sides loosely
// (Record<string, unknown> / a minimal AsyncIterable+interrupt shape) so
// scripted test streams never need to satisfy the real SDK's message union.
// Bridging the two here needs an `unknown` intermediate on the return —
// `Query`'s `interrupt(): Promise<SDKControlInterruptResponse | undefined>`
// isn't structurally assignable to our narrower `interrupt?: () => Promise<void>`.
const realQueryFn: QueryFn = ({ prompt, options }) =>
  query({ prompt, options: options as Options }) as unknown as ReturnType<QueryFn>;

export function startDriver(
  run: Run,
  queryFn: QueryFn = realQueryFn,
  opts: { resume?: boolean; ledgerWatcherImpl?: typeof startLedgerWatcher } = {}
): DriverHandle {
  const config = run.snapshot.config!;
  const abort = new AbortController();
  let pausing = false;
  // Injectable seam (tests only — production always gets the real watcher):
  // every pre-existing driver test scripts a non-demo run, so without this
  // seam each one silently spins up a REAL fs.watch/poll timer against its
  // (usually nonexistent) `config.projectPath`.
  const ledgerWatcherImpl = opts.ledgerWatcherImpl ?? startLedgerWatcher;

  const options: Record<string, unknown> = {
    cwd: config.projectPath,
    abortController: abort,
    permissionMode: 'default',
    // Load the target repo's .claude settings: the kit's skill + its
    // self-protection PreToolUse gates apply to this session exactly as in a
    // terminal run. The kit stays the authority on its own safety.
    settingSources: ['project'],
    canUseTool: makeCanUseTool(run),
    mcpServers: { 'hektor-console': hektorMcpServer(run) },
    ...(opts.resume && run.snapshot.sessionId ? { resume: run.snapshot.sessionId } : {}),
  };

  const stream = queryFn({ prompt: buildPrompt(config, { resume: !!opts.resume }), options });

  // Ledger-watcher lifecycle (leak-proof): started once this run is actually
  // 'running' (real sessions only — a scripted demo has no ledger.json to
  // read), stopped on every exit path below (stream end, driver error,
  // explicit stop(), explicit pause()). `stopLedgerWatcher` is idempotent —
  // safe to call from more than one of those paths for the same run.
  let stopWatcher: (() => void) | null = null;
  const startLedgerWatcherOnce = () => {
    if (!stopWatcher && !config.demo) stopWatcher = ledgerWatcherImpl(run, config.projectPath);
  };
  const stopLedgerWatcher = () => { stopWatcher?.(); stopWatcher = null; };

  void (async () => {
    run.setStatus(opts.resume ? 'running' : 'preparing');
    if (opts.resume) startLedgerWatcherOnce();
    try {
      for await (const m of stream) {
        if (run.isStopped()) break;
        const type = m.type as string;
        if (type === 'system' && (m as { subtype?: string }).subtype === 'init') {
          run.setSessionId((m as { session_id: string }).session_id);
          run.setStatus('running');
          run.setTelemetry({ thinking: true });
          startLedgerWatcherOnce();
        } else if (type === 'assistant') {
          const message = (m as {
            message?: { content?: Array<Record<string, unknown>>; usage?: { output_tokens?: number } };
          }).message;
          // Live token telemetry: bump on every assistant turn that carries usage,
          // so the meter moves during the run instead of staying at 0 until the
          // final `result` message. `raiseTokens` on `result` remains the
          // authoritative monotonic high-water mark.
          const outputTokens = message?.usage?.output_tokens;
          if (typeof outputTokens === 'number') run.bumpTokens(outputTokens);
          const content = message?.content ?? [];
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              run.log({ kind: 'info', text: (block.text as string).slice(0, 400) });
            } else if (block.type === 'tool_use') {
              const name = block.name as string;
              const input = (block.input ?? {}) as Record<string, unknown>;
              if (name === 'Bash' && typeof input.command === 'string') {
                const phase = inferPhase(input.command);
                if (phase && (!GATED_ON_PICK.has(phase) || pickIsDone(run))) advancePhase(run, phase);
                run.log({ kind: 'bash', text: `Bash(${(input.command as string).slice(0, 160)})` });
              } else if (name === 'Edit' || name === 'Write') {
                const file = (input.file_path as string) ?? '';
                run.addFile({ path: file, kind: name === 'Write' ? 'created' : 'modified' });
                run.log({ kind: 'active', text: `${name} ${file}` }, { verb: name === 'Write' ? 'write' : 'edit', file });
              } else if (!name.startsWith('mcp__hektor-console')) {
                run.log({ kind: 'skill', text: name });
              }
            }
          }
        } else if (type === 'result') {
          const r = m as { subtype?: string; total_cost_usd?: number; usage?: { output_tokens?: number }; result?: string };
          if (typeof r.total_cost_usd === 'number') run.setTelemetry({ costUsd: r.total_cost_usd });
          if (typeof r.usage?.output_tokens === 'number') run.raiseTokens(r.usage.output_tokens);
          run.setTelemetry({ thinking: false });
          if (r.subtype === 'success') {
            advancePhase(run, 'report');
            run.setPhase('report', 'done');
            if (r.result) {
              run.log({ kind: 'success', text: r.result.slice(0, 2000) });
              run.setReportText(r.result);
            }
            run.finish(true);
          } else if (pausing) {
            run.setStatus('paused');
          } else {
            run.log({ kind: 'error', text: `agent ended: ${r.subtype ?? 'unknown error'}` });
            run.finish(false);
          }
        }
      }
      // Stream ended without a result (abort/stop): leave status as set by stop()/pause.
      if (!run.isStopped() && run.snapshot.status === 'running' && !pausing) run.finish(false);
      if (!run.isStopped() && pausing && run.snapshot.status === 'running') run.setStatus('paused');
    } catch (err) {
      if (!run.isStopped()) {
        run.log({ kind: 'error', text: `driver error: ${(err as Error).message}` });
        if (pausing) run.setStatus('paused'); else run.finish(false);
      }
    } finally {
      // Every path out of this stream loop (success, failure, pause, abort,
      // thrown error) lands here — the watcher must never outlive the
      // stream it was started alongside.
      stopLedgerWatcher();
    }
  })();

  const stop = () => { abort.abort(); run.stop(); stopLedgerWatcher(); };
  return Object.assign(stop, {
    pause: () => { pausing = true; stopLedgerWatcher(); void stream.interrupt?.().catch(() => abort.abort()); },
  });
}

const DEMO_CLUSTER_ID = 'onetrust';
const DEMO_QUESTION = 'Which clusters should be picked for this triage pass?';

const demoBash = (command: string): Record<string, unknown> => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
});

/**
 * Scripted demo stream used when `config.demo === true` — walks the same
 * shape a real triage session takes: system init → ingest → cluster
 * (publishing a cluster via `run.setClusters`, mirroring what the real
 * session's `set_clusters` MCP tool does — see driver-mcp.ts) → a cluster
 * pick via AskUserQuestion → fix → verify → the picked cluster turns green →
 * a success result. No SDK/network/child-process involved.
 *
 * Unlike the earlier stub, the AskUserQuestion here is a REAL round-trip: it
 * blocks on the exact same `pendingAnswers` registry `makeCanUseTool` uses
 * for a live run (driver-can-use-tool.ts) — a scripted message stream never
 * flows through the real SDK's `canUseTool` hook, so this generator (closed
 * over `run`) reproduces that bridge itself. The console's QuestionModal →
 * `POST /api/runs/:runId/answer` flow resolves it exactly as it would a real
 * session's pause. This is what Task 13's smoke test exercises end-to-end.
 */
export function makeDemoQueryFn(run: Run): QueryFn {
  return () => {
    async function* gen() {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

      yield { type: 'system', subtype: 'init', session_id: 'demo-1' };
      await wait(50);
      yield demoBash('KIT=…; "$KIT/ingest.sh" "https://demo.example/report" > fails.json');
      await wait(50);
      yield demoBash('"$KIT/cluster.sh" < fails.json');
      await wait(50);

      // set_clusters equivalent: a real session publishes clusters via the
      // hektor-console MCP tool (driver-mcp.ts); the demo calls the same
      // Run method directly since there is no real MCP dispatch here.
      const cluster: Cluster = {
        id: DEMO_CLUSTER_ID,
        title: 'OneTrust consent overlay intercepts clicks',
        bucket: 'easy-fix',
        tests: ['com.sahibinden.web.CheckoutFlowTest#submitsWithConsentBanner'],
        state: 'proposed',
      };
      run.setClusters([cluster]);

      const questions: QuestionSpec[] = [
        {
          question: DEMO_QUESTION,
          header: 'Pick clusters',
          multiSelect: true,
          options: [{ label: 'onetrust', description: 'OneTrust consent overlay intercepts clicks on 1 test' }],
        },
      ];
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions } }] },
      };

      const questionId = run.nextQuestionId();
      const runId = run.snapshot.config!.runId;
      const answerPromise = pendingAnswers.register(runId, questionId);
      run.setPendingQuestion({ questionId, questions });
      run.setPhase('pick', 'active');
      try {
        await answerPromise;
      } catch {
        return; // stop()/rejectAll — the run was stopped before it was answered
      }
      run.clearPendingQuestion();
      run.setPhase('pick', 'done');
      run.updateCluster(DEMO_CLUSTER_ID, { state: 'picked' });
      await wait(50);

      // cluster_status equivalent (see driver-mcp.ts) — again a direct Run
      // call rather than a real MCP dispatch.
      yield demoBash('"$KIT/apply.sh" onetrust');
      run.updateCluster(DEMO_CLUSTER_ID, { state: 'fixing' });
      await wait(50);
      yield demoBash('"$KIT/rerun.sh" onetrust tb161');
      run.updateCluster(DEMO_CLUSTER_ID, { state: 'verifying', passes: 1, runs: 3 });
      await wait(50);
      run.updateCluster(DEMO_CLUSTER_ID, { state: 'green', passes: 3, runs: 3, note: 'fixed selector, verified green' });
      await wait(50);

      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.08,
        usage: { output_tokens: 320 },
        result: 'Demo triage completed — 1 cluster fixed and verified green, 0 escalations.',
      };
    }
    return Object.assign(gen(), { interrupt: async () => {} });
  };
}
