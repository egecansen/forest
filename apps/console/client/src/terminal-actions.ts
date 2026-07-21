import type { RunConfig, RunSnapshot } from './types';

export interface TerminalAction {
  label: string;
  mode: RunConfig['mode'];
  recommended?: boolean;
}

export interface TerminalActionsView {
  title: string;
  tone: 'clear' | 'error' | 'neutral';
  actions: TerminalAction[];
}

/**
 * Maps a terminal run status to the next-action panel content. Returns null for
 * any non-terminal status. `currentMode` is the finished run's mode — used by the
 * retry (failed) and continue (cancelled) actions that re-run the same mode.
 */
export function terminalActions(
  status: RunSnapshot['status'],
  currentMode: RunConfig['mode'],
  pipelineStatus?: string | null
): TerminalActionsView | null {
  switch (status) {
    case 'completed':
      // A run can END 'completed' while the pipeline itself is blocked or
      // unfinished (the agent stopped cleanly on a blocker and phases 3+ never
      // ran). Offering "Expand coverage" there reads as if the suite shipped —
      // offer a resume instead. (F20)
      if (pipelineStatus && pipelineStatus !== 'completed') {
        return {
          title:
            pipelineStatus === 'blocked'
              ? 'Run blocked — resume when ready?'
              : 'Pipeline unfinished — continue?',
          tone: pipelineStatus === 'blocked' ? 'error' : 'neutral',
          actions: [{ label: 'Continue this run', mode: currentMode, recommended: true }],
        };
      }
      return {
        title: 'Suite delivered — what next?',
        tone: 'clear',
        actions: [
          { label: 'Expand coverage', mode: 'coverage-expansion', recommended: true },
          { label: 'Find bugs', mode: 'bug-discovery' },
          { label: 'Companion verify', mode: 'companion' },
        ],
      };
    case 'failed':
      return {
        title: 'Run failed — how to proceed?',
        tone: 'error',
        actions: [
          { label: 'Retry from checkpoint', mode: currentMode, recommended: true },
          { label: 'Run repair', mode: 'repair' },
        ],
      };
    case 'cancelled':
      return {
        title: 'Run stopped — continue?',
        tone: 'neutral',
        actions: [{ label: 'Continue this run', mode: currentMode, recommended: true }],
      };
    default:
      return null;
  }
}
