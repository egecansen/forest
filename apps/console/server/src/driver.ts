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
import { buildSelenoidUrlRegex } from './console-config.js';

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

// Cap on how much tool-result text a single 'user' message contributes to the
// Selenoid scan — a rerun's stdout capture can be huge, and this is scan
// input, not anything ever logged/persisted wholesale.
const SELENOID_SCAN_CAP = 200_000;
// Plausibility guard on a regex MATCH before it's ever surfaced via
// run.setSelenoidUrl: must look like an actual http(s) URL, contain no
// whitespace (a greedy \S* alternative could otherwise straddle unrelated
// text), and stay within a sane length.
const MAX_PLAUSIBLE_URL_LENGTH = 500;
function isPlausibleUrl(candidate: string): boolean {
  return (
    /^https?:\/\//i.test(candidate) &&
    !/\s/.test(candidate) &&
    candidate.length <= MAX_PLAUSIBLE_URL_LENGTH
  );
}

/**
 * Scans a single SDK stream message's `user`-type tool_result content for a
 * Selenoid live-session URL. The SDK types `message.content` as `string |
 * Array<ContentBlockParam>`, and a `tool_result` block's own `content` as
 * `string | Array<TextBlockParam | ...>` (see @anthropic-ai/sdk's
 * ToolResultBlockParam) — both shapes are handled here, plus the absence of
 * either. Defensive by construction (every access is optional-chained /
 * type-guarded) and additionally wrapped in try/catch so a genuinely
 * unexpected shape from a future SDK version can never crash the driver's
 * stream loop — it just means this message contributes no match.
 *
 * Returns the first plausible match's raw text, or null.
 */
export function extractSelenoidUrl(m: Record<string, unknown>, pattern: RegExp): string | null {
  try {
    const message = (m as { message?: { content?: unknown } }).message;
    const blocks = message?.content;
    if (!Array.isArray(blocks)) return null;

    let scanned = '';
    for (const block of blocks) {
      if (scanned.length >= SELENOID_SCAN_CAP) break;
      if (!block || typeof block !== 'object') continue;
      if ((block as { type?: unknown }).type !== 'tool_result') continue;
      const content = (block as { content?: unknown }).content;
      if (typeof content === 'string') {
        scanned += content;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (
            part &&
            typeof part === 'object' &&
            (part as { type?: unknown }).type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string'
          ) {
            scanned += (part as { text: string }).text;
          }
        }
      }
    }
    if (!scanned) return null;

    const match = scanned.slice(0, SELENOID_SCAN_CAP).match(pattern);
    const candidate = match?.[0];
    if (!candidate) return null;
    return isPlausibleUrl(candidate) ? candidate : null;
  } catch {
    return null;
  }
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
  opts: {
    resume?: boolean;
    ledgerWatcherImpl?: typeof startLedgerWatcher;
    /** Regex used to detect a Selenoid live-session URL in tool-result text
     *  (see extractSelenoidUrl below). Defaults to the built-in pattern —
     *  production callers (index.ts) pass one built from the operator's
     *  optional ConsoleConfig.selenoidUrlPattern. */
    selenoidUrlRegex?: RegExp;
  } = {}
): DriverHandle {
  const config = run.snapshot.config!;
  const abort = new AbortController();
  let pausing = false;
  const selenoidUrlRegex = opts.selenoidUrlRegex ?? buildSelenoidUrlRegex();
  // The last Selenoid URL this driver has surfaced — so a rerun that keeps
  // logging the SAME live url every tick doesn't call run.setSelenoidUrl (and
  // thus re-log "watch live: …") on every single tool result. A genuinely
  // DIFFERENT url (a fresh rerun's new session) still gets surfaced.
  let lastSelenoidUrl: string | null = null;
  // Injectable seam (tests only — production always gets the real watcher):
  // every pre-existing driver test scripts a non-demo run, so without this
  // seam each one silently spins up a REAL fs.watch/poll timer against its
  // (usually nonexistent) `config.projectPath`.
  const ledgerWatcherImpl = opts.ledgerWatcherImpl ?? startLedgerWatcher;

  const mcpAvailable = process.env.HEKTOR_DISABLE_MCP !== '1';

  const options: Record<string, unknown> = {
    cwd: config.projectPath,
    abortController: abort,
    permissionMode: 'default',
    // Load the target repo's .claude settings: the kit's skill + its
    // self-protection PreToolUse gates apply to this session exactly as in a
    // terminal run. The kit stays the authority on its own safety.
    settingSources: ['project'],
    canUseTool: makeCanUseTool(run),
    ...(mcpAvailable ? { mcpServers: { 'hektor-console': hektorMcpServer(run) } } : {}),
    ...(opts.resume && run.snapshot.sessionId ? { resume: run.snapshot.sessionId } : {}),
  };

  const stream = queryFn({ prompt: buildPrompt(config, { resume: !!opts.resume, mcpAvailable }), options });

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
        } else if (type === 'user') {
          // Tool RESULTS (not tool calls) stream back as 'user' messages —
          // this is where a rerun's gradle/Selenium stdout (and thus the
          // Selenoid live-session URL) actually appears. Only the matched
          // URL ever flows out via run.setSelenoidUrl — the raw tool-result
          // text itself is never logged wholesale.
          const url = extractSelenoidUrl(m, selenoidUrlRegex);
          if (url && url !== lastSelenoidUrl) {
            lastSelenoidUrl = url;
            run.setSelenoidUrl(url);
          }
        } else if (type === 'result') {
          const r = m as { subtype?: string; total_cost_usd?: number; usage?: { output_tokens?: number }; result?: string };
          if (typeof r.total_cost_usd === 'number') run.setTelemetry({ costUsd: r.total_cost_usd });
          if (typeof r.usage?.output_tokens === 'number') run.raiseTokens(r.usage.output_tokens);
          run.setTelemetry({ thinking: false });
          if (r.subtype === 'success') {
            // Completion honesty: a session can end its stream with a
            // `result` success while a green-proof verification run was only
            // backgrounded, not awaited — the SDK session closing doesn't
            // mean the picked clusters actually converged. Any cluster still
            // in-flight (picked/fixing/verifying) means this "success" is
            // really an unfinished session, not a completed triage — park it
            // as 'paused' (resumable via the existing /resume route, which
            // re-enters the same sessionId) instead of marking it done.
            const unverified = run.snapshot.clusters.filter(
              (c) => c.state === 'picked' || c.state === 'fixing' || c.state === 'verifying'
            );
            if (unverified.length > 0) {
              if (r.result) run.setReportText(r.result);
              run.log({
                kind: 'warn',
                text: `session ended with ${unverified.length} cluster(s) unverified — parked as paused; resume to collect verdicts`,
              });
              run.setStatus('paused');
            } else {
              advancePhase(run, 'report');
              run.setPhase('report', 'done');
              if (r.result) {
                run.log({ kind: 'success', text: r.result.slice(0, 2000) });
                run.setReportText(r.result);
              }
              run.finish(true);
            }
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
