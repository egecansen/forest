---
name: hektor-conventions
description: >
  The framework-rules kernel for sahibinden/web-test. Use BEFORE writing any
  *Page.java, *Layout.java, or *Test.java file. Captures the rules from
  review.md (the team's PR checklist) and web-ui-test/generateMethods.md (the
  @GenerateMethods annotation processor), plus tag taxonomy, page/layout
  pattern, dynamic locators, and DI rules. Triggers on any request that
  involves authoring or reviewing Java test code in this repo. Always
  consulted before generating code — do not guess.
---

# Hektor conventions — must-know framework rules

This skill is a reference, not a workflow. Load it when you are about to
write or review code in `web-ui-test/`. Every rule here comes from
`review.md` (the PR checklist) and `web-ui-test/generateMethods.md` (the
annotation processor docs) — those two files are kernel. Re-read them if
in doubt; this skill summarises them for fast lookup.

---

## Annotation packages — two roots

The framework's annotations live across **two** sahibinden packages plus
one Spring import. Don't auto-import the wrong one — IDEs guess wrong here
(in particular for `@PageComponent` vs `@PageLayout`).

| Package | Annotations |
|---|---|
| `com.sahibinden.annotations` (the annotation-processor module) | `@PageLayout`, `@GenerateMethods`, `@VisualRegression` |
| `com.sahibinden.web.annotation` | `@PageComponent`, `@Layout`, `@AutowiredBean`, `@Cookies`, `@LocalStorage`, `@EdrName`, `@FindByImage`, `@PropertyComponent`, `@WebStorage`, `@ABSwitch`, `@Restriction` |
| `com.sahibinden.web.annotation.test` | `@WebTest`, `@ParameterizedWebTest`, `@MobileSiteTest`, `@ParameterizedMobileSiteTest`, `@VisualRegressionTest`, `@MobileVisualRegressionTest`, `@ParameterizedVisualRegressionTest`, `@ParameterizedMobileVisualRegressionTest`, `@ZapSecurityTest` |
| `org.springframework.context.annotation` | `@Description` — NOT a sahibinden annotation; comes from Spring. |

`@Tag` / `@Tags` are JUnit Jupiter (`org.junit.jupiter.api.Tag`,
`org.junit.jupiter.api.Tags`). Don't import `org.testng.*` — this is a
JUnit 5 suite.

---

## File layout

```
web-ui-test/src/main/java/com/sahibinden/web/
├── client/
│   ├── website/                # desktop surface
│   │   ├── page/<domain>/<Name>Page.java
│   │   └── layout/<domain>/<Name>Layout.java
│   └── responsivesite/         # mobile surface — flatter tree, Responsive* prefix
│       ├── page/<area>/Responsive<Name>Page.java
│       └── layout/<area>/Responsive<Name>Layout.java
├── annotation/                 # @WebTest, @MobileSiteTest, @Layout, @Cookies, ...
└── util/suite/tag/             # MainTag, Kure, *Domain, tagx/*

web-ui-test/src/test/java/com/sahibinden/web/ui/
├── website/<domain>/<Name>Test.java
├── responsive/<domain>/<Name>Test.java
└── security/...                # ZAP / sensitivedata
```

Pages and layouts split between `website` (desktop) and `responsivesite`
(mobile), but the trees are **not strict mirrors** — the responsive side
is flatter and uses a `Responsive*` class-name prefix on every class.
Examples from the actual code:

- Desktop home: `client/website/page/home/HomePage.java`
  Mobile home: `client/responsivesite/page/homepage/ResponsiveHomePage.java`
  (`homepage`, not `home`; `Responsive*` prefix).
- Desktop hybrid-search left filter:
  `client/website/layout/search/hybridsearch/LeftFilterLayout.java`
  Mobile equivalent (closest):
  `client/responsivesite/layout/search/ResponsiveSearchResultFilterLayout.java`
  (no `hybridsearch/` subdir on mobile side; layout lives directly under
  `layout/search/`).

When adding a mobile file, **always `ls` the responsive area first** and
mirror the existing neighbour's depth and naming — don't invent a deeper
subdir than the team already uses there.

---

## The Page / Layout pattern

### Page

```java
@PageComponent
public class HybridSearchPage extends PageFacility<HybridSearchPage> {

  public abstract static class HybridSearchPageUrls {
    public static final String SEARCH_RESULT_PAGE =
        BaseUrls.BASE_URL + "/real-estate-for-sale";
    // every URL the test uses lives here, NOT in the test file
  }

  @Layout private LeftFilterLayout leftFilterLayout;
  @Layout private SearchResultLayout searchResultLayout;
  @Layout private HeaderLayout headerLayout;

  // pages can hold helper methods that span layouts, but NEVER WebElement fields
}
```

