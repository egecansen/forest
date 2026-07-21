import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  FileChange,
  Finding,
  LogEntry,
  PendingQuestion,
  PhaseId,
  PhaseState,
  PhaseStatus,
  ReviewerVerdict,
  RunConfig,
  RunSnapshot,
  ServerEvent,
  Telemetry,
  TestArtifact,
} from './types.js';
import { PHASE_ORDER } from './types.js';
import type { FileOp } from './types.js';
import { pendingAnswers } from './pending-answers.js';

const initialPhases = (): PhaseState[] =>
  PHASE_ORDER.map((id) => ({ id, status: 'queued' as PhaseStatus }));

const initialTelemetry = (): Telemetry => ({
  startedAt: null,
  elapsedMs: 0,
  tokens: 0,
  thinking: false,
});

export class Run extends EventEmitter {
  readonly snapshot: RunSnapshot;
  private stopped = false;
  private questionSeq = 0;
  // Cost accounting across context-boundary continuations. The SDK's
  // total_cost_usd is per-session cumulative and restarts each resumed session;
  // `costBase` banks finished sessions' costs, `sessionCostUsd` tracks the live
  // one, and the displayed cost is their sum. (finding F9)
  private costBase = 0;
  private sessionCostUsd = 0;
  // Active-time accounting across context-boundary continuations, mirroring the
  // cost banking above. `elapsedBase` banks finished sessions' active durations;
  // `sessionStartedAt` is the current session's start. Total elapsed is their
  // sum — so the idle gap between a session ending and the next resuming is
  // excluded (finding F12), and prior/current can be shown separately.
  private elapsedBase = 0;
  private sessionStartedAt: number | null = null;
  // Open active-work span for per-phase duration (#14): the phase currently
  // running and the moment THIS process saw it go active. Finalized into
  // `phase.activeMs` when the phase leaves 'active' — independent of the
  // ledger-authored startedAt/endedAt, so it survives a resumed stale ledger.
  private activeSpanPhaseId: PhaseId | null = null;
  private activeSpanStartedAt: number | null = null;
  // Tail-of-log file-op tracker for coalescing (#11): the last appended file-op
  // entry's verb/file/count and its log id, so a same-file edit burst folds into
  // one 'Refining <file> ×N' line and a read that just verifies the agent's own
  // write is dropped. Only valid while its `id` is still the last log entry.
  private lastFileOp: { verb: 'write' | 'read' | 'edit' | 'refine'; file: string; id: string; count: number } | null =
    null;

  constructor(config: RunConfig) {
    super();
    this.setMaxListeners(50);
    this.snapshot = {
      config,
      phases: initialPhases(),
      activePhase: null,
      telemetry: initialTelemetry(),
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
    };
  }

  isStopped(): boolean {
    return this.stopped;
  }

