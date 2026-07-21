import type { QuestionSpec } from './types';

/** selections maps question index → chosen option labels. */
export function buildAnswers(
  questions: QuestionSpec[],
  selections: Record<number, string[]>
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  questions.forEach((q, i) => {
    const picked = selections[i];
    if (!picked || picked.length === 0) return;
    out[q.question] = q.multiSelect ? picked : picked[0];
  });
  return out;
}
