import { useEffect } from 'react';
import { PHASES } from '../phases';

interface Props {
  open: boolean;
  onClose: () => void;
}

const FRIENDLY: Record<string, { lead: string; body: string }> = {
  ingest: {
    lead: 'pin the build',
    body: 'Pins the build and pulls every FAILED doc from the report — the raw material every later phase works from.',
  },
  cluster: {
    lead: 'find the shared cause',
    body: 'Groups failures into root-cause clusters and buckets each one from easy-fix through to likely app bug.',
  },
  pick: {
    lead: 'one decision',
    body: 'A single call on which clusters to take this pass — the rest wait for a later run.',
  },
  fix: {
    lead: 'apply the fix',
    body: 'Applies and compile-checks a fix for each picked cluster.',
  },
  verify: {
    lead: 'prove it',
    body: 'Runs a green-proof pass^N on the testbox so a fix only counts once it holds.',
  },
  report: {
    lead: 'the scoreboard',
    body: 'Produces a convergence scoreboard — what was picked, what went green, what is still open.',
  },
};

export function ProcessDrawer({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`info-backdrop ${open ? 'open' : ''}`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={`info-drawer info-drawer-right ${open ? 'open' : ''}`}
        aria-hidden={!open}
        aria-label="how does hektor work?"
        role="dialog"
      >
        <button
          type="button"
          className="info-close"
          onClick={onClose}
          aria-label="close"
        >
          ✕
        </button>

        <div className="info-kicker">the process &middot; 6 phases</div>

        <h2 className="info-h" style={{ fontSize: 28, marginBottom: 14 }}>
          how does it work?
        </h2>

        <p className="info-p" style={{ marginBottom: 28 }}>
          When you start a triage run, hektor walks six phases in sequence. Each
          phase either narrows down the failures, makes a decision, applies a
          fix, or proves it holds.
        </p>

        <ol className="process-list">
          {PHASES.map((phase) => {
            const meta = FRIENDLY[phase.id];
            const num = String(phase.number).padStart(2, '0');
            return (
              <li
                key={phase.id}
                className="process-card"
                style={{ ['--phase-i' as string]: phase.number } as React.CSSProperties}
              >
                <span className="process-num" aria-hidden>
                  {num}
                </span>
                <div className="process-body">
                  <div className="process-kicker">
                    phase {num} &middot; {meta.lead}
                  </div>
                  <h3 className="process-h">{phase.label}</h3>
                  <p className="process-desc">{meta.body}</p>
                </div>
              </li>
            );
          })}
        </ol>

        <footer className="info-foot">
          press <span className="kbd">esc</span> or click outside to close
        </footer>
      </aside>
    </>
  );
}
