import { useMemo, useState } from 'react';
import type { Finding, FindingSeverity, PhaseState } from '../types';
import { phaseWaitState } from '../consoleAlerts';
import { phaseById } from '../phases';
import { romanize } from '../roman';

const SEV_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const SEV_LABEL: Record<FindingSeverity, string> = {
  critical: 'CRIT',
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
  info: 'INFO',
};

interface Props {
  findings: Finding[];
  /** Phase state for `bug-discovery` — sharpens the empty-state copy. */
  phase?: PhaseState;
}

const BUG_DISCOVERY = phaseById('bug-discovery');

export function FindingsTab({ findings, phase }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) c[f.severity] += 1;
    return c;
  }, [findings]);

  const sorted = useMemo(
    () => [...findings].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.ts - b.ts),
    [findings]
  );

  if (findings.length === 0) {
    const wait = phaseWaitState(phase);
    const phaseLabel = `Phase ${romanize(BUG_DISCOVERY?.number ?? 6)} · ${BUG_DISCOVERY?.label ?? 'Bug hunt'}`;
    if (wait === 'running') {
      return (
        <EmptyState
          glyph="∅"
          tone="waiting"
          title="Bug discovery in progress"
          body="Adversarial probing is running right now — findings will populate here the moment they're found."
        />
      );
    }
    if (wait === 'settled') {
      return (
        <EmptyState
          glyph="✓"
          tone="clear"
          title="No findings — clean pass"
          body={`${phaseLabel} completed without turning up any issues.`}
        />
      );
    }
    return (
      <EmptyState
        glyph="∅"
        tone="waiting"
        title="Waiting for bug discovery"
        body={`${phaseLabel} hasn't run yet. Each finding will show severity, area, a one-line title, and a repro detail once it does.`}
      />
    );
  }

  return (
    <div className="findings">
      <div className="findings-summary">
        <SevPill sev="critical" n={counts.critical} />
        <SevPill sev="high" n={counts.high} />
        <SevPill sev="medium" n={counts.medium} />
        <SevPill sev="low" n={counts.low} />
        <span className="findings-total">{findings.length} total</span>
      </div>
      <ul className="findings-list">
        {sorted.map((f) => {
          const isOpen = openId === f.id;
          return (
            <li
              key={f.id}
              className={`finding sev-${f.severity} ${isOpen ? 'is-open' : ''}`}
            >
              <button
                type="button"
                className="finding-card"
                onClick={() => setOpenId(isOpen ? null : f.id)}
                aria-expanded={isOpen}
              >
                <div className="finding-row-top">
                  <span className={`finding-sev sev-${f.severity}`}>{SEV_LABEL[f.severity]}</span>
                  <span className="finding-area">{f.area}</span>
                  <span className="finding-ts">{formatClock(f.ts)}</span>
                </div>
                <div className="finding-title">{f.title}</div>
                {f.detail && (
                  <div className={`finding-detail ${isOpen ? 'is-expanded' : ''}`}>
                    {f.detail}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SevPill({ sev, n }: { sev: FindingSeverity; n: number }) {
  return (
    <span className={`sev-pill sev-${sev} ${n === 0 ? 'is-zero' : ''}`}>
      <span className="sev-pill-dot" />
      <span className="sev-pill-num">{n}</span>
      <span className="sev-pill-label">{sev}</span>
    </span>
  );
}

interface EmptyStateProps {
  glyph: string;
  title: string;
  body: string;
  /** `waiting` = phase hasn't produced output yet; `clear` = phase settled with nothing to report. */
  tone?: 'default' | 'waiting' | 'clear';
}

export function EmptyState({ glyph, title, body, tone = 'default' }: EmptyStateProps) {
  return (
    <div className={`empty-state tone-${tone}`}>
      <div className="empty-glyph" aria-hidden>{glyph}</div>
      <div className="empty-title">{title}</div>
      <div className="empty-body">{body}</div>
    </div>
  );
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
