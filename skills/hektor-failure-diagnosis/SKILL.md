---
name: hektor-failure-diagnosis
description: >
  Diagnose a SINGLE failing JUnit test in web-ui-test via evidence-based
  triage — Selenoid VNC artefacts, screenshots from web-ui-test/temp/images/,
  WebDriver logs, stack traces, page source. Decides whether the failure is
  (a) a flake the test should retry-tolerate, (b) a stale selector the
  layout needs to fix, (c) a behaviour change the test must adapt to, or
  (d) an app bug. Triggers on "this test is failing", "debug this test",
  "why does <Test> fail", or auto-escalated from hektor-test-composer /
  hektor-test-repair when a single run fails. Do NOT use for many failing
  tests at once — that is hektor-test-repair.
---

# Hektor failure diagnosis

One failing test → one structured diagnosis → one of four outcomes:

| Outcome | Action |
|---|---|
| **Flake** | Document the flake's signature; suggest a wait/sleep replacement or stabiliser. Do NOT just add a retry. |
| **Stale selector** | Edit the layout's `@FindBy(...)`. Re-run. |
| **Behaviour change** | Edit the test to match the new expected behaviour. Re-run. |
| **App bug** | Park the test with `@ScheduledDisable(startTime = <epoch-ms>, reason = "Bug mevcut - SHBDN-<id>")` (the team's annotation, NOT JUnit's bare `@Disabled`). Surface the bug. |

You do not blanket-retry. You do not add `Thread.sleep(...)` to make a test
green. You diagnose the actual cause.

---

## Inputs

- The fully-qualified test method (e.g.,
  `com.sahibinden.web.ui.website.search.hybridsearch.HybridSearchFilterTest#testOpenLeftMenuList`).
- (Optional) The Selenoid run ID, recent CI URL, or local stack trace.
- (Optional) `mode: apply | propose-fix`. Default `apply`.

If the caller passes none of the above, ask for the test FQCN.

## Modes

| Mode | Behaviour |
|---|---|
| `apply` (default) | Diagnose, fix, re-run until green. Do **not** commit. Used by `hektor-test-composer` in autonomous mode, by `hektor-test-repair`, and by direct user invocations. |
| `propose-fix` | Diagnose, classify root cause, produce a structured diff describing the proposed edit, return WITHOUT applying it. Used by `hektor-from-jira` so all proposed fixes for a ticket can be batched into one human approval gate. |

Under `propose-fix` you still do the full evidence-gathering (§1–§3 below)
— the only difference is §5 becomes "describe the fix" rather than
"apply the fix". The return shape's `fix-applied:` field becomes
`fix-proposed:` and carries:

```json
{
  "files": ["path/to/Layout.java"],
  "diff": "<unified diff text>",
  "confidence": "high | medium | low",
  "rationale": "<one-paragraph why-this-fixes-it>",
  "evidence-pointers": ["docs/hektor/jira/<KEY>/probes/screenshot-1.png", ...]
}
```

The caller is responsible for applying (or rejecting) the proposed diff
and re-running the test afterwards.

---

## Procedure

### 1. Reproduce

Read `testbox.gradleArgs` + `testbox.gradleArgsLocal` from
`docs/hektor/run-status.json`. Paste verbatim. If the ledger has no
`testbox` block, refuse — the orchestrator owns the prompt.

Run the test in isolation, three times, both environments:

```
gradle test --tests "FQCN.method" {{testbox.gradleArgs}}       # ×3
gradle test --tests "FQCN.method" {{testbox.gradleArgsLocal}}  # ×3
```

| Result pattern | Likely cause |
|---|---|
| 0/3 fail both envs | Stable failure — behaviour change or stale selector |
| 1-2/3 fail both envs | Flake — race, animation, intermittent network |
| 3/3 pass local, 3/3 fail Selenoid | Environment-specific (cookie banner, locale, network policy) |
| 3/3 fail local, 3/3 pass Selenoid | Local config drift (cached creds, stale DB) |

### 2. Read the evidence

The framework already drops artefacts. Pull them:

- **Stack trace** — `build/test-results/test/*.xml` for the failed run.
- **Screenshot** — `web-ui-test/temp/images/` (the framework writes one
  on failure).
- **PDF / MHTML page snapshot** — `web-ui-test/temp/pdf/` if the test
  enabled it.
- **Selenoid VNC video** — if the run was on Selenoid, the video lives in
  `/opt/sahibinden/selenoid/config/video/<sessionId>.mp4`. Watch the last
  10–15 s before the failure.
- **WebDriver logs** — driver / browser console logs surface NPE-on-element
  vs network-error vs JS-error distinctions.
- **Historical step trace (qagent, if available; see `hektor-qagent`).** Pull
  the selectors/pages the test used when it last ran clean — pin the test:
  ```
  mcp__qagent__query_collection(
    collection_name="<section>_teststeps",
    query="<the failing step / assertion>",
    where={"testName": "<FQCN.method>"}, n_results=10)
  ```
  Compare the historical `elementSelector` / `pageName` against today's
  failure: a selector that no longer matches the live DOM points straight at
  **stale-selector**; the last passing `stepNumber` localises where behaviour
  drifted. It's a lead, not proof — confirm on the live app before fixing.

