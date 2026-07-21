import type { QuestionSpec } from './types';

/** selections maps question index → chosen option labels.
 *  freeText maps question index → a typed answer, which stands in for (single-select)
 *  or is appended to (multi-select) the picked options. */
export function buildAnswers(
  questions: QuestionSpec[],
  selections: Record<number, string[]>,
  freeText: Record<number, string> = {}
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  questions.forEach((q, i) => {
    const picked = selections[i] ?? [];
    const text = freeText[i]?.trim();
    if (q.multiSelect) {
      const combined = text ? [...picked, text] : picked;
      if (combined.length > 0) out[q.question] = combined;
      return;
    }
    if (text) out[q.question] = text;
    else if (picked.length > 0) out[q.question] = picked[0];
  });
  return out;
}