  setStatus(status: RunSnapshot['status']) {
    this.snapshot.status = status;
    if (status === 'running' && this.snapshot.telemetry.startedAt == null) {
      const now = Date.now();
      this.snapshot.telemetry.startedAt = now;
      this.sessionStartedAt = now;
      // Stream the stamp: telemetry delta events never carry startedAt, so a
      // client that adopted the run while 'preparing' otherwise keeps
      // startedAt:null forever and its Timeline clamps every phase into a
      // zero-width window at `now` (0s elapsed / 0s durations). (F15)
      this.emitEvent({ type: 'telemetry', telemetry: { startedAt: now } });
    }
    // Freeze a real elapsed on any terminal status so the persisted snapshot
    // (history / report) carries the actual duration instead of 0.
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      // A finished run isn't thinking; also recomputes elapsedMs from startedAt.
      this.setTelemetry({ thinking: false });
    }
    this.emitEvent({ type: 'status', status });
  }

  nextQuestionId(): string {
    this.questionSeq += 1;
    return `${this.snapshot.config?.runId ?? 'run'}-q${this.questionSeq}`;
  }

  /**
   * `question` is AGENT-authored (the engine writes the question/header/option
   * text via the AskUserQuestion tool call). Rebuilds the questions array with
   * each text field passed through `redact()` (currently a no-op passthrough —
   * see the class-level note above).
   */
  setPendingQuestion(question: PendingQuestion) {
    const redacted: PendingQuestion = {
      questionId: question.questionId,
      questions: question.questions.map((q) => ({
        question: this.redact(q.question)!,
        header: this.redact(q.header)!,
        multiSelect: q.multiSelect,
        options: q.options.map((o) => ({
          label: this.redact(o.label)!,
          description: this.redact(o.description),
        })),
      })),
    };
    this.snapshot.pendingQuestion = redacted;
    this.emitEvent({ type: 'question', question: redacted });
    this.setStatus('awaiting-input');
  }

  clearPendingQuestion() {
    const q = this.snapshot.pendingQuestion;
    this.snapshot.pendingQuestion = null;
    if (q) this.emitEvent({ type: 'questionResolved', questionId: q.questionId });
    if (!this.isStopped()) this.setStatus('running');
  }

  setSessionId(id: string) {
    // A genuinely new session (context-boundary continuation) banks the prior
    // session's final cost so the run total keeps climbing instead of resetting
    // when the new session's total_cost_usd restarts at ~0. (finding F9)
    if (this.snapshot.sessionId && this.snapshot.sessionId !== id) {
      this.costBase += this.sessionCostUsd;
      this.sessionCostUsd = 0;
      // Bank the just-ended session's active time and start a fresh session
      // clock — the gap until now (process idle between sessions) is dropped.
      if (this.sessionStartedAt != null) {
        this.elapsedBase += Math.max(0, Date.now() - this.sessionStartedAt);
      }
      this.sessionStartedAt = Date.now();
    }
    this.snapshot.sessionId = id;
  }

  log(entry: Omit<LogEntry, 'id' | 'ts'> & Partial<Pick<LogEntry, 'id' | 'ts'>>, fileOp?: FileOp) {
    const full: LogEntry = {
      id: entry.id ?? randomUUID(),
      ts: entry.ts ?? Date.now(),
      kind: entry.kind,
      text: this.redact(entry.text)!,
      detail: this.redact(entry.detail),
      progress: entry.progress,
    };
    // #11 coalescing — only when the tracked file-op entry is still the log tail
    // (guarded by id, so any other entry appended in between disables it).
    if (fileOp) {
      const lastIdx = this.snapshot.log.length - 1;
      const last = lastIdx >= 0 ? this.snapshot.log[lastIdx] : null;
      const tail = this.lastFileOp && last && last.id === this.lastFileOp.id ? this.lastFileOp : null;
      if (tail && tail.file === fileOp.file) {
        // A read that merely verifies the agent's own just-written/edited file
        // is round-trip noise — drop it entirely.
        if (fileOp.verb === 'read' && tail.verb !== 'read') return;
        // A consecutive same-file edit folds into the tail as 'Refining ×N'.
        if (fileOp.verb === 'edit' && (tail.verb === 'edit' || tail.verb === 'refine')) {
          const count = tail.count + 1;
          const merged: LogEntry = { ...last!, ts: Date.now(), text: this.redact(`Refining ${fileOp.file} ×${count}`)! };
          this.snapshot.log[lastIdx] = merged;
          this.lastFileOp = { verb: 'refine', file: fileOp.file, id: merged.id, count };
          this.emitEvent({ type: 'log', entry: merged });
          return;
        }
      }
    }
    this.snapshot.log.push(full);
    if (this.snapshot.log.length > 500) {
      this.snapshot.log.splice(0, this.snapshot.log.length - 500);
    }
    // Track (or clear) the tail file-op: a non-file-op entry breaks a burst.
    this.lastFileOp = fileOp ? { verb: fileOp.verb, file: fileOp.file, id: full.id, count: 1 } : null;
    this.emitEvent({ type: 'log', entry: full });
  }

  /**
   * No-op passthrough. The QA-pipeline RunSecret/redaction plumbing (raw API
   * key / OAuth token / prerequisite-credentials scrubbing) doesn't apply to
   * the triage shell and has been removed; `redact()` is kept as an identity
   * function so the many call sites below don't need to change.
   */
  private redact(s: string | undefined): string | undefined {
    return s;
  }

  /**
   * Live-progress variant: a single named bar that updates in place rather
   * than appending a new log entry every tick. Use this for chromium
   * download, etc.
   */
  setProgress(key: string, percent: number, label?: string) {
    const redactedKey = this.redact(key)!;
    const redactedLabel = this.redact(label);
    const lastIdx = this.snapshot.log.length - 1;
    const existing =
      lastIdx >= 0 && this.snapshot.log[lastIdx].kind === 'progress' && this.snapshot.log[lastIdx].text === redactedKey
        ? this.snapshot.log[lastIdx]
        : null;
    const entry: LogEntry = existing
      ? { ...existing, ts: Date.now(), progress: { percent, label: redactedLabel } }
      : { id: randomUUID(), ts: Date.now(), kind: 'progress', text: redactedKey, progress: { percent, label: redactedLabel } };
    if (existing) {
      this.snapshot.log[lastIdx] = entry;
    } else {
      this.snapshot.log.push(entry);
    }
    this.emitEvent({ type: 'log', entry });
  }

  setPhase(
    phaseId: PhaseId,
    status: PhaseStatus,
    opts: {
      stage?: string;
      progress?: number;
      reviewerVerdict?: ReviewerVerdict;
      reviewerCycles?: number;
      subStage?: string | null;
    } = {}
  ) {
    const phase = this.snapshot.phases.find((p) => p.id === phaseId);
    if (!phase) return;
    const redactedStage = this.redact(opts.stage);
    // subStage is fed from the same agent-authored ledger text as setSubStage,
    // so redact it too (guarding the string|null shape redact() doesn't accept).
    const redactedSubStage = opts.subStage == null ? opts.subStage : this.redact(opts.subStage);
    const wasActive = phase.status === 'active';
    phase.status = status;
    if (redactedStage !== undefined) phase.stage = redactedStage;
    if (opts.progress !== undefined) phase.progress = opts.progress;
    if (opts.reviewerVerdict !== undefined) phase.reviewerVerdict = opts.reviewerVerdict;
    if (opts.reviewerCycles !== undefined) phase.reviewerCycles = opts.reviewerCycles;
    if (opts.subStage !== undefined) phase.subStage = redactedSubStage;

    // Accumulate real active-work time (#14), tracked independently of the
    // ledger-mutable startedAt/endedAt so a resumed run's stale stamps can't
    // corrupt it. Opening a span for a new phase finalizes any dangling one.
    const nowTs = Date.now();
    if (status === 'active') {
      if (this.activeSpanPhaseId !== phaseId) {
        this.finalizeActiveSpan(nowTs);
        this.activeSpanPhaseId = phaseId;
        this.activeSpanStartedAt = nowTs;
      }
    } else if (this.activeSpanPhaseId === phaseId) {
      this.finalizeActiveSpan(nowTs);
    }

    let startedAt: number | undefined;
    let endedAt: number | undefined;
    if (status === 'active' && !phase.startedAt) {
      startedAt = Date.now();
      phase.startedAt = startedAt;
    }
    // Only stamp an end on a real active→done transition observed THIS run. A
    // phase that arrives already-done from a resumed ledger (never active here)
    // gets no in-run end — it didn't run this session, so the timeline shows it
    // done with no misleading duration rather than one spanning the whole run.
    if (wasActive && status !== 'active' && !phase.endedAt) {
      endedAt = Date.now();
      phase.endedAt = endedAt;
    }
    if (status === 'active') {
      this.snapshot.activePhase = phaseId;
    } else if (this.snapshot.activePhase === phaseId) {
      this.snapshot.activePhase = null;
    }
    this.emitEvent({
      type: 'phase',
      phaseId,
      status,
      stage: redactedStage,
      progress: opts.progress,
      startedAt,
      endedAt,
      // Banked active-work duration rides every phase event — it previously
      // lived only in the snapshot, so live clients never saw real durations
      // and completed phases rendered 0s/"carried". (F15)
      activeMs: phase.activeMs,
      reviewerVerdict: opts.reviewerVerdict,
      reviewerCycles: opts.reviewerCycles,
      subStage: redactedSubStage,
    });
  }

  /** Close the open active-work span, banking its duration onto the phase's
   *  `activeMs`. No-op when no span is open. (#14) */
  private finalizeActiveSpan(now: number) {
    if (this.activeSpanPhaseId != null && this.activeSpanStartedAt != null) {
      const phase = this.snapshot.phases.find((p) => p.id === this.activeSpanPhaseId);
      if (phase) phase.activeMs = (phase.activeMs ?? 0) + Math.max(0, now - this.activeSpanStartedAt);
    }
    this.activeSpanPhaseId = null;
    this.activeSpanStartedAt = null;
  }

  /**
   * Applies ledger-authored (or otherwise externally resolved) start/end
   * timestamps to a phase and emits the update live — unlike mutating
   * `snapshot.phases` directly, this reaches connected WS clients.
   */
  setPhaseTimes(phaseId: PhaseId, startedAt?: number, endedAt?: number) {
    const phase = this.snapshot.phases.find((p) => p.id === phaseId);
    if (!phase) return;
    if (startedAt != null) phase.startedAt = startedAt;
    if (endedAt != null) phase.endedAt = endedAt;
    this.emitEvent({ type: 'phase', phaseId, status: phase.status, startedAt: phase.startedAt, endedAt: phase.endedAt, activeMs: phase.activeMs });
  }

  /** Historical work time from the ledger for a phase completed in a prior
   *  session. Real observed activeMs wins — this only fills the gap. */
  setPhaseCarriedDuration(phaseId: PhaseId, durationMs: number) {
    const phase = this.snapshot.phases.find((p) => p.id === phaseId);
    if (!phase) return;
    if (phase.activeMs != null && phase.activeMs > 0) return;
    if (phase.carriedDurationMs === durationMs) return;
    phase.carriedDurationMs = durationMs;
    this.emitEvent({ type: 'phase', phaseId, status: phase.status, carriedDurationMs: durationMs });
  }

  setPipelineStatus(pipelineStatus: string | null) {
    const redacted = this.redact(pipelineStatus ?? undefined) ?? null;
    this.snapshot.pipelineStatus = redacted;
    this.emitEvent({ type: 'pipelineStatus', pipelineStatus: redacted });
  }

  addFinding(f: Omit<Finding, 'id' | 'ts'> & Partial<Pick<Finding, 'id' | 'ts'>>) {
    const finding: Finding = {
      id: f.id ?? randomUUID(),
      ts: f.ts ?? Date.now(),
      severity: f.severity,
      area: this.redact(f.area)!,
      title: this.redact(f.title)!,
      detail: this.redact(f.detail),
    };
    this.snapshot.findings.push(finding);
    this.emitEvent({ type: 'finding', finding });
  }

  addFile(f: Omit<FileChange, 'id' | 'ts'> & Partial<Pick<FileChange, 'id' | 'ts'>>) {
    const file: FileChange = {
      id: f.id ?? randomUUID(),
      ts: f.ts ?? Date.now(),
      path: this.redact(f.path)!,
      kind: f.kind,
      bytes: f.bytes,
    };
    this.snapshot.files.push(file);
    this.emitEvent({ type: 'file', file });
  }

  addTest(t: Omit<TestArtifact, 'id' | 'ts'> & Partial<Pick<TestArtifact, 'id' | 'ts'>>) {
    const test: TestArtifact = {
      id: t.id ?? randomUUID(),
      ts: t.ts ?? Date.now(),
      path: this.redact(t.path)!,
      name: this.redact(t.name)!,
      status: t.status,
    };
    this.snapshot.tests.push(test);
    this.emitEvent({ type: 'test', test });
  }

  setReport(url: string) {
    // `url` is a server-generated /api/... path, never agent-authored free
    // text — it cannot contain the secret, and redacting it here would risk
    // corrupting a legitimate URL. Intentionally not passed through redact().
    this.snapshot.reportUrl = url;
    this.emitEvent({ type: 'report', reportUrl: url });
  }

  setSubStage(subStage: string | null) {
    const redacted = this.redact(subStage ?? undefined) ?? null;
    this.snapshot.currentSubStage = redacted;
    this.emitEvent({ type: 'subStage', subStage: redacted });
  }

  setTelemetry(patch: Partial<Telemetry>) {
    const merged: Telemetry = { ...this.snapshot.telemetry, ...patch };
    // Total ACTIVE elapsed = banked prior sessions + current session, so the
    // snapshot (history / report) reflects worked time rather than wall-clock
    // that includes idle gaps between resumed sessions. (findings #9, F12)
    const sessionStart = this.sessionStartedAt ?? merged.startedAt;
    if (sessionStart != null) {
      const sessionMs = Math.max(0, Date.now() - sessionStart);
      merged.elapsedMs = this.elapsedBase + sessionMs;
    }
    merged.sessionStartedAt = this.sessionStartedAt;
    merged.priorElapsedMs = this.elapsedBase;
    // costUsd from the SDK is this session's cumulative cost; the run total is
    // banked prior sessions + this one, so a resumed session never drops the
    // displayed cost back toward $0. (finding F9)
    if (patch.costUsd != null) {
      this.sessionCostUsd = patch.costUsd;
      merged.costUsd = this.costBase + this.sessionCostUsd;
    }
    // Surface the banked prior cost alongside the total so the Timeline split
    // (previous / this session / total) reads from real SDK cost. (#14)
    merged.priorCostUsd = this.costBase;
    this.snapshot.telemetry = merged;
    this.emitEvent({
      type: 'telemetry',
      telemetry: {
        ...patch,
        ...(patch.costUsd != null ? { costUsd: merged.costUsd } : {}),
        elapsedMs: merged.elapsedMs,
        sessionStartedAt: merged.sessionStartedAt,
        priorElapsedMs: merged.priorElapsedMs,
        priorCostUsd: merged.priorCostUsd,
      },
    });
  }

  bumpTokens(by: number) {
    this.setTelemetry({ tokens: this.snapshot.telemetry.tokens + by });
  }

  /** Raise the token meter to `value` if higher — a monotonic high-water mark
   *  so per-turn, cache-dependent usage never makes the meter drop. (finding #10) */
  raiseTokens(value: number) {
    if (value > this.snapshot.telemetry.tokens) this.setTelemetry({ tokens: value });
  }

  /** Set current context-window occupancy (last-wins, NOT cumulative): the live
   *  fill of the context, which naturally rises and falls turn to turn. (#14) */
  setContextTokens(value: number) {
    this.setTelemetry({ contextTokens: value });
  }

  /** Record the model's context-window size so the near-limit gauge scales to
   *  the real ceiling (200k, or 1M for a `[1m]` model). (#14) */
  setContextWindow(value: number) {
    this.setTelemetry({ contextWindow: value });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.setStatus('cancelled');
    // Defensive: a run reaching a terminal state should never leave a stale
    // pendingQuestion on the snapshot. clearPendingQuestion() only flips
    // status back to 'running' when `!isStopped()` — since `stopped` is
    // already true above, this just nulls the question + emits
    // `questionResolved`, preserving the terminal status just set.
    if (this.snapshot.pendingQuestion) this.clearPendingQuestion();
    // Unblock any in-flight AskUserQuestion await in makeCanUseTool so the
    // driver's canUseTool promise settles (deny) instead of hanging forever.
    pendingAnswers.rejectAll(this.snapshot.config?.runId ?? '');
    this.emit('stopped');
  }

  finish(success: boolean) {
    if (this.stopped) return;
    this.stopped = true;
    this.setStatus(success ? 'completed' : 'failed');
    // Defensive: see the comment in stop() — clearPendingQuestion() will not
    // flip status back to 'running' since `stopped` is already true.
    if (this.snapshot.pendingQuestion) this.clearPendingQuestion();
  }

  private emitEvent(ev: ServerEvent) {
    this.emit('event', ev);
  }

  /**
   * Hard guarantee: if anything ever calls `JSON.stringify(run)` on the whole
   * instance — a future persistence task, a stray debug log — it yields only
   * `this.snapshot`.
   */
  toJSON(): RunSnapshot {
    return this.snapshot;
  }
}

