---
name: hektor-page-authoring
description: >
  Author or modify *Page.java and *Layout.java files in
  web-ui-test/src/main/java/com/sahibinden/web/client/. Use BEFORE writing
  tests that target a route currently not covered by a Page/Layout pair.
  Enforces the @PageComponent / @PageLayout / @GenerateMethods / @Layout
  pattern from review.md and generateMethods.md. Triggers when
  hektor-test-composer reports a missing layout, or when the user asks
  "add a layout for X" or "create the page object for Y".
---

# Hektor page authoring

You author Page and Layout files that match the existing 940-test framework
conventions. You do not invent shapes. You mirror the closest existing
neighbour.

**Hard rule:** every file you create must compile (`gradle build -x test`)
and match `review.md`. Never commit code that bypasses any rule in
`hektor-conventions`.

---

## Inputs

The caller (typically `hektor-test-composer` or the user) tells you:

- **Surface** — `website` or `responsivesite` (or both — you author both).
- **Section / domain** — `search`, `classified.classifieddetail`, etc.
- **URL** — the route the page covers, e.g.,
  `BaseUrls.BASE_URL + "/elektronik/cep-telefonu"`.
- **Behaviours required** — the methods the layout must expose, e.g.,
  `clickRefreshOnClickButton`, `isDisplayedTooltipText`,
  `sendKeysPriceMin(String)`. The composer derives this list from the
  journey block's `Steps:` and `Test expectations:`.

