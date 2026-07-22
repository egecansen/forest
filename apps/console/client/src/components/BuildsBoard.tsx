import { useEffect, useMemo, useState } from 'react';

/** Mirrors server/src/trackers/jenkins.ts's `StageInfo` — a wfapi/describe
 *  digest. `null` when the poller couldn't fetch/parse it (board degrades:
 *  the stage line is simply omitted). */
interface StageInfo { current: string | null; failed: string | null; done: number; total: number }

interface BuildRow {
  jobName: string; number: number; building: boolean; result: string | null;
  timestamp: number; duration: number; estimatedDuration: number; url: string; displayName: string;
  params: Record<string, string>; buildUser: string | null;
  failedCount: number; reportUrl: string | null; stage: StageInfo | null;
}
interface BoardData { builds: BuildRow[]; fetchedAt: number | null; stale: boolean }

/** Minimal shape of `GET /api/history`'s `RunSummary[]` — only what the
 *  triaged-build chip needs (see types.ts for the full shape). */
interface HistorySummary {
  targetUrl: string;
  status: string;
}

const isRed = (b: BuildRow) => !b.building && (b.result === 'FAILURE' || b.result === 'UNSTABLE');

/** A red build only counts as "needs triage" while it hasn't already been
 *  triaged (its reportUrl doesn't show up in run history) — the board's
 *  three sections partition every build into exactly one of NEEDS
 *  TRIAGE / RUNNING / DONE. */
const isUntriagedRed = (b: BuildRow, triaged: Map<string, string>) =>
  isRed(b) && !!b.reportUrl && !triaged.has(b.reportUrl);

/** `params.TESTBOX` carries the raw testbox number (e.g. "307") — the
 *  board (meta line + triage prefill) always renders/passes the `tb307`
 *  form the start screen's testbox field expects. */
const testboxOf = (b: BuildRow): string | undefined => (b.params.TESTBOX ? `tb${b.params.TESTBOX}` : undefined);

/** Single aligned meta string for a NEEDS TRIAGE card — empty segments
 *  (missing build parameters) are omitted rather than left as stray dots. */
function metaLine(b: BuildRow): string {
  const parts: string[] = [];
  if (b.params.TAG) parts.push(`TAG ${b.params.TAG}`);
  if (b.params.TESTBOX) parts.push(`tb${b.params.TESTBOX}`);
  if (b.params.BRANCH) parts.push(b.params.BRANCH);
  if (b.params.JIRA_TICKET) parts.push(b.params.JIRA_TICKET);
  if (b.buildUser) parts.push(b.buildUser);
  return parts.join(' · ');
}

const formatClock = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

const formatDuration = (ms: number): string => {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
};

const formatMinutes = (ms: number): number => Math.max(0, Math.round(ms / 60000));

/** Terse headline shown everywhere a build title appears — this Jenkins sets
 *  verbose custom `displayName`s (e.g. "Build : 2164 | Branch :
 *  tech/WEBT-251268 | TB : 85") that duplicate the meta line and overflow
 *  cards/rows, so the headline is built from the numeric `number` field
 *  instead. The full `displayName` is kept as a hover `title`. */
const headline = (b: BuildRow): string => `#${b.number} · ${b.jobName}`;

/** Status-rail tone — drives the left-edge inset border across all three
 *  sections (cards + compact/ledger rows) instead of per-row status chips. */
const railTone = (b: BuildRow): string => {
  if (b.building) return 'running';
  if (b.result === 'FAILURE') return 'failure';
  if (b.result === 'UNSTABLE') return 'unstable';
  if (b.result === 'SUCCESS') return 'success';
  if (b.result === 'ABORTED') return 'aborted';
  return 'muted';
};

interface TriageProps { onTriage: (reportUrl: string, testbox?: string) => void }

interface BoardProps extends TriageProps {
  /** Navigates back to the triage start form without picking a build —
   *  the board's own escape hatch, mirroring the form's "latest builds →". */
  onBack: () => void;
}

/** NEEDS TRIAGE — full card. The fail count is the card's one bold
 *  element (the "fail meter"); a failed-stage line surfaces the stage that
 *  actually broke, when the poller has it. */
