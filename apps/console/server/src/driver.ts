import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Run } from './run-store.js';
import type { PhaseId } from './types.js';
import { PHASE_ORDER } from './types.js';
import { buildPrompt } from './driver-prompt.js';
import { makeCanUseTool } from './driver-can-use-tool.js';
import { hektorMcpServer } from './driver-mcp.js';

export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) =>
  AsyncIterable<Record<string, unknown>> & { interrupt?: () => Promise<void> };
export type DriverHandle = (() => void) & { pause: () => void };

const PHASE_BY_SCRIPT: Array<[RegExp, PhaseId]> = [
  [/ingest\.sh/, 'ingest'],
  [/cluster\.sh/, 'cluster'],
  [/(apply|compile)\.sh/, 'fix'],
  [/(rerun|dom-capture|dom-on-failure)\.sh/, 'verify'],
  [/summary\.sh/, 'report'],
];

export function inferPhase(command: string): PhaseId | null {
  for (const [re, id] of PHASE_BY_SCRIPT) if (re.test(command)) return id;
  return null;
}

/** Advance the pipeline: mark `next` active and every earlier phase done. */
function advancePhase(run: Run, next: PhaseId) {
  const order = PHASE_ORDER;
  const target = order.indexOf(next);
  for (let i = 0; i < order.length; i++) {
    const cur = run.snapshot.phases.find((p) => p.id === order[i])!;
    if (i < target && (cur.status === 'active' || cur.status === 'queued')) run.setPhase(order[i], 'done');
    if (i === target && cur.status !== 'active') run.setPhase(order[i], 'active');
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

export function startDriver(run: Run, queryFn: QueryFn = realQueryFn, opts: { resume?: boolean } = {}): DriverHandle {
  const config = run.snapshot.config!;
  const abort = new AbortController();
  let pausing = false;

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

  void (async () => {
    run.setStatus(opts.resume ? 'running' : 'preparing');
    try {
      for await (const m of stream) {
        if (run.isStopped()) break;
        const type = m.type as string;
        if (type === 'system' && (m as { subtype?: string }).subtype === 'init') {
          run.setSessionId((m as { session_id: string }).session_id);
          run.setStatus('running');
          run.setTelemetry({ thinking: true });
        } else if (type === 'assistant') {
          const content = ((m as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? []);
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              run.log({ kind: 'info', text: (block.text as string).slice(0, 400) });
            } else if (block.type === 'tool_use') {
              const name = block.name as string;
              const input = (block.input ?? {}) as Record<string, unknown>;
              if (name === 'Bash' && typeof input.command === 'string') {
                const phase = inferPhase(input.command);
                if (phase) advancePhase(run, phase);
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
            if (r.result) run.log({ kind: 'success', text: r.result.slice(0, 2000) });
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
    } catch (err) {
      if (!run.isStopped()) {
        run.log({ kind: 'error', text: `driver error: ${(err as Error).message}` });
        if (pausing) run.setStatus('paused'); else run.finish(false);
      }
    }
  })();

  const stop = () => { abort.abort(); run.stop(); };
  return Object.assign(stop, {
    pause: () => { pausing = true; void stream.interrupt?.().catch(() => abort.abort()); },
  });
}

/**
 * Scripted demo stream used when `config.demo === true` — walks the same
 * shape a real triage session takes (system init → ingest → cluster → a
 * cluster pick via AskUserQuestion → a success result with a scoreboard) with
 * no SDK/network involved, so the UI has a working end-to-end path to demo
 * against. Yields asynchronously so WS clients see the run progress rather
 * than jumping straight to 'completed'. The AskUserQuestion block is only
 * logged in this task (the stub canUseTool doesn't intercept it) — the real
 * pick round-trip through the console lands in Task 10; this script is kept
 * so Task 13's smoke test has something to exercise once that lands.
 */
export const demoQueryFn: QueryFn = () => {
  const messages: Record<string, unknown>[] = [
    { type: 'system', subtype: 'init', session_id: 'demo-1' },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'KIT=…; "$KIT/ingest.sh" "https://demo.example/report" > fails.json' },
          },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/cluster.sh" < fails.json' } },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Which clusters should be picked for this triage pass?',
                  header: 'Pick clusters',
                  multiSelect: true,
                  options: [
                    { label: 'flaky-selector', description: 'Selector timing flake across 4 tests' },
                    { label: 'infra-timeout', description: 'Testbox network timeout, 2 tests' },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.08,
      usage: { output_tokens: 320 },
      result: 'Demo triage complete — 2 clusters picked, 0 escalations.',
    },
  ];
  async function* gen() {
    for (const m of messages) {
      await new Promise((r) => setTimeout(r, 50));
      yield m;
    }
  }
  return Object.assign(gen(), { interrupt: async () => {} });
};
