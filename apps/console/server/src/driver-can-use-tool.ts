import type { Run } from './run-store.js';
import type { QuestionSpec } from './types.js';
import { pendingAnswers } from './pending-answers.js';
import { notifyDecision } from './notify.js';

type CanUseToolResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * sahika's anticipated bridge, realized: AskUserQuestion never reaches a
 * terminal — the tool call is held here, the question is pushed to the browser
 * (Run.setPendingQuestion → WS → QuestionModal), and the operator's POSTed
 * answer resolves the held promise. The answers ride back on `updatedInput.answers`
 * exactly as the interactive harness fills them, so the tool result the agent
 * sees is indistinguishable from a terminal session. Everything else is allowed
 * untouched — the kit's own PreToolUse gates (settingSources:'project') remain
 * the enforcement layer.
 */
export function makeCanUseTool(run: Run) {
  return async (toolName: string, input: Record<string, unknown>, _opts: { signal?: AbortSignal }): Promise<CanUseToolResult> => {
    if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };

    const questions = (input.questions ?? []) as QuestionSpec[];
    const questionId = run.nextQuestionId();
    const runId = run.snapshot.config!.runId;
    const answerPromise = pendingAnswers.register(runId, questionId);
    run.setPendingQuestion({ questionId, questions });
    notifyDecision(`hektor needs a decision: ${questions[0]?.header ?? 'question'}`);
    // The 'pick' phase is exactly the AskUserQuestion wait for the cluster pick;
    // any later question also parks there harmlessly (phase already done).
    const pick = run.snapshot.phases.find((p) => p.id === 'pick');
    if (pick && pick.status === 'queued') run.setPhase('pick', 'active');
    try {
      const answers = await answerPromise;
      run.clearPendingQuestion();
      if (pick && pick.status === 'active') run.setPhase('pick', 'done');
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    } catch {
      // stop()/a newer question rejected this one
      return { behavior: 'deny', message: 'The run was stopped before the user answered.' };
    }
  };
}
