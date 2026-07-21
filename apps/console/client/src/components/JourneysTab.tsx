import type { Journey, PhaseState } from '../types';
import { EmptyState } from './FindingsTab';
import { phaseWaitState } from '../consoleAlerts';
import { phaseById } from '../phases';
import { romanize } from '../roman';

const PRIORITY_ORDER: Record<Journey['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3, unranked: 4 };
const JOURNEY_MAPPING = phaseById('journey-mapping');

interface Props {
  journeys: Journey[];
  /** Phase state for `journey-mapping` — sharpens the empty-state copy. */
  phase?: PhaseState;
}

export function JourneysTab({ journeys, phase }: Props) {
  if (journeys.length === 0) {
    const wait = phaseWaitState(phase);
    const phaseLabel = `Phase ${romanize(JOURNEY_MAPPING?.number ?? 4)} · ${JOURNEY_MAPPING?.label ?? 'Journey map'}`;
    if (wait === 'running') {
      return (
        <EmptyState
          glyph="⌗"
          tone="waiting"
          title="Mapping journeys now"
          body="Journey mapping is running — flows and their coverage will appear here as they're discovered."
        />
      );
    }
    if (wait === 'settled') {
      return (
        <EmptyState
          glyph="⌗"
          tone="clear"
          title="No journeys mapped"
          body={`${phaseLabel} completed without recording any journeys.`}
        />
      );
    }
    return (
      <EmptyState
        glyph="⌗"
        tone="waiting"
        title="Waiting for journey mapping"
        body={`${phaseLabel} hasn't run yet — it writes journey-map.md. Mapped user flows and their coverage will appear here once it does.`}
      />
    );
  }
  const sorted = [...journeys].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  return (
    <div className="journeys-tab">
      <ul className="journeys-list">
        {sorted.map((j) => (
          <li key={j.id} className={`journey-row cov-${j.coverage}`}>
            <span className={`journey-prio prio-${j.priority.toLowerCase()}`}>{j.priority}</span>
            <span className="journey-title">{j.title}</span>
            <span className="journey-id">{j.id}</span>
            <span className={`journey-cov cov-${j.coverage}`}>{j.coverage}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
