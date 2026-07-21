import type { ProjectState } from './types.js';

/**
 * No on-disk pipeline state is inspected in this build — every project reads
 * as a fresh one.
 */
export async function readProjectState(_projectPath: string): Promise<ProjectState> {
  return {
    installed: false,
    hasState: false,
    currentPhase: null,
    pipelineStatus: null,
    journeys: 0,
    tests: 0,
    findings: 0,
    targetUrl: null,
    runMode: null,
  };
}
