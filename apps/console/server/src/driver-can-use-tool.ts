import type { Run } from './run-store.js';
import type { QuestionSpec } from './types.js';
import { pendingAnswers } from './pending-answers.js';
import { notifyDecision } from './notify.js';

type CanUseToolResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

// Conservative deny-list — defense-in-depth alongside the kit's own
// PreToolUse hooks (settingSources: 'project' in driver.ts loads those; they
// remain the primary wall). Kept SHORT and specific: only patterns that are
// unambiguously out of scope for a flaky-triage run, so ordinary kit work
// (gradle, jq, sed, git diff/status, ./core/*.sh) is never caught.
const DENIED_TOOLS = new Set(['WebFetch', 'WebSearch']);

const DENIED_BASH_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /\bgit\s+push\b/, message: 'git push is out of scope for this triage kit.' },
  { re: /\bgit\s+commit\b/, message: 'git commit is out of scope — the kit never commits.' },
  { re: /\brm\s+-(rf|fr)\s+\/\S*/, message: 'rm -rf on a rooted path is out of scope.' },
  { re: /(curl|wget)[^|]*\|\s*(ba)?sh\b/, message: 'piping a network fetch into a shell is out of scope.' },
];

function deniedBashMessage(command: string): string | null {
  for (const { re, message } of DENIED_BASH_PATTERNS) {
    if (re.test(command)) return message;
  }
  return null;
}

/**
 * sahika's anticipated bridge, realized: AskUserQuestion never reaches a
 * terminal — the tool call is held here, the question is pushed to the browser
 * (Run.setPendingQuestion → WS → QuestionModal), and the operator's POSTed
 * answer resolves the held promise. The answers ride back on `updatedInput.answers`
 * exactly as the interactive harness fills them, so the tool result the agent
 * sees is indistinguishable from a terminal session. Every other tool is
 * allowed through unmodified except the short conservative deny-list above —
 * the kit's own PreToolUse gates (settingSources:'project') remain the
 * primary enforcement layer; this is defense-in-depth on top of it.
 */
export function makeCanUseTool(run: Run) {
  return async (toolName: string, input: Record<string, unknown>, _opts: { signal?: AbortSignal }): Promise<CanUseToolResult> => {
    if (toolName !== 'AskUserQuestion') {
      if (DENIED_TOOLS.has(toolName)) {
        const message = `${toolName} is out of scope for this triage run — no general web access is needed (qagent/Atlassian MCP tools are unaffected).`;
        run.log({ kind: 'warn', text: `denied ${toolName}: ${message}` });
        return { behavior: 'deny', message };
      }
      if (toolName === 'Bash' && typeof input.command === 'string') {
        const message = deniedBashMessage(input.command);
        if (message) {
          run.log({ kind: 'warn', text: `denied Bash: ${message}` });
          return { behavior: 'deny', message };
        }
      }
      return { behavior: 'allow', updatedInput: input };
    }

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
