import { useEffect } from 'react';
import { PHASES } from '../phases';

interface Props {
  open: boolean;
  onClose: () => void;
}

const FRIENDLY: Record<string, { lead: string; body: string }> = {
  scaffold: {
    lead: 'the runway',
    body: 'Drops a Playwright skeleton into your project — configs, fixtures, and docs. The base every test sits on.',
  },
  groundwork: {
    lead: 'learning your app',
    body: 'Crawls your app and writes down what it sees: an app context note, a selector repository, and a fixture that signs itself in.',
  },
  'happy-path': {
    lead: 'the critical flow',
    body: 'Writes the first spec — the one path your product depends on. Catches catastrophic regressions before any other test runs.',
  },
  'journey-mapping': {
    lead: 'the coverage plan',
    body: 'Maps every meaningful user journey and ranks them by business impact. Everything that follows uses this map.',
  },
  'coverage-expansion': {
    lead: 'growing the suite',
    body: 'Runs prioritized, depth-tiered passes across the journey map, growing the suite journey by journey until coverage is real.',
  },
  'bug-discovery': {
    lead: 'breaking your app',
    body: 'An adversarial pass — hektor deliberately tries to break things, then turns each finding into a regression test you keep.',
  },
  'secrets-sweep': {
    lead: 'no leaks',
    body: 'Scans the suite for credentials, keys, or PII that slipped into checked-in code and moves them into .env.',
  },
  report: {
    lead: 'the proof',
    body: 'Generates a shareable QA summary deck (HTML + PDF) — what was tested, what broke, what got fixed.',
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

        <div className="info-kicker">the process &middot; 8 phases</div>

        <h2 className="info-h" style={{ fontSize: 28, marginBottom: 14 }}>
          how does it work?
        </h2>

        <p className="info-p" style={{ marginBottom: 28 }}>
          When you start a pilot, hektor runs eight phases in sequence. Each phase
          either learns something about your app, writes new tests, or produces
          output you can share.
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
