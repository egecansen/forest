import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import fsp from 'node:fs/promises';
import url from 'node:url';
import { runStore } from './run-store.js';
import { startDriver, makeDemoQueryFn, type DriverHandle } from './driver.js';
import { pendingAnswers } from './pending-answers.js';
import { normalizeRunBody } from './validate.js';
import { listDirectories } from './browse.js';
import { isAllowedHost } from './host-guard.js';
import { saveRun, listRuns, loadRun, isSafeRunId, resolveInsideRoot, resolveRunsDirSync } from './persistence.js';
import { loadConsoleConfig, kitAllowlist } from './console-config.js';
import { getWorktree } from './worktree.js';
import { BuildsPoller } from './trackers/poller.js';
import { fetchJenkinsUser } from './trackers/jenkins.js';
import { notifyTerminal } from './notify.js';
import type { RunSnapshot, ServerEvent } from './types.js';
import type { WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8765);
const RUNS_DIR = resolveRunsDirSync();
const app = express();

// DNS-rebinding defense: reject any /api request whose Host header doesn't
// name this server's own loopback address, before any route handler runs.
// The static client (served below) is intentionally NOT guarded here.
app.use('/api', (req, res, next) => {
  if (!isAllowedHost(req.headers.host, PORT)) {
    res.status(403).json({ error: 'forbidden host' });
    return;
  }
  next();
});

app.use(express.json());

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');

// Active driver handles keyed by runId so the HTTP stop/pause/resume routes can
// control them. Each handle is callable (stop) with a `.pause` method.
const drivers = new Map<string, DriverHandle>();

// Set once config loads inside main() (null when unconfigured). Declared here
// so the shutdown handler below — which runs before main()'s promise settles
// on process exit — can reach it.
let poller: BuildsPoller | null = null;

// Statuses a run never leaves once reached (see Run.stop/finish — both are
// guarded by `this.stopped` and set exactly one of these).
const TERMINAL_RUN_STATUSES = new Set<RunSnapshot['status']>(['completed', 'failed', 'cancelled']);

