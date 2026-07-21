import type { Run } from './run-store.js';
import { runSimulator } from './simulator.js';

/**
 * Runs in this build are served by the built-in simulation harness, which
 * walks the eight pipeline phases with synthetic logs, files, and telemetry.
 */
export type DriverHandle = (() => void) & { pause: () => void };

export function startDriver(
  run: Run,
  _queryFn?: unknown,
  _opts: { resume?: boolean } = {}
): DriverHandle {
  void runSimulator(run);
  return Object.assign(() => run.stop(), { pause: () => {} });
}
