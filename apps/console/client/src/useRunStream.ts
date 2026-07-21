import { useEffect, useRef, useState } from 'react';
import type {
  LogEntry,
  PhaseId,
  PhaseState,
  RunSnapshot,
  ServerEvent,
  Telemetry,
} from './types';
import { PHASES } from './phases';

const EMPTY_TELEMETRY: Telemetry = {
  startedAt: null,
  elapsedMs: 0,
  tokens: 0,
  thinking: false,
};

const initialPhases = (): PhaseState[] =>
  PHASES.map((p) => ({ id: p.id, status: 'queued' }));

const initialSnapshot = (): RunSnapshot => ({
  config: null,
  phases: initialPhases(),
  activePhase: null,
  telemetry: EMPTY_TELEMETRY,
  log: [],
  status: 'idle',
  findings: [],
  files: [],
  tests: [],
  reportUrl: null,
  clusters: [],
  currentSubStage: null,
  pipelineStatus: null,
  pendingQuestion: null,
});

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

const TERMINAL_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/** A run in a terminal state will never emit more events — don't reconnect. */
export function isTerminalStatus(status: RunSnapshot['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;

/** attempt is 0-indexed: 0->1s, 1->2s, 2->4s, 3+ -> capped at 8s. */
export function nextBackoffDelay(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * `staticSnapshot` seeds the initial state and is used verbatim — pass a
 * `null` `runId` alongside it (as `RunConsole` does for a past-run,
 * read-only view) to render a persisted snapshot without ever opening a
 * live WS connection.
 */
export function useRunStream(runId: string | null, staticSnapshot?: RunSnapshot | null) {
  const [snapshot, setSnapshot] = useState<RunSnapshot>(() => staticSnapshot ?? initialSnapshot());
  const [conn, setConn] = useState<ConnectionState>('closed');
  const wsRef = useRef<WebSocket | null>(null);
  // Mirrors snapshot.status, updated synchronously as messages are processed
  // (not via a render-driven effect) so onclose always sees the freshest
  // status even if it fires in the same tick as the terminal status message.
  const statusRef = useRef<RunSnapshot['status']>(initialSnapshot().status);

  useEffect(() => {
    if (!runId) {
      setConn('closed');
      return;
    }

    let stopped = false;
    let attempt = 0;
    let reconnectTimer: number | null = null;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const connect = () => {
      if (stopped) return;
      setConn('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${window.location.host}/ws?runId=${encodeURIComponent(runId)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0; // reset backoff on a successful (re)connect
        setConn('open');
      };

      ws.onclose = () => {
        setConn('closed');
        if (stopped) return;
        // Server closed intentionally after a terminal status, or we're
        // mid-unmount/runId-change: don't chase a socket that's done for good.
        if (isTerminalStatus(statusRef.current)) return;

        clearReconnectTimer();
        const delay = nextBackoffDelay(attempt);
        attempt += 1;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      };

      ws.onerror = () => setConn('error');

      ws.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data) as ServerEvent;
          setSnapshot((prev) => {
            const next = applyEvent(prev, ev);
            statusRef.current = next.status;
            return next;
          });
        } catch (err) {
          console.error('bad ws message', err);
        }
      };
    };

    connect();

    return () => {
      stopped = true;
      clearReconnectTimer();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [runId]);

  // Tick elapsedMs locally while running for smoother clock.
  useEffect(() => {
    if (snapshot.status !== 'running' || !snapshot.telemetry.startedAt) return;
    const id = window.setInterval(() => {
      setSnapshot((prev) => {
        if (prev.status !== 'running' || !prev.telemetry.startedAt) return prev;
        // Total active = banked prior sessions + current session's live clock,
        // ticked off sessionStartedAt so idle gaps between sessions aren't counted.
        const base = prev.telemetry.priorElapsedMs ?? 0;
        const sessStart = prev.telemetry.sessionStartedAt ?? prev.telemetry.startedAt;
        return {
          ...prev,
          telemetry: {
            ...prev.telemetry,
            elapsedMs: base + Math.max(0, Date.now() - sessStart),
          },
        };
      });
    }, 500);
    return () => window.clearInterval(id);
  }, [snapshot.status, snapshot.telemetry.startedAt]);

  return {
    snapshot,
    conn,
    send: (m: object) => wsRef.current?.send(JSON.stringify(m)),
  };
}

export function applyEvent(prev: RunSnapshot, ev: ServerEvent): RunSnapshot {
  switch (ev.type) {
    case 'snapshot':
      return ev.snapshot;
    case 'log':
      return { ...prev, log: appendLog(prev.log, ev.entry) };
    case 'phase':
      return updatePhase(prev, ev);
    case 'clusters':
      return { ...prev, clusters: ev.clusters };
    case 'cluster': {
      const idx = prev.clusters.findIndex((c) => c.id === ev.cluster.id);
      const clusters = idx >= 0
        ? prev.clusters.map((c) => (c.id === ev.cluster.id ? ev.cluster : c))
        : [...prev.clusters, ev.cluster];
      return { ...prev, clusters };
    }
    case 'subStage':
      return { ...prev, currentSubStage: ev.subStage };
    case 'telemetry':
      return { ...prev, telemetry: { ...prev.telemetry, ...ev.telemetry } };
    case 'status':
      return { ...prev, status: ev.status };
    case 'finding':
      return { ...prev, findings: [...prev.findings, ev.finding] };
    case 'file':
      return { ...prev, files: [...prev.files, ev.file] };
    case 'test':
      return { ...prev, tests: [...prev.tests, ev.test] };
    case 'report':
      return { ...prev, reportUrl: ev.reportUrl };
    case 'reportText':
      return { ...prev, reportText: ev.reportText };
    case 'pipelineStatus':
      return { ...prev, pipelineStatus: ev.pipelineStatus };
    case 'question':
      return { ...prev, pendingQuestion: ev.question };
    case 'questionResolved':
      return prev.pendingQuestion?.questionId === ev.questionId
        ? { ...prev, pendingQuestion: null }
        : prev;
    case 'nudging':
      return { ...prev, nudging: ev.nudging };
    default:
      return prev;
  }
}

const LOG_LIMIT = 500;
function appendLog(log: LogEntry[], entry: LogEntry): LogEntry[] {
  // Replace-in-place when this entry's id already exists — used by the
  // server's setProgress() to drive a single live bar.
  const idx = log.findIndex((e) => e.id === entry.id);
  let next: LogEntry[];
  if (idx >= 0) {
    next = log.slice();
    next[idx] = entry;
  } else {
    next = [...log, entry];
  }
  return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
}

function updatePhase(
  prev: RunSnapshot,
  ev: Extract<ServerEvent, { type: 'phase' }>
): RunSnapshot {
  const { phaseId, status, stage, progress, startedAt, endedAt, activeMs, carriedDurationMs, reviewerVerdict, reviewerCycles, subStage } = ev;
  const phases = prev.phases.map((p) =>
    p.id === phaseId
      ? {
          ...p,
          status,
          stage: stage ?? p.stage,
          progress: progress ?? p.progress,
          startedAt: startedAt ?? p.startedAt,
          endedAt: endedAt ?? p.endedAt,
          activeMs: activeMs ?? p.activeMs,
          carriedDurationMs: carriedDurationMs ?? p.carriedDurationMs,
          reviewerVerdict: reviewerVerdict ?? p.reviewerVerdict,
          reviewerCycles: reviewerCycles ?? p.reviewerCycles,
          subStage: subStage ?? p.subStage,
        }
      : p
  );
  let activePhase: PhaseId | null = prev.activePhase;
  if (status === 'active') {
    activePhase = phaseId;
  } else if (prev.activePhase === phaseId) {
    activePhase = null;
  }
  return { ...prev, phases, activePhase };
}