Rules:
- `@PageComponent` on the class.
- `extends PageFacility<SelfType>` — self-typed.
- URLs live in a `<Name>PageUrls` abstract static inner class.
- **NO `WebElement` fields on pages.** Ever.
- Layouts are declared as fields with `@Layout`. The framework builder
  instantiates them — never `new` a layout.
- Methods that navigate to another page either use `@GenerateMethods(click,
  returnPage = X.class)` on the underlying element, or do
  `return appContext.getBean(TargetPage.class)`. **Never** `new
  TargetPage(...)`.

### Layout

```java
@PageLayout
public class LeftFilterLayout extends PageFacility<LeftFilterLayout> {

  public static final String OFFERABLE_CLASSIFIEDS = "Teklif verilebilir ilanlar";

  @GenerateMethods(sendKeys = true, getAttributeType = AttributeTypes.VALUE)
  @FindBy(css = "input[id='price_min']")
  private WebElement priceMin;

  @GenerateMethods(click = true, returnPage = HybridSearchPage.class)
  @FindBy(css = ".js-manual-search-button")
  private WebElement manualSearchButton;
}
```

Rules:
- `@PageLayout` on the class. **The class name MUST end in `Layout`** (or
  `LayoutBase` for a shared base). The reviewer BLOCKS a `@PageLayout` class
  whose name doesn't. `[PR-reviewer: BLOCKER]`
- `extends PageFacility<SelfType>`.
- **Every** `WebElement` field gets `@GenerateMethods(...)` listing the
  interactions you need: `click`, `sendKeys`, `getText`, `isDisplayed`,
  `getAttribute`, `getAttributeType`, etc. See
  `web-ui-test/generateMethods.md` for the full property list.
- Selector priority (per `review.md`): `id` > `css` > rest.
  - **Never put an XPath expression inside a non-xpath `@FindBy`** — e.g.
    `@FindBy(css = "//div[@class='x']")` is a broken locator the reviewer
    BLOCKS. The value of `@FindBy(css=…/id=…/name=…)` must be a real
    CSS/id/name selector, not `//…`, `./…`, or `[@…]`. If you genuinely need
    XPath, use `@FindBy(xpath = "…")`. `[PR-reviewer: BLOCKER]`
  - **No hardcoded URL inside `@FindBy`** (`http://…` / `https://…` in the
    selector value). `[PR-reviewer: WARNING]`
  - Keep selectors short — a selector ≥ 150 characters is flagged; anchor on a
    stable `id` / `data-*` attribute and shorten. `[PR-reviewer: WARNING]`
- A layout class may **not** return another page's layout. It returns its
  own page (via the `returnPage` on `@GenerateMethods`) or itself.
  `[PR-reviewer: WARNING]`
- **Never reach for the raw driver** — `browser.getRemoteWebDriver()` and
  `getShadowRoot()` are BLOCKED in a `*Layout.java` (and `*Test.java`). Use
  the framework's element APIs. `[PR-reviewer: BLOCKER]`
- Layout class names end in `Layout` (or `LayoutBase` for shared bases).

### Pages, layouts, and the generated method names

The annotation processor turns `@GenerateMethods(click = true)` on a field
named `manualSearchButton` into `clickManualSearchButton()`. The return type
follows from the field's annotation:

| Annotation | Method on layout |
|---|---|
| `click = true` | `<Layout> clickFoo()` (self-return) |
| `click = true, returnPage = X.class` | `X clickFoo()` |
| `genericReturnClick = true` | `<T extends PageFacility> T clickFoo(Class<T> page)` |
| `sendKeys = true` | `<Layout> sendKeysFoo(String text)` |
| `getText = true` | `String getTextFoo()` |
| `isDisplayed = true` | `boolean isDisplayedFoo()` |
| `getAttribute = true` | `String getAttributeFoo(String attr)` |
| `getAttributeType = {AttributeTypes.HREF}` | `String getAttributeHrefFoo()` |
| `waitForVisibility = true` | `<Layout> waitForVisibilityFoo(int timeout)` |
| `getListText = true` (on `List<WebElement>`) | `List<String> getListTextFoo()` |

Generated methods you can rely on — never hand-write a method that already
has a `@GenerateMethods` form. If the form doesn't exist for what you need,
add the property to `@GenerateMethods`; don't write a one-off helper.

