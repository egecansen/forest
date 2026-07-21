import type { PhaseState, Telemetry } from './types';

// Cache-aware blended API rate, used ONLY as a fallback when the SDK's real
// total_cost_usd isn't available (e.g. the demo simulator). Real runs display
// the authoritative SDK cost instead of this estimate. (#14, was #13)
export const EST_USD_PER_TOKEN = 0.7 / 1_000_000;

/** Previous / this-session / total cost, preferring the SDK's real cost over a
 *  token-derived estimate. Summing cache-inclusive tokens balloons the count, so
 *  estimating cost off it (the old behavior) badly over-read; the SDK's
 *  total_cost_usd is authoritative and already banked as costUsd/priorCostUsd. */
export function costSplit(t: Telemetry): {
  prior: number;
  current: number;
  total: number;
  estimated: boolean;
} {
  if (t.costUsd != null) {
    const total = t.costUsd;
    const prior = t.priorCostUsd ?? 0;
    return { prior, current: Math.max(0, total - prior), total, estimated: false };
  }
  const priorTok = t.priorTokens ?? 0;
  const curTok = t.tokens;
  return {
    prior: priorTok * EST_USD_PER_TOKEN,
    current: curTok * EST_USD_PER_TOKEN,
    total: (priorTok + curTok) * EST_USD_PER_TOKEN,
    estimated: true,
  };
}

/** Current context-window occupancy vs the model's real window. Returns null
 *  until we have an occupancy reading — so the near-limit warning can NEVER fire
 *  off the lifetime throughput sum (the old always-on "context limit near"). */
export function contextGauge(
  t: Telemetry
): { tokens: number; window: number; pct: number; level: 'normal' | 'warn' | 'danger' } | null {
  if (t.contextTokens == null) return null;
  const window = t.contextWindow ?? 200_000;
  const pct = window > 0 ? t.contextTokens / window : 0;
  const level = pct >= 0.85 ? 'danger' : pct >= 0.65 ? 'warn' : 'normal';
  return { tokens: t.contextTokens, window, pct, level };
}

/** The Timeline Duration label for a phase. Completed phases prefer their real
 *  activeMs (ledger-immune work time, incl. carried prior sessions) so a resumed
 *  run's stale ledger stamps no longer flatten them to "0s"/"carried". (#14) */
export function phaseDurationLabel(
  state: PhaseState,
  opts: { now: number; runStart: number }
): { text: string; carried: boolean } {
  const { now, runStart } = opts;
  const status = state.status;
  const clampToRun = (v: number) => Math.max(runStart, Math.min(now, v));
  const cStart = typeof state.startedAt === 'number' ? clampToRun(state.startedAt) : undefined;

  if (status === 'active') {
    return { text: formatDuration(cStart != null ? now - cStart : 0), carried: false };
  }
  const isTerminal = status === 'done' || status === 'failed' || status === 'skipped';
  if (!isTerminal) return { text: '—', carried: false };

  // Real recorded work time wins — this is what recovers carried prior phases.
  if (state.activeMs != null && state.activeMs > 0) {
    return { text: formatDuration(state.activeMs), carried: false };
  }

  // No activeMs: fall back to the in-run clamped span. A terminal phase whose
  // clamped end collapses onto its start (ledger end predates this run) reads
  // "carried" — done in a prior session, but with no recorded duration. (#9)
  const cEnd = typeof state.endedAt === 'number' ? clampToRun(state.endedAt) : undefined;
  const endedBeforeRun = typeof state.endedAt === 'number' && state.endedAt < runStart;
  const isCarried = cEnd == null || endedBeforeRun;
  if (cStart != null && cEnd != null && !isCarried) {
    return { text: formatDuration(Math.max(0, cEnd - cStart)), carried: false };
  }
  // Carried from a prior session: the ledger's own span (offset-immune) is the
  // only trustworthy record of how long the phase really took back then.
  if (state.carriedDurationMs != null && state.carriedDurationMs > 0) {
    return { text: `carried · ${formatDuration(state.carriedDurationMs)}`, carried: true };
  }
  return { text: 'carried', carried: true };
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const s = total % 60;
  const totalMin = Math.floor(total / 60);
  if (totalMin < 60) return `${totalMin}m ${String(s).padStart(2, '0')}s`;
  const m = totalMin % 60;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) return `${totalHr}h ${String(m).padStart(2, '0')}m`;
  const h = totalHr % 24;
  const d = Math.floor(totalHr / 24);
  return `${d}d ${String(h).padStart(2, '0')}h`;
}

export const fmtTokens = (t: number): string =>
  t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1_000 ? `${(t / 1_000).toFixed(1)}k` : `${t}`;

export const fmtCost = (n: number): string => `$${n.toFixed(2)}`;
