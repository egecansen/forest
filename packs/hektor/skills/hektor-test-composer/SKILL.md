---
name: hektor-test-composer
description: >
  Compose the full test portfolio for ONE journey block from
  docs/hektor/journey-map.md — happy path, error states, edge cases, mobile
  variants, EDR/contract assertions, parameterised data variants. Writes one
  *Test.java class (or extends the existing one) at the suggested Java target
  path, dispatches hektor-page-authoring if a needed layout doesn't exist,
  dispatches hektor-resource-client / hektor-test-dao if a REST or SQL helper
  is missing (never writes those helpers in web-test), runs the new tests on
  Selenoid AND locally, and verifies coverage of every Test expectation in the
  journey block. Triggers when the user asks "write tests for j-X" or when
  hektor-coverage-expansion dispatches per-journey.
---

# Hektor test composer

**Scope:** exactly one journey per invocation. The iteration over many
journeys is `hektor-coverage-expansion`'s job, not yours.

You are responsible for the journey's complete test portfolio. Every step,
every branch, and every applicable state variation in its `Test
expectations:` list must have a corresponding test method before you return.

---

## Inputs

Caller passes:

- `journey: j-<id>` referencing a block in `docs/hektor/journey-map.md`,
  OR `scenario: <slug>` for ticket-driven calls from `hektor-from-jira`
  (where the scenario is described in the ticket plan, not the journey
  map).
- (Optional) `surface: website | responsivesite | both`. Default: both, if
  the journey block lists both surfaces.
- (Optional) `mode: autonomous | stop-on-failure`. Default `autonomous`.
- (Optional) `target-class: <FQCN>` — explicit class to extend (overrides
  the auto-mapping).
- (Optional) `ticket-context: <KEY>` — Jira ticket attribution; if set,
  the commit message line becomes `test(<KEY>): ...` and the test method
  gets a `// Covers <KEY> AC #N` short comment.

## Modes

| Mode | Failure handling |
|---|---|
| `autonomous` (default) | On failure, dispatch `hektor-failure-diagnosis` and loop until green or 3 diagnosis rounds elapse. The original behaviour — used by `hektor-coverage-expansion` and direct user invocations. |
| `stop-on-failure` | Compose the test, run on Selenoid + local once, return the failure unfixed. Do NOT dispatch failure-diagnosis. Used by `hektor-from-jira` so the caller can batch all failures across the ticket's scenarios and present them as one approval gate. |

Under `stop-on-failure` the return shape's `status` becomes
`composed-failed` instead of `covered-exhaustively`, and `failure-bundle:`
is populated with the stack, screenshot path, page-source path, and the
Selenoid video URL (if applicable) so the caller can pass them to
`hektor-failure-diagnosis` in `mode: propose-fix` later.

---

## Mandatory stages

In order, in your own context. Don't return until all six complete.

1. **Load context** (§1) — read the journey block + its sub-journeys + the
   conventions skill.
2. **Page/layout readiness** (§2) — dispatch `hektor-page-authoring` for
   any missing or incomplete layout method.
3. **Data-layer readiness** (§2b) — reuse an existing TDC/DAO method, or
   dispatch `hektor-resource-client` / `hektor-test-dao`. Never write a
   client or DAO in web-test.
4. **Compose** (§3) — write the test methods (one class or
   class-extension), matching the framework conventions.
5. **Stabilise** (§4) — run on Selenoid, then locally; fix flakes; re-run
   until 100% pass.
6. **Coverage verification** (§5) — map every `Test expectations:` bullet
   to a test method; loop back to §3 if any bullet is uncovered.

---

## §1 Load context

1. Verify `docs/hektor/journey-map.md` exists and line 1 is
   `<!-- hektor:journey-mapping -->`. If missing or wrong, stop and tell
   the caller to run `hektor-journey-mapping` first.
2. Locate the `### j-<id>` block. Read **only** that block plus referenced
   `sj-<slug>` sub-journey blocks. Don't load the whole map.
3. Read `hektor-conventions` if it isn't already loaded in this session.
4. Note these fields from the block:
   - `Priority` → drives variant set (table below).
   - `Surfaces` → drives whether you produce website tests, mobile tests, or
     both.
   - `Suggested Kure:` + `Suggested domain tags:` → drives the
     class-level `@Tags({...})`.
   - `Java targets (suggested):` → drives where the new test class lives.
   - `Existing test classes:` → drives whether you create a new class or
     extend an existing one.
   - `Test expectations:` → drives the test method list.
   - `EDR:` (if present) → drives EDR assertion structure.
