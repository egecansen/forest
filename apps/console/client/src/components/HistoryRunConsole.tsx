import { useEffect, useState } from 'react';
import type { RunSnapshot, RunSummary } from '../types';
import { RunConsole } from './RunConsole';

interface Props {
  runId: string;
  onNew: () => void;
  onOpenHistory: (run: RunSummary) => void;
  backLabel?: string;
}

/**
 * Wraps RunConsole for a HISTORY tab: fetches the run's full persisted
 * snapshot fresh (GET /api/history/:runId) whenever `runId` changes — a
 * history tab never opens a live WS, and per the tabs design, switching
 * to it re-fetches rather than caching the snapshot in tab state.
 */
export function HistoryRunConsole({ runId, onNew, onOpenHistory, backLabel }: Props) {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let ignore = false;
    setSnapshot(null);
    setFailed(false);
    (async () => {
      try {
        const res = await fetch(`/api/history/${encodeURIComponent(runId)}`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as RunSnapshot;
        if (!ignore) setSnapshot(json);
      } catch {
        if (!ignore) setFailed(true);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [runId]);

  if (failed || (snapshot && !snapshot.config)) {
    return (
      <div className="start-screen">
        <div className="start-card">
          <p className="field-note">This run has no recoverable configuration.</p>
          <button type="button" className="btn btn-ghost" onClick={onNew}>
            {backLabel ?? 'back'}
          </button>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="start-screen">
        <div className="start-card">
          <p className="field-note">loading…</p>
        </div>
      </div>
    );
  }

  return (
    <RunConsole
      config={snapshot.config!}
      onNew={onNew}
      backLabel={backLabel}
      onOpenHistory={onOpenHistory}
      readOnly
      staticSnapshot={snapshot}
    />
  );
}
