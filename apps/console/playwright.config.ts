import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The e2e webServer needs a working `~/.hektor-console/config.json` (via
 * HEKTOR_CONSOLE_HOME) so the board/config routes don't 503 and — crucially —
 * so POST /api/runs' host-allowlist check (server/src/validate.ts, sourced
 * from server/src/console-config.ts's `kitAllowlist`) accepts the smoke
 * test's demo report URL. `repoPath` doubles as BOTH the console's global
 * config's repo AND the location of the installed kit's own
 * `.claude/skills/hektor-flaky-triage/core/config.json` (host_allowlist) —
 * per Task 13's brief, "repoPath can be the fixture dir itself".
 *
 * jenkins/es both point at `http://127.0.0.1:1` (nothing listens there) so
 * BuildsPoller fails fast and the board renders its degraded/stale state
 * harmlessly — the smoke spec never visits the board anyway (it deep-links
 * straight to the start form), but a real config is still required for the
 * server to boot configured.
 *
 * Regenerated fresh on every `playwright.config.ts` load (not checked into
 * git — see .gitignore) because `repoPath` must be this checkout's real
 * absolute path, which vintage-cache/CI checkouts won't share.
 */
const FIXTURE_HOME = path.resolve(__dirname, 'e2e/fixtures/console-home');
const KIT_CORE_DIR = path.join(FIXTURE_HOME, '.claude', 'skills', 'hektor-flaky-triage', 'core');

// The origin the smoke spec's demo report URL uses — must appear in the
// installed kit's es.host_allowlist below for POST /api/runs to accept it.
export const E2E_ALLOWED_ORIGIN = 'http://127.0.0.1:1';

fs.mkdirSync(KIT_CORE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(FIXTURE_HOME, 'config.json'),
  JSON.stringify(
    {
      repoPath: FIXTURE_HOME,
      testbox: 'tb161',
      jenkins: { baseUrl: E2E_ALLOWED_ORIGIN, jobUrls: [`${E2E_ALLOWED_ORIGIN}/job/web-test-s4-flaky`] },
      es: { url: E2E_ALLOWED_ORIGIN, index: 'web-report' },
      reportBase: E2E_ALLOWED_ORIGIN,
      pollMs: 15000,
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(KIT_CORE_DIR, 'config.json'),
  JSON.stringify({ es: { host_allowlist: [E2E_ALLOWED_ORIGIN] } }, null, 2)
);

// A dedicated port for the e2e server, distinct from the console's normal
// dev/prod default (8765, see server/src/index.ts's `PORT` env override) —
// avoids fighting a real hektor-console dev server (or anything else) a
// developer may already have bound to 8765 on their machine.
const E2E_PORT = 8799;

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.output',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'retain-on-failure',
  },
  // Uses the machine's locally installed Google Chrome (no Playwright browser
  // download required) rather than Playwright's bundled Chromium.
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: {
    command: 'npm run build && npm start',
    cwd: __dirname,
    url: `http://localhost:${E2E_PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      HEKTOR_CONSOLE_HOME: FIXTURE_HOME,
      PORT: String(E2E_PORT),
      // Suppress notify.ts's real macOS `osascript` notifications while the
      // e2e (and the demo bridge's AskUserQuestion it exercises) run.
      NODE_ENV: 'test',
    },
  },
});
