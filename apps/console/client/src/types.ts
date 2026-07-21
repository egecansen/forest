export type PhaseStatus = 'queued' | 'active' | 'done' | 'failed' | 'skipped' | 'blocked';

export type PhaseId =
  | 'scaffold'
  | 'groundwork'
  | 'happy-path'
  | 'journey-mapping'
  | 'coverage-expansion'
  | 'bug-discovery'
  | 'secrets-sweep'
  | 'report';

export interface PhaseDescriptor {
  id: PhaseId;
  number: number;
  label: string;
  short: string;
  description: string;
}

export type ReviewerVerdict = 'pending' | 'approved' | 'rejected' | 'escalated-to-user';

export interface PhaseState {
  id: PhaseId;
  status: PhaseStatus;
  progress?: number;
  stage?: string;
  startedAt?: number;
  endedAt?: number;
  /** Ledger-derived span for phases completed in prior sessions (offset-immune). */
  carriedDurationMs?: number;
  /** Accumulated ACTIVE-work time for this phase (real work spans, ledger-immune,
   *  incl. any carried from prior sessions). The Timeline's Duration column shows
   *  this for completed phases instead of a clamp of stale ledger stamps. (#14) */
  activeMs?: number;
  reviewerVerdict?: ReviewerVerdict;
  reviewerCycles?: number;
  subStage?: string | null;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  id: string;
  ts: number;
  severity: FindingSeverity;
  area: string;
  title: string;
  detail?: string;
}