Look at all of these before forming a hypothesis. Reading the stack trace
alone is not enough — Selenium failures often happen one step before they
throw.

### 3. Form a hypothesis

| Symptom | Hypothesis |
|---|---|
| `NoSuchElementException` for a stable element | Selector changed in the app or layout has wrong `@FindBy` |
| `ElementNotInteractableException` | Element is in DOM but covered by overlay (cookie banner, masthead, login popup) |
| `StaleElementReferenceException` | Layout re-rendered between find and click; needs a wait or re-find |
| `TimeoutException` on `waitForVisibility...` | Element never appears; either selector is wrong OR app didn't reach the expected state OR a precondition failed silently |
| `AssertionError` on `assertTrue(isDisplayed...)` | App behaviour changed; assert what's actually there now |
| `WebDriverException: chrome not reachable` | Infra (Selenoid restart, browser crash); not a test issue |
| Test passes alone but fails in suite | SERIAL test was tagged PARALLEL by mistake, or shares state with a sibling |
| All EDR assertions fail | Kafka topic name changed or event shape changed; coordinate with the EDR producer team |

### 4. Validate the hypothesis

Don't fix until validated.

- **Stale selector** → open the live app, find the new selector
  (`hektor-page-authoring`'s discovery protocol), confirm it works, then
  edit the layout.
- **Overlay** → add a layout method to dismiss the overlay (the framework
  has `CookieLayout.acceptCookies()` patterns) and call it before the
  affected step in the test (or in the test's `@BeforeEach` if every test
  in the class needs it).
- **Race** → look for the actual signal the test should wait for
  (`waitInVisibilityLoadSpinner`, `waitForVisibilityX`); add the
  `@GenerateMethods(waitForVisibility = true)` to the relevant `WebElement`
  if it doesn't exist; never `Thread.sleep`.
- **Behaviour change** → check the most recent commit to the relevant
  product code (a Hektor session won't have access to product repos, so
  ask the user "is the app's behaviour expected to have changed here?")
- **App bug** → confirm by reproducing manually in a browser. If
  reproduced, file the bug, park the test using the team's
  `@ScheduledDisable` convention (NOT JUnit's bare `@Disabled` —
  this suite uses a custom annotation that takes a future-resume
  timestamp + a ticket-referencing reason):

```java
import com.sahibinden.web.annotation.disable.ScheduledDisable;

@ScheduledDisable(
    startTime = 1782950400000L,  // epoch-millis after which the test is expected to re-pass
    reason = "Bug mevcut - SHBDN-251142")
@WebTest
public void testOpenLeftMenuList() { ... }
```

`startTime` is epoch-milliseconds; pick a reasonable future date when
you expect the product fix to ship, then `hektor-test-repair` re-checks
disabled tests on each run. The `reason` string follows the team's
literal "Bug mevcut - <KEY>" pattern (or the English equivalent if the
test file is English) so disabled-test sweeps can grep for the
ticket.

### 5. Apply the fix

- Layout fix → edit the `@FindBy(...)` only. No business-logic changes.
- Test fix → edit the test method body. Don't change the class's tags,
  description, or method name unless the journey block in the map
  changed.
- Confirm with `gradle build -x test` then the same 3+3 reproduce sequence.
- 3/3 pass both envs → done.

### 6. Commit convention (reference only — never auto-commit)

**Do not commit.** Surface the fixed files and let the user commit.

The team's convention (for the user's reference) is a one-line
`SHBDN-<key>` message on a `tech/WEBT-<key>` branch — NOT
conventional-commits style:

```
SHBDN-251142
```

That's the entire commit message. The branch (`tech/WEBT-251142`) and
the PR title carry the human-readable context.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-failure-diagnosis",
    "status": "diagnosed-fixed | diagnosed-bug-reported | flake-document-only | needs-more-evidence",
    "next-action": "resume composer / repair / report bug"
  },
  "test": "com.sahibinden.web.ui.website.search.hybridsearch.HybridSearchFilterTest#testOpenLeftMenuList",
  "reproducibility": "stable | flaky | env-specific",
  "root-cause": "stale-selector | behaviour-change | flake-race | overlay | app-bug | infra",
  "fix-applied": {
    "files": ["client/website/layout/search/hybridsearch/LeftFilterLayout.java"],
    "summary": "Updated .tooltipText to .tooltipText-v2"
  },
  "bug-filed": null,
  "rerun-verdict": { "selenoid": "3/3 pass", "local": "3/3 pass" },
  "summary": "Selector drift — fixed in layout, re-green across 6 runs."
}
```

If diagnosis can't reach a verdict, return `status:
needs-more-evidence` with a list of artefacts you'd need (e.g., "the
Selenoid video for run 42 — can you grant access?"). Don't guess.
