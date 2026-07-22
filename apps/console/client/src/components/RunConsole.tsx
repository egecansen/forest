import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunConfig, RunSnapshot } from '../types';
import { useRunStream, isTerminalStatus } from '../useRunStream';
import { findLatestRateLimitWarning, findLatestError, isRunLive, runStatusTone } from '../consoleAlerts';
import { TerminalLog } from './TerminalLog';
import { Sidebar } from './Sidebar';
import { Footer } from './Footer';
import { TabBar, type TabDef, type TabId } from './TabBar';
import { ClustersTab } from './ClustersTab';
import { TimelineTab } from './TimelineTab';
import { FilesTab } from './FilesTab';
import { ReportTab } from './ReportTab';
import { HistoryModal } from './HistoryModal';
import { QuestionModal } from './QuestionModal';
import { ThemeToggle } from './ThemeToggle';

interface Props {
  config: RunConfig;
  onStop?: () => void;
  /** Suspend a live (running) run into a resumable paused state. */
  onPause?: () => void;
  /** Resume a paused run from where it left off. */
  onResume?: () => void;
  onNew: () => void;
  /** Label for the primary header button in read-only mode (defaults to 'back'). */
  backLabel?: string;
  /** Opens a past run read-only; when provided, a "recent runs" popup trigger is shown. */
  onOpenHistory?: (runId: string) => void;
  /**
   * Renders a past, persisted run: no live WS connection is opened (a
   * `null` runId is passed to `useRunStream`), and the stop/interrupt
   * controls are hidden since there is nothing running to stop.
   */
  readOnly?: boolean;
  /** Required when `readOnly` — the persisted snapshot to render verbatim. */
  staticSnapshot?: RunSnapshot;
}

