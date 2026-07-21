import type { PhaseId, PhaseState } from '../types';
import { PHASES, phaseById } from '../phases';

interface Props {
  activePhase: PhaseId | null;
  phases: PhaseState[];
  currentSubStage?: string | null;
  /** True while the driver is nudging the reviewer re-dispatch after an
   *  approver-registration block — shows a "recovering" chip. (#10) */
  nudging?: boolean;
}

/**
 * A thin horizontal strip mounted above the tab bar. Always visible during
 * a run regardless of which tab is open. Replaces the old dense sidebar
 * "Active phase" card.
 *
 * Layout: [NOW] · [phase num] [name] · stage · progress bar + % · next →
 */
export function NowPlaying({ activePhase, phases, currentSubStage, nudging }: Props) {
  if (!activePhase) return null;
  const meta = phaseById(activePhase);
  if (!meta) return null;
  const state = phases.find((p) => p.id === activePhase);
  const pct = Math.min(100, Math.max(0, state?.progress ?? 0));
  const next = PHASES.find((p) => p.number === meta.number + 1);

  return (
    <div className="now-playing" role="status" aria-live="polite">
      <div className="now-playing-label">NOW</div>
      <div className="now-playing-id">
        <span className="now-playing-num">{String(meta.number).padStart(2, '0')}</span>
        <span className="now-playing-name">{meta.label}</span>
        {currentSubStage && <span className="now-substage">{currentSubStage}</span>}
        {nudging && (
          <span className="now-substage now-nudging" title="Recovering from an approver-registration block — nudging the reviewer to re-dispatch in the required format.">
            recovering approver…
          </span>
        )}
        {(!!state?.reviewerCycles || (state?.reviewerVerdict && state.reviewerVerdict !== 'pending')) && (
          <span className="now-substage now-reviewer" title="reviewer gate status for this phase">
            reviewer
            {!!state?.reviewerCycles && ` · cycle ${state.reviewerCycles}`}
            {state?.reviewerVerdict && state.reviewerVerdict !== 'pending' && (
              <span className={`rev-chip rev-${state.reviewerVerdict}`}>{state.reviewerVerdict}</span>
            )}
          </span>
        )}
      </div>
      {/* Fallback when the run reports no sub-stage: "working…" reads honestly
          at any elapsed, unlike "starting…" which lingers for the whole phase. */}
      <div className="now-playing-stage">{state?.stage ?? 'working…'}</div>
      <div className="now-playing-bar-wrap">
        <div className="now-playing-bar">
          <div className="now-playing-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="now-playing-pct">{pct}%</span>
      </div>
      <div className="now-playing-next">
        {next ? (
          <>
            <span className="now-playing-next-arrow">→</span>
            <span className="now-playing-next-num">{String(next.number).padStart(2, '0')}</span>
            <span className="now-playing-next-name">{next.label}</span>
          </>
        ) : (
          <span className="now-playing-next-end">— finale —</span>
        )}
      </div>
    </div>
  );
}
