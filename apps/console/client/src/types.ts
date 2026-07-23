export type PhaseStatus = 'queued' | 'active' | 'done' | 'failed' | 'skipped' | 'blocked';

export type PhaseId = 'ingest' | 'cluster' | 'pick' | 'fix' | 'verify' | 'report';

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

export type ClusterBucket = 'easy-fix' | 'selector' | 'vrt' | 'app-change' | 'infra' | 'likely-bug';
export type ClusterState =
  | 'proposed' | 'picked' | 'skipped' | 'fixing' | 'verifying' | 'green' | 'app-bug' | 'error';

export interface Cluster {
  id: string;            // agent-chosen slug, e.g. "onetrust-overlay"
  title: string;         // one-line cause, human phrasing
  bucket: ClusterBucket;
  tests: string[];       // FQCNs or test names
  state: ClusterState;
  passes?: number;       // green-proof progress: passes so far
  runs?: number;         // green-proof target N
  note?: string;         // short status detail ("fixed selector, verifying")
  /** Longer evidence/cause explanation shown in the Clusters tab's expanded
   *  row: the failing signature, why it broke, and the intended fix approach. */
  detail?: string;
  /** Per-test outcomes that diverge from the cluster's own life-cycle
   *  `state` — sourced from a v2 ledger's `cluster.tests[].status` entries
   *  (only present when a test's own red/green/skipped outcome is worth
   *  calling out separately, e.g. one test in an "applied" cluster already
   *  proved green while its sibling hasn't rerun yet). Rendered as a small
   *  status-tinted chip per entry in the Clusters tab's expanded row. */
  divergent?: { fqcn: string; status: 'red' | 'green' | 'skipped' }[];
  /** Per-test VRT (visual regression) review links — sourced from a v2
   *  ledger's `cluster.tests[].vrt` (a baseline-vs-regression compare URL),
   *  present only on `vrt`-bucket clusters whose tests actually carry one.
   *  Rendered as a link-card per entry in the Clusters tab's expanded row's
   *  "VRT REVIEW" section. */
  vrt?: { fqcn: string; url: string }[];
}

export interface RunConfig {
  projectPath: string;                 // web-test repo (agent cwd)
  targetUrl: string;                   // the s-report URL (kept name: shell renders it)
  testbox: string;                     // e.g. "tb161"
  mode: 'triage';
  permissionPolicy: 'autonomous' | 'confirm-applies';
  projectMode?: 'new' | 'continue';
  runId: string;
  demo?: boolean;
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
  /** The agent's final result message (SDK `result` field on a successful
   *  run) — the triage report's actual content, rendered mono/preformatted
   *  by the Report tab. Unset until the run finishes successfully. */
  reportText?: string;
  clusters: Cluster[];
  currentSubStage: string | null;
  pipelineStatus: string | null;
  pendingQuestion: PendingQuestion | null;
  sessionId?: string;
  /** True while the driver is recovering from an approver-registration block —
   *  drives the "recovering" chip in the run header. (#10) */
  nudging?: boolean;
  /** Selenoid live-session URL detected live from the running triage's own
   *  tool-result output — the header "watch live" link prefers this over the
   *  static config `selenoidUrl` fallback (see RunConsole.tsx). */
  selenoidUrl?: string;
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
  | { type: 'clusters'; clusters: Cluster[] }
  | { type: 'cluster'; cluster: Cluster }
  | { type: 'subStage'; subStage: string | null }
  | { type: 'telemetry'; telemetry: Partial<Telemetry> }
  | { type: 'status'; status: RunSnapshot['status'] }
  | { type: 'finding'; finding: Finding }
  | { type: 'file'; file: FileChange }
  | { type: 'test'; test: TestArtifact }
  | { type: 'report'; reportUrl: string }
  | { type: 'reportText'; reportText: string }
  | { type: 'pipelineStatus'; pipelineStatus: string | null }
  | { type: 'question'; question: PendingQuestion }
  | { type: 'questionResolved'; questionId: string }
  | { type: 'nudging'; nudging: boolean }
  | { type: 'selenoidUrl'; url: string };

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

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

/** One changed path from `git diff --name-status` (GET /api/runs/:runId/worktree). */
export interface WorktreeFile {
  status: string; // git's single-letter status code, e.g. "M", "A", "D", "R100"
  path: string;
}

/** Working-tree diff vs HEAD for a run's project repo — the Files tab's
 *  primary content (see FilesTab.tsx). */
export interface WorktreeResult {
  files: WorktreeFile[];
  diff: string;
  truncated: boolean;
}
