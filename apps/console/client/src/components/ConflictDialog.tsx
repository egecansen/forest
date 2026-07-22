import { useEffect } from 'react';

interface Props {
  conflictRunId: string;
  /** Opens (or activates) the conflicting run's tab. */
  onView: () => void;
  /** Retries the same submission with `override: true`. */
  onStartAnyway: () => void;
  onClose: () => void;
}

/**
 * POST /api/runs' same-projectPath 409 dialog: a triage is already running
 * against this repo, so starting another here would fight over the same
 * working tree + ledger. Offers "view running triage" (jump to its tab) or
 * "start anyway (risky)" (retries with override: true).
 */
export function ConflictDialog({ conflictRunId, onView, onStartAnyway, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="history-modal-overlay" onClick={onClose}>
      <div
        className="history-modal-panel conflict-dialog-panel"
        role="dialog"
        aria-label="a triage is already running here"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="history-modal-head">
          <span>already running here</span>
          <button type="button" className="history-modal-close" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        <div className="conflict-dialog-body">
          <p className="field-note">
            a triage is already running in this repo (run <code>{conflictRunId.slice(0, 8)}</code>) — two agents would
            fight over one working tree and ledger.
          </p>
          <div className="conflict-dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onView}>
              view running triage
            </button>
            <button type="button" className="btn btn-danger" onClick={onStartAnyway}>
              start anyway (risky)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
