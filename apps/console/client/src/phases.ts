import type { PhaseDescriptor } from './types';

export const PHASES: PhaseDescriptor[] = [
  { id: 'ingest',  number: 1, label: 'Ingest',  short: 'Phase 1 · Ingest',  description: 'pin the build, pull FAILED docs from the report' },
  { id: 'cluster', number: 2, label: 'Cluster', short: 'Phase 2 · Cluster', description: 'root-cause clusters, easy-fix → likely-bug' },
  { id: 'pick',    number: 3, label: 'Pick',    short: 'Phase 3 · Pick',    description: 'one decision: which clusters to take' },
  { id: 'fix',     number: 4, label: 'Fix',     short: 'Phase 4 · Fix',     description: 'apply + compile-check the picked clusters' },
  { id: 'verify',  number: 5, label: 'Verify',  short: 'Phase 5 · Verify',  description: 'green-proof pass^N on the testbox' },
  { id: 'report',  number: 6, label: 'Report',  short: 'Phase 6 · Report',  description: 'convergence scoreboard' },
];
export const phaseById = (id: string) => PHASES.find((p) => p.id === id);