**Common anti-patterns to avoid:**
- Writing a manual `clickFoo()` method that just calls `browser.click(foo)` or
  `jExecutor.click(foo)` — add `click = true` to `@GenerateMethods` instead.
- Writing a wrapper method like `openFooPanel()` that only calls a single
  generated click — let the test call `clickFoo()` directly.
- Adding `browser.waitUntilVisibilityOfElement(...)` as a post-click wait inside
  a layout helper — the test chain handles ordering; keep layout methods atomic.
- Calling `stream().map(...getText...)` over a `List<WebElement>` field — declare
  the field as `List<WebElement>` with `@GenerateMethods(getListText = true)`
  (or `getText = true`) and call the generated `getListTextFoo()` /
  `getTextFoo()` instead. `[PR-reviewer: WARNING]`
- Passing conflicting or redundant `@GenerateMethods` parameters — e.g. two
  return-mode flags, or a parameter the field's type can't use. List only the
  interactions the element actually needs. `[PR-reviewer: WARNING]`

---

## Test class anatomy

```java
@Tags({
    @Tag(MainTag.PARALLEL),
    @Tag(MainTag.READ_ONLY),
    @Tag(Kure.SEARCH),
    @Tag(SearchDomain.HYBRID_SEARCH),
    @Tag(SearchDomain.FILTER_SEARCH)
})
@Slf4j
public class HybridSearchFilterTest extends TestDataResource {

  @AutowiredBean private HybridSearchPage hybridSearchPage;
  @AutowiredBean private UserResourceClient userResourceClient;

  @Tag(MainTag.PRODUCTION)
  @WebTest
  @Description("Hybrid arama sonuç sayfasında filter tooltip kontrolü")
  public void testOpenLeftMenuList() {
    hybridSearchPage
        .go(HybridSearchPageUrls.SEARCH_RESULT_PAGE)
        .getLeftFilterLayout()
        .clickRefreshOnClickButton()
        .waitInVisibilityLoadSpinner()
        .scrollFilterKeyword()
        .clickTooltipIcon();

    assertTrue(hybridSearchPage.getLeftFilterLayout().isDisplayedTooltipText());
  }
}
```

Rules:
- Class name ends in `Test`.
- `extends TestDataResource`.
- Class-level `@Tags({...})` ALWAYS declares: one of `PARALLEL` / `SERIAL`,
  one `Kure` (sphere), one or more domain tags.
- Pages injected via `@AutowiredBean`. Never `new`.
- Method names start with `test`.
- Every test method has `@Description("...")`. Three patterns are in use — pick
  the right one for the context:

  | Situation | Pattern |
  |---|---|
  | Default | Plain Turkish action sentence: `@Description("Bireysel kullanıcı önceden verilmiş ilanına dinamik doping alır")` |
  | Wide-scope product area | Domain/feature prefix: `@Description("VasıtaPro - Satış Danışmanı Performans Takibi(Kullanıcı Takip Paneli)")` |
  | Complex scenario — multiple preconditions or ordered steps | Multi-line text block: `@Description("""\n    Sıfır araç fiyatı bulunan ilan favoriye eklenmiş,\n    satıcı fiyatı üç kez değiştirir,\n    tarihçede başlangıç ve güncel fiyat doğru görünür""")` |

  Hard rules:
  - **Turkish is primary; English is acceptable.**
  - **Never include ticket keys (SHBDN-XXXXX, WEBT-XXXXX) in `@Description`.**
    Ticket keys belong in branch names and commit messages only.
  - Never emit a placeholder such as `@Description("TODO : Açıklama doldurulacak")`.
  - When extending an existing test class, match that class's existing description style.
- The test annotation `@WebTest` is for desktop, `@MobileSiteTest` for
  responsive, `@VisualRegressionTest` for VRT, `@ZapSecurityTest` for
  security. Parameterized versions exist (`@ParameterizedWebTest` +
  `@ValueSource(...)`).
- If you disable a test with `@ScheduledDisable`, the **`reason` parameter is
  MANDATORY**: `@ScheduledDisable(reason = "flaky on filter, tracked
  internally")`. A bare `@ScheduledDisable` is BLOCKED. `[PR-reviewer: BLOCKER]`
- Method names are `camelCase` starting with `test` — never snake_case
  (`test_foo`) or PascalCase (`TestFoo`). `[PR-reviewer: WARNING]`
