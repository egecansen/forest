import { useState } from 'react';
import type { PendingQuestion } from '../types';
import { buildAnswers } from '../question-logic';

interface Props {
  question: PendingQuestion;
  onSubmit: (questionId: string, answers: Record<string, string | string[]>) => Promise<void>;
}

export function QuestionModal({ question, onSubmit }: Props) {
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (qi: number, label: string, multi: boolean) =>
    setSel((prev) => {
      const cur = prev[qi] ?? [];
      if (multi) return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...prev, [qi]: [label] };
    });
  const ready = question.questions.every((_, i) => (sel[i]?.length ?? 0) > 0);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(question.questionId, buildAnswers(question.questions, sel));
      // On success DO NOT reset `submitting` — the modal unmounts when
      // `pendingQuestion` clears via the WS `questionResolved` event; leaving
      // it disabled prevents a double-send in the gap before that happens.
    } catch {
      setError('Could not send your answer — check the connection and try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="question-dock" role="region" aria-label="hektor needs a decision">
      <div className="question-card">
        <div className="question-eyebrow">hektor needs a decision</div>
        {question.questions.map((q, i) => (
          <div key={i} className="question-block">
            <div className="question-header">{q.header}</div>
            <div className="question-prompt">{q.question}</div>
            <div className="question-options">
              {q.options.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  className={`question-option ${(sel[i] ?? []).includes(o.label) ? 'is-picked' : ''}`}
                  onClick={() => toggle(i, o.label, q.multiSelect)}
                >
                  <span className="question-option-label">{o.label}</span>
                  {o.description && <span className="question-option-desc">{o.description}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button
          type="button"
          className="question-submit"
          disabled={!ready || submitting}
          onClick={handleSubmit}
        >
          send answer
        </button>
        {error && <p className="question-error">{error}</p>}
      </div>
    </div>
  );
}
