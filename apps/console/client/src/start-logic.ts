import type { ProjectState } from './types';

export type ProjectMode = 'new' | 'continue';

/** Whether Continue can start, and why not. Continue needs a resumable ledger. */
export function continueSubmitState(
  projectMode: ProjectMode,
  state: ProjectState | null
): { blocked: boolean; reason: string | null } {
  if (projectMode === 'continue' && state && state.hasState === false) {
    return { blocked: true, reason: 'No resumable state in this folder — nothing to continue.' };
  }
  return { blocked: false, reason: null };
}

/** Inline note under the mode field explaining what a run will do. */
export function modeNote(
  projectMode: ProjectMode,
  mode: string,
  state: ProjectState | null
): string | null {
  if (projectMode === 'continue') {
    if (!state || !state.hasState) return null;
    if (mode === 'onboarding') {
      return `resumes from phase ${state.currentPhase ?? '?'}/8 (${state.pipelineStatus ?? 'unknown'})`;
    }
    return `starts a fresh ${mode} pass on the existing suite instead of resuming`;
  }
  if (projectMode === 'new' && state && state.installed && state.hasState) {
    return 'this folder already has a run — starting New re-onboards from zero';
  }
  return null;
}

/** Last path segment, for the run-history list's project column. */
export function projectBasename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.at(-1) ?? p;
}

/** Coarse human-relative time (e.g. "3m ago", "2d ago") for the history list. `null` -> em dash. */
export function relativeTime(ts: number | null, now: number): string {
  if (ts == null) return '—';
  const diffMs = Math.max(0, now - ts);
  const sec = Math.round(diffMs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(mo / 12);
  return `${yr}y ago`;
}
