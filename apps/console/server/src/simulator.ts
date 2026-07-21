import type { Run } from './run-store.js';
import type { PhaseId, FindingSeverity } from './types.js';
import { PHASE_ORDER } from './types.js';
import { pendingAnswers } from './pending-answers.js';

/**
 * Per-phase synthetic artifacts. The simulator drips these into the run
 * snapshot at staggered points across each phase's duration so the new
 * tabs (Files / Tests / Findings / Report) come alive even without a real
 * run engine installed.
 */
type PhaseArtifacts = {
  files?: Array<{ path: string; kind?: 'created' | 'modified' }>;
  tests?: Array<{ path: string; name: string }>;
  findings?: Array<{ severity: FindingSeverity; area: string; title: string; detail?: string }>;
};

/**
 * Per-phase narrative lines — short observations / actions a real agent would
 * emit while working. Dripped across the phase's duration so the log tells a
 * story instead of just echoing the phase progress bar above.
 */
const NARRATIVE: Record<PhaseId, string[]> = {
  scaffold: [
    'Reading element-interactions skill manifest',
    'Resolving project metadata — node 20, vite 5, typescript 5.3',
    'Materializing playwright.config.ts from scaffold template',
    'Inspecting tsconfig.json for path aliases',
  ],
  groundwork: [
    'Crawling target — sitemap unavailable, falling back to BFS',
    'Sniffing auth shape — detected OAuth handshake at /oauth/callback',
    'Reading dashboard at /home — capturing selectors',
    'Drafting selectors with dual fallbacks (data-testid → role)',
    'Composing app-context.md from observations',
  ],
  'happy-path': [
    'Reading app-context.md to identify the critical flow',
    'Drafting spec from page-repository.json selectors',
    'Validating spec against live target',
    'Recording sign-in journey for regression baseline',
  ],
  'journey-mapping': [
    'Walking the app surface — enumerating user intents',
    'Ranking journeys by business impact and historical incidents',
    'Cross-referencing with the page repository for selector coverage',
  ],
  'coverage-expansion': [
    'Pass 1 — priority 1 journeys, depth tier A',
    'Composing edge-case variants for search and filter',
    'Pass 2 — priority 2 journeys, depth tier A',
    'Composing profile edit + avatar upload coverage',
    'Pass 3 — depth tier B, recombining variants from earlier passes',
  ],
  'bug-discovery': [
    'Loading bug-discovery heuristics — auth, race, validation, a11y',
    'Probing /api/login for cookie and CSRF defects',
    'Replaying checkout under contention to surface race conditions',
    'Auditing settings for keyboard + screen-reader gaps',
    'Deduplicating findings against existing ledger',
  ],
  'secrets-sweep': [
    'Scanning checked-in files for credentials, keys, PII',
    'Found token literal in tests/e2e/fixtures/auth.fixture.ts — relocating',
    'Updating .env and refactoring fixture to read from process.env',
  ],
  report: [
    'Aggregating findings, files, and test results',
    'Rendering qa-summary-deck.html',
    'Exporting deck to PDF via headless chromium',
  ],
};

