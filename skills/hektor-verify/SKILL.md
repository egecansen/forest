---
name: hektor-verify
description: >
  Evidence-first single-change verification — run one focused check against
  the live app or a local dev build and produce an artefact bundle a
  developer can read in 60 seconds: screenshot per step, video, console
  log, test result XML, page source dump, summary. Use when asked to
  "verify this fix", "confirm the change works", "check the PR's
  behaviour", or "screenshot the new feature". Output is a developer
  deliverable, not a durable suite test.
---

# Hektor verify

Achilles' "companion mode" — one focused check, full evidence bundle.

Not a regression test. Not a coverage expansion. The deliverable is the
evidence bundle. The developer reads it; the suite never sees it.

---

## Inputs

The caller passes some combination of:

- **What changed** — a PR URL, a commit, a Java file path, a JIRA ID.
- **What to verify** — "the tooltip now shows the correct text", "the
  filter combination no longer returns 500", "the new payment method
  appears in the dropdown".
- **Where** — staging URL, local dev, prod read-only.

If the caller is vague ("verify the change"), ask: "Verify what
specifically? Give me the user-visible behaviour you want confirmed."

---

## Procedure

### 1. Decide the probe

One linear scenario — entry → action → assertion. No journey mapping. No
variant matrix. The scope of `hektor-verify` is intentionally small.

Identify:
- The starting URL (use the relevant `<Page>PageUrls` constant).
- The ordered actions to perform.
- The assertion (visible text, element present, URL after navigation, EDR
  event fired, etc.).

### 2. Run the probe

Two execution modes:

#### Mode A — reuse an existing test

If a test already exercises the scenario, run it. Paste
`testbox.gradleArgs` from `docs/hektor/run-status.json`:

```
gradle test --tests "<FQCN>.<method>" {{testbox.gradleArgs}}
```

If verification is against staging or a PR-build URL instead of the
reserved testbox, the user must explicitly say so (`verify against
staging`). Don't override the testbox silently.

Capture stdout, stderr, the JUnit XML, and the screenshot the framework
drops on success or failure.

#### Mode B — write a temporary probe

If no test fits, write a temp class:

```
web-ui-test/temp/HektorVerify_<jira>_<timestamp>.java
```

Same shape as a real test (TestDataResource, @AutowiredBean, @WebTest)
but tagged `@Tag("hektor-verify-temp")` and placed outside `src/test`
so it doesn't pollute the suite (or placed under `src/test` with the
temp tag and deleted after).

The temp class drives the live app via the existing Page / Layout pattern
— do not bypass and reach for raw WebDriver unless absolutely necessary.

#### `--proof N` mode

By default the probe runs **once** and returns
`verified-pass | verified-fail | inconclusive` as above. With `--proof N`
the probe runs N times (N = the flaky-triage `flaky_confidence_runs`,
default 3) and the verdict is `verified-pass` ONLY when pass^N holds — all
N runs green. One green run is not proof; a single flake among the N
demotes the verdict to `inconclusive`. Drop a `verifier-result.json`
(schema `hektor.flaky.verifier.v1` — the same shape
`hektor-flaky-triage/core/gate.sh` emits) into the evidence bundle.

### 3. Evidence bundle

Drop everything into `docs/hektor/verify/<jira-or-slug>-<timestamp>/`:

```
docs/hektor/verify/WEBT-245156-20260521-1430/
├── summary.md            — the report (see template below)
├── step-1-load.png       — screenshot per major action
├── step-2-click.png
├── step-3-assert.png
├── video.mp4             — Selenoid VNC video (if Selenoid)
├── junit.xml             — test-results XML
├── browser-console.log   — browser logs
├── webdriver.log         — Selenium logs
├── page-source-final.html— DOM at the assertion point
├── network.har           — HAR if available
└── verifier-result.json  — hektor.flaky.verifier.v1 (only with --proof N)
```

**Redaction.** Redact credentials/tokens and user PII (phone numbers,
names) from any screenshot or page-source before saving to the bundle —
this suite hits a live marketplace; reuse
`hektor-flaky-triage/core/sanitize-text.py`.

### 4. summary.md template

```markdown
# Hektor verify — WEBT-245156

**Date:** 2026-05-21T14:30:00Z
**Target:** staging.sahibinden.com (PR-4012 build)
**Surface:** website (Chrome 105 / Selenoid)
**Tester:** Hektor (automated)

## What was verified
The filter tooltip on `HybridSearchPage > LeftFilterLayout` now shows the
correct Turkish text "Filtre yenileme aktif" after clicking the
refresh-on-click toggle.

## Result
✅ **PASS** — tooltip text matches expected.

## Evidence
- Step 1: Loaded `/real-estate-for-sale/istanbul` — [screenshot](./step-1-load.png)
- Step 2: Clicked refresh-on-click toggle — [screenshot](./step-2-click.png)
- Step 3: Tooltip shown with correct text — [screenshot](./step-3-assert.png)
- Video: [video.mp4](./video.mp4) (Selenoid VNC, 14s)
- WebDriver session: see [webdriver.log](./webdriver.log)
- Network: no 4xx / 5xx during run; see [network.har](./network.har)

## Side observations
- Cookie banner appeared on first load and was auto-dismissed by the test
  fixture; behaviour unchanged from previous runs.
- The filter loading spinner is now ~200ms shorter than the prior baseline
  (visible in video.mp4 at t=4s); not a regression, possibly perf
  improvement.

## Suite impact
None — this is a one-off verify. The existing test
`HybridSearchFilterTest#testOpenLeftMenuList` still passes against this
build (re-confirmed in [junit.xml](./junit.xml)).
```

### 5. Cleanup

If you wrote a temp probe under `web-ui-test/temp/`:
- After the bundle is written, delete the temp Java file.
- Do not check in temp probes.

If you wrote a temp tag (`@Tag("hektor-verify-temp")`) inside the main
`src/test` tree, remove the file before exiting. Don't leak verify
probes into the durable suite.

---

## Output

A single message back to the caller pointing at the bundle:

> Verified WEBT-245156. Bundle at
> `docs/hektor/verify/WEBT-245156-20260521-1430/`. Tooltip text correct,
> no network errors, no console warnings. Existing tests still green.

The developer reads the bundle. You do not summarise the bundle into the
chat.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-verify",
    "status": "verified-pass | verified-fail | inconclusive",
    "next-action": "report"
  },
  "subject": "WEBT-245156",
  "target-url": "https://staging.sahibinden.com",
  "surface": "website",
  "verdict": "PASS",
  "bundle-path": "docs/hektor/verify/WEBT-245156-20260521-1430/",
  "regression-impact": "none",
  "side-observations": ["Filter spinner ~200ms shorter than baseline"],
  "summary": "Tooltip fix verified on staging; bundle in docs/hektor/verify/."
}
```
