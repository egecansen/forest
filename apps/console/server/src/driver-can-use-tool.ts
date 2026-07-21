import type { Run } from './run-store.js';

/**
 * Minimal stub: allows every tool call unconditionally. Task 10 replaces
 * this with the real gate — AskUserQuestion round-tripping through the
 * console's WS (pendingAnswers) plus apply-policy confirmation.
 */
export const makeCanUseTool =
  (_run: Run) =>
  async (_toolName: string, _input: Record<string, unknown>, _opts: unknown) =>
    ({ behavior: 'allow' as const });
