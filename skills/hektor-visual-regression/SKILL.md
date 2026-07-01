---
name: hektor-visual-regression
description: >
  Manage Visual Regression Tracker (VRT) baselines for sahibinden using the
  framework's @VisualRegressionTest / @ParametrizedVisualRegressionTracker
  annotations and the @VisualRegression(...) parameter on
  @GenerateMethods. Use to add a new VRT-covered element, refresh a
  baseline after an intentional design change, or diagnose a VRT diff.
  Triggers on "lock visual regression for <page>", "update VRT baseline",
  "VRT diff is failing", or "screenshot regression test".
---

# Hektor visual regression

The framework already has visual regression coverage via the `vrt`
dependency (declared in `build.gradle.kts` as `vrtVersion = "1.6.2-SNAPSHOT"`)
and the `@VisualRegressionTest` test annotation + `@VisualRegression(...)`
on element fields. This skill is the workflow for using it correctly.

---

## When to add VRT coverage

Add a VRT assertion for:

- A high-visibility, design-stable element (homepage masthead, footer,
  category-tree, hybrid-search filter sidebar header).
- A regulated UI region (KVKK consent banner, cookie banner).
- A region whose layout regression would be visually obvious to users but
  not to functional assertions.

**Don't** add VRT for:

- Content that changes daily (search-result list, classified card body).
- Localised text (the diff threshold doesn't gracefully handle language
  toggles).
- Animated regions (loading spinners, banner carousels) unless you also
  pin the animation state.

---

## Procedure

### 1. Pin the element in the layout

In the layout file where the element lives:

```java
@GenerateMethods(
    isDisplayed = true,
    visualRegression = @VisualRegression(
        enabled = true,
        scrollIntoView = true,
        diff = 5    // 5% tolerance
    )
)
@FindBy(css = ".header__masthead")
private WebElement masthead;
```

`diff` is the percentage tolerance. Pick:
- `3` — tight, for chrome / nav / footers.
- `5` — default for content blocks with minor antialiasing drift.
- `10` — only for blocks with known stable variation (avatar, dynamic
  count badges) — and avoid VRT'ing those at all if you can.

### 2. Add the VRT test method

In a `*VRTTest` class (the framework keeps VRT separated). **Pick the
right annotation for the surface:**

- Desktop tests use `@VisualRegressionTest` (or
  `@ParameterizedVisualRegressionTest`).
- Mobile tests use `@MobileVisualRegressionTest` (or
  `@ParameterizedMobileVisualRegressionTest`).

Both annotations live at `com.sahibinden.web.annotation.test.*`. Mixing
them up will fail — `@VisualRegressionTest` on a responsive test won't
trigger the mobile VRT capture, and vice versa.


```java
@Tags({
    @Tag(MainTag.PARALLEL),
    @Tag(MainTag.VISUAL_REGRESSION),
    @Tag(Kure.SEARCH),
    @Tag(SearchDomain.HYBRID_SEARCH)
})
public class HybridSearchVRTTest extends TestDataResource {

  @AutowiredBean private HybridSearchPage hybridSearchPage;

  @VisualRegressionTest
  @Description("HybridSearch masthead visual regression baseline")
  public void testHybridSearchMastheadVRT() {
    hybridSearchPage
        .go(HybridSearchPageUrls.SEARCH_RESULT_PAGE)
        .getHeaderLayout()
        .checkVisualRegressionMasthead("hybrid_search_masthead");
  }
}
```

The framework generates `checkVisualRegressionMasthead(String snapshotName)`
from `@VisualRegression(enabled = true)`. The string is the baseline ID.

### 3. Create the baseline

Run the test once against the canonical environment (staging,
production, or the reserved testbox — confirm with the user; baselines
captured on one environment shouldn't be diffed against another). When
targeting the reserved box, paste `testbox.gradleArgs` from the ledger:

```
gradle test --tests "HybridSearchVRTTest.testHybridSearchMastheadVRT" \
    {{testbox.gradleArgs}} \
    -Dvrt.api.url=<team-vrt-url>
```

The first run creates the baseline; subsequent runs diff against it.
Note the testbox in the baseline's metadata so future diffs run against
the same target.

**Missing-baseline honesty.** A first run — or any run where the baseline
is absent — must NOT silently auto-baseline and count as a pass. Treat a
missing baseline as **inconclusive**: capture the candidate, surface it
for explicit authorisation (as in §5), and never count that run as
coverage. A baseline the suite minted for itself is not a passed
assertion (adapted from ECC browser-qa: "no baseline ⇒ INCONCLUSIVE,
never a silent PASS").

**Redaction.** Redact credentials/tokens and user PII (phone numbers,
names) from any screenshot or page-source before saving to the bundle —
this suite hits a live marketplace; reuse
`hektor-flaky-triage/core/sanitize-text.py`.

### 4. Diagnose a diff

When a VRT test fails:

1. Pull the VRT report URL from the failure log.
2. Open the diff in the VRT UI. Inspect:
   - **Pixel diff overlay** — where exactly did pixels change?
   - **Side-by-side** — baseline vs current.
3. Classify the diff:

| Diff cause | Action |
|---|---|
| Intentional design change | Refresh baseline (§5) |
| Font / antialiasing drift (browser update) | Increase `diff` tolerance by 1-2 or refresh |
| Localised text change | Move element out of VRT or pin language |
| Dynamic content (avatar, count) | Move element out of VRT |
| Genuine regression | File bug, DO NOT refresh baseline |

### 5. Refresh a baseline (intentional design change)

Only on explicit user authorisation — refreshing hides regressions.

```
gradle test --tests "...VRTTest.test...VRT" \
    {{testbox.gradleArgs}} \
    -Dvrt.api.url=<team-vrt-url> \
    -Dvrt.ci.build.id=<new-baseline-id>
```

Document the refresh in `docs/hektor/vrt-baseline-changes.md`:

```markdown
## 2026-05-21 — Hybrid search masthead refresh
- Baseline ID: hybrid_search_masthead
- Diff size: ~8% (logo updated by design team in #PR-4022)
- Authorized by: <user quote>
- Refreshed in commit <sha>
```

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-visual-regression",
    "status": "baseline-added | baseline-refreshed | diff-diagnosed | bug-filed",
    "next-action": "verify or report"
  },
  "subject": "hybrid_search_masthead",
  "action": "baseline-added",
  "diff-tolerance": 5,
  "vrt-baseline-id": "hybrid_search_masthead",
  "files-touched": [
    "client/website/layout/common/HeaderLayout.java",
    "ui/website/search/hybridsearch/HybridSearchVRTTest.java"
  ],
  "summary": "Added VRT coverage for hybrid-search masthead with 5% tolerance."
}
```
