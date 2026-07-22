import { useCallback, useEffect, useRef, useState } from 'react';
import { StartScreen } from './components/StartScreen';
import { BuildsBoard } from './components/BuildsBoard';
import { RunConsole } from './components/RunConsole';
import { HistoryRunConsole } from './components/HistoryRunConsole';
import { RunTabsBar } from './components/RunTabsBar';
import { PreviousTriages } from './components/PreviousTriages';
import { ConflictDialog } from './components/ConflictDialog';
import { InfoDrawer } from './components/InfoDrawer';
import { ProcessDrawer } from './components/ProcessDrawer';
import { ThemeToggle } from './components/ThemeToggle';
import { isTerminalStatus } from './useRunStream';
import { RunConflictError } from './run-conflict';
import { hasLiveNonTerminalTab, liveRunsSummary, nextActiveAfterClose, type OpenRunTab } from './run-tabs-logic';
import type { RunConfig, RunSnapshot, RunSummary } from './types';

/**
 * When no run tab is active, the app shows one of two "screens": the triage
 * start form (the landing view — reached on load, or via a `?triage=<url>`
 * deep link), or the builds board (a live snapshot of recent Jenkins builds
 * to triage from, reached from the form's "latest builds →" button / the
 * tab strip's `board` button).
 */
type ScreenView = 'board' | 'start';