export interface QuestionSpec {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

export interface PendingQuestion {
  questionId: string;
  questions: QuestionSpec[];
}

export interface FileChange {
  id: string;
  ts: number;
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  bytes?: number;
}

export interface TestArtifact {
  id: string;
  ts: number;
  path: string;
  name: string;
  status: 'wrote' | 'updated';
}

export interface Telemetry {
  startedAt: number | null;
  /** Total ACTIVE time = banked prior sessions + current session. */
  elapsedMs: number;
  /** Start of the current session's active clock (for live ticking). */
  sessionStartedAt?: number | null;
  /** Banked active time from prior sessions of this run (0 on a single session). */
  priorElapsedMs?: number;
  /** Tokens carried from prior runs of the same project (project-total display). */
  priorTokens?: number;
  tokens: number;
  /** Current context-window OCCUPANCY (last-wins): how full the live context is
   *  right now — drives the near-limit gauge, distinct from `tokens`' lifetime
   *  throughput sum. (#14) */
  contextTokens?: number;
  /** The model's context-window size (200k, or 1M for a `[1m]` variant). (#14) */
  contextWindow?: number;
  thinking: boolean;
  costUsd?: number;
  /** Banked API-rate cost from prior sessions of this run, for the Timeline's
   *  previous / this-session / total split from real SDK cost. (#14) */
  priorCostUsd?: number;
}

export type LogKind =
  | 'bash'
  | 'skill'
  | 'info'
  | 'active'
  | 'progress'
  | 'tree'
  | 'warn'
  | 'error'
  | 'success';

export interface LogEntry {
  id: string;
  ts: number;
  kind: LogKind;
  text: string;
  detail?: string;
  progress?: { percent: number; label?: string };
}

export interface Journey {
  id: string;
  title: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'unranked';
  coverage: 'covered' | 'partial' | 'uncovered';
}

export interface RunConfig {
  projectPath: string;
  targetUrl: string;
  mode: 'onboarding' | 'coverage-expansion' | 'bug-discovery' | 'repair' | 'companion';
  runMode: 'standard' | 'depth';
  permissionPolicy: 'autonomous' | 'restricted';
  projectMode?: 'new' | 'continue';
  runId: string;
  demo?: boolean;
  /**
   * Opt-in per-run capture flag. When true, the agent is instructed to record
   * Playwright video/trace + frequent step screenshots, and the recordings
   * discovery/serving routes surface them.
   */
  record?: boolean;
  /**
   * Non-secret display flag: which kind of credential override this run was
   * started with, if any. The raw API key / OAuth token itself is NEVER
   * part of RunConfig/RunSnapshot.
   */
  usesCustomCredential?: 'apiKey' | 'oauthToken' | null;
  /**
   * Non-secret display flag: whether the caller uploaded a prerequisite
   * login-credentials file for this run. The raw credential CONTENT is NEVER
   * part of RunConfig/RunSnapshot — it lives only off-snapshot on the server.
   */
  hasPrereqCreds?: boolean;
}

/**
 * A single captured browser-session artifact discovered under a run's project
 * (see `findRecordings` on the server). `relPath` is project-root-relative and
 * is what the serving route (`GET /api/runs/:runId/recording?path=`) resolves
 * + sandboxes back to an absolute file.
 */
export interface Recording {
  id: string;
  kind: 'video' | 'trace' | 'screenshot';
  relPath: string;
  label: string;
  bytes: number;
}

export interface RunSnapshot {
  config: RunConfig | null;
  phases: PhaseState[];
  activePhase: PhaseId | null;
  telemetry: Telemetry;
  log: LogEntry[];
  status: 'idle' | 'preparing' | 'running' | 'awaiting-input' | 'paused' | 'completed' | 'failed' | 'cancelled';
  findings: Finding[];
  files: FileChange[];
  tests: TestArtifact[];
  reportUrl: string | null;
  journeys: Journey[];
  currentSubStage: string | null;
  pipelineStatus: string | null;
  pendingQuestion: PendingQuestion | null;
  sessionId?: string;
  /** True while the driver is recovering from an approver-registration block —
   *  drives the "recovering" chip in the run header. (#10) */
  nudging?: boolean;
}

export type ServerEvent =
  | { type: 'snapshot'; snapshot: RunSnapshot }
  | { type: 'log'; entry: LogEntry }
  | {
      type: 'phase';
      phaseId: PhaseId;
      status: PhaseStatus;
      stage?: string;
      progress?: number;
      startedAt?: number;
      endedAt?: number;
      /** Banked active-work duration (#14) — streamed so live clients render
       *  real phase durations instead of clamped 0s. (F15) */
      activeMs?: number;
      /** Prior-session work time from the ledger (offset-immune span). */
      carriedDurationMs?: number;
      reviewerVerdict?: ReviewerVerdict;
      reviewerCycles?: number;
      subStage?: string | null;
    }
  | { type: 'journey'; journey: Journey }
  | { type: 'subStage'; subStage: string | null }
  | { type: 'telemetry'; telemetry: Partial<Telemetry> }
  | { type: 'status'; status: RunSnapshot['status'] }
  | { type: 'finding'; finding: Finding }
  | { type: 'file'; file: FileChange }
  | { type: 'test'; test: TestArtifact }
  | { type: 'report'; reportUrl: string }
  | { type: 'pipelineStatus'; pipelineStatus: string | null }
  | { type: 'question'; question: PendingQuestion }
  | { type: 'questionResolved'; questionId: string }
  | { type: 'nudging'; nudging: boolean };

/**
 * Lightweight, list-friendly projection of a persisted `RunSnapshot` — what
 * `GET /api/history` returns for the run-history list. Never carries the
 * full log/findings/files arrays (fetch `GET /api/history/:runId` for that).
 */
export interface RunSummary {
  runId: string;
  projectPath: string;
  targetUrl: string;
  mode: RunConfig['mode'];
  status: RunSnapshot['status'];
  startedAt: number | null;
  findings: number;
  tests: number;
}

export interface ProjectState {
  installed: boolean;
  hasState: boolean;
  currentPhase: number | null;
  pipelineStatus: string | null;
  journeys: number;
  tests: number;
  findings: number;
  targetUrl: string | null;
  runMode: 'standard' | 'depth' | null;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  error: string | null;
}