function BuildCard({ b, onTriage }: { b: BuildRow } & TriageProps) {
  const tone = railTone(b);
  const meta = metaLine(b);
  return (
    <article className={`build-card tone-${tone}`}>
      <div className="build-card-info">
        <div className="build-card-title" title={b.displayName}>
          <span className="tag-serial-num">#{b.number}</span> · {b.jobName}
        </div>
        {meta && <div className="build-card-meta">{meta}</div>}
        <div className="build-card-timing">started {formatClock(b.timestamp)} · took {formatDuration(b.duration)}</div>
        {b.stage?.failed && (
          <div className="build-card-stage is-failed">failed stage: {b.stage.failed}</div>
        )}
      </div>
      <div className="build-card-footer">
        <div className={`fail-meter tone-${tone}`}>
          <div className="fail-meter-top">
            <span className="fail-meter-num">{b.failedCount}</span>
            <span className="fail-meter-label">failed</span>
          </div>
          <div className="fail-meter-bar"><div className="fail-meter-bar-fill" /></div>
        </div>
        <div className="build-card-actions">
          <a className="btn btn-ghost" href={b.url} target="_blank" rel="noreferrer">open build ↗</a>
          {b.reportUrl && (
            <a className="btn btn-ghost" href={b.reportUrl} target="_blank" rel="noreferrer">s-report ↗</a>
          )}
          <button type="button" className="btn btn-primary"
            onClick={() => b.reportUrl && onTriage(b.reportUrl, testboxOf(b))}>
            triage
          </button>
        </div>
      </div>
    </article>
  );
}

/** RUNNING — compact single-row entry. No fail meter (nothing has failed
 *  yet) and no triage action (nothing to triage while it's still moving). */
function RunningRow({ b }: { b: BuildRow }) {
  const pct = b.stage && b.stage.total > 0 ? Math.round((b.stage.done / b.stage.total) * 100) : 0;
  const tone = railTone(b);
  return (
    <div className={`build-row build-row-running tone-${tone}`}>
      <div className="build-row-main">
        <div className="build-row-title-row">
          <span className="build-row-title" title={b.displayName}>{headline(b)}</span>
          <span className="board-chip board-chip-running">running</span>
        </div>
        {b.stage && (
          <div className="build-row-stage">
            <div className="mini-bar"><div className="mini-bar-fill" style={{ width: `${pct}%` }} /></div>
            <span className="build-row-stage-text">stage: {b.stage.current ?? '—'} · {b.stage.done}/{b.stage.total}</span>
          </div>
        )}
        <span className="build-row-timing">started {formatClock(b.timestamp)} · ~{formatMinutes(b.estimatedDuration)}m expected</span>
      </div>
      <a className="btn btn-ghost" href={b.url} target="_blank" rel="noreferrer">open build ↗</a>
    </div>
  );
}

/** DONE — one-line ledger row: every build that's neither still running nor
 *  waiting to be triaged (a triaged red, a clean green, an aborted run). */
function DoneRow({ b, triagedStatus }: { b: BuildRow; triagedStatus?: string }) {
  const tone = railTone(b);
  return (
    <div className={`build-row build-row-done tone-${tone}`}>
      <span className="build-row-status">
        {triagedStatus ? (
          <span className="board-chip">triaged · {triagedStatus}</span>
        ) : b.result === 'SUCCESS' ? (
          <span className="build-row-status-text">clear</span>
        ) : b.result === 'ABORTED' ? (
          <span className="build-row-status-text is-muted">aborted</span>
        ) : (
          <span className="build-row-status-text is-muted">{(b.result ?? 'unknown').toLowerCase()}</span>
        )}
      </span>
      <span className="build-row-title" title={b.displayName}>{headline(b)}</span>
      <span className="build-row-timing">took {formatDuration(b.duration)}</span>
      <div className="build-row-links">
        <a className="btn btn-ghost" href={b.url} target="_blank" rel="noreferrer">build ↗</a>
        {b.reportUrl && (
          <a className="btn btn-ghost" href={b.reportUrl} target="_blank" rel="noreferrer">s-report ↗</a>
        )}
      </div>
    </div>
  );
}