- Test methods compose actions via chained layout calls. **No `By.xpath(...)`
  or `By.cssSelector(...)` inside a test method body.** That selector goes
  to the layout.
- **No raw driver / shadow-root reach-through in a test** —
  `browser.findElement(By.…)`, `browser.getRemoteWebDriver()`, and
  `getShadowRoot()` are BLOCKED inside `*Test.java`. Drive through layout
  methods. `[PR-reviewer: BLOCKER]`
- **No `Layout`-typed variables in a test.** Don't declare a `SomeLayout foo =
  …` local, and don't assign the result of a `getXxxLayout()` call to a
  variable. Chain straight off the page
  (`page.getXxxLayout().clickY()`), or re-call `page.getXxxLayout()` each time.
  `[PR-reviewer: WARNING]`
- **No field shadowing.** An `@AutowiredBean` / `@Layout` dependency is a class
  field only — never re-declare the same name as a local inside a method.
  `[PR-reviewer: WARNING]`
- **No commented-out code, and no unused locals or imports** in the diff — the
  reviewer flags each. `[PR-reviewer: WARNING]`

### Test class is method-only

`review.md` rule: "Test class larda test methodu haricinde method
yazılmamalıdır." Don't add helper methods to a test class. Helpers go on
the page, layout, or a util class. `@MethodSource` factory methods that feed
`@ParameterizedWebTest` are the one exemption — they may live on the class.
`[PR-reviewer: WARNING]`

### Assertions

- **Every test method must assert.** A method that drives actions but ends
  without any assertion is flagged — close it with at least one `assertX` /
  `assertAll`. `[PR-reviewer: WARNING]`
- **Group related assertions with `assertAll(...)`** rather than a run of
  separate `assertTrue(...)` / `assertEquals(...)` statements outside the chain.
  `[PR-reviewer: WARNING]`
- **Inside a fluent chain, use `assertx(...)`** (the chainable assertion), not
  `assertAll(...)`. Keep `assertAll(...)` for the standalone grouped block
  outside the chain. `[PR-reviewer: WARNING]`
- **Keep `checkVisualRegression*` out of `assertx(...)`.** VRT checks belong on
  their own VRT chain, not nested inside a functional `assertx(...)`.
  `[PR-reviewer: WARNING]`

---

## Tag taxonomy

| Family | Where | Picking |
|---|---|---|
| Execution mode | `MainTag.PARALLEL` / `MainTag.SERIAL` | PARALLEL by default; SERIAL only when the test mutates tenant-shared state. |
| Sphere ("küre") | `Kure.SEARCH`, `Kure.CLASSIFIED`, `Kure.INDIVIDUAL`, `Kure.SHOPPING`, `Kure.S360`, `Kure.LONDON`, `Kure.YEPY`, `Kure.OPERATION`, `Kure.SEO`, `Kure.NATIVEAD`, `Kure.KURUMSAL_TEMEL`, `Kure.KURUMSAL_EK` | Exactly one. The feature's owning team. |
| Domain | `SearchDomain.*`, `ClassifiedDomain.*`, `IndividualDomain.*`, `ShoppingDomain.*`, `CorporateDomain.*`, `FinanceDomain.*`, `S360Domain.*`, `LondonDomain.*`, `YepyDomain.*`, `OperationDomain.*` | One or more. The subsystem(s) exercised. |
| Gating | `MainTag.PRODUCTION` (runs in prod canary), `MainTag.FASTTRACK`, `MainTag.HOTFIX`, `MainTag.READ_ONLY` | Optional, opt-in. |
| Cross-cutting | `MainTag.EDR`, `MainTag.SECURITY`, `MainTag.VISUAL_REGRESSION`, `MainTag.KVKK`, `MainTag.RESPONSIVE`, `MainTag.NETWORK`, `MainTag.MICROSERVICE` | Add when applicable. |

**Don't invent tags.** Look at the existing tag class for the domain you're
touching:
`web-ui-test/src/main/java/com/sahibinden/web/util/suite/tag/`.

If a tag is genuinely missing, add it to the right tag class as part of
your change — but check first that an existing tag doesn't already cover it.

---

## Dynamic locators

For elements whose selector varies at runtime (index, attribute value), use
`{placeholder}` in the `@FindBy` and `LocatorUtil.getDynamicWebElement(...)`
in the layout method:

```java
@FindBy(css = "[scrollbar='category_select_scrollbar{boxIndex}'] li:nth-of-type(999)")
private WebElement subCategoryItem;