// Graceful shutdown: stop every running driver (which kills its child process
// group) before exiting, so SIGINT/SIGTERM don't orphan spawned child
// processes. Guarded + idempotent — safe if invoked more than once (e.g. a
// second signal arriving mid-shutdown) or if a driver's stop() throws.
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const stop of drivers.values()) {
    try {
      stop();
    } catch {
      // best-effort: a stuck driver shouldn't block the rest from stopping.
    }
  }
  poller?.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  const consoleConfig = await loadConsoleConfig().catch((e) => {
    console.warn('[hektor-console] no config:', (e as Error).message);
    return null;
  });
  const allowlist = consoleConfig ? await kitAllowlist(consoleConfig.repoPath).catch(() => []) : [];
  // Best-effort — an unreachable/anonymous Jenkins just means the board's
  // "only mine" filter stays unavailable, not a hard startup failure.
  const jenkinsUser = consoleConfig
    ? await fetchJenkinsUser(consoleConfig.jenkins).catch(() => null)
    : null;
  poller = consoleConfig ? new BuildsPoller(consoleConfig) : null;
  // WS clients on /ws-board — a live connection is the sole "poll while
  // watched" signal (see setClientCount below), and each gets pushed the
  // latest builds snapshot whenever the poller refreshes.
  const boardClients = new Set<WebSocket>();
  if (poller) {
    poller.onRefresh = (data) => {
      for (const ws of boardClients) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'builds', ...data }));
    };
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/builds', (_req, res) => {
    if (!poller) {
      res.status(503).json({ error: 'console not configured — create ~/.hektor-console/config.json' });
      return;
    }
    res.json(poller.getBuilds());
  });

  app.get('/api/config', (_req, res) => {
    if (!consoleConfig) {
      res.json({ configured: false });
      return;
    }
    res.json({
      configured: true,
      repoPath: consoleConfig.repoPath,
      testbox: consoleConfig.testbox,
      reportBase: consoleConfig.reportBase,
      // An identity, not a secret — the client uses it purely to power the
      // builds board's "only mine" filter (see BuildsBoard.tsx).
      jenkinsUser,
      // A URL, not a secret — powers the run console's "selenoid ↗" link
      // (see RunConsole.tsx). Omitted (undefined) when unconfigured.
      selenoidUrl: consoleConfig.selenoidUrl,
    });
  });

  app.get('/api/browse', async (req, res) => {
    const p = typeof req.query.path === 'string' ? req.query.path : undefined;
    try {
      res.json(await listDirectories(p));
    } catch (err) {
      res.status(400).json({ error: `cannot read directory: ${(err as Error).message}` });
    }
  });

  app.post('/api/runs', async (req, res) => {
    const parsed = normalizeRunBody(req.body, allowlist);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    // Only one triage run active at a time — the driver owns the target
    // repo's working tree, so a second concurrent run would race it.
    if (runStore.listActive().length > 0) {
      res.status(409).json({ error: 'a triage run is already active' });
      return;
    }
    // Continue requires an existing project dir; New doesn't check here, but a
    // non-existent 'new' project path is not created by the console — the run
    // fails at the SDK cwd; (persistence's RUNS_DIR mkdir is unrelated).
    // Demo runs are exempt — the demo stream never touches the filesystem, and the
    // demo project path is synthetic, so a real-directory check would wrongly reject
    // "continue this run" on a demo run.
    if (parsed.value.projectMode === 'continue' && !parsed.value.demo) {
      try {
        const stat = await fsp.stat(parsed.value.projectPath);
        if (!stat.isDirectory()) throw new Error('not a directory');
      } catch {
        res.status(400).json({ error: `project path does not exist: ${parsed.value.projectPath}` });
        return;
      }
    }
    const run = runStore.create(parsed.value);
    const runId = run.snapshot.config!.runId;
    const stop = startDriver(run, parsed.value.demo === true ? makeDemoQueryFn(run) : undefined);
    drivers.set(runId, stop);

    // The drivers map is otherwise only pruned by the explicit /stop route —
    // a run that completes or fails on its own would sit there forever.
    // Watch for the run's one-and-only terminal status event and drop the
    // stop handle shortly after, giving any open WS a grace period to
    // deliver the final snapshot before /stop starts 404ing for this run.
    const onEvent = (ev: ServerEvent) => {
      if (ev.type === 'status' && TERMINAL_RUN_STATUSES.has(ev.status)) {
        run.off('event', onEvent);
        // Persist the final snapshot so this run survives a server restart and
        // shows up in run history. Fire-and-forget — a write failure (e.g.
        // unwritable home dir) shouldn't affect the live run.
        void saveRun(RUNS_DIR, run.snapshot);
        notifyTerminal('hektor — run finished', `${ev.status}: ${run.snapshot.clusters.filter(c => c.state === 'green').length} green / ${run.snapshot.clusters.filter(c => c.state === 'app-bug').length} app-bug`);
        setTimeout(() => {
          drivers.delete(runId);
        }, 30_000);
      }
    };
    run.on('event', onEvent);

    res.json({ runId });
  });

  app.post('/api/runs/:runId/stop', (req, res) => {
    const id = req.params.runId;
    const stop = drivers.get(id);
    if (!stop) {
      res.status(404).json({ error: 'unknown run' });
      return;
    }
    stop();
    drivers.delete(id);
    res.json({ ok: true });
  });

  // Suspend a live run into a resumable `paused` state. Only a `running` run can
  // pause (an awaiting-input run must be answered or stopped first). The handle
  // stays in `drivers` so /resume or /stop can still act on it. (finding F6)
  app.post('/api/runs/:runId/pause', (req, res) => {
    const id = req.params.runId;
    const handle = drivers.get(id);
    const run = runStore.get(id);
    if (!handle || !run) {
      res.status(404).json({ error: 'unknown run' });
      return;
    }
    if (run.snapshot.status !== 'running') {
      res.status(409).json({ error: `cannot pause a run in status "${run.snapshot.status}"` });
      return;
    }
    handle.pause();
    res.json({ ok: true });
  });

  // Resume a paused run — re-enter the SAME session from its recorded state via a
  // fresh driver, replacing the handle. (finding F6)
  app.post('/api/runs/:runId/resume', (req, res) => {
    const id = req.params.runId;
    const run = runStore.get(id);
    if (!run) {
      res.status(404).json({ error: 'unknown run' });
      return;
    }
    if (run.snapshot.status !== 'paused') {
      res.status(409).json({ error: `cannot resume a run in status "${run.snapshot.status}"` });
      return;
    }
    drivers.set(id, startDriver(run, undefined, { resume: true }));
    res.json({ ok: true });
  });

  // Resolves an in-flight AskUserQuestion pause (see makeCanUseTool in
  // driver.ts): the operator's chosen answer(s) are handed to the waiting
  // `canUseTool` promise via the `pendingAnswers` registry. 409 when there is
  // no pending question matching runId+questionId (already answered, stale
  // questionId, or the run never asked). `answers` is operator-authored option
  // labels, never logged raw here.
  app.post('/api/runs/:runId/answer', (req, res) => {
    const { questionId, answers } = (req.body ?? {}) as { questionId?: string; answers?: Record<string, unknown> };
    if (typeof questionId !== 'string' || answers == null || typeof answers !== 'object') {
      res.status(400).json({ error: 'questionId and answers are required' });
      return;
    }
    const ok = pendingAnswers.resolve(req.params.runId, questionId, answers);
    if (!ok) {
      res.status(409).json({ error: 'no matching pending question' });
      return;
    }
    res.json({ ok: true });
  });

  // Active (non-terminal) runs — lets the client reconnect to a live run after a
  // reload / back-button / HMR instead of dropping to the start screen.
  app.get('/api/runs', (_req, res) => {
    res.json(runStore.listActive());
  });

  app.get('/api/runs/:runId', (req, res) => {
    const run = runStore.get(req.params.runId);
    if (!run) {
      res.status(404).json({ error: 'unknown run' });
      return;
    }
    res.json(run.snapshot);
  });

  // Resolve a run's project root from the LIVE run first, else the persisted
  // history snapshot — so the Files-tab viewer works both during a run and
  // shortly after it finishes (once the driver map has dropped the live Run).
  // Returns null when neither source knows the run. `loadRun` already guards
  // `isSafeRunId` structurally, and the callers below guard it at the route
  // layer too.
  async function projectPathForRun(runId: string): Promise<string | null> {
    const run = runStore.get(runId);
    if (run?.snapshot.config) return run.snapshot.config.projectPath;
    const snap = await loadRun(RUNS_DIR, runId);
    return snap?.config?.projectPath ?? null;
  }

  // Serve one project file's TEXT content for the Files-tab viewer. Path-traversal
  // sensitive, guarded: (1) the runId must be a bare safe token; (2) the resolved
  // file must stay inside the run's project root. Caps the payload and refuses
  // binary so the client never has to render a blob. (F5)
  const FILE_VIEW_CAP = 512 * 1024; // 512 KB
  app.get('/api/runs/:runId/file', async (req, res) => {
    if (!isSafeRunId(req.params.runId)) {
      res.status(400).json({ error: 'invalid run id' });
      return;
    }
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const projectPath = await projectPathForRun(req.params.runId);
    if (!projectPath || !rel) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // Sandbox: the resolved file must live inside the run's project root.
    const file = resolveInsideRoot(projectPath, rel);
    if (!file) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const buf = await fsp.readFile(file);
      const slice = buf.subarray(0, FILE_VIEW_CAP);
      // Binary sniff: a NUL byte in the served slice ⇒ don't try to render text.
      if (slice.includes(0)) {
        res.json({ path: rel, binary: true, bytes: stat.size });
        return;
      }
      res.json({
        path: rel,
        content: slice.toString('utf8'),
        bytes: stat.size,
        truncated: stat.size > slice.length,
      });
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  // Working-tree diff for the Files-tab diff viewer: what's changed on disk
  // vs HEAD, so an operator can review before committing. Mirrors the /file
  // route's guards (isSafeRunId + projectPathForRun) — same sandboxing
  // rationale, read-only (getWorktree never mutates the repo).
  app.get('/api/runs/:runId/worktree', async (req, res) => {
    if (!isSafeRunId(req.params.runId)) {
      res.status(400).json({ error: 'invalid run id' });
      return;
    }
    const projectPath = await projectPathForRun(req.params.runId);
    if (!projectPath) {
      res.status(404).json({ error: 'unknown run' });
      return;
    }
    try {
      res.json(await getWorktree(projectPath));
    } catch {
      res.status(500).json({ error: 'failed to read working tree' });
    }
  });

  // Flat-file run history: past runs persisted to RUNS_DIR on terminal status
  // (see the onEvent subscription in POST /api/runs above), so they survive a
  // server restart and can be reopened read-only from the start screen.
  app.get('/api/history', async (_req, res) => {
    res.json(await listRuns(RUNS_DIR));
  });

  app.get('/api/history/:runId', async (req, res) => {
    // Sandbox: reject anything but a bare token before it reaches the
    // filesystem — real run ids are randomUUID() values. Blocks path
    // traversal (e.g. `..%2F..%2F..%2Fsomething`) at the route layer;
    // loadRun's resolve-inside-dir check backs this up structurally.
    if (!isSafeRunId(req.params.runId)) {
      res.status(400).json({ error: 'invalid run id' });
      return;
    }
    const snapshot = await loadRun(RUNS_DIR, req.params.runId);
    if (!snapshot) {
      res.status(404).json({ error: 'unknown run' });
      return;
    }
    res.json(snapshot);
  });

  // Serve built client when present (production mode).
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
      if (err) next();
    });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    // DNS-rebinding defense: mirror the /api Host check on the sibling /ws
    // channel — without this, a rebound-DNS Host header could open the
    // upgrade and exfiltrate live run telemetry/logs/findings over the WS.
    if (!isAllowedHost(request.headers.host, PORT)) {
      socket.destroy();
      return;
    }
    const u = new URL(request.url ?? '/', 'http://localhost');

    if (u.pathname === '/ws-board') {
      // Board presence channel: no runId — a connection itself is the "someone
      // is watching" signal that gates BuildsPoller's polling (see
      // setClientCount) plus the transport for its `{type:'builds'}` pushes.
      wss.handleUpgrade(request, socket, head, (ws) => {
        boardClients.add(ws);
        poller?.setClientCount(boardClients.size);
        ws.on('close', () => {
          boardClients.delete(ws);
          poller?.setClientCount(boardClients.size);
        });
      });
      return;
    }

    if (u.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const runId = u.searchParams.get('runId');
    if (!runId) {
      socket.destroy();
      return;
    }
    const run = runStore.get(runId);
    if (!run) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Push snapshot first so the client renders the up-to-date state.
      const initial: ServerEvent = { type: 'snapshot', snapshot: run.snapshot };
      ws.send(JSON.stringify(initial));
      const listener = (ev: ServerEvent) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
      };
      run.on('event', listener);
      ws.on('close', () => run.off('event', listener));
    });
  });

  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log(`[hektor-console] listening on http://localhost:${PORT}`);
  });
}

void main();
