import { useEffect, useState } from 'react';
import type { RunSummary } from '../types';
import { projectBasename, relativeTime } from '../start-logic';
import { tabLabel } from '../run-tabs-logic';

const MAX_ROWS = 8;

interface Props {
  /** Opens the chosen past run as a history tab. */
  onOpen: (run: RunSummary) => void;
}

/**
 * Start screen's "previous triages" eyebrow section: the last 8 runs from
 * GET /api/history, each row opening as a history tab on click. Deliberately
 * light — only the already-cheap RunSummary fields (no per-row full-snapshot
 * fetch for a cluster outcome breakdown). Renders nothing once loaded empty,
 * so it never adds dead chrome to a fresh install with no run history yet.
 */
export function PreviousTriages({ onOpen }: Props) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/history');
        if (!res.ok) throw new Error(String(res.status));
        const json: unknown = await res.json();
        const list = Array.isArray(json) ? (json as RunSummary[]) : [];
        if (!ignore) setRuns(list.slice(0, MAX_ROWS));
      } catch {
        if (!ignore) setRuns([]);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  if (!runs || runs.length === 0) return null;

  return (
    <div className="history-panel previous-triages">
      <div className="history-panel-head">
        <span>previous triages</span>
        <span className="history-panel-count">{runs.length}</span>
      </div>
      <ul className="history-list">
        {runs.map((r) => (
          <li key={r.runId}>
            <button type="button" className="history-row" onClick={() => onOpen(r)} title={r.projectPath}>
              <span className="history-row-project">{tabLabel(r)}</span>
              <span className="history-row-mode">{projectBasename(r.projectPath)}</span>
              <span className={`history-row-status status-${r.status}`}>{r.status}</span>
              <span className="history-row-meta">
                {r.findings} findings · {r.tests} tests
              </span>
              <span className="history-row-time">{relativeTime(r.startedAt, Date.now())}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