public WebElement getSubCategoryItem(String boxIndex, int itemIndex) {
  return LocatorUtil.getDynamicWebElement(subCategoryItem, boxIndex, String.valueOf(itemIndex));
}
```

Rules (per `review.md`):
- The placeholder name is the variable's purpose (`{boxIndex}`, `{categoryId}`).
- `999` is the reserved literal for "index that will be replaced".
- The replacement order matches the placeholder order in the selector.
- **Never** build a `By.xpath("..." + variable + "...")` inside a test method.

Variants:
- `LocatorUtil.getDynamicLocator(...)` — returns `By`.
- `LocatorUtil.getDynamicWebElement(...)` — returns `WebElement`.
- `LocatorUtil.getDynamicWebElementList(...)` — returns `List<WebElement>`.

---

## Cookies, storage, browser handle

```java
@Cookies(key = "nwsh", value = "fct")
private Cookie nwsh;

public void addCookieNWSH() {
  addCookie(nwsh);  // CookieManager provides addCookie
}
```

```java
@LocalStorage(key = "walkthrough_shown", value = "true", desc = "...")
private String[] walkthroughShown;

public void setWalkthroughShown() {
  localStorage.setItem(walkthroughShown[0], walkthroughShown[1]);
}
```

When you genuinely need the raw browser:

```java
WebTestContextProvider.get().getBrowser().addCookie(myCookie);
```

But prefer the layer-of-purpose API (`CookieManager`, `LocalStorageManager`,
layout methods) over reaching for `getBrowser()`.

---

## Test data and self-credentialing

```java
@AutowiredBean protected UserResourceClient userResourceClient;
```

Get a fresh user from the resource client. Don't hard-code `test@test.com`,
don't seed accounts in the test file, don't share users between
SERIAL-tagged tests that mutate.

For data that REST exposes, the resource client lives at the
`com.sahibinden.client.*` namespace and is injected via `@AutowiredBean` on
the test class (typically via `TestDataResource`).

---

## Build, run, and environment

| What | How |
|---|---|
| Build | `gradle build -x test` (always works; never `--no-verify`) |
| **Testbox** | **`-Dui.testbox=<id>`** — MANDATORY for selenoid / se_grid / local_selenoid / local_se_grid launchpads. URL the framework targets is `http://${dataCenter}tb${dataCenter}${testbox}` (see `build.gradle.kts:624 checkTestBoxState`). |
| Data centre | `-Denv.data.center=x` (ngn, default) or `=y` (gcp) |
| Launchpad | `selenoid` (default), `se_grid`, `local_selenoid`, `local_se_grid`, `local` (the only launchpad that doesn't need a testbox — uses the engineer's own browser) |
| Browser | `-Dui.browser.type=chrome` (default) or `firefox` |
| Run all | `gradle test -Dui.testbox=<id> -Denv.data.center=<dc> -Denv.launchpad=<...>` |
| Run by tag | `gradle test -P<tagName>=true -Dui.testbox=<id> -Denv.data.center=<dc> -Denv.launchpad=<...>` |
| Parallel | `-Djunit.jupiter.execution.parallel.enabled=true` |

**The testbox is non-negotiable.** Every Hektor session asks for the
reserved testbox before running anything; the value is recorded in
`docs/hektor/run-status.json` and inherited by every `gradle test`
invocation. Running without `-Dui.testbox` against a non-local
launchpad targets `http://xtbx` (no suffix) which hits nothing real —
and even if it did, it would clash with someone else's reservation.

When running tests as part of a Hektor phase, ALWAYS:
1. Run against the reserved testbox first (matches CI shape).
2. Confirm the test also passes locally (`-Denv.launchpad=local`) before
   committing — `review.md` requires both.

---

## Red flags — refuse to commit code that does any of these

1. `WebElement` field declared on a `*Page.java`.
2. `new SomethingLayout(...)` or `new SomethingPage(...)` anywhere.
3. `By.xpath(...)` / `By.cssSelector(...)` inside a `*Test.java` method.
4. A `*Test.java` class with a non-test helper method on it.
5. A `*Test.java` without class-level `@Tags({...})` declaring
   PARALLEL/SERIAL + Kure + domain.
6. A test method without `@Description(...)`.
7. A `WebElement` field without `@GenerateMethods(...)`.
8. Hard-coded credentials (email, password, token, masterpass key) in any
   `*Test.java` file.
9. URL string concatenated inline in a test instead of a constant in
   `<Page>PageUrls`.
