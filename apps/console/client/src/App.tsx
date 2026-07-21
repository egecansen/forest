import { useCallback, useEffect, useState } from 'react';
import { StartScreen } from './components/StartScreen';
import { BuildsBoard } from './components/BuildsBoard';
import { RunConsole } from './components/RunConsole';
import { InfoDrawer } from './components/InfoDrawer';
import { ProcessDrawer } from './components/ProcessDrawer';
import { ThemeToggle } from './components/ThemeToggle';
import type { RunConfig, RunSnapshot } from './types';

/**
 * The app has exactly four views: the builds board (the landing view — a
 * live snapshot of recent Jenkins builds to triage from), the triage start
 * form (reached from the board, or via a `?triage=<url>` deep link), a live
 * run console (backed by a WS stream), and a read-only console for a past,
 * persisted run opened from the history list. Only 'console' ever has a
 * stoppable/interruptible run behind it.
 */
type View =
  | { kind: 'board' }
  | { kind: 'start'; prefillReportUrl?: string }
  | { kind: 'console'; config: RunConfig }
  | { kind: 'history'; runId: string; snapshot: RunSnapshot };

export function App() {
  const [view, setView] = useState<View>(() => {
    const deep = new URLSearchParams(location.search).get('triage');
    return deep ? { kind: 'start', prefillReportUrl: deep } : { kind: 'board' };
  });
  // The live/current run's config, kept even while browsing a past run in the
  // history view so "back" can return to the running session (not the start
  // screen). Cleared when the user abandons the run ("new run").
  const [activeConfig, setActiveConfig] = useState<RunConfig | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);

  // Guard accidental navigation away from a live run. The app has no routing,
  // so the browser back button (also reload / tab-close) leaves the page and
  // drops the in-memory run view → start screen, orphaning the run. A
  // beforeunload prompt lets the user cancel. Only armed while viewing the
  // live console with an active run.
  useEffect(() => {
    if (view.kind !== 'console' || !activeConfig) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [view.kind, activeConfig]);

  // On load, reconnect to a live run if the server still has one — survives a
  // reload / back-button / HMR / lid-close that reset the in-memory view to the
  // start screen (or landed on the board). Only runs once, and only adopts a
  // run when we're still on the board/start screen (never clobbers an
  // in-progress interaction) — a live run still wins over the board. (root fix)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/runs');
        if (!res.ok) return;
        const active = (await res.json()) as Array<{ runId: string; config: RunConfig }>;
        if (cancelled || active.length === 0) return;
        const cfg = active[0].config; // newest active run
        setActiveConfig(cfg);
        setView((v) => (v.kind === 'start' || v.kind === 'board' ? { kind: 'console', config: cfg } : v));
      } catch {
        /* offline / no server → stay on the start screen */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRun = useCallback(
    async (
      projectPath: string,
      targetUrl: string,
      testbox: string,
      permissionPolicy: RunConfig['permissionPolicy']
    ) => {
      const body: Record<string, unknown> = { projectPath, targetUrl, testbox, permissionPolicy };

      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`failed to start run: ${res.status} ${t}`);
      }
      const json = (await res.json()) as { runId: string };
      const config: RunConfig = {
        projectPath,
        targetUrl,
        testbox,
        mode: 'triage',
        permissionPolicy,
        runId: json.runId,
      };
      setActiveConfig(config);
      setView({ kind: 'console', config });
    },
    []
  );

  const stopRun = useCallback(async () => {
    if (view.kind !== 'console') return;
    await fetch(`/api/runs/${view.config.runId}/stop`, { method: 'POST' });
  }, [view]);

  const pauseRun = useCallback(async () => {
    if (view.kind !== 'console') return;
    await fetch(`/api/runs/${view.config.runId}/pause`, { method: 'POST' });
  }, [view]);

  const resumeRun = useCallback(async () => {
    if (view.kind !== 'console') return;
    await fetch(`/api/runs/${view.config.runId}/resume`, { method: 'POST' });
  }, [view]);

  const newRun = useCallback(async () => {
    if (view.kind === 'console') {
      await fetch(`/api/runs/${view.config.runId}/stop`, { method: 'POST' }).catch(() => {});
    }
    setActiveConfig(null);
    setView({ kind: 'board' });
  }, [view]);

  // "back" from a read-only history run: return to the live/current session if
  // there is one (re-opening its console reconnects the WS), else the board.
  const leaveHistory = useCallback(() => {
    setView(activeConfig ? { kind: 'console', config: activeConfig } : { kind: 'board' });
  }, [activeConfig]);

  // Opens a past run read-only from the "recent runs" popup in the run-console
  // header — fetches its persisted snapshot once and renders it statically, no WS.
  const openHistoryRun = useCallback(async (runId: string) => {
    try {
      const res = await fetch(`/api/history/${encodeURIComponent(runId)}`);
      if (!res.ok) return;
      const snapshot = (await res.json()) as RunSnapshot;
      setView({ kind: 'history', runId, snapshot });
    } catch {
      // Best-effort: if the fetch fails, just stay on the start screen.
    }
  }, []);

  // Global keybinding: esc to interrupt (with confirm) — only meaningful
  // for a live run; the history view has nothing to interrupt.
  useEffect(() => {
    if (view.kind !== 'console') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirm('Interrupt the current run?')) {
          void stopRun();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [view, stopRun]);

  const viewKey =
    view.kind === 'console'
      ? view.config.runId
      : view.kind === 'history'
        ? `history-${view.runId}`
        : view.kind === 'board'
          ? 'board'
          : 'start';

  return (
    <div className="app-shell">
      {(view.kind === 'start' || view.kind === 'board') && (
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
            <span className="info-trigger-glyph">8</span>
            how does it work?
          </button>
          <InfoDrawer open={infoOpen} onClose={() => setInfoOpen(false)} />
          <ProcessDrawer
            open={processOpen}
            onClose={() => setProcessOpen(false)}
          />
          <ThemeToggle className="theme-toggle-start" />
        </>
      )}
      <div className="view-switch" key={viewKey}>
        {view.kind === 'board' && (
          <BuildsBoard onTriage={(url) => setView({ kind: 'start', prefillReportUrl: url })} />
        )}
        {view.kind === 'start' && (
          <StartScreen onStart={startRun} prefillReportUrl={view.prefillReportUrl} />
        )}
        {view.kind === 'console' && (
          <RunConsole
            config={view.config}
            onStop={stopRun}
            onPause={pauseRun}
            onResume={resumeRun}
            onNew={newRun}
            onOpenHistory={openHistoryRun}
          />
        )}
        {view.kind === 'history' && (
          view.snapshot.config ? (
            <RunConsole
              config={view.snapshot.config}
              onNew={leaveHistory}
              backLabel={activeConfig ? 'back to session' : 'back to board'}
              onOpenHistory={openHistoryRun}
              readOnly
              staticSnapshot={view.snapshot}
            />
          ) : (
            <div className="start-screen">
              <div className="start-card">
                <p className="field-note">This run has no recoverable configuration.</p>
                <button type="button" className="btn btn-ghost" onClick={leaveHistory}>
                  {activeConfig ? 'back to session' : 'back to board'}
                </button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