/**
 * Caps how many runs the store retains. Runs are never removed on natural
 * completion (only the explicit /stop route touches the drivers map, and
 * nothing ever called `remove`), so a long-lived server would otherwise
 * accumulate one `Run` — with its full log/findings/files history — per
 * request forever. `Map` preserves insertion order, so the oldest entry is
 * always the first key; evicting it on overflow gives us a simple FIFO/LRU
 * cap without extra bookkeeping.
 */
const MAX_RUNS = 25;

class RunStore {
  private runs = new Map<string, Run>();

  create(config: Omit<RunConfig, 'runId'>): Run {
    const runId = randomUUID();
    const run = new Run({ ...config, runId });
    this.runs.set(runId, run);
    if (this.runs.size > MAX_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest !== undefined) this.runs.delete(oldest);
    }
    return run;
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  /**
   * Active (non-terminal) runs, newest first — lets the client reconnect to a
   * live run after a reload / back-button / HMR instead of dropping to the
   * start screen. (root fix for orphaned-run loss)
   */
  listActive(): Array<{ runId: string; status: RunSnapshot['status']; config: RunConfig }> {
    const terminal = new Set<RunSnapshot['status']>(['completed', 'failed', 'cancelled']);
    const out: Array<{ runId: string; status: RunSnapshot['status']; config: RunConfig }> = [];
    for (const run of this.runs.values()) {
      const s = run.snapshot;
      if (s.config && !terminal.has(s.status)) {
        out.push({ runId: s.config.runId, status: s.status, config: s.config });
      }
    }
    return out.reverse(); // Map preserves insertion order → newest last → reverse for newest-first
  }

  remove(runId: string) {
    this.runs.delete(runId);
  }
}

export const runStore = new RunStore();