10. Dynamic locator built via string concatenation instead of `LocatorUtil`.
11. A manual layout method that only wraps a single `browser.click(...)` /
    `jExecutor.click(...)` call — add `click = true` to `@GenerateMethods`
    and remove the hand-written method. The test calls the generated method
    directly.
12. Inline comments above `@GenerateMethods` / `@FindBy` field declarations
    explaining what the element is or referencing ticket keys. The field name
    and selector are self-documenting; the ticket key belongs in the branch
    name and commit message only.
13. A `@PageLayout` class whose name doesn't end in `Layout` / `LayoutBase`.
    **(BLOCKER)**
14. An XPath expression (`//…`, `./…`, `[@…]`) inside a non-xpath
    `@FindBy(css=…/id=…/name=…)`. **(BLOCKER)**
15. `browser.getRemoteWebDriver()`, `getShadowRoot()`, or
    `browser.findElement(By.…)` in a `*Test.java` or `*Layout.java`.
    **(BLOCKER)**
16. `@ScheduledDisable` without a `reason` parameter. **(BLOCKER)**
17. A `Layout`-typed local variable in a test, or a `getXxxLayout()` result
    assigned to a variable. **(WARNING)**
18. An `@AutowiredBean` / `@Layout` field re-declared as a method-local
    (shadowing the class field). **(WARNING)**
19. A method name that isn't `camelCase` (snake_case / PascalCase).
    **(WARNING)**
20. Commented-out code, an unused local variable, or an unused import left in
    the diff. **(WARNING)**
21. `stream().map(...getText...)` over a `List<WebElement>` instead of a
    `@GenerateMethods(getListText = true)` generated method. **(WARNING)**
22. A test method that ends without any assertion; `checkVisualRegression*`
    nested inside `assertx(...)`; or a run of singular assertions outside the
    chain that should be grouped with `assertAll(...)`. **(WARNING)**
23. A magic number / literal value repeated 3+ times in the file — extract a
    `static final` constant (`0` / `1` and `static final` declarations are
    exempt). **(WARNING)**

Items 1–16 are reviewer **BLOCKERs** — refuse to commit code that trips one.
Items 17–23 (and 9 above where inline) are reviewer **WARNINGs**: they don't
block the merge, but the bot leaves an inline comment, so fix them in the same
pass unless there's a documented reason. If you catch any BLOCKER in code the
user asked you to commit, refuse and explain which rule was violated. The
downstream `hektor-test-composer` self-checks against this list before
declaring its work done, and the `pr-rules-gate.sh` hook scans your working
tree at write-time.

---

## Sibling repo: test-data-client (resource clients)

The resource clients you inject with `@AutowiredBean` (e.g.
`UserResourceClient`) live in the **test-data-client** repo, which the same PR
reviewer polices with its own rule set. When you author or edit a
`*ResourceClient` there, load **`hektor-resource-client`** for the full
workflow — but the headline rules are:

| Rule | Severity |
|---|---|
| A `*ResourceClient` class `extends AbstractService` | BLOCKER |
| A new `*ResourceClient` class is annotated `@Component` | BLOCKER |
| Every `clients.*(...)` URL starts with `/` | BLOCKER |
| No `//` (double slash) inside a `clients.*(...)` URL | BLOCKER |
| New `AbName.java` enum values are `SCREAMING_SNAKE_CASE` | BLOCKER |
| A class that uses `log.*` is annotated `@Slf4j` | WARNING |
| `log.*` uses `{}` placeholders, not string `+` concatenation | WARNING |
| Method names are `camelCase`; no unused imports | WARNING |

---

## Pointers

- `review.md` — the team's PR review checklist. **The** kernel.
- `hektor-resource-client` — the sibling skill for authoring test-data-client
  `*ResourceClient` code (the reviewer's second rule set).
- `.claude/hooks/pr-rules-gate.sh` — the local diff-scanner that runs the
  reviewer's deterministic (Katman 1a) regex checks against your working tree
  at write-time, so a violation is caught before the PR. Kill switch:
  `HEKTOR_PR_RULES_GATE=off`.
- `web-ui-test/generateMethods.md` — the annotation processor doc.
- `readme.md` — VM options, env, Selenoid/Grid setup.
- `web-ui-test/build.gradle.kts` — dependency versions, test task setup.
- `web-ui-test/src/main/java/com/sahibinden/web/util/suite/tag/` — tag taxonomy.
- `web-ui-test/src/main/java/com/sahibinden/web/annotation/` — every test /
  field annotation the framework recognises.
