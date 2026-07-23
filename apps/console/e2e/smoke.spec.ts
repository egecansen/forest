import { expect, test } from '@playwright/test';

/**
 * End-to-end smoke: deep link → prefilled start form → a demo triage run
 * (server/src/driver.ts's makeDemoQueryFn) → clusters appear → answer the
 * AskUserQuestion pick through the REAL console↔operator bridge (the same
 * pendingAnswers registry a live run's canUseTool uses, see Task 10's
 * driver-can-use-tool.ts) → the picked cluster is fixed + verified green →
 * the run reaches its terminal 'completed' status.
 *
 * `fullTestBuildName=demo` in the deep-linked report URL is what makes the
 * StartScreen render its demo toggle (see StartScreen's
 * computeShowDemoToggle) — the same marker server/src/validate.ts's
 * normalizeRunBody and the demo driver both key off.
 *
 * The origin (http://127.0.0.1:1) must be in the fixture kit config's
 * es.host_allowlist — see playwright.config.ts, which materializes that
 * fixture fresh on every run.
 */
const REPORT_URL = 'http://127.0.0.1:1/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=demo';

test('board → deep link → demo triage run → clusters → pick → completion', async ({ page }) => {
  // 'domcontentloaded' rather than the default 'load' — the page head pulls
  // in Google Fonts (client/index.html), and waiting on that external
  // stylesheet is both irrelevant to this smoke test and a source of
  // flakiness/hangs on a network-restricted machine or CI runner.
  await page.goto(`/?triage=${encodeURIComponent(REPORT_URL)}`, { waitUntil: 'domcontentloaded' });

  // The deep link lands on the start form, prefilled with the report URL:
  await expect(page.getByLabel(/report url/i)).toHaveValue(/web-test-s4-flaky\/2127/);

  await page.getByLabel(/project path/i).fill('/tmp/demo-project');
  // The testbox field now holds only the digits (a fixed, non-editable "tb"
  // prefix renders next to it) — the console composes "tb161" on submit.
  await page.getByLabel(/testbox/i).fill('161');

  // The demo checkbox only renders because the report URL carries
  // fullTestBuildName=demo — asserting it's actually there (not just
  // assumed) before relying on it.
  const demoToggle = page.getByRole('checkbox', { name: /demo/i });
  await expect(demoToggle).toBeVisible();
  await demoToggle.check();

  await page.getByRole('button', { name: /start triage/i }).click();

  // Starting a run appends a live tab to the run-tabs strip and activates
  // it — exactly one tab, and it's the active one.
  await expect(page.locator('.run-tabs-bar [role="tab"][aria-selected="true"]')).toHaveCount(1);

  // The demo driver publishes a cluster, then asks the pick — a genuine
  // pause on the operator, not a logged-only tool call. Scoped to the
  // question dock's region (not just a role+name match on "onetrust")
  // because the Clusters tab's cluster row is now ALSO a button whose
  // accessible name includes the cluster id "onetrust" (its expand/collapse
  // affordance — see ClustersTab.tsx) — an unscoped query would be ambiguous.
  const questionDock = page.getByRole('region', { name: /needs a decision/i });
  await expect(questionDock).toBeVisible({ timeout: 15000 });
  await questionDock.getByRole('button', { name: /onetrust/i }).click();
  await page.getByRole('button', { name: /send answer/i }).click();

  // Answering unblocks the demo driver: it fixes + verifies the picked
  // cluster, which turns its chip green —
  await expect(page.getByText(/✅ green/)).toBeVisible({ timeout: 15000 });

  // — and the run itself reaches its terminal 'completed' status.
  await expect(page.locator('.conn.tone-completed')).toBeVisible({ timeout: 15000 });
});