export function App() {
  const [screenView, setScreenView] = useState<ScreenView>('start');
  const [startPrefill, setStartPrefill] = useState<{ reportUrl?: string; testbox?: string }>(() => {
    const deep = new URLSearchParams(location.search).get('triage');
    return { reportUrl: deep ?? undefined };
  });

  // Every run tab currently open (live, backed by a WS once active — or
  // history, a past persisted run reopened read-only), plus which one (if
  // any) is active. Only the ACTIVE tab's console is ever mounted — one WS
  // connection at a time — keyed by runId so switching tabs remounts fresh
  // (re-fetches its snapshot + resubscribes).
  const [openRuns, setOpenRuns] = useState<OpenRunTab[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Latest activeRunId for the freshness-poll effect below, which must not
  // reset its 10s interval on every tab switch (its effect deps stay
  // [openRuns]) yet still needs the CURRENT active id to exclude it from
  // each tick's writes — a ref sidesteps the stale-closure problem without
  // re-subscribing the interval.
  const activeRunIdRef = useRef(activeRunId);
  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);
  // Best-known status per live-kind runId: seeded from the reconnect fetch,
  // kept current for the ACTIVE tab via RunConsole's onStatusChange (its own
  // live stream), and refreshed for every OTHER live tab by polling
  // GET /api/runs every 10s. Absent (undefined/null) reads as "unknown".
  const [statusByRunId, setStatusByRunId] = useState<Record<string, RunSnapshot['status']>>({});
  const [conflictDialog, setConflictDialog] = useState<{ conflictRunId: string; retry: () => Promise<void> } | null>(null);

  const [infoOpen, setInfoOpen] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);

  const activeTab = openRuns.find((t) => t.runId === activeRunId) ?? null;
  const statusFor = useCallback((runId: string) => statusByRunId[runId] ?? null, [statusByRunId]);

  // Guard accidental navigation away from a live run — armed whenever ANY
  // open tab is live and non-terminal, not just the active one, since
  // navigating away never stops the others.
  useEffect(() => {
    if (!hasLiveNonTerminalTab(openRuns, statusFor)) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [openRuns, statusFor]);

  // On load, adopt EVERY active server run as a live tab — survives a
  // reload / back-button / HMR / lid-close that reset the in-memory view.
  // Activates the newest (the server returns active runs newest-first);
  // board/start stay reachable via the tab strip regardless.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/runs');
        if (!res.ok || cancelled) return;
        const active = (await res.json()) as Array<{ runId: string; status: RunSnapshot['status']; config: RunConfig }>;
        if (active.length === 0) return;
        setOpenRuns(active.map((r) => ({ runId: r.runId, kind: 'live' as const, config: r.config })));
        setStatusByRunId((prev) => {
          const next = { ...prev };
          for (const r of active) next[r.runId] = r.status;
          return next;
        });
        setActiveRunId(active[0].runId);
      } catch {
        /* offline / no server → stay on the start screen */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps INACTIVE live tabs' status dots roughly fresh — the active tab's
  // dot is kept current by its own stream via onStatusChange instead. A live
  // tab missing from the response has gone terminal since the last poll.
  useEffect(() => {
    if (!openRuns.some((t) => t.kind === 'live')) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/runs');
        if (!res.ok || cancelled) return;
        const active = (await res.json()) as Array<{ runId: string; status: RunSnapshot['status'] }>;
        const activeIds = new Set(active.map((r) => r.runId));
        // The ACTIVE tab's status is owned exclusively by its own WS stream
        // (RunConsole's onStatusChange) — this poll's response can be stale
        // by up to one interval, so writing it here risks briefly regressing
        // a status the active tab's live stream has already moved past
        // (e.g. completed -> running for up to 10s).
        const currentActiveRunId = activeRunIdRef.current;
        setStatusByRunId((prev) => {
          const next = { ...prev };
          for (const r of active) {
            if (r.runId === currentActiveRunId) continue;
            next[r.runId] = r.status;
          }
          for (const t of openRuns) {
            if (t.kind === 'live' && t.runId !== currentActiveRunId && !activeIds.has(t.runId)) next[t.runId] = 'completed';
          }
          return next;
        });
      } catch {
        /* best-effort */
      }
    };
    const id = window.setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [openRuns]);

  const goToStart = useCallback(() => {
    setActiveRunId(null);
    setScreenView('start');
  }, []);

  const goToBoard = useCallback(() => {
    setActiveRunId(null);
    setScreenView('board');
  }, []);

  const addLiveTabAndActivate = useCallback((config: RunConfig) => {
    setOpenRuns((prev) => (prev.some((t) => t.runId === config.runId) ? prev : [...prev, { runId: config.runId, kind: 'live', config }]));
    setActiveRunId(config.runId);
  }, []);

  const startRun = useCallback(
    async (
      projectPath: string,
      targetUrl: string,
      testbox: string,
      permissionPolicy: RunConfig['permissionPolicy'],
      projectMode: RunConfig['projectMode'],
      demo: boolean,
      override?: boolean
    ) => {
      const body: Record<string, unknown> = { projectPath, targetUrl, testbox, permissionPolicy, projectMode, demo };
      if (override) body.override = true;

      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 409) {
          const errBody = (await res.json().catch(() => null)) as { conflictRunId?: string } | null;
          if (errBody?.conflictRunId) throw new RunConflictError(errBody.conflictRunId);
        }
        throw new Error(`failed to start run: ${res.status}`);
      }
      const json = (await res.json()) as { runId: string };
      const config: RunConfig = {
        projectPath,
        targetUrl,
        testbox,
        mode: 'triage',
        permissionPolicy,
        projectMode,
        runId: json.runId,
        demo,
      };
      addLiveTabAndActivate(config);
    },
    [addLiveTabAndActivate]
  );

  const stopRun = useCallback(async () => {
    if (!activeRunId) return;
    await fetch(`/api/runs/${activeRunId}/stop`, { method: 'POST' });
  }, [activeRunId]);

  const pauseRun = useCallback(async () => {
    if (!activeRunId) return;
    await fetch(`/api/runs/${activeRunId}/pause`, { method: 'POST' });
  }, [activeRunId]);

  const resumeRun = useCallback(async () => {
    if (!activeRunId) return;
    await fetch(`/api/runs/${activeRunId}/resume`, { method: 'POST' });
  }, [activeRunId]);

  // "new run" from a LIVE console: stop it (RunConsole already confirms
  // first when it isn't terminal), then navigate to the start screen — the
  // tab itself stays open (now terminal, so it picks up a close button)
  // rather than being force-removed.
  const onNewFromLiveConsole = useCallback(async () => {
    await stopRun();
    goToStart();
  }, [stopRun, goToStart]);

  const closeTab = useCallback(
    (runId: string) => {
      const idx = openRuns.findIndex((t) => t.runId === runId);
      if (idx === -1) return;
      setOpenRuns((prev) => prev.filter((t) => t.runId !== runId));
      if (activeRunId === runId) {
        const next = nextActiveAfterClose(openRuns.map((t) => t.runId), idx);
        setActiveRunId(next);
        if (next == null) setScreenView('start');
      }
    },
    [openRuns, activeRunId]
  );

  // Opens a run (live or persisted) as a history tab — idempotent: if it's
  // already open, this just activates it. Used by both the run-console
  // "recent runs" popup and the start screen's "previous triages" list.
  const openHistoryTab = useCallback((run: RunSummary) => {
    setOpenRuns((prev) => {
      if (prev.some((t) => t.runId === run.runId)) return prev;
      const tab: OpenRunTab = {
        runId: run.runId,
        kind: 'history',
        config: { runId: run.runId, projectPath: run.projectPath, targetUrl: run.targetUrl, mode: run.mode },
      };
      return [...prev, tab];
    });
    setActiveRunId(run.runId);
  }, []);

  // "view running triage" from the 409-conflict dialog: activate the tab if
  // it's already open (started/adopted by this session), else fetch its
  // live snapshot for a full config and open it as a live tab.
  const viewConflictingRun = useCallback(
    async (runId: string) => {
      if (openRuns.some((t) => t.runId === runId)) {
        setActiveRunId(runId);
        return;
      }
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
        if (!res.ok) return;
        const snap = (await res.json()) as RunSnapshot;
        if (!snap.config) return;
        addLiveTabAndActivate(snap.config);
      } catch {
        /* best-effort — the dialog just closes with nothing to show */
      }
    },
    [openRuns, addLiveTabAndActivate]
  );

  // Global keybinding: esc to interrupt (with confirm) — only meaningful for
  // a LIVE, non-terminal active tab.
  useEffect(() => {
    if (!activeTab || activeTab.kind !== 'live') return;
    const status = statusFor(activeTab.runId);
    if (status && isTerminalStatus(status)) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirm('Interrupt the current run?')) void stopRun();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTab, statusFor, stopRun]);

  const liveSummary = liveRunsSummary(openRuns, statusFor);
  const showTopButtons = activeRunId === null; // start/board only — never over a run console

  const viewKey = activeRunId ?? `screen-${screenView}`;

  return (
    <div className="app-shell">
      {showTopButtons && (
        <>
          <button
            type="button"
            className="info-trigger"
            onClick={() => {
              setInfoOpen(true);
              setProcessOpen(false);
            }}
            aria-label="what is hektor?"
          >
            <span className="info-trigger-glyph">?</span>
            what is hektor?
          </button>
          <button
            type="button"
            className="info-trigger info-trigger-right"
            onClick={() => {
              setProcessOpen(true);
              setInfoOpen(false);
            }}
            aria-label="how does it work?"
          >
            <span className="info-trigger-glyph">6</span>
            how does it work?
          </button>
          <InfoDrawer open={infoOpen} onClose={() => setInfoOpen(false)} />
          <ProcessDrawer open={processOpen} onClose={() => setProcessOpen(false)} />
          <ThemeToggle className="theme-toggle-start" />
        </>
      )}

      {openRuns.length > 0 && (
        <RunTabsBar
          tabs={openRuns}
          activeRunId={activeRunId}
          boardActive={activeRunId === null && screenView === 'board'}
          statusFor={statusFor}
          onActivate={setActiveRunId}
          onClose={closeTab}
          onBoard={goToBoard}
          onNew={goToStart}
          topInset={showTopButtons}
        />
      )}

      <div className="view-switch" key={viewKey}>
        {activeRunId === null && screenView === 'board' && (
          <BuildsBoard
            onTriage={(url, testbox) => {
              setStartPrefill({ reportUrl: url, testbox });
              setScreenView('start');
            }}
            onBack={goToStart}
          />
        )}
        {activeRunId === null && screenView === 'start' && (
          <StartScreen
            onStart={startRun}
            prefillReportUrl={startPrefill.reportUrl}
            prefillTestbox={startPrefill.testbox}
            onBrowseBuilds={goToBoard}
            onConflict={(conflictRunId, retry) => setConflictDialog({ conflictRunId, retry })}
            banner={
              liveSummary.count > 0 ? (
                <div className="live-run-banner" role="status">
                  <span>
                    {liveSummary.count} triage{liveSummary.count > 1 ? 's' : ''} running
                    {liveSummary.needsYou ? ' — needs you' : ''} —{' '}
                  </span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => liveSummary.focusRunId && setActiveRunId(liveSummary.focusRunId)}
                  >
                    view
                  </button>
                </div>
              ) : undefined
            }
            afterForm={<PreviousTriages onOpen={openHistoryTab} />}
          />
        )}
        {activeTab?.kind === 'live' && (
          <RunConsole
            key={activeTab.runId}
            config={activeTab.config}
            onStop={stopRun}
            onPause={pauseRun}
            onResume={resumeRun}
            onNew={onNewFromLiveConsole}
            onOpenHistory={openHistoryTab}
            onStatusChange={(status) => setStatusByRunId((m) => ({ ...m, [activeTab.runId]: status }))}
          />
        )}
        {activeTab?.kind === 'history' && (
          <HistoryRunConsole
            key={activeTab.runId}
            runId={activeTab.runId}
            onNew={() => closeTab(activeTab.runId)}
            onOpenHistory={openHistoryTab}
            backLabel="close"
          />
        )}
      </div>

      {conflictDialog && (
        <ConflictDialog
          conflictRunId={conflictDialog.conflictRunId}
          onView={() => {
            void viewConflictingRun(conflictDialog.conflictRunId);
            setConflictDialog(null);
          }}
          onStartAnyway={() => {
            const retry = conflictDialog.retry;
            setConflictDialog(null);
            void retry();
          }}
          onClose={() => setConflictDialog(null)}
        />
      )}
    </div>
  );
}
