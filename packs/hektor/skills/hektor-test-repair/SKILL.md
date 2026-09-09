---
name: hektor-test-repair
description: >
  Batch-heal a rotted JUnit test suite by clustering failures by shared root
  cause and applying fixes per cluster instead of one-by-one. Triggers on
  "repair the suite", "fix the red tests", "the suite rotted",
  "diagnose all failures", or auto-escalates from hektor-failure-diagnosis
  when ≥5 distinct tests fail with related signatures. Do NOT use for a
  single failing test — that is hektor-failure-diagnosis.
---

# Hektor test repair

Heal many failing tests at once by finding the few shared causes that
explain most failures, then applying targeted fixes per cluster. Mirrors
Achilles' test-repair skill but tuned for Selenium + JUnit 5.

---

## Inputs

- A pointer to the failing run: the JUnit XML report
  (`web-ui-test/build/test-results/test/`), the CI build URL, or a tag
  filter.
- (Optional) The set of recent product / framework commits since the suite
  was last green — narrows the blame surface.

If the caller passes none of these, ask: "Where are the failing runs?"

---

## Procedure

### 1. Inventory failures

Parse the JUnit XML to enumerate `<testcase>` entries with `<failure>` or
`<error>` children. Build a flat table:

| FQCN#method | Surface | Tag(s) | Exception class | First-line message | Failing element selector (if visible) | Last 3 frames |

For each failure pull:
- Screenshot from `web-ui-test/temp/images/` matching the test name.
- The class-level tags (PARALLEL/SERIAL, Kure, domain) — clustering signal.

### 2. Cluster

Group by shared signature. Candidate cluster keys (try in this order):

1. **Same selector / element name** — `NoSuchElementException` mentioning
   the same `WebElement` field across N tests → one stale selector,
   N tests bleeding.
2. **Same overlay** — `ElementNotInteractableException` mentioning the same
   `clientX, clientY` region or the same `xxxLayout` blocker (cookie
   banner is the classic).
3. **Same exception type + same domain** — e.g., all
   `TimeoutException` on `Kure.SEARCH` tests → search service degraded
   or a shared selector in `LeftFilterLayout` drifted.
4. **Same product commit window** — failures all from tests touching pages
   the recent product commit changed.
5. **Same fixture / test data shape** — all failures on tests using
   `UserResourceClient.createXxxUser()` → fixture broke.
6. **Environment-specific** — Selenoid-only failures cluster separately
   from local-only.

A cluster needs ≥ 2 tests to be a cluster. Lone failures route to
`hektor-failure-diagnosis` instead.

Output (intermediate, scratch):

```
cluster-1 (12 tests, NoSuchElementException, '.tooltipText')
  - all in Kure.SEARCH
  - all reference LeftFilterLayout
  - root cause hypothesis: .tooltipText renamed in product
  - fix scope: one layout edit

cluster-2 (5 tests, ElementNotInteractableException, cookie banner)
  - mixed Kure
  - all run unauthed
  - root cause hypothesis: cookie banner overlay
  - fix scope: add CookieLayout.acceptCookies() in @BeforeEach to affected classes

cluster-3 (3 tests, AssertionError, payment success URL)
  - all in Kure.CLASSIFIED, post-classified flow
  - root cause hypothesis: success URL pattern changed
  - fix scope: update SuccessPageUrls constant + one assertion site
```

### 3. Per-cluster fix

For each cluster, dispatch one `hektor-failure-diagnosis` brief (or do
the diagnosis inline if the cluster's root cause is obvious from the
inventory) and apply ONE fix that resolves all members. Then re-run all
member tests.

Critical rule: **one fix per cluster**. Resist the temptation to patch the
test files individually — fix the layout or the fixture once.

If a cluster's "shared cause" turns out to be N distinct causes (the
hypothesis was wrong), split the cluster and re-fix.

### 4. Order of operations

Run cluster fixes in priority order:

1. Clusters that block many tests (cluster size DESC).
2. P0 / production-tagged clusters before others.
3. Selenoid-only clusters before local-only (CI gating).

Don't fix all clusters in parallel — the second cluster's hypothesis often
sharpens after the first cluster's fix lands. Sequential clusters, per-test
parallelism within a cluster.

### 5. Re-run

After each cluster fix, paste `testbox.gradleArgs` from
`docs/hektor/run-status.json`:

```
gradle test -Pkure_search_tests=true {{testbox.gradleArgs}}
```

(adjust the tag filter to the cluster). Confirm all formerly-red tests in
the cluster are green; confirm no green tests regressed.

After all clusters are addressed:

```
gradle test {{testbox.gradleArgs}}
gradle test {{testbox.gradleArgsLocal}}
```

Full suite, both environments (reserved testbox + local). Until both
report 0 failures, the repair isn't done.

**Loop antibody.** Repair drives to green — but green the honest way:
**green AND no spec deleted, weakened, or quarantined-without-reason, no
assertion loosened, no `Thread.sleep` added, coverage not lowered**.
Masking a regression is a bug to flag (§6), not a repair.

### 6. Bug-flagged escalations

For clusters whose root cause is an app bug (not a test/framework issue),
do not commit a "fix" that silences the test. Park the test methods with
the team's `@ScheduledDisable(startTime = <epoch-ms>, reason = "Bug
mevcut - SHBDN-<id>")` annotation from
`com.sahibinden.web.annotation.disable` (NOT JUnit's bare `@Disabled`).
Surface the bug separately. Track the disabled set in
`docs/hektor/disabled-tests.md`:

```markdown
# Disabled tests — bug-blocked

| Test | Bug | Disabled at | Reason |
|---|---|---|---|
| HybridSearchFilterTest#testTooltipText | WEBT-251142 | 2026-05-21 | tooltip text wrong in prod |
```

`hektor-test-repair` re-checks the disabled list each run; when the
upstream bug is closed (verified via the user or a status check),
re-enable the test.

---

## Commit convention (reference only — never auto-commit)

**Do not commit.** Surface the fixed files and let the user commit.
Never run `git commit` automatically after a cluster turns green.

When the user explicitly asks to commit, the convention is one-line
`SHBDN-<key>` commits — NOT conventional-commits. One commit per cluster
fix, using the bug-ticket key that triggered the repair. That's the
entire commit message — no body.

If multiple clusters trace to one bug ticket, multiple identical
`SHBDN-<key>` commits on the branch is normal (the team's recent log
already does this).

Per-cluster commits give a clean rollback path if a fix turns out wrong.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-test-repair",
    "status": "suite-green | partially-repaired | blocked-on-bugs",
    "next-action": "report or continue diagnosis"
  },
  "input-failures": 47,
  "clusters": [
    { "id": "cluster-1", "size": 12, "root-cause": "stale-selector .tooltipText",
      "fix": "LeftFilterLayout selector update", "status": "fixed" },
    { "id": "cluster-2", "size": 5,  "root-cause": "cookie-banner overlay",
      "fix": "@BeforeEach acceptCookies", "status": "fixed" },
    { "id": "cluster-3", "size": 3,  "root-cause": "payment success URL changed",
      "fix": "SuccessPageUrls constant", "status": "fixed" },
    { "id": "cluster-4", "size": 2,  "root-cause": "app-bug WEBT-251142",
      "fix": "@ScheduledDisable", "status": "bug-flagged" }
  ],
  "final-verdict": { "selenoid": "0 failures", "local": "0 failures" },
  "disabled-tests-added": 2,
  "commits": 4,
  "summary": "4 clusters healed; 2 tests parked behind app-bug WEBT-251142."
}
```
