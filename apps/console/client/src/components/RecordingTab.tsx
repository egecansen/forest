import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Recording } from '../types';
import { EmptyState } from './FindingsTab';
import { groupRecordings, recordingUrl, formatBytes, latestScreenshotIndex } from '../recordings-logic';

interface Props {
  runId: string;
  /** True while the run is live (running/preparing) — drives the near-live poll. */
  running: boolean;
  /** Whether this run was started with the record flag — sharpens the empty state. */
  recordEnabled: boolean;
}

const POLL_MS = 4000;

export function RecordingTab({ runId, running, recordEnabled }: Props) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Ticks once a second so the "updated Ns ago" caption stays honest between polls.
  const [now, setNow] = useState(() => Date.now());
  // When a specific frame is pinned (via prev/next) the near-live view stops
  // auto-advancing; `null` means "follow the newest frame as it lands".
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const [gridOpen, setGridOpen] = useState(false);

  // Guards state updates after unmount for BOTH the polled fetch (via `signal`)
  // and the manual refresh (which passes no signal).
  const mountedRef = useRef(true);
  // Reset on (re)mount, not just teardown: React StrictMode double-invokes effects
  // in dev (mount → cleanup → mount), and a cleanup-only effect would leave
  // `mountedRef.current` stuck at false after the first cleanup — permanently
  // wedging every fetch's `dead()` guard (empty list + perpetual "loading…").
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(
    async (signal?: { ignore: boolean }) => {
      const dead = () => signal?.ignore || !mountedRef.current;
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/recordings`);
        if (dead()) return;
        if (!res.ok) return;
        const data = (await res.json()) as Recording[];
        if (dead()) return;
        setRecordings(Array.isArray(data) ? data : []);
        setUpdatedAt(Date.now());
      } catch {
        /* tolerate fetch failure — keep whatever we last had */
      } finally {
        if (!dead()) setLoading(false);
      }
    },
    [runId]
  );

  // Fetch on mount + whenever the run id changes; while live, poll for new frames.
  useEffect(() => {
    const signal = { ignore: false };
    setLoading(true);
    void load(signal);
    let poll: number | undefined;
    if (running) poll = window.setInterval(() => void load(signal), POLL_MS);
    return () => {
      signal.ignore = true;
      if (poll !== undefined) window.clearInterval(poll);
    };
  }, [load, running]);

  // Lightweight 1s ticker for the "Ns ago" caption — only meaningful while live.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const grouped = useMemo(() => groupRecordings(recordings), [recordings]);
  const { videos, traces, screenshots } = grouped;

  const liveIndex = latestScreenshotIndex(screenshots);
  const shownIndex = pinnedIndex == null ? liveIndex : Math.min(pinnedIndex, liveIndex);
  const isLive = pinnedIndex == null;
  const current = shownIndex >= 0 ? screenshots[shownIndex] : null;

  const stepPrev = () => setPinnedIndex(Math.max(0, shownIndex - 1));
  const stepNext = () => {
    const next = shownIndex + 1;
    if (next >= liveIndex) setPinnedIndex(null); // caught up → resume live-follow
    else setPinnedIndex(next);
  };

  const refresh = () => {
    setLoading(true);
    void load();
  };

  const showNearLive = running && screenshots.length > 0 && current;
  const hasReplay = videos.length > 0 || traces.length > 0 || screenshots.length > 0;

  return (
    <div className="recording-tab">
      <div className="recording-head">
        <div className="recording-head-title">
          <span className="recording-head-glyph" aria-hidden>⏺</span>
          <span>Recording</span>
          {recordings.length > 0 && (
            <span className="recording-count">{recordings.length}</span>
          )}
        </div>
        <button type="button" className="icon-btn" onClick={refresh} disabled={loading}>
          {loading ? 'loading…' : 'refresh'}
        </button>
      </div>

      {showNearLive && current && (
        <div className="recording-live">
          <div className="recording-live-cap">
            <span className={`recording-live-dot ${isLive ? 'is-live' : 'is-paused'}`} aria-hidden />
            <span className="recording-live-state">{isLive ? 'live' : 'paused'}</span>
            <span className="recording-live-sep">·</span>
            <span>{agoLabel(updatedAt, now)}</span>
            <span className="recording-live-sep">·</span>
            <span>frame {shownIndex + 1} of {screenshots.length}</span>
            <span className="recording-live-nav">
              <button type="button" className="icon-btn" onClick={stepPrev} disabled={shownIndex <= 0}>
                ‹ prev
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={stepNext}
                disabled={isLive && shownIndex >= liveIndex}
              >
                next ›
              </button>
              {!isLive && (
                <button type="button" className="icon-btn" onClick={() => setPinnedIndex(null)}>
                  jump to live
                </button>
              )}
            </span>
          </div>
          <div className="recording-live-frame">
            <img
              src={recordingUrl(runId, current.relPath)}
              alt={`session frame ${shownIndex + 1}`}
              className="recording-live-img"
            />
          </div>
          <div className="recording-live-path">{current.relPath}</div>
        </div>
      )}

      {!hasReplay ? (
        <RecordingEmpty running={running} recordEnabled={recordEnabled} />
      ) : (
        <div className="recording-replay">
          {videos.length > 0 && (
            <section className="recording-group">
              <h4 className="recording-group-head">video ({videos.length})</h4>
              {videos.map((v) => (
                <figure key={v.id} className="recording-video-wrap">
                  <video
                    className="recording-video"
                    controls
                    preload="metadata"
                    src={recordingUrl(runId, v.relPath)}
                  />
                  <figcaption className="recording-cap">
                    {v.label} · {formatBytes(v.bytes)}
                  </figcaption>
                </figure>
              ))}
            </section>
          )}

          {traces.length > 0 && (
            <section className="recording-group">
              <h4 className="recording-group-head">trace ({traces.length})</h4>
              {traces.map((t) => (
                <div key={t.id} className="recording-trace">
                  <a
                    className="recording-trace-link"
                    href={recordingUrl(runId, t.relPath)}
                    download
                  >
                    ↓ download trace · {t.label} · {formatBytes(t.bytes)}
                  </a>
                  <code className="recording-hint">
                    npx playwright show-trace {t.relPath}
                  </code>
                </div>
              ))}
            </section>
          )}

          {screenshots.length > 0 && (
            <section className="recording-group">
              <button
                type="button"
                className="recording-shots-toggle"
                onClick={() => setGridOpen((v) => !v)}
                aria-expanded={gridOpen}
              >
                {gridOpen ? '▾' : '▸'} all screenshots ({screenshots.length})
              </button>
              {gridOpen && (
                <div className="recording-shots">
                  {screenshots.map((s) => (
                    <a
                      key={s.id}
                      className="recording-shot"
                      href={recordingUrl(runId, s.relPath)}
                      target="_blank"
                      rel="noreferrer"
                      title={s.relPath}
                    >
                      <img
                        src={recordingUrl(runId, s.relPath)}
                        alt={s.label}
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function RecordingEmpty({ running, recordEnabled }: { running: boolean; recordEnabled: boolean }) {
  if (!recordEnabled) {
    return (
      <EmptyState
        glyph="⏺"
        tone="default"
        title="Recording wasn't enabled"
        body="Recording wasn't enabled for this run — tick 'record browser session' when starting a run to capture video, trace, and step screenshots."
      />
    );
  }
  if (running) {
    return (
      <EmptyState
        glyph="⏺"
        tone="waiting"
        title="Waiting for the first frame"
        body="Screenshots appear here as the browser runs — the near-live view opens the moment the first frame lands, and video/trace show up once the session settles."
      />
    );
  }
  return (
    <EmptyState
      glyph="⏺"
      tone="clear"
      title="No recordings captured"
      body="No recordings were captured for this run."
    />
  );
}

/** "updated Ns ago" for the near-live caption; coarse and forgiving. */
function agoLabel(updatedAt: number | null, now: number): string {
  if (updatedAt == null) return 'updating…';
  const sec = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (sec < 1) return 'updated just now';
  return `updated ${sec}s ago`;
}