export function BuildsBoard({ onTriage, onBack }: BoardProps) {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [pasted, setPasted] = useState('');
  // The console's own Jenkins identity (GET /api/config's `jenkinsUser`) —
  // null until resolved, and it stays null when Jenkins auth isn't
  // configured/reachable or the session is anonymous. The "only mine"
  // checkbox is meaningless without it, so it's hidden entirely in that case
  // (see the board-filters render below) rather than left as a filter that
  // silently can't work.
  const [jenkinsUser, setJenkinsUser] = useState<string | null>(null);
  // reportUrl -> latest history status, so a row already triaged (however it
  // resolved) shows a small "triaged · <status>" chip instead of leaving the
  // board looking untouched. The board doubles as history-at-a-glance, and
  // (via isUntriagedRed) is what moves a red build out of NEEDS TRIAGE.
  const [triaged, setTriaged] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    (async () => {
      try {
        const res = await fetch('/api/builds');
        if (!res.ok) {
          const json = await res.json();
          if (!closed) setError(json.error ?? `HTTP ${res.status}`);
          return;
        }
        const json = await res.json();
        if (!closed) setData(json);
        ws = new WebSocket(`ws://${location.host}/ws-board`);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'builds' && !closed) setData(msg);
        };
      } catch {
        if (!closed) setError('server unreachable');
      }
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

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/config');
        if (!res.ok) return;
        const json = (await res.json()) as { jenkinsUser?: string | null };
        if (!ignore) setJenkinsUser(json.jenkinsUser ?? null);
      } catch {
        // Best-effort: the board still works with "only mine" just unavailable.
      }
    })();
    return () => { ignore = true; };
  }, []);

  const rows = useMemo(() => (data?.builds ?? [])
    .filter((b) => !tagFilter || (b.params.TAG ?? '').toLowerCase().includes(tagFilter.toLowerCase()))
    // jenkinsUser === null means the filter can't work (no checkbox is even
    // shown in that case) — ignore a stale/leftover mineOnly=true rather
    // than filtering everything out.
    .filter((b) => !mineOnly || jenkinsUser === null || b.buildUser === jenkinsUser),
    [data, tagFilter, mineOnly, jenkinsUser]);

  // `rows` is already newest-first (server-sorted) — filtering preserves that
  // order, so each section (and each job within NEEDS TRIAGE) stays
  // newest-first with no extra sort needed.
  const needsTriage = useMemo(() => rows.filter((b) => isUntriagedRed(b, triaged)), [rows, triaged]);
  const running = useMemo(() => rows.filter((b) => b.building), [rows]);
  const done = useMemo(() => rows.filter((b) => !b.building && !isUntriagedRed(b, triaged)), [rows, triaged]);

  const latestRed = needsTriage[0];

  if (error) return <div className="start-screen"><div className="start-card"><p className="field-note">{error}</p></div></div>;

  return (
    <div className="start-screen">
      <div className="start-card builds-board">
        <div className="board-header">
          <h1 className="brand">hektor</h1>
          <span className="field-note">flaky triage — latest builds{data?.stale ? ' · stale — jenkins unreachable' : ''}</span>
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            ← new triage
          </button>
          <button type="button" className="btn btn-primary" disabled={!latestRed}
            onClick={() => latestRed?.reportUrl && onTriage(latestRed.reportUrl, testboxOf(latestRed))}>
            triage latest
          </button>
        </div>
        <div className="board-filters">
          <input placeholder="filter TAG" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} />
          {jenkinsUser !== null && (
            <label><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> only mine</label>
          )}
        </div>

        <div className="board-section board-section-needs-triage">
          <div className="board-section-title">needs triage ({needsTriage.length})</div>
          {needsTriage.length === 0 ? (
            <p className="board-section-empty">nothing needs triage — board is clean</p>
          ) : (
            <div className="build-cards">
              {needsTriage.map((b) => (
                <BuildCard key={`${b.jobName}-${b.number}`} b={b} onTriage={onTriage} />
              ))}
            </div>
          )}
        </div>

        {running.length > 0 && (
          <div className="board-section board-section-running">
            <div className="board-section-title">running ({running.length})</div>
            <div className="build-rows">
              {running.map((b) => <RunningRow key={`${b.jobName}-${b.number}`} b={b} />)}
            </div>
          </div>
        )}

        {done.length > 0 && (
          <div className="board-section board-section-done">
            <div className="board-section-title">done ({done.length})</div>
            <div className="build-rows">
              {done.map((b) => (
                <DoneRow key={`${b.jobName}-${b.number}`} b={b}
                  triagedStatus={b.reportUrl ? triaged.get(b.reportUrl) : undefined} />
              ))}
            </div>
          </div>
        )}

        <div className="board-paste">
          <input placeholder="…or paste an s-report URL" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <button type="button" className="btn" disabled={!pasted.trim()} onClick={() => onTriage(pasted.trim())}>triage url</button>
        </div>
      </div>
    </div>
  );
}
