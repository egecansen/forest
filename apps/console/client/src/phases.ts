import type { PhaseDescriptor, PhaseState, RunConfig } from './types';

export const PHASES: PhaseDescriptor[] = [
  {
    id: 'scaffold',
    number: 1,
    label: 'Scaffold',
    short: 'Phase 1 · Scaffold',
    description: 'Playwright config, fixtures, docs, gitignore additions',
  },
  {
    id: 'groundwork',
    number: 2,
    label: 'Groundwork',
    short: 'Phase 2 · Groundwork',
    description: 'app-context.md, page-repository.json, self-credentialing fixture',
  },
  {
    id: 'happy-path',
    number: 3,
    label: 'Happy path',
    short: 'Phase 3 · Happy path',
    description: 'sign-in + critical-action spec per primary flow',
  },
  {
    id: 'journey-mapping',
    number: 4,
    label: 'Journey map',
    short: 'Phase 4 · Journey map',
    description: 'journey-map.md + coverage blueprint',
  },
  {
    id: 'coverage-expansion',
    number: 5,
    label: 'Coverage',
    short: 'Phase 5 · Coverage',
    description: 'priority/depth-tiered coverage passes',
  },
  {
    id: 'bug-discovery',
    number: 6,
    label: 'Bug discovery',
    short: 'Phase 6 · Bug hunt',
    description: 'adversarial findings + regression specs',
  },
  {
    id: 'secrets-sweep',
    number: 7,
    label: 'Secrets sweep',
    short: 'Phase 7 · Secrets',
    description: 'credentials/keys/PII into .env',
  },
  {
    id: 'report',
    number: 8,
    label: 'Report',
    short: 'Phase 8 · Report',
    description: 'qa-summary-deck.html + .pdf',
  },
];

export const phaseById = (id: string) => PHASES.find((p) => p.id === id);

/** Short label for each run mode, for compact status chips. */
export const MODE_LABEL: Record<RunConfig['mode'], string> = {
  onboarding: 'onboarding',
  'coverage-expansion': 'coverage',
  'bug-discovery': 'bug hunt',
  repair: 'repair',
  companion: 'companion',
};

/**
 * Whether a run drives the 8-phase onboarding pipeline. Only `onboarding`
 * (incl. continue-onboarding, whose phases start ticking) does; companion /
 * standalone coverage / bug-discovery / repair run their own task and never
 * populate the phase state machine — so the Pipeline/Timeline views must not
 * present a misleading empty 8-phase tracker for them. (finding #11)
 */
export function usesPipeline(mode: RunConfig['mode'], phases: PhaseState[]): boolean {
  return mode === 'onboarding' || phases.some((p) => p.startedAt != null || p.status !== 'queued');
}