const ARTIFACTS: Record<PhaseId, PhaseArtifacts> = {
  scaffold: {
    files: [
      { path: 'playwright.config.ts' },
      { path: 'tests/e2e/fixtures/base.ts' },
      { path: 'tests/e2e/docs/.keep' },
      { path: '.gitignore', kind: 'modified' },
    ],
  },
  groundwork: {
    files: [
      { path: 'tests/e2e/docs/app-context.md' },
      { path: 'tests/e2e/repository/page-repository.json' },
      { path: 'tests/e2e/fixtures/auth.fixture.ts' },
    ],
  },
  'happy-path': {
    files: [{ path: 'tests/e2e/specs/sign-in.spec.ts' }],
    tests: [
      { path: 'tests/e2e/specs/sign-in.spec.ts', name: 'sign-in › happy path → dashboard' },
      { path: 'tests/e2e/specs/checkout.spec.ts', name: 'checkout › single item → confirmation' },
    ],
  },
  'journey-mapping': {
    files: [{ path: 'tests/e2e/docs/journey-map.md' }],
  },
  'coverage-expansion': {
    files: [
      { path: 'tests/e2e/specs/search.spec.ts' },
      { path: 'tests/e2e/specs/profile.spec.ts' },
      { path: 'tests/e2e/specs/settings.spec.ts' },
    ],
    tests: [
      { path: 'tests/e2e/specs/search.spec.ts', name: 'search › query + filter + paginate' },
      { path: 'tests/e2e/specs/search.spec.ts', name: 'search › empty state shows suggestions' },
      { path: 'tests/e2e/specs/profile.spec.ts', name: 'profile › edit + save + reload' },
      { path: 'tests/e2e/specs/profile.spec.ts', name: 'profile › avatar upload accepts png/jpg' },
      { path: 'tests/e2e/specs/settings.spec.ts', name: 'settings › toggle notifications persists' },
      { path: 'tests/e2e/specs/checkout.spec.ts', name: 'checkout › promo-code edge cases' },
    ],
  },
  'bug-discovery': {
    findings: [
      {
        severity: 'high',
        area: 'auth',
        title: 'Session cookie missing Secure flag on /api/login',
        detail: 'Reproducible on cold browser; cookie set without Secure even on https origin.',
      },
      {
        severity: 'medium',
        area: 'search',
        title: 'Empty-query submission triggers 500 instead of validation',
        detail: 'POST /api/search with q="" returns 500. Expected 400 with field error.',
      },
      {
        severity: 'critical',
        area: 'checkout',
        title: 'Race condition allows double-charge under fast double-click',
        detail: 'Two POST /api/checkout/confirm fire before idempotency lock engages.',
      },
      {
        severity: 'low',
        area: 'profile',
        title: 'Avatar upload accepts files > 5MB despite documented limit',
        detail: 'Server-side size check missing; only the client-side limit fires.',
      },
      {
        severity: 'medium',
        area: 'a11y',
        title: 'Settings toggles missing aria-pressed state',
      },
    ],
    files: [{ path: 'tests/e2e/docs/findings.md' }],
  },
  'secrets-sweep': {
    files: [{ path: '.env', kind: 'modified' }],
  },
  report: {
    files: [
      { path: 'tests/e2e/docs/qa-summary-deck.html' },
      { path: 'tests/e2e/docs/qa-summary-deck.pdf' },
    ],
  },
};

/**
 * A scripted run that walks the eight phases with synthetic logs and
 * telemetry. Useful as a demo when the project path does not actually
 * have the run engine installed yet, and as a fallback while wiring the real
 * subprocess driver. Honours run.isStopped() so the user can interrupt.
 */
