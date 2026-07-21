import { expect, test, type Page } from '@playwright/test';

/**
 * Layout regression guard for the builds board (client/src/components/
 * BuildsBoard.tsx + the `.start-card.builds-board` rule in
 * client/src/styles/global.css): the board must render as a capped,
 * centered column that never sits under the two fixed top info-trigger
 * buttons (`.info-trigger` / `.info-trigger-right`, "what is hektor?" /
 * "how does it work?"), at any window width — and the page itself must
 * never scroll horizontally.
 *
 * The console now lands on the triage start form (client/src/App.tsx) —
 * the board is reached from there via its "latest builds →" button — so
 * each measurement first navigates the form → board before measuring.
 *
 * The board's own network calls (`/api/builds`, `/api/history`,
 * `/api/config`, `/api/runs`) are mocked directly rather than relying on
 * the fixture's unreachable Jenkins/ES stand-ins — that gives a real,
 * populated board (NEEDS TRIAGE + RUNNING + DONE sections, actual build
 * cards) to check the "hollow middle" footer layout against, and sidesteps
 * ever landing on a stale 'console' view because some other test's demo
 * run is still active on the shared e2e server.
 */
const NOW = Date.now();

const BOARD_DATA = {
  builds: [
    {
      jobName: 'web-test-s4-flaky', number: 2201, building: false, result: 'FAILURE',
      timestamp: NOW - 12 * 60000, duration: 9 * 60000 + 12000, estimatedDuration: 8 * 60000,
      url: 'http://127.0.0.1:1/job/web-test-s4-flaky/2201', displayName: 'Build : 2201',
      params: { TAG: 'nightly', TESTBOX: '307', BRANCH: 'tech/WEBT-99001', JIRA_TICKET: 'WEBT-99001' },
      buildUser: 'egecan.sen', failedCount: 14, reportUrl: 'http://127.0.0.1:1/web-test-s4-flaky/2201',
      stage: { current: null, failed: 'checkout', done: 3, total: 8 },
    },
    {
      jobName: 'web-test-s4-flaky', number: 2200, building: false, result: 'UNSTABLE',
      timestamp: NOW - 40 * 60000, duration: 11 * 60000 + 3000, estimatedDuration: 8 * 60000,
      url: 'http://127.0.0.1:1/job/web-test-s4-flaky/2200', displayName: 'Build : 2200',
      params: { TAG: 'nightly', TESTBOX: '308', BRANCH: 'tech/WEBT-99000' },
      buildUser: 'someone.else', failedCount: 3, reportUrl: 'http://127.0.0.1:1/web-test-s4-flaky/2200',
      stage: { current: null, failed: null, done: 8, total: 8 },
    },
    {
      jobName: 'web-test-s4-flaky', number: 2202, building: true, result: null,
      timestamp: NOW - 3 * 60000, duration: 0, estimatedDuration: 8 * 60000,
      url: 'http://127.0.0.1:1/job/web-test-s4-flaky/2202', displayName: 'Build : 2202',
      params: { TAG: 'nightly', TESTBOX: '61', BRANCH: 'tech/WEBT-99002' },
      buildUser: 'egecan.sen', failedCount: 0, reportUrl: null,
      stage: { current: 'run-tests', failed: null, done: 4, total: 8 },
    },
    {
      jobName: 'web-test-s4-flaky', number: 2198, building: false, result: 'SUCCESS',
      timestamp: NOW - 150 * 60000, duration: 6 * 60000 + 40000, estimatedDuration: 8 * 60000,
      url: 'http://127.0.0.1:1/job/web-test-s4-flaky/2198', displayName: 'Build : 2198',
      params: {}, buildUser: 'egecan.sen', failedCount: 0, reportUrl: null, stage: null,
    },
  ],
  fetchedAt: NOW,
  stale: false,
};

async function mockBoardApis(page: Page) {
  await page.route('**/api/builds', (route) => route.fulfill({ json: BOARD_DATA }));
  await page.route('**/api/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/config', (route) => route.fulfill({ json: { jenkinsUser: 'egecan.sen' } }));
  // Forces the board view regardless of whether another test left a run
  // active on this (shared, reused) e2e server.
  await page.route('**/api/runs', (route) => route.fulfill({ json: [] }));
}

const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

test('/ with no params lands on the triage form, and its nav button reaches the board', async ({ page }) => {
  await mockBoardApis(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('button', { name: /start triage/i })).toBeVisible();

  await page.getByRole('button', { name: /latest builds/i }).click();

  // The NEEDS TRIAGE section title (e.g. "needs triage (2)") — distinct from
  // the info-drawer copy elsewhere on the page that also mentions the phrase.
  await expect(page.locator('.board-section-title', { hasText: /needs triage/i })).toBeVisible();
});

for (const width of [1920, 1280, 690]) {
  test(`builds board stays capped, centered, and clear of the info triggers @ ${width}px`, async ({ page }) => {
    await mockBoardApis(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Lands on the triage form — reach the board via its nav button.
    await page.getByRole('button', { name: /latest builds/i }).click();

    const card = page.locator('.builds-board');
    await expect(card).toBeVisible();

    const measurements = await page.evaluate(() => {
      const cardBox = document.querySelector('.builds-board')!.getBoundingClientRect();
      const triggers = [...document.querySelectorAll<HTMLElement>('.info-trigger')].map((el) =>
        el.getBoundingClientRect()
      );
      return {
        cardBox: { left: cardBox.left, right: cardBox.right, top: cardBox.top, bottom: cardBox.bottom, width: cardBox.width },
        triggers: triggers.map((t) => ({ left: t.left, right: t.right, top: t.top, bottom: t.bottom })),
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });

    // Capped at ~1080px, per the `.start-card.builds-board` rule.
    expect(measurements.cardBox.width).toBeLessThanOrEqual(1080);

    // Centered column: left/right gutters match within ±8px.
    const leftGutter = measurements.cardBox.left;
    const rightGutter = measurements.innerWidth - measurements.cardBox.right;
    expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(8);

    // Never overlaps either fixed top info-trigger button, at any width.
    for (const trigger of measurements.triggers) {
      expect(intersects(measurements.cardBox as DOMRect, trigger as DOMRect)).toBe(false);
    }

    // No page-level horizontal scroll (the board's own vertical overflow
    // scrolls inside `.start-screen`, never the document).
    expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.innerWidth);
  });
}