If the caller gives you a vague brief ("make a layout for the filter
sidebar"), refuse and ask for the behaviour list. You don't guess methods.

---

## Procedure

### 1. Mirror the closest neighbour

For surface `website` + section `search`:

```bash
ls web-ui-test/src/main/java/com/sahibinden/web/client/website/page/search/
ls web-ui-test/src/main/java/com/sahibinden/web/client/website/layout/search/
```

Find the page/layout pair that handles the most similar feature. Read it
front-to-back so your new file matches the imports, the `extends`
declaration, the static URL constant convention, the `@Layout` ordering.

For surface `responsivesite`, do the same under
`client/responsivesite/`. The trees are NOT perfectly mirrored — the
responsive tree is flatter and uses a `Responsive*` class-name prefix.
Two concrete examples from the actual codebase:

- Desktop: `client/website/layout/search/hybridsearch/LeftFilterLayout.java`
  Mobile: `client/responsivesite/layout/search/ResponsiveSearchResultFilterLayout.java`
  (no `hybridsearch/` subdir on the mobile side; closely-related layouts
  live directly under `layout/search/`).
- Desktop: `client/website/page/home/HomePage.java`
  Mobile: `client/responsivesite/page/homepage/ResponsiveHomePage.java`
  (note `homepage`, not `home`, AND the `Responsive*` class prefix).

Before creating a new mobile file, **always** `ls
client/responsivesite/<area>/` to see how the team has organised THAT
section. Match the existing neighbour's depth and prefix; don't invent a
deeper subdir than already exists.

### 2. Live-DOM inspection

Before declaring any `@FindBy(...)`, **inspect the live DOM**.

**Lead first (qagent, if available; see `hektor-qagent`).** Query the
section's step traces to recover the selector + page object past runs
actually used for this interaction:

```
mcp__qagent__query_collection(
  collection_name="<section>_teststeps",   # arama_, ilan_, alisveris_, …
  query="<the interaction, e.g. 'POI location suggestion click'>",
  n_results=5)
```

The returned `elementSelector` / `pageName` is a **starting hint, NOT a
substitute for inspection** — the snapshot can be stale and the app may have
changed. Always confirm the candidate on the live DOM (`count > 0`) before
writing it. This narrows the search; it never ends it.

Approaches in priority order:

1. **Playwright MCP with testbox cookie injection (preferred).** The
   `plugin-playwright-playwright` MCP is always active. Navigate to the
   target page on the reserved testbox by:

   > **The testbox is dynamic — the user provides it at the start of every
   > chat session.** Read `<id>` and `<dataCenter>` from the testbox the
   > user stated in the current conversation (stored in
   > `docs/hektor/run-status.json` once the orchestrator writes it).
   > Never assume a value from a previous session.

   ```
   # Step A — land on the homepage to establish the domain context
   browser_navigate → https://www.sahibinden.com

   # Step B — inject testbox cookies
   #   <id>         = testbox id from current session  (e.g. 293)
   #   <dataCenter> = tbSite value from current session (x = ngn, y = gcp)
   browser_evaluate →
     () => {
       document.cookie = 'testBox=<id>; domain=.sahibinden.com; path=/; secure; samesite=None';
       document.cookie = 'tbSite=<dataCenter>; domain=.sahibinden.com; path=/; secure; samesite=None';
       return document.cookie.includes('testBox=<id>') ? 'cookies set' : 'FAILED';
     }

   # Step C — navigate to the target page
   browser_navigate → https://www.sahibinden.com/<path>
   ```

   **Never** use `http://xtbx<N>:8080` — that address is unreachable from
   the Playwright MCP sandbox. The cookies route the backend to the testbox.

   Once on the page, use `browser_evaluate` with `querySelectorAll` to
   bulk-check candidate selectors before writing any `@FindBy`. Only write
   a selector when `count > 0` on the live DOM.

   **When inspection is complete, close the browser:**
   ```
   browser_close
   ```
   Never leave the browser open after DOM inspection is finished.

2. **Read existing snapshots.** If `web-ui-test/temp/images/` has a recent
   screenshot of the page, look at it. The framework already takes them.
3. **Run an existing layout-development scratch test.** Many domains have a
   tiny scratch test that loads the page and pauses. Reuse the pattern.
4. **Browser DevTools, manually.** If nothing else works, ask the user to
   open the page in Chrome, capture the selectors, and dictate them.

**Never guess selectors from URL structure or training data.** Wrong
selectors are the #1 source of test flakiness in this suite.

### 3. Selector priority

Per `review.md`, prefer in this order:

1. `id` (`@FindBy(id = "price_min")`).
2. `data-*` attributes if the team uses them.
3. `css` selectors targeting class names or attribute paths.
4. `xpath` only when nothing else discriminates.

Avoid:
- `nth-of-type(N)` without a stable parent context.
- `:contains(...)` style text-matched selectors (Selenium doesn't support
  `:contains`; use XPath `[text()='...']` only when truly necessary).
- Selectors that depend on visible text — text shifts with translations.

For Turkish vs English text variations, use the layout's static `String`
constants pattern: declare both texts as constants, pick the right one based
on the language detector.

### 4. Layout shape

Author shape (mirror existing layouts exactly):

```java
package com.sahibinden.web.client.website.layout.search.hybridsearch;

import com.sahibinden.annotations.GenerateMethods;
import com.sahibinden.annotations.PageLayout;
import com.sahibinden.constants.AttributeTypes;
import com.sahibinden.web.client.facility.PageFacility;
import com.sahibinden.web.client.website.page.search.hybridsearch.HybridSearchPage;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.FindBy;

@PageLayout
public class LeftFilterLayout extends PageFacility<LeftFilterLayout> {

  public static final String TOOLTIP_EXPECTED_TEXT = "Beklenen tooltip metni";

  @GenerateMethods(click = true)
  @FindBy(css = ".js-refresh-on-click")
  private WebElement refreshOnClickButton;

  @GenerateMethods(isDisplayed = true)
  @FindBy(css = ".tooltipText")
  private WebElement tooltipText;

  @GenerateMethods(click = true, returnPage = HybridSearchPage.class)
  @FindBy(css = ".js-manual-search-button")
  private WebElement manualSearchButton;
}
```

Rules:
- `@PageLayout` on the class.
- `extends PageFacility<SelfType>`.
- Static constants for any literal text the layout's methods compare against.
- `@GenerateMethods(...)` on every `WebElement` field with the right
  interaction flags.
- `@FindBy(...)` next to the field.
- For methods that navigate to a different page, use
  `returnPage = TargetPage.class` on `@GenerateMethods`.

### 5. Page shape

Author shape (mirror existing pages exactly):

```java
package com.sahibinden.web.client.website.page.search.hybridsearch;

import com.sahibinden.web.annotation.Layout;
import com.sahibinden.web.annotation.PageComponent;
import com.sahibinden.web.client.BaseUrls;
import com.sahibinden.web.client.facility.PageFacility;
import com.sahibinden.web.client.website.layout.common.HeaderLayout;
import com.sahibinden.web.client.website.layout.search.hybridsearch.LeftFilterLayout;
import com.sahibinden.web.client.website.layout.search.hybridsearch.SearchResultLayout;
import lombok.Getter;

@Getter
@PageComponent
public class HybridSearchPage extends PageFacility<HybridSearchPage> {

  public abstract static class HybridSearchPageUrls {
    public static final String SEARCH_RESULT_PAGE =
        BaseUrls.BASE_URL + "/real-estate-for-sale";
    public static final String SEARCH_RESULT_ISTANBUL_PAGE =
        BaseUrls.BASE_URL + "/real-estate-for-sale/istanbul";
  }

  @Layout private HeaderLayout headerLayout;
  @Layout private LeftFilterLayout leftFilterLayout;
  @Layout private SearchResultLayout searchResultLayout;
}
```

Rules:
- `@PageComponent` on the class.
- `extends PageFacility<SelfType>`.
- URLs in a `<Name>PageUrls` static inner class.
- `@Layout` fields, **NO** `WebElement` fields, **NO** `new`ed layouts.
- Lombok's `@Getter` (the existing pages use it) so `page.getXxxLayout()`
  works for tests.

### 6. Dynamic locator helpers

If the layout needs dynamic locators, the helper method goes on the layout
(`hektor-conventions` documents this):

```java
@FindBy(css = "li[data-id='{categoryId}'] .item:nth-of-type(999)")
private WebElement subCategoryItem;

public WebElement getSubCategoryItem(String categoryId, int itemIndex) {
  return LocatorUtil.getDynamicWebElement(
      subCategoryItem, categoryId, String.valueOf(itemIndex));
}
```

Never put dynamic locator builders in a test method body.

### 7. Cross-page actions

Methods that traverse to a different page chain via `@GenerateMethods(click,
returnPage = X.class)` for static destinations, or `genericReturnClick =
true` for dynamic destinations:

```java
@GenerateMethods(genericReturnClick = true)
@FindBy(css = ".js-card")
private WebElement classifiedCard;

// generates: public <T extends PageFacility> T clickClassifiedCard(Class<T> page)
```

Tests then call:

```java
ClassifiedDetailPage detail = searchPage
    .getSearchResultLayout()
    .clickClassifiedCard(ClassifiedDetailPage.class);
```

### 8. Both surfaces

If the journey applies to both `website` and `responsivesite`, author the
mobile counterpart in the same commit:

```
client/website/layout/search/hybridsearch/LeftFilterLayout.java
client/responsivesite/layout/search/Responsive<Name>FilterLayout.java
```

The responsive tree is flatter — the mobile equivalent often lives one
directory shallower than its desktop counterpart and always carries the
`Responsive*` class-name prefix. Find the closest existing mobile layout
for the same area (e.g. `ls client/responsivesite/layout/search/`) and
match its depth + prefix exactly. Don't create a `hybridsearch/` subdir
on the mobile side just because one exists on desktop.

---

## Validation before commit

Run, in order:

1. `gradle build -x test` — must compile. The `@GenerateMethods` annotation
   processor runs here; if your `@GenerateMethods` declaration is wrong, the
   build fails.
2. Find the existing tests that import the page you touched (`grep -r
   "import com.sahibinden.web.client.website.page.search.hybridsearch
   .HybridSearchPage;" web-ui-test/src/test/`). Re-run them locally to
   confirm you didn't break method names downstream. (Renaming a field
   renames its generated method.)