5. **qagent pre-check (if available; see `hektor-qagent`).** Two queries
   before you write anything:
   - **Dedup.** `query_collection("testlist", "<journey in one sentence>",
     n_results=8, where={"kure": "<domain-kure>"})`. A close hit on
     `com.sahibinden.web.ui.website.*` / `.responsive.*` means the scenario
     likely already exists — open that class in the live repo and **extend
     it** rather than duplicating. A hit only on native
     (`sahibinden.tests.mainapp.*`) is a parity gap, not a dup. Verify every
     name in the repo before acting (the index can be stale).
   - **Rule-grounding.** For any `Test expectations:` bullet carrying a
     `[rule: confluence::…]` citation (or to enrich a thin bullet), pull the
     rule via `query_collection("<section>_business_rules", …)` and let the
     documented behaviour drive the assertion and the Turkish `@Description`
     text. Cite the rule id in a `// rule: confluence::…` comment.

   If `qagent` is unavailable, fall back to the existing dedup
   (`grep -r "@Description"`) and infer expectations from the block.

| Priority | Variant set |
|---|---|
| **P0** | happy path + 2+ error states + edge cases + mobile + data-lifecycle + EDR contract + VRT critical-snapshot |
| **P1** | happy path + 1+ error state + edge case + mobile (if applicable) + EDR assertion if `EDR:` set |
| **P2** | happy path + 1 error state + data-verification check |
| **P3** | smoke test (loads, key elements present) |

---

## §2 Page/layout readiness

For each interaction the journey requires, check whether the matching
layout method already exists.

Search pattern:

```bash
grep -r "clickRefreshOnClickButton\|isDisplayedTooltipText" \
  web-ui-test/src/main/java/com/sahibinden/web/client/
```

For any missing method, dispatch `hektor-page-authoring` with a brief
listing exactly which methods you need. Wait for that subagent to return
`page-authored` and verify `gradle build -x test` passes before continuing.

Do not write the test methods until every layout method you need exists.

---

## §2b Data-layer readiness

For every REST or SQL helper the scenario needs, search the **sibling
source** first — not the published JAR, not `web-ui-test/`.

```bash
PRIMARY="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
ROOT="$(dirname "$PRIMARY")"
grep -r "<method-or-endpoint>" "$ROOT/test-data-client/src/main/java" --include='*.java'
grep -r "<method-or-sql-intent>" "$ROOT/test-dao/src/main/java" --include='*DAO*.java'
```

Also check `AbstractTestDataResource` for an already-injected
`*ResourceClient` / `*DAO` field.

| Result | Action |
|---|---|
| Matching TDC method exists | Call it (`dopingResourceClient.getClassifiedPromotionWizard(...)`). |
| Matching DAO method exists | Call it (`classifiedDAO.getExpireClassifiedVehicleCategoryOneYearsOld()`). |
| REST helper missing | STOP. Dispatch `hektor-resource-client` with `ticket-context` and the method brief. Wait for `reused` or `authored`. |
| SQL helper missing | STOP. Dispatch `hektor-test-dao` the same way. |

Do **not** write `*Client.java`, `extends AbstractService`, `extends AbstractDAO`,
`*DAO.java`, RestAssured, or inline JDBC under `web-ui-test/` — that is the
WEBT-255458 `PromotionWizardClient` failure. `pr-rules-gate` denies it.

Do not write the test methods until every data helper exists in TDC/DAO (reused
or just authored). If a helper was authored, the next gradle run needs
`--refresh-dependencies`.

---

## §3 Compose

### File location

Use the journey block's `Java targets (suggested):` as the path. If
`Existing test classes:` names a class you can extend, prefer extending
that class with the new test methods. Otherwise create a new class.

### Class skeleton

For desktop:

