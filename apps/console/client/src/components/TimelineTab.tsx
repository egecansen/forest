import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { PhaseState, PhaseStatus, Telemetry } from '../types';
import { PHASES } from '../phases';
import { costSplit, fmtCost, fmtTokens, formatDuration, phaseDurationLabel } from '../telemetry-format';

interface Props {
  phases: PhaseState[];
  telemetry: Telemetry;
}

const STATUS_GLYPH: Record<PhaseStatus, string> = {
  queued: '○',
  active: '◐',
  done: '✓',
  failed: '✕',
  skipped: '—',
  blocked: '⊘',
};

/**
 * Gantt-style timeline: one row per phase, horizontal bar spanning
 * [startedAt, endedAt). The window starts at the earliest startedAt and
 * extends to "now" (or the latest endedAt if the run is over) — bars get
 * positioned proportionally inside that window.
 *
 * Pending phases render as faint dashed centerlines across the full track
 * so the shape of the remaining work is visible even before they start.
 *
 * While the run is live a glowing NOW cursor sweeps across the chart and
 * a dotted vertical grid behind the bars provides time context.
 */
export function TimelineTab({ phases, telemetry }: Props) {
  // Tick once per second so the active bar keeps growing while we watch.
  // Depend on the boolean — not the phases array — or the simulator's
  // half-second phase updates keep clearing the interval before it fires.
  const hasActive = phases.some((p) => p.status === 'active');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasActive) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasActive]);

  // On a resumed run, phases carry ledger-authored timestamps from the ORIGINAL
  // run (possibly days old), which would stretch the axis to absurd spans and
  // make the active phase read `now − staleStart` (finding F12). Floor every
  // phase time at THIS run's start so the timeline reflects the current run.
  // startedAt is preferred; sessionStartedAt (streamed with every telemetry
  // delta) is the fallback for a client whose snapshot predates the F15
  // startedAt event — better a session-anchored axis than a zero-width one.
  const startRef = telemetry.startedAt ?? telemetry.sessionStartedAt ?? null;
  const runStart = startRef ?? now;
  const clampToRun = (v: number) => Math.max(runStart, Math.min(now, v));
  const earliest = runStart;
  const allEnded = phases.every(
    (p) => p.status === 'done' || p.status === 'failed' || p.status === 'skipped'
  );
  const ends = phases
    .map((p) => p.endedAt)
    .filter((v): v is number => typeof v === 'number')
    .map(clampToRun);
  const latest = allEnded && ends.length ? Math.max(...ends) : now;
  const span = Math.max(1000, latest - earliest);

  const ticks = useMemo(
    () =>
      [0, 0.25, 0.5, 0.75, 1].map((p) => ({
        pct: p * 100,
        label: formatDuration(span * p),
      })),
    [span]
  );

  const nowPct = hasActive
    ? Math.min(100, Math.max(0, ((now - earliest) / span) * 100))
    : null;

  const doneCount = phases.filter((p) => p.status === 'done').length;
  const failedCount = phases.filter((p) => p.status === 'failed').length;
  const totalCount = PHASES.length;
  const remainingCount = Math.max(0, totalCount - doneCount - failedCount);
  const elapsed = startRef != null ? Math.max(0, now - runStart) : 0;

  // Detailed telemetry breakdown (moved here from the sidebar card): project
  // totals for time · tokens · cost, split previous / this session / total.
  const priorMs = telemetry.priorElapsedMs ?? 0;
  const priorTok = telemetry.priorTokens ?? 0;
  const hasPrior = priorMs > 0 || priorTok > 0;
  const totalMs = telemetry.elapsedMs;
  const currentMs = hasPrior ? Math.max(0, totalMs - priorMs) : totalMs;
  const currentTok = telemetry.tokens;
  const totalTok = currentTok + priorTok;
  // Cost from the SDK's real total_cost_usd where available (falls back to a
  // token estimate only for the simulator, which reports no cost). (#14)
  const cost = costSplit(telemetry);

  return (
    <div className="timeline">
      <header className="timeline-summary">
        <div className="timeline-summary-title">
          <span className="timeline-summary-pulse" aria-hidden />
          <span>Phase timeline</span>
        </div>
        <div className="timeline-summary-stats">
          <SummaryStat label="elapsed" value={formatDuration(elapsed)} tone="ok" />
          <SummaryStat label="complete" value={`${doneCount}/${totalCount}`} />
          <SummaryStat label="remaining" value={`${remainingCount}`} muted />
          {failedCount > 0 && (
            <SummaryStat label="failed" value={`${failedCount}`} tone="err" />
          )}
        </div>
      </header>

      <div className="timeline-chart">
        <div className="timeline-head">
          <span className="timeline-head-label">Phase</span>
          <div className="timeline-head-track">
            {ticks.map((t, i) => (
              <span
                key={i}
                className="timeline-tick-label"
                style={{ left: `${t.pct}%` }}
                data-edge={
                  i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : undefined
                }
              >
                {t.label}
              </span>
            ))}
          </div>
          <span className="timeline-head-dur">Duration</span>
        </div>

        <div className="timeline-rows">
          <div className="timeline-overlay" aria-hidden>
            <div className="timeline-overlay-spacer" />
            <div className="timeline-overlay-track">
              {ticks.map((t, i) => (
                <div
                  key={i}
                  className="timeline-grid-line"
                  style={{ left: `${t.pct}%` }}
                  data-edge={i === 0 || i === ticks.length - 1 ? 'true' : undefined}
                />
              ))}
              {nowPct !== null && (
                <div className="timeline-now" style={{ left: `${nowPct}%` }}>
                  <span className="timeline-now-tip" aria-hidden />
                </div>
              )}
            </div>
            <div className="timeline-overlay-spacer" />
          </div>

          {PHASES.map((meta, idx) => {
            const state = phases.find((p) => p.id === meta.id);
            const status: PhaseStatus = state?.status ?? 'queued';
            const startedAt = state?.startedAt;
            const endedAt = state?.endedAt;
            const isActive = status === 'active';
            const isQueued = status === 'queued';

            // Clamp positions into this run's window so a stale ledger start
            // can't push a bar off-axis or stretch it across days (F12).
            const cStart = typeof startedAt === 'number' ? clampToRun(startedAt) : undefined;
            const cEnd = typeof endedAt === 'number' ? clampToRun(endedAt) : undefined;
            let left = 0;
            let width = 0;
            if (cStart != null) {
              const rawLeft = ((cStart - earliest) / span) * 100;
              left = Math.min(100, Math.max(0, rawLeft));
              const end = cEnd ?? (isActive ? now : cStart);
              const rawWidth = ((end - cStart) / span) * 100;
              width = Math.min(100 - left, Math.max(1.2, rawWidth));
            }

            // Duration prefers a phase's real recorded work time (activeMs) —
            // ledger-immune and carried across sessions — so a resumed run's
            // completed phases show their true duration instead of a clamp of
            // stale ledger stamps collapsing to "0s"/"carried". (#14, was #9/F12)
            const { text: dur, carried: isCarried } = phaseDurationLabel(
              state ?? { id: meta.id, status },
              { now, runStart }
            );

            // A phase only earns a solid bar if it has a real span IN THIS run's
            // window (or is live). A prior-session phase — even one now showing a
            // real activeMs duration — has a collapsed in-run span, so it keeps
            // the faint ghost track with its duration alongside. (#14)
            const hasInRunSpan = isActive || (cStart != null && cEnd != null && cEnd > cStart);
            const showGhost = isQueued || !hasInRunSpan;

            const progressPct =
              isActive && state?.progress != null
                ? Math.min(100, Math.max(0, Math.round(state.progress)))
                : null;

            return (
              <div
                key={meta.id}
                className={`timeline-row status-${status}`}
                data-status={status}
                style={{ '--row-i': idx } as CSSProperties}
              >
                <div className="timeline-label">
                  <span className={`timeline-glyph glyph-${status}`} aria-hidden>
                    {STATUS_GLYPH[status]}
                  </span>
                  <span className="timeline-num">
                    {String(meta.number).padStart(2, '0')}
                  </span>
                  <div className="timeline-name-block">
                    <span className="timeline-name">{meta.label}</span>
                    {isActive && state?.stage && (
                      <span className="timeline-stage">{state.stage}</span>
                    )}
                  </div>
                </div>

                <div className="timeline-track">
                  {showGhost ? (
                    // No in-run span (queued, or done in a prior session): a faint
                    // ghost track. The ✓ glyph + the duration/"carried" text convey
                    // completeness — not a 0-width solid bar. (#14, was #9)
                    <div className="timeline-bar is-ghost" />
                  ) : (
                    <div
                      className={`timeline-bar status-${status}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    >
                      {isActive && (
                        <span className="timeline-bar-sweep" aria-hidden />
                      )}
                    </div>
                  )}
                </div>

                <div className="timeline-dur">
                  <span className={isCarried ? 'timeline-dur-carried' : undefined}>{dur}</span>
                  {progressPct !== null && (
                    <span className="dur-pct">{progressPct}%</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="timeline-telemetry">
        {hasPrior && (
          <div className="tl-telem-row">
            <span className="tl-telem-k">previous sessions</span>
            <span className="tl-telem-v">
              {formatDuration(priorMs)} · {fmtTokens(priorTok)} tok · {fmtCost(cost.prior)}
            </span>
          </div>
        )}
        <div className="tl-telem-row tl-telem-current">
          <span className="tl-telem-k">this session</span>
          <span className="tl-telem-v">
            {formatDuration(currentMs)} · {fmtTokens(currentTok)} tok · {fmtCost(cost.current)}
          </span>
        </div>
        {hasPrior && (
          <div className="tl-telem-row tl-telem-total">
            <span className="tl-telem-k">total</span>
            <span className="tl-telem-v">
              {formatDuration(totalMs)} · {fmtTokens(totalTok)} tok · {fmtCost(cost.total)}
            </span>
          </div>
        )}
        <div className="tl-telem-note">
          tokens cumulative, incl. cache · {cost.estimated ? '$ is a rough API-rate estimate' : '$ is the real API-rate cost'} — on a subscription you pay ≈ $0
        </div>
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'err';
  muted?: boolean;
}) {
  const cls = [
    'timeline-stat',
    tone ? `tone-${tone}` : '',
    muted ? 'is-muted' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls}>
      <span className="timeline-stat-value">{value}</span>
      <span className="timeline-stat-label">{label}</span>
    </span>
  );
}