3. Re-read `review.md` checklist items against your diff. The frequent
   misses:
   - Forgot `@Layout` on a new layout field on a page.
   - Forgot `@GenerateMethods` on a `WebElement` field.
   - Imported the wrong builder package (must use the builder-generated
     namespace, not the base layout — see `review.md` rule on imports).
   - Returned a layout from another page (forbidden — only own-page layouts).

---

## Refusal cases

- Caller gives you a method list but no URL. Refuse — ask for the URL.
- Caller asks you to "fix" a layout but won't say what's wrong. Refuse — ask
  for the failing test name or the missing method.
- The DOM inspection failed and you'd be guessing selectors. Refuse — ask
  for screenshots or a manual inspection.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-page-authoring",
    "status": "page-authored",
    "next-action": "advance to test composition"
  },
  "files-created": [
    "web-ui-test/src/main/java/com/sahibinden/web/client/website/layout/search/hybridsearch/LeftFilterLayout.java",
    "web-ui-test/src/main/java/com/sahibinden/web/client/website/page/search/hybridsearch/HybridSearchPage.java"
  ],
  "files-modified": [],
  "methods-exposed": [
    "LeftFilterLayout.clickRefreshOnClickButton",
    "LeftFilterLayout.isDisplayedTooltipText",
    "LeftFilterLayout.clickManualSearchButton (returns HybridSearchPage)"
  ],
  "build-passed": true,
  "surface": "website",
  "summary": "Added LeftFilterLayout with 3 methods on HybridSearchPage."
}
```