```java
package com.sahibinden.web.ui.website.search.hybridsearch;

import static com.sahibinden.web.client.website.page.search.hybridsearch.HybridSearchPage
    .HybridSearchPageUrls.SEARCH_RESULT_PAGE;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sahibinden.web.TestDataResource;
import com.sahibinden.web.annotation.AutowiredBean;
import com.sahibinden.web.annotation.test.WebTest;
import com.sahibinden.web.client.website.page.search.hybridsearch.HybridSearchPage;
import com.sahibinden.web.util.suite.tag.MainTag;
import com.sahibinden.web.util.suite.tag.MainTag.Kure;
import com.sahibinden.web.util.suite.tag.SearchDomain;
import lombok.extern.slf4j.Slf4j;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Tags;
import org.springframework.context.annotation.Description;

@Tags({
    @Tag(MainTag.PARALLEL),
    @Tag(MainTag.READ_ONLY),
    @Tag(Kure.SEARCH),
    @Tag(SearchDomain.HYBRID_SEARCH),
    @Tag(SearchDomain.FILTER_SEARCH)
})
@Slf4j
public class HybridSearchIstanbulTest extends TestDataResource {

  @AutowiredBean
  private HybridSearchPage hybridSearchPage;

  @Tag(MainTag.PRODUCTION)
  @WebTest
  @Description("İstanbul filtresinde tooltip kontrolü")
  public void testIstanbulFilterTooltip() {
    hybridSearchPage
        .go(SEARCH_RESULT_PAGE)
        .getLeftFilterLayout()
        .clickRefreshOnClickButton()
        .waitInVisibilityLoadSpinner()
        .clickTooltipIcon();

    assertTrue(hybridSearchPage.getLeftFilterLayout().isDisplayedTooltipText());
  }
}
```

For mobile, the equivalent under
`web-ui-test/src/test/java/com/sahibinden/web/ui/responsive/search/...`
using `@MobileSiteTest` instead of `@WebTest` and the mobile page/layout.

### Self-check against `hektor-conventions` red flags

Before declaring §3 complete, walk the red-flag list in `hektor-conventions`:

- [ ] Class extends `TestDataResource`.
- [ ] Class-level `@Tags({...})` declares PARALLEL or SERIAL, a Kure, ≥1 domain.
- [ ] All pages injected via `@AutowiredBean`. No `new Page(...)`.
- [ ] No `WebElement` fields in the test file.
- [ ] No `By.xpath(...)` / `By.cssSelector(...)` in test method bodies.
- [ ] Every test method starts with `test...`.
- [ ] Every test method has `@Description(...)`.
- [ ] Non-test helpers are NOT in the class (move to a util if needed;
      `@MethodSource` parameter factories are exempt).
- [ ] URLs are imports from `<Page>PageUrls`, not inline strings.
- [ ] Dynamic locators (if any) go through `LocatorUtil.*` in the layout.
- [ ] If the test mutates tenant-shared state, class is tagged
      `MainTag.SERIAL`, not `PARALLEL`.

Reviewer rules added to the kernel — also walk these before declaring done:

- [ ] Method names are `camelCase` starting with `test` (no `test_foo` /
      `TestFoo`). **(BLOCKER-adjacent WARNING)**
- [ ] No `browser.findElement(By.…)`, `browser.getRemoteWebDriver()`, or
      `getShadowRoot()` anywhere in the test. **(BLOCKER)**
- [ ] Any `@ScheduledDisable` carries a `reason` parameter. **(BLOCKER)**
- [ ] No `Layout`-typed local variable, and no `getXxxLayout()` result assigned
      to a variable — chain straight off the page. **(WARNING)**
- [ ] No `@AutowiredBean` / `@Layout` field re-declared as a method-local
      (no shadowing). **(WARNING)**
- [ ] Every test method ends with an assertion; grouped asserts use
      `assertAll(...)` outside the chain and `assertx(...)` inside it;
      `checkVisualRegression*` is NOT nested in `assertx(...)`. **(WARNING)**
- [ ] No commented-out code, unused locals, or unused imports in the diff.
      **(WARNING)**
- [ ] Any new `@FindBy` (if you touched a layout) uses a real CSS/id/name
      selector — no XPath inside `@FindBy(css=…)`, no hardcoded URL, < 150
      chars. **(BLOCKER / WARNING)**
- [ ] No `extends AbstractService` / `*ResourceClient` / `extends AbstractDAO`
      / `*DAO.java` under `web-ui-test/`. REST → `hektor-resource-client`;
      SQL → `hektor-test-dao`. **(BLOCKER)**

Any check failing → fix before moving on. Don't commit failing-checklist
code. (If a TDC/DAO skill authored a helper, run that skill's red-flag list
too.)

### Parameterised variants

For data-lifecycle / multi-input variants, prefer `@ParameterizedWebTest`
+ `@ValueSource(strings = {...})` or `@MethodSource(...)` over hand-rolled
loops in one test:

```java
@ParameterizedWebTest
@ValueSource(strings = {"/otomobil", "/arazi-suv-pick-up"})
@Description("Çok markalı seçimde URL kontrolü")
public void testMultipleBrandSelection(String url) { ... }
```