export async function runSimulator(run: Run) {
  run.setStatus('running');
  run.setTelemetry({ thinking: true });

  const cfg = run.snapshot.config;
  run.log({
    kind: 'active',
    text: `Driving onboarding for ${cfg?.targetUrl ?? 'target'}`,
  });
  await wait(400, run);

  run.log({
    kind: 'bash',
    text: 'npx playwright install chromium 2>&1 | tail -3',
  });

  // One bar that ticks up in place — same key on every call so the
  // renderer / store collapse it to a single live row.
  for (let p = 6; p <= 100; p += 6) {
    if (run.isStopped()) return;
    run.setProgress('chromium-download', p, `${p}% of 97.5 MiB`);
    await wait(110, run);
  }
  run.log({
    kind: 'success',
    text: 'Chrome Headless Shell 148.0.7778.96 (playwright chromium-headless-shell v1223) downloaded',
  });

  await wait(300, run);
  run.log({ kind: 'info', text: 'Allowed by auto mode classifier' });
  run.log({ kind: 'info', text: 'Listed 2 directories', detail: 'ctrl+o to expand' });
  await wait(400, run);
  run.log({
    kind: 'active',
    text: 'All preconditions met. Starting Phase 1 by loading the element-interactions skill for Stage 1 scaffold shapes.',
  });

  run.log({ kind: 'skill', text: 'element-interactions', detail: 'Successfully loaded skill' });

  // Walk the phases with synthetic durations and richer sub-task logs.
  const durations: Record<string, number> = {
    scaffold: 6000,
    groundwork: 7000,
    'happy-path': 9000,
    'journey-mapping': 8000,
    'coverage-expansion': 12000,
    'bug-discovery': 9000,
    'secrets-sweep': 5000,
    report: 4000,
  };

  for (const phaseId of PHASE_ORDER) {
    if (run.isStopped()) return;
    run.setPhase(phaseId, 'active', { stage: `Stage 1 of 3 — starting`, progress: 0 });

    const dur = durations[phaseId] ?? 6000;
    const ticks = 12;
    // Build a single ordered event timeline for this phase. Narrative lines
    // and artifact discoveries get interleaved evenly across the duration so
    // the log reads like an agent working through the phase instead of a
    // duplicate of the phase progress bar.
    const events: Array<() => void> = [];

    for (const text of NARRATIVE[phaseId] ?? []) {
      events.push(() => run.log({ kind: 'info', text }));
    }
    const artifacts = ARTIFACTS[phaseId] ?? {};
    for (const f of artifacts.files ?? []) {
      events.push(() => {
        run.addFile({
          path: f.path,
          kind: f.kind ?? 'created',
          bytes: 200 + Math.floor(Math.random() * 4800),
        });
        run.log({
          kind: 'info',
          text: `${f.kind === 'modified' ? 'modified' : 'wrote'} ${f.path}`,
        });
      });
    }
    for (const t of artifacts.tests ?? []) {
      events.push(() => {
        run.addTest({ path: t.path, name: t.name, status: 'wrote' });
        run.log({ kind: 'info', text: `added spec: ${t.name}` });
      });
    }
    for (const fd of artifacts.findings ?? []) {
      events.push(() => {
        run.addFinding({
          severity: fd.severity,
          area: fd.area,
          title: fd.title,
          detail: fd.detail,
        });
        const isLoud = fd.severity === 'critical' || fd.severity === 'high';
        run.log({
          kind: isLoud ? 'warn' : 'info',
          text: `found ${fd.severity} (${fd.area}) — ${fd.title}`,
        });
      });
    }

    const dropAt = events.length
      ? Array.from({ length: events.length }, (_, i) =>
          Math.max(2, Math.min(ticks - 1, Math.round(((i + 1) / (events.length + 1)) * ticks)))
        )
      : [];

    for (let i = 1; i <= ticks; i++) {
      if (run.isStopped()) return;
      const progress = Math.round((i / ticks) * 100);
      const stage = stageLabel(i, ticks);
      run.setPhase(phaseId, 'active', { stage, progress });
      run.bumpTokens(Math.floor(80 + Math.random() * 220));

      // Drop scheduled events that match this tick.
      for (let a = 0; a < events.length; a++) {
        if (dropAt[a] === i) {
          events[a]();
          dropAt[a] = -1;
        }
      }

      await wait(dur / ticks, run);
    }
    run.setPhase(phaseId, 'done', { progress: 100, stage: 'phase complete' });

    if (phaseId === 'groundwork' && !run.isStopped()) {
      const questionId = run.nextQuestionId();
      run.setPendingQuestion({
        questionId,
        questions: [{
          question: 'Multiple auth flows detected — which should I automate first?',
          header: 'Auth flow',
          options: [
            { label: 'Proceed', description: 'Email + password sign-in' },
            { label: 'OAuth', description: 'Google OAuth handshake' },
          ],
          multiSelect: false,
        }],
      });
      await pendingAnswers.register(run.snapshot.config!.runId, questionId).catch(() => {});
      run.clearPendingQuestion();
      run.log({ kind: 'info', text: 'proceeding on the operator-selected flow' });
    }
  }

  // Final artifact: the report URL. Without the real run engine the URL
  // is symbolic; the Report tab will render its placeholder preview. The
  // deck lives at the project root (matching artifacts-watcher.ts and the
  // GET /api/runs/:runId/report route), not under tests/e2e/docs.
  run.setReport(`${cfg?.projectPath ?? ''}/qa-summary-deck.html`);

  run.setTelemetry({ thinking: false });
  run.finish(true);
  run.log({ kind: 'success', text: 'Run completed successfully.' });
}

function stageLabel(i: number, ticks: number): string {
  const stage = Math.min(3, Math.ceil((i / ticks) * 3));
  return `Stage ${stage} of 3 — ${i === ticks ? 'almost done' : 'in progress'}`;
}

// Exported for unit testing (see __tests__/simulator.test.ts) — verifying
// the 'stopped' listener doesn't leak needs direct access to this helper
// rather than driving a full ~60s runSimulator() pass.
export function wait(ms: number, run: Run): Promise<void> {
  return new Promise((resolve) => {
    const onStop = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      // Normal (non-stop) resolution: the 'stopped' listener registered
      // below never fired, so it's still attached to `run` — drop it here.
      // A full demo run calls `wait()` ~100+ times; without this every one
      // of those `once` registrations survives its own timeout and piles
      // up on the shared Run instance, eventually exceeding
      // `setMaxListeners(50)`.
      run.off('stopped', onStop);
      resolve();
    }, ms);
    run.once('stopped', onStop);
  });
}
