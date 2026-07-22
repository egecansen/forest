import type { Run, Redactor } from './run-store.js';
import type { DriverHandle } from './driver.js';
import { pendingAnswers } from './pending-answers.js';
import { saveRun, listRuns, loadRun } from './persistence.js';
import { TERMINAL_RUN_STATUSES } from './types.js';
import type { RunSnapshot } from './types.js';

/**
 * Parks every non-terminal run into a resumable `paused` state and persists
 * its snapshot, so a console restart doesn't silently cancel/lose a live run
 * (the boot-time counterpart is `restoreParkedRuns` below). Extracted out of
 * `index.ts`'s `shutdown()` so it's unit-testable without spinning up the
 * real HTTP server / SDK driver — `shutdown()` just calls this then
 * `process.exit(0)`.
 *
 * Per run:
 * - `running` → pause the live driver handle (`DriverHandle.pause` —
 *   interrupts the SDK stream; see driver.ts). The handle's own async
 *   pausing path usually lands `status: 'paused'` on its own, but since we
 *   persist + the caller exits the process right after, we don't wait on
 *   that race — status is force-set to `'paused'` below regardless, so the
 *   persisted snapshot (and therefore boot-time restore, which only
 *   restores `status: 'paused'` summaries) is never left stuck on a stale
 *   `'running'`.
 * - `awaiting-input` → reject the bridge's held answer promise
 *   (`pendingAnswers.rejectAll`) WITHOUT going through the run's own
 *   `stop()`/`clearPendingQuestion()`. Traced: the deny-catch branch in both
 *   `makeCanUseTool` (driver-can-use-tool.ts) and the demo driver's own
 *   bridge never call `clearPendingQuestion()` — that only runs on the
 *   answered/success branch — so there's no risk of `clearPendingQuestion`'s
 *   `!isStopped()` guard flipping status back to `'running'` out from under
 *   us here. The stale `pendingQuestion` itself is cleared directly (not via
 *   `clearPendingQuestion`, to avoid that method's status side effect)
 *   because a restored run can never answer it — the operator's answer
 *   route has nothing registered for this runId after a restart.
 * - anything else non-terminal (`idle`/`preparing`/already-`paused`) → the
 *   uniform safety net below just force-sets `'paused'`.
 *
 * Bounded: every park+save runs concurrently, and the WHOLE batch races
 * against `timeoutMs` (default 3s) so one slow disk or stuck run never blocks
 * shutdown indefinitely.
 */
export async function parkAllRuns(
  runs: Run[],
  getHandle: (runId: string) => DriverHandle | undefined,
  runsDir: string,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const parkable = runs.filter((r) => !TERMINAL_RUN_STATUSES.has(r.snapshot.status));

  const parkOne = async (run: Run): Promise<void> => {
    const runId = run.snapshot.config?.runId;
    if (!runId) return;
    if (run.snapshot.status === 'running') {
      getHandle(runId)?.pause();
    } else if (run.snapshot.status === 'awaiting-input') {
      pendingAnswers.rejectAll(runId);
      run.snapshot.pendingQuestion = null;
    }
    if (run.snapshot.status !== 'paused') run.setStatus('paused');
    await saveRun(runsDir, run.snapshot);
  };

  const settle = Promise.allSettled(parkable.map(parkOne));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([settle, timeout]);
}

/**
 * Boot-time counterpart to `parkAllRuns`: restores every persisted run left
 * in `'paused'` status (i.e. parked by `parkAllRuns` on a prior shutdown)
 * back into the live `RunStore` so `GET /api/runs` lists it and the client's
 * reconnect effect adopts it as a resumable tab. Terminal-status snapshots
 * are never restored — they're already final and browsable via
 * `GET /api/history`. Capped at the newest `limit` (default 10) paused runs
 * (`listRuns` already sorts newest-first) so a runs dir with a long tail of
 * old parked runs doesn't flood the board on boot.
 *
 * `onRestored`, when given, is invoked once per restored run — its intended
 * use is wiring up the same per-run terminal-status persistence subscription
 * a freshly-created run gets (see `attachPersistence` in index.ts), since a
 * restored run is a brand-new `Run`/`EventEmitter` instance with no
 * listeners of its own yet.
 */
export async function restoreParkedRuns(
  runsDir: string,
  store: { get(runId: string): Run | undefined; restore(snapshot: RunSnapshot, redactor?: Redactor): Run | null },
  opts: { redactor?: Redactor; limit?: number; onRestored?: (run: Run) => void } = {}
): Promise<Run[]> {
  const limit = opts.limit ?? 10;
  const summaries = (await listRuns(runsDir)).filter((s) => s.status === 'paused').slice(0, limit);

  const restored: Run[] = [];
  for (const summary of summaries) {
    if (store.get(summary.runId)) continue; // already live — never double-restore
    const snapshot = await loadRun(runsDir, summary.runId);
    if (!snapshot) continue; // vanished/corrupt between listRuns and loadRun
    const run = store.restore(snapshot, opts.redactor);
    if (run) {
      restored.push(run);
      opts.onRestored?.(run);
    }
  }
  return restored;
}