### Mobile variants

`@MobileSiteTest` + the responsive page object. The class lives under
`ui.responsive.<section>.*`. Don't try to share a class between surfaces;
the existing suite keeps them separate.

### EDR contract assertions

If the journey block lists `EDR:` actions, structure the assertion like the
existing patterns in `HybridSearchFilterTest` (search "EDR" or
"KafkaEdrFields" in `src/test/`). Use the project's existing
`EdrTestCycleDataCtx` plumbing.

### Visual regression

If P0/critical, add a `@VisualRegressionTest` method on a separate class
following the existing VRT structure (see
`@Tag(MainTag.VISUAL_REGRESSION)` tests). `hektor-visual-regression`
covers the baseline-locking workflow if the user explicitly requests it.

---

## §4 Stabilise

**Read `testbox.gradleArgs` from `docs/hektor/run-status.json` once.**
Paste it verbatim onto every selenoid invocation. Use
`testbox.gradleArgsLocal` for the local pass. If the ledger has no
`testbox` block, refuse — the orchestrator owns the prompt.

1. `gradle build -x test` (no testbox flags needed for build).
2. Run against the reserved testbox:
   ```
   gradle test --tests "<FQCN>.<methodName>" {{testbox.gradleArgs}}
   ```
3. Run locally:
   ```
   gradle test --tests "<FQCN>.<methodName>" {{testbox.gradleArgsLocal}}
   ```
4. For any failure, escalate to `hektor-failure-diagnosis` (do not
   patch around it). When the diagnosis returns a fix, apply and re-run.
5. Re-run the whole test class until consecutive runs pass on Selenoid AND
   local. Flakiness budget: zero. A test that passes 4/5 runs is not done.

---

## §5 Coverage verification

Build the coverage matrix:

| Test expectation | Method covering it |
|---|---|
| Happy path | `testIstanbulFilterTooltip` |
| Error state: no results found | `testNoResultsState` |
| Edge case: filter combination 0 results | `testZeroResultsCombination` |
| Mobile | `ResponsiveHybridSearchTest.testIstanbulFilterTooltip` |
| EDR: SEARCHED, SEARCH_RESULT_VIEWED, ... | `testFilterEdrActions` |

For any unmapped expectation, loop back to §3 and write the missing test.
Don't claim coverage with skipped checks.

---

## Commit convention (reference only — never auto-commit)

**Do not commit.** Surface the ready files and let the user commit.
Never run `git commit` automatically after tests go green.

When the user explicitly asks to commit, the convention is:

| Position | Convention |
|---|---|
| Branch name | `tech/WEBT-<key>` (technical / test work) or `fun/WEBT-<key>` (functional / coverage). |
| Commit message (each commit) | `SHBDN-<key>` — one line, that's it. NOT conventional-commits style. |
| PR title | `Pull request #<NNNN>: Tech/WEBT-<key>` (Bitbucket auto-generates; Hektor does not author PR titles). |

Split layout changes and test additions into separate commits. Multiple
`SHBDN-<key>` commits on one branch is normal.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-test-composer",
    "status": "covered-exhaustively",
    "next-action": "advance to coverage-expansion or report"
  },
  "journey": "j-hybrid-search-istanbul",
  "surfaces": ["website", "responsivesite"],
  "test-classes": [
    "ui.website.search.hybridsearch.HybridSearchIstanbulTest",
    "ui.responsive.search.ResponsiveHybridSearchIstanbulTest"
  ],
  "test-methods-added": 5,
  "layouts-touched": [
    "client/website/layout/search/hybridsearch/LeftFilterLayout.java"
  ],
  "data-layer": {
    "reused": ["DopingResourceClient.getClassifiedPromotionWizard"],
    "authored": [],
    "tdc-branch": null,
    "dao-branch": null
  },
  "coverage-table": [
    { "expectation": "happy path", "method": "testIstanbulFilterTooltip" },
    { "expectation": "no-results error", "method": "testNoResultsState" }
  ],
  "selenoid-pass": true,
  "local-pass": true,
  "commits": ["abc1234 (SHBDN-245156: add LeftFilterLayout.clickTooltipIcon)",
              "def5678 (SHBDN-245156: testIstanbulFilterTooltip)"],
  "summary": "Composed 5 test methods across 2 surfaces; both green."
}
```

If a test couldn't be stabilised after 3 diagnosis rounds, return
`status: blocked` with the failure diagnosis attached — don't claim
coverage you can't run green.