export function RunConsole({ config, onStop, onPause, onResume, onNew, backLabel, onOpenHistory, readOnly = false, staticSnapshot }: Props) {
  const { snapshot, conn } = useRunStream(readOnly ? null : config.runId, staticSnapshot ?? null);

  // Selenoid live-session link (GET /api/config's `selenoidUrl`) — a URL, not a
  // secret, so it's fetched the same best-effort way BuildsBoard/StartScreen
  // fetch their own slice of /api/config. Stays null (hiding the header link
  // entirely) when the console isn't wired up to a Selenoid grid, or the
  // fetch itself fails.
  const [selenoidUrl, setSelenoidUrl] = useState<string | null>(null);
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/config');
        if (!res.ok) return;
        const json = (await res.json()) as { selenoidUrl?: string };
        if (!ignore) setSelenoidUrl(json.selenoidUrl ?? null);
      } catch {
        // Best-effort: the console still works with the selenoid link just unavailable.
      }
    })();
    return () => { ignore = true; };
  }, []);
  const showSelenoidLink = !!selenoidUrl && isRunLive(snapshot.status, readOnly) && (snapshot.status === 'running' || snapshot.status === 'awaiting-input');

  // Files tab badge (worktree file count, not the agent-touched snapshot.files
  // count — see the tabs[] definition below): fetched independently of
  // whether the Files tab is the active one, so the badge stays live the
  // whole time. Polls every 10s while the run is live; a single fetch
  // otherwise (finished run / history view). `null` (fetch never resolved,
  // or the endpoint 404s — e.g. a history run whose repo moved) falls back
  // to snapshot.files.length in the badge formula.
  const [worktreeFileCount, setWorktreeFileCount] = useState<number | null>(null);
  useEffect(() => {
    let ignore = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/runs/${config.runId}/worktree`);
        if (!res.ok) return;
        const json = (await res.json()) as { files?: unknown[] };
        if (!ignore) setWorktreeFileCount(Array.isArray(json.files) ? json.files.length : null);
      } catch {
        // Best-effort: the badge falls back to snapshot.files.length.
      }
    };
    void load();
    if (!isRunLive(snapshot.status, readOnly)) return () => { ignore = true; };
    const id = window.setInterval(load, 10_000);
    return () => { ignore = true; window.clearInterval(id); };
  }, [config.runId, readOnly, snapshot.status]);
  const logScrollRef = useRef<HTMLDivElement>(null);
  // Whether the log is pinned to the bottom. Driven by the user's own scrolling
  // (a scroll listener), NOT recomputed from the post-render delta — a batch of
  // new entries can add >120px in one tick, which the old delta check misread as
  // "user scrolled away" and stopped following. (finding F3)
  const atBottomRef = useRef(true);
  const handleLogScroll = () => {
    const el = logScrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  const [historyOpen, setHistoryOpen] = useState(false);

  // Rate-limit / credit banner: derived from the log itself (not a separate
  // event) so it works identically live and from a persisted read-only
  // snapshot. Dismissal is keyed to the entry id, so a *newer* matching
  // warning re-opens the banner even if an older one was dismissed.
  const rateLimitEntry = useMemo(() => findLatestRateLimitWarning(snapshot.log), [snapshot.log]);
  const [dismissedRateLimitId, setDismissedRateLimitId] = useState<string | null>(null);
  const showRateLimitBanner = !!rateLimitEntry && rateLimitEntry.id !== dismissedRateLimitId;

  // Concise failure summary: on a failed run, surface the last error line at the
  // top instead of leaving the raw stack buried in the Log. (findings #3, #7)
  const failureEntry = useMemo(
    () => (snapshot.status === 'failed' ? findLatestError(snapshot.log) : null),
    [snapshot.status, snapshot.log]
  );

  const [activeTab, setActiveTabState] = useState<TabId>('log');
  // Tracks whether the user has ever manually picked a tab, so the Clusters
  // auto-switch (below) never fights a deliberate choice — once the user has
  // clicked a tab, hektor stops steering.
  const [userPickedTab, setUserPickedTab] = useState(false);
  const selectTab = (id: TabId) => {
    setUserPickedTab(true);
    setActiveTabState(id);
  };
  // Auto-switch to Clusters the first time a non-empty cluster list shows up
  // (live event or an already-populated static/history snapshot) — but only
  // once, and only if the user hasn't picked a tab of their own yet.
  const autoSwitchedToClustersRef = useRef(false);
  useEffect(() => {
    if (
      shouldAutoSwitchToClusters({
        clusterCount: snapshot.clusters.length,
        userPickedTab,
        alreadyAutoSwitched: autoSwitchedToClustersRef.current,
      })
    ) {
      autoSwitchedToClustersRef.current = true;
      setActiveTabState('clusters');
    }
  }, [snapshot.clusters.length, userPickedTab]);
  // Auto-scroll behavior for the live log — three triggers (finding F3):
  // (1) Jump to newest whenever the Log tab becomes active. The pane remounts at
  //     scrollTop 0 on tab switch, so a `near`-gated scroll would never fire and
  //     you'd land at the top of a live tail.
  useEffect(() => {
    if (activeTab !== 'log') return;
    const el = logScrollRef.current;
    if (!el) return;
    // The pane remounts on tab switch and every .log-entry replays its `logIn`
    // entrance animation, so re-pin across the next two frames as well — a
    // single synchronous set can miss if layout/scrollHeight isn't settled yet
    // on the remounted, animating content. (finding F3 hardening)
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      const e1 = logScrollRef.current;
      if (e1) e1.scrollTop = e1.scrollHeight;
      raf2 = requestAnimationFrame(() => {
        const e2 = logScrollRef.current;
        if (e2) e2.scrollTop = e2.scrollHeight;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [activeTab]);
  // (2) Stick to the bottom as entries arrive, but only if already near it — don't
  //     yank the user down while they're scrolled up reading history.
  useEffect(() => {
    if (activeTab !== 'log') return;
    const el = logScrollRef.current;
    if (!el) return;
    // Follow the tail only if the user was pinned to the bottom (tracked by the
    // scroll listener), so a batched burst of tall entries doesn't strand us
    // mid-log or yank us down while reading history. (finding F3)
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [snapshot.log, activeTab]);
  // (3) Force to newest when a decision is requested, so the reasoning that led to
  //     the question (just above the docked panel) is visible. Unconditional.
  useEffect(() => {
    if (activeTab !== 'log' || !snapshot.pendingQuestion) return;
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snapshot.pendingQuestion?.questionId ?? null, activeTab]);

  // Unseen-content indicators on inactive tabs.
  const [seen, setSeen] = useState<Record<TabId, number>>({
    log: 0,
    clusters: 0,
    timeline: 0,
    files: 0,
    report: 0,
  });
  const counts: Record<TabId, number> = {
    log: snapshot.log.length,
    clusters: snapshot.clusters.length,
    timeline: snapshot.phases.filter((p) => p.startedAt).length,
    files: snapshot.files.length,
    report: snapshot.reportUrl ? 1 : 0,
  };
  // When the user opens a tab, reset its seen counter.
  useEffect(() => {
    setSeen((prev) => ({ ...prev, [activeTab]: counts[activeTab] }));
  }, [activeTab, counts[activeTab]]);
  const unseen: Partial<Record<TabId, boolean>> = {
    log: counts.log > seen.log,
    clusters: counts.clusters > seen.clusters,
    timeline: counts.timeline > seen.timeline,
    files: counts.files > seen.files,
    report: counts.report > seen.report,
  };

  const reportReady = snapshot.phases.find((p) => p.id === 'report')?.status === 'done';
  const filesPhase = snapshot.phases.find((p) => p.id === 'fix');
  const runIsLive = isRunLive(snapshot.status, readOnly);
  // Worktree file count wins for the badge; fall back to the agent-touched
  // snapshot.files.length when the endpoint hasn't resolved (or 404s — e.g. a
  // history run whose repo moved).
  const filesBadgeCount = worktreeFileCount ?? snapshot.files.length;

  const tabs: TabDef[] = [
    { id: 'log',      label: 'Log',      icon: '›', badge: null },
    { id: 'clusters', label: 'Clusters', icon: '◫', badge: snapshot.clusters.length || null },
    { id: 'timeline', label: 'Timeline', icon: '╱', badge: null },
    { id: 'files',    label: 'Files',    icon: '⌗', badge: filesBadgeCount || null },
    { id: 'report',   label: 'Report',   icon: '◈', badge: reportReady ? 1 : null, disabled: !reportReady && snapshot.status !== 'running' && snapshot.status !== 'completed' && snapshot.status !== 'idle' },
  ];

  const outputs = useMemo(
    () => ({
      files: snapshot.files.length,
      tests: snapshot.tests.length,
    }),
    [snapshot.files.length, snapshot.tests.length]
  );

  const projectName = config.projectPath.split('/').filter(Boolean).pop() ?? 'project';
  const runTitle = `${projectName} · ${config.mode} run`;
  const path = `~/${shortPath(config.projectPath)} · zsh`;

  return (
    <div className="console">
      <div className="terminal">
        <div className="term-header">
          <div className="term-mark" aria-label="hektor">
            <span className="term-mark-name">hektor</span>
            <span className="term-chip">sahibinden</span>
          </div>
          <div className={`term-title status-${runStatusTone(snapshot.status)}`}>
            <span className="term-title-name">{runTitle}</span>
            <span className="dot" />
            <span className="mode">{runStatusLabel(snapshot.status)}</span>
            {readOnly && (
              <span className="pipeline-status archived-badge" title="past run, read-only — viewed from history">
                archived · read-only
              </span>
            )}
            {/* Ledger's self-reported status. Hidden when it just echoes a live
                run ("in-progress" during RUNNING); shown when it diverges and
                carries signal the run tone doesn't — e.g. "blocked" (F10),
                "complete". Cost lives in RUN TELEMETRY, not here. */}
            {!readOnly && snapshot.pipelineStatus && snapshot.pipelineStatus !== 'in-progress' && (
              <span className="pipeline-status" title="ledger pipeline status">
                {snapshot.pipelineStatus}
              </span>
            )}
          </div>
          <div className="term-controls">
            <span className="term-path">{path}</span>
            <ThemeToggle />
            {showSelenoidLink && (
              <a
                className="icon-btn selenoid-link"
                href={selenoidUrl!}
                target="_blank"
                rel="noreferrer"
              >
                selenoid ↗
              </a>
            )}
            {onOpenHistory && (
              <button type="button" className="icon-btn" onClick={() => setHistoryOpen(true)}>
                recent runs
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                // Starting a new run abandons the current one — confirm while
                // it's still live so "new run" can't silently kill a run.
                if (!readOnly && !isTerminalStatus(snapshot.status)) {
                  if (!confirm('Start a new run? This will stop the current run.')) return;
                }
                onNew();
              }}
            >
              {readOnly ? (backLabel ?? 'back') : 'new run'}
            </button>
            {!readOnly && onPause && snapshot.status === 'running' && (
              <button type="button" className="icon-btn pause" onClick={() => onPause()}>
                pause
              </button>
            )}
            {!readOnly && onResume && snapshot.status === 'paused' && (
              <button type="button" className="icon-btn resume" onClick={() => onResume()}>
                resume
              </button>
            )}
            {!readOnly && !isTerminalStatus(snapshot.status) && (
              <button
                type="button"
                className="icon-btn stop"
                onClick={() => {
                  if (confirm('Stop the current run?')) onStop?.();
                }}
              >
                stop
              </button>
            )}
          </div>
        </div>

        {failureEntry && (
          <div className="warn-banner failure-banner" role="alert">
            <span>
              ✕ Run failed — {failureEntry.text}. See the Log tab for details.
            </span>
          </div>
        )}

        {showRateLimitBanner && rateLimitEntry && (
          <div className="warn-banner rate-limit-banner" role="alert">
            <span>
              ⚠ Rate limit reached — a request was rejected; the run may stall.
            </span>
            <button
              type="button"
              className="warn-dismiss"
              onClick={() => setDismissedRateLimitId(rateLimitEntry.id)}
              aria-label="dismiss"
            >
              dismiss
            </button>
          </div>
        )}

        <TabBar
          tabs={tabs}
          active={activeTab}
          unseen={unseen}
          onSelect={selectTab}
        />

        <div className="term-body">
          <div className="term-main">
          <div className="term-pane">
            {activeTab === 'log' && (
              <div className="term-log" ref={logScrollRef} onScroll={handleLogScroll}>
                <TerminalLog entries={snapshot.log} />
              </div>
            )}
            {activeTab === 'clusters' && (
              <div className="term-pane-inner">
                <ClustersTab clusters={snapshot.clusters} />
              </div>
            )}
            {activeTab === 'timeline' && (
              <div className="term-pane-inner">
                <TimelineTab phases={snapshot.phases} telemetry={snapshot.telemetry} />
              </div>
            )}
            {activeTab === 'files' && (
              <div className="term-pane-inner">
                <FilesTab files={snapshot.files} tests={snapshot.tests} phase={filesPhase} runId={config.runId} live={runIsLive} />
              </div>
            )}
            {activeTab === 'report' && (
              <div className="term-pane-inner">
                <ReportTab
                  reportUrl={snapshot.reportUrl}
                  reportReady={reportReady}
                  reportIsReal={(snapshot.reportUrl ?? '').startsWith('/api/')}
                  clusters={snapshot.clusters}
                  reportText={snapshot.reportText}
                  telemetry={snapshot.telemetry}
                />
              </div>
            )}
          </div>
          {!readOnly && snapshot.pendingQuestion && (
            <QuestionModal
              question={snapshot.pendingQuestion}
              onSubmit={async (questionId, answers) => {
                const res = await fetch(`/api/runs/${config.runId}/answer`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ questionId, answers }),
                });
                if (!res.ok) throw new Error(`answer failed (${res.status})`);
              }}
            />
          )}
          </div>
          <Sidebar
            phases={snapshot.phases}
            activePhase={snapshot.activePhase}
            telemetry={snapshot.telemetry}
            outputs={outputs}
            status={snapshot.status}
          />
        </div>

        <Footer status={snapshot.status} conn={conn} readOnly={readOnly} />
      </div>
      {historyOpen && onOpenHistory && (
        <HistoryModal onOpen={onOpenHistory} onClose={() => setHistoryOpen(false)} />
      )}
    </div>
  );
}

/** Decides whether the Clusters tab should auto-activate: only on the first
 *  time a non-empty cluster list is seen, and only if the user hasn't picked
 *  a tab of their own — so the auto-switch never fights a manual choice, and
 *  never re-fires on every subsequent cluster update. Pure — testable
 *  without mounting the live WS stream. */
export function shouldAutoSwitchToClusters(opts: {
  clusterCount: number;
  userPickedTab: boolean;
  alreadyAutoSwitched: boolean;
}): boolean {
  return !opts.userPickedTab && !opts.alreadyAutoSwitched && opts.clusterCount > 0;
}

function shortPath(p: string): string {
  const parts = p.replace(/\/$/, '').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function runStatusLabel(status: string): string {
  switch (status) {
    case 'preparing':
      return 'preparing…';
    case 'running':
      return 'running';
    case 'awaiting-input':
      return 'waiting on you';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'stopped';
    case 'paused':
      return 'paused';
    default:
      return 'idle';
  }
}
