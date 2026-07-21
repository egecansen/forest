import { useEffect, useState } from 'react';
import type { RunSummary } from '../types';
import { projectBasename, relativeTime } from '../start-logic';

interface Props {
  /** Opens the read-only console view for the chosen past run, then closes. */
  onOpen: (runId: string) => void;
  onClose: () => void;
}

/**
 * A popup list of recent (persisted) runs, opened from the run-console header.
 * Deliberately kept off the start screen — history is a place you go to, not
 * clutter on the entry point. This is the minimal version; a fuller history
 * experience can grow from here.
 */
export function HistoryModal({ onOpen, onClose }: Props) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/history');
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as RunSummary[];
        if (!ignore) setRuns(json);
      } catch {
        if (!ignore) setRuns([]);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="history-modal-overlay" onClick={onClose}>
      <div
        className="history-modal-panel"
        role="dialog"
        aria-label="recent runs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="history-modal-head">
          <span>recent runs</span>
          <button type="button" className="history-modal-close" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        {runs === null ? (
          <div className="history-modal-empty">loading…</div>
        ) : runs.length === 0 ? (
          <div className="history-modal-empty">no runs yet — completed runs show up here.</div>
        ) : (
          <ul className="history-list">
            {runs.map((r) => (
              <li key={r.runId}>
                <button
                  type="button"
                  className="history-row"
                  onClick={() => {
                    onOpen(r.runId);
                    onClose();
                  }}
                  title={r.projectPath}
                >
                  <span className="history-row-project">{projectBasename(r.projectPath)}</span>
                  <span className="history-row-mode">{r.mode}</span>
                  <span className={`history-row-status status-${r.status}`}>{r.status}</span>
                  <span className="history-row-meta">
                    {r.findings} findings · {r.tests} tests
                  </span>
                  <span className="history-row-time">{relativeTime(r.startedAt, Date.now())}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
