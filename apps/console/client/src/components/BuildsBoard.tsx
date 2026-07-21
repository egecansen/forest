import { useEffect, useMemo, useState } from 'react';

interface BuildRow {
  jobName: string; number: number; building: boolean; result: string | null;
  timestamp: number; duration: number; url: string; displayName: string;
  params: Record<string, string>; buildUser: string | null;
  failedCount: number; reportUrl: string | null;
}
interface BoardData { builds: BuildRow[]; fetchedAt: number | null; stale: boolean }

/** Minimal shape of `GET /api/history`'s `RunSummary[]` — only what the
 *  triaged-build chip needs (see types.ts for the full shape). */
interface HistorySummary {
  targetUrl: string;
  status: string;
}

const isRed = (b: BuildRow) => !b.building && (b.result === 'FAILURE' || b.result === 'UNSTABLE');

export function BuildsBoard({ onTriage }: { onTriage: (reportUrl: string) => void }) {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [pasted, setPasted] = useState('');
  // reportUrl -> latest history status, so a row already triaged (however it
  // resolved) shows a small "triaged · <status>" chip instead of leaving the
  // board looking untouched. The board doubles as history-at-a-glance.
  const [triaged, setTriaged] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    (async () => {
      try {
        const res = await fetch('/api/builds');
        if (!res.ok) { setError((await res.json()).error ?? `HTTP ${res.status}`); return; }
        setData(await res.json());
        ws = new WebSocket(`ws://${location.host}/ws-board`);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'builds' && !closed) setData(msg);
        };
      } catch { setError('server unreachable'); }
    })();
    return () => { closed = true; ws?.close(); };
  }, []);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/history');
        if (!res.ok) return;
        const summaries = (await res.json()) as HistorySummary[];
        if (ignore) return;
        const map = new Map<string, string>();
        for (const s of summaries) if (s.targetUrl) map.set(s.targetUrl, s.status);
        setTriaged(map);
      } catch {
        // Best-effort: the board still works without the triaged-chip overlay.
      }
    })();
    return () => { ignore = true; };
  }, []);

  const rows = useMemo(() => (data?.builds ?? [])
    .filter((b) => !tagFilter || (b.params.TAG ?? '').toLowerCase().includes(tagFilter.toLowerCase()))
    .filter((b) => !mineOnly || !!b.buildUser), [data, tagFilter, mineOnly]);
  const latestRed = rows.find((b) => isRed(b) && b.reportUrl);

  if (error) return <div className="start-screen"><div className="start-card"><p className="field-note">{error}</p></div></div>;

  return (
    <div className="start-screen">
      <div className="start-card builds-board">
        <div className="board-header">
          <h1 className="brand">hektor</h1>
          <span className="field-note">flaky triage — latest builds{data?.stale ? ' · stale' : ''}</span>
          <button type="button" className="btn btn-primary" disabled={!latestRed}
            onClick={() => latestRed?.reportUrl && onTriage(latestRed.reportUrl)}>
            triage latest
          </button>
        </div>
        <div className="board-filters">
          <input placeholder="filter TAG" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} />
          <label><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> only mine</label>
        </div>
        <table className="board-table">
          <tbody>
            {rows.map((b) => (
              <tr key={`${b.jobName}-${b.number}`} className={isRed(b) ? 'is-red' : b.building ? 'is-running' : ''}>
                <td>{b.displayName}</td>
                <td>{b.building ? 'RUNNING' : b.result}</td>
                <td>{b.params.TAG ?? ''}</td>
                <td>{b.buildUser ?? ''}</td>
                <td>{b.failedCount > 0 ? `${b.failedCount} failed` : ''}</td>
                <td><a href={b.url} target="_blank" rel="noreferrer">jenkins</a></td>
                <td>{b.reportUrl && <a href={b.reportUrl} target="_blank" rel="noreferrer">report</a>}</td>
                <td>
                  <button type="button" className="btn" disabled={!isRed(b) || !b.reportUrl}
                    onClick={() => b.reportUrl && onTriage(b.reportUrl)}>triage</button>
                  {b.reportUrl && triaged.has(b.reportUrl) && (
                    <span className="board-chip">triaged · {triaged.get(b.reportUrl)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="board-paste">
          <input placeholder="…or paste an s-report URL" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <button type="button" className="btn" disabled={!pasted.trim()} onClick={() => onTriage(pasted.trim())}>triage url</button>
        </div>
      </div>
    </div>
  );
}
