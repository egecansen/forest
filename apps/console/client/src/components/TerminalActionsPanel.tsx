import { useState } from 'react';
import type { RunConfig } from '../types';
import type { TerminalActionsView } from '../terminal-actions';

interface Props {
  view: TerminalActionsView;
  onSelect: (mode: RunConfig['mode']) => void | Promise<void>;
  onDismiss: () => void;
}

export function TerminalActionsPanel({ view, onSelect, onDismiss }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = async (mode: RunConfig['mode']) => {
    setSubmitting(true);
    setError(null);
    try {
      await onSelect(mode);
      // On success the run switches and this panel unmounts; leaving `submitting`
      // set prevents a double-start in the gap before that happens.
    } catch {
      setError('Could not start that run — check the connection and try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className={`question-dock terminal-actions tone-${view.tone}`} role="region" aria-label="run actions">
      <div className="question-card">
        <div className="term-actions-head">
          <div className="term-actions-title">{view.title}</div>
          <button type="button" className="term-actions-dismiss" onClick={onDismiss}>
            dismiss
          </button>
        </div>
        <div className="question-options">
          {view.actions.map((a) => (
            <button
              key={`${a.mode}:${a.label}`}
              type="button"
              className={`question-option ${a.recommended ? 'is-recommended' : ''}`}
              disabled={submitting}
              onClick={() => handleSelect(a.mode)}
            >
              <span className="question-option-label">{a.label}</span>
            </button>
          ))}
        </div>
        {error && <p className="question-error">{error}</p>}
      </div>
    </div>
  );
}
