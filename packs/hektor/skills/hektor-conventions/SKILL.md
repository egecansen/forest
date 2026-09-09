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
paths: "web-ui-test/**/*.java, **/*Page.java, **/*Layout.java, **/*Test.java"
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

> **On a `List<WebElement>` the wait forms are INDEX-based, and the index is
> resolved BEFORE any waiting.** `waitForVisibilityFoo(0, 5)` means
> `foo.get(0)` then wait — so it throws `IndexOutOfBoundsException` on an empty
> list instead of waiting for the list to fill. Worse,
> `waitForInVisibilityFoo(5)` is a single-arg **index**, not a timeout:
> `foo.get(5)`, which blows up whenever the list is shorter than 6.
> Cost 2026-08-01: two tests crashed before reaching any assertion, which
> masked a real data-gating finding for a full day.
> **To wait for a list to become non-empty, poll the size getter instead:**
> ```java
> for (int attempt = 0; attempt < 30; attempt++) {
>   if (layout.getSizeFoo() > 0) { break; }
>   pageRefresh();
>   waitForPageLoad();      // paces by a real page load, not a magic number
> }
> ```
> `waitForPageLoad()` is `PageFacility`'s own `WebDriverWait` — use it rather
> than `sleepSecond(n)`. Note server-side propagation (feature flags) needs a
> generous attempt ceiling; the loop exits early when the condition is met.

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
- **`assertThat(List<String>).contains(x)` is exact ELEMENT equality, not
  substring.** Comparing a filename constant against a list of full CDN URLs, or
  a class-name fragment against a full `class` attribute, can never pass. When
  the expected value is a *fragment* of the actual, use
  `.anyMatch(e -> e.contains(fragment))` / `.noneMatch(...)`. When it is the
  whole value, `contains` is right. Found 2026-08-01 after a review comment
  simplified `anySatisfy(...)` to `contains(...)` and silently made four
  assertions impossible.
- **Guard every negative assertion against a vacuous pass.** `doesNotContain`,
  `isZero`, `isEmpty` and friends all pass on an empty actual. Pair them with
  `.isNotEmpty()` on the collection, or assert the positive case in the same
  method, so "nothing rendered" cannot masquerade as "the bad thing is absent".
  Two tests passed vacuously for months this way.

### Language tests

A language test is ONE method that passes in both the default TR run and the
`-Dtest.lang=en` run (a foreign-language run executes ONLY tests tagged
`@Tag(CommonTag.LANGUAGE)` — see `TestExecutionCondition`). The test never sets
the language itself: no `_EN` url constant, no manual language cookie, no
in-page language switch. Every language-dependent value (asserted text, url
path, text-based locator fragment) is a layout/page constant defined with
`LanguageText.pick("TR", "EN")`, replaced **in place** — never a second
constant next to the TR one. The one carve-out: changing the language from
inside the page is a legitimate scenario when the switcher itself is the
subject under test (assert the `language` cookie).

Load **`hektor-write-language-test`** before authoring or converting one; it
owns the full rule set (method template, `pick` constant rules, forbidden
list) plus the run mechanics — the EN-run gate, the `-Dlang.audit=true`
localization audit, and the AI page-language check
(`getWrongLanguageWords` / `isPageInLanguage` + `@Tag(CommonTag.AI)`).

---

## Tag taxonomy

| Family | Where | Picking |
|---|---|---|
| Execution mode | `MainTag.PARALLEL` / `MainTag.SERIAL` | PARALLEL by default; SERIAL only when the test mutates tenant-shared state. |
| Sphere ("küre") | `Kure.SEARCH`, `Kure.CLASSIFIED`, `Kure.INDIVIDUAL`, `Kure.SHOPPING`, `Kure.S360`, `Kure.LONDON`, `Kure.YEPY`, `Kure.OPERATION`, `Kure.SEO`, `Kure.NATIVEAD`, `Kure.KURUMSAL_TEMEL`, `Kure.KURUMSAL_EK` | Exactly one. The feature's owning team. |
| Domain | `SearchDomain.*`, `ClassifiedDomain.*`, `IndividualDomain.*`, `ShoppingDomain.*`, `CorporateDomain.*`, `FinanceDomain.*`, `S360Domain.*`, `LondonDomain.*`, `YepyDomain.*`, `OperationDomain.*` | One or more. The subsystem(s) exercised. |
| Gating | `MainTag.PRODUCTION` (runs in prod canary), `MainTag.FASTTRACK`, `MainTag.HOTFIX`, `MainTag.READ_ONLY` | Optional, opt-in. |
| Cross-cutting | `MainTag.EDR`, `MainTag.SECURITY`, `MainTag.VISUAL_REGRESSION`, `MainTag.KVKK`, `MainTag.RESPONSIVE`, `MainTag.NETWORK`, `MainTag.MICROSERVICE` | Add when applicable. |
| Language | `CommonTag.LANGUAGE` (method-level) | Marks a language test — one method valid in both `-Dtest.lang` runs. See "Language tests" above + `hektor-write-language-test`. |

> **`PARALLEL` / `SERIAL` are Gradle job-splitting labels, NOT JUnit
> concurrency.** `build.gradle.kts:509-510` string-replaces `parallel_tests` →
> `serial_tests` to select a job. There is no `junit-platform.properties` and
> `maxParallelForks` is unset, so JUnit parallelism is off — tests already run
> one at a time within a job. Consequences:
> - You **cannot** "add a serial guard" to one method: a method-level
>   `@Tag(MainTag.SERIAL)` inside a `@Tag(MainTag.PARALLEL)` class matches
>   **both** task selections and the method **runs twice**. For a state-mutating
>   test that is worse than no guard at all.
> - `@ResourceLock` / `@Isolated` / `@Execution` have zero usage here and are
>   no-ops.
> - To make a mutating test safe in a `PARALLEL` class, don't reach for tags:
>   pick a data target no other method touches, capture the original state
>   before mutating, and restore it in `@AfterEach` so an abort mid-test cannot
>   leave the row dirty.
> - The repo pattern for a mixed class is PARALLEL/SERIAL on the **methods**,
>   Kure/domain on the **class**.

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
the test class (typically via `TestDataResource`). For data that SQL exposes,
the DAO lives in **test-dao** and is injected the same way (`classifiedDAO`,
`promotionsDAO`, …).

**Reuse an existing TDC/DAO method.** Grep the sibling **source**
(`…/test-data-client/src`, `…/test-dao/src`) before adding anything. If the
method exists, call it. If it does not, load **`hektor-resource-client`**
(REST → branch `tech/TDC-<n>`) or **`hektor-test-dao`** (SQL → branch
`tech/DAO-<n>`), wait for `reused` / `authored`, then continue.

**Never author the helper in web-test.** `PromotionWizardClient extends
AbstractService` under `web-ui-test/util/doping/` (WEBT-255458) is the banned
shape — `pr-rules-gate` denies `extends AbstractService`, `extends AbstractDAO`,
`*ResourceClient.java`, and `*DAO.java` in `web-ui-test/`. A new `@AutowiredBean`
field on `AbstractTestDataResource` is the only web-test edit this path allows
(injection site, not the implementation).

### `loginByPass` does NOT navigate

It sets the `st` cookie and returns `this` (`ModuleFacility:41-83`). Meanwhile
`CookieUtil.addInitCookies` does `browser.get("https://www.sahibinden.com")`, so
unless the test calls `.go(url)` explicitly the browser is sitting on the **home
page**. Assertions after a bare `loginByPass` then run against the wrong page —
and any negative assertion (`doesNotContain`, `isZero`) passes vacuously.

Always: `loginByPass(id).go(targetUrl).<wait>()`. If a page helper takes a URL,
make sure its body actually uses it — a "clean up the unused variable" lint
warning on a `String url` is usually the *symptom* of lost navigation, not a
tidy-up opportunity.

### Feature flags (FGW)

| Call | Semantics |
|---|---|
| `updateFeatureConfig(flag, weights)` | **Global.** Creates `/config` if absent. WIPES the selector set. Affects the whole testbox. |
| `updateFeatureConfigWithRestriction(...)` | REPLACES the selector set. Patches an existing config — **404s if none exists**. |
| `createFeatureConfigWithRestriction(...)` | APPENDS a selector. Patches an existing config — **404s if none exists**. |

So a user-scoped flag needs **two** calls: a bare `updateFeatureConfig(...)` to
seed `/config`, then the restriction call with
`Map.of(RestrictionType.USER_ID_CONDITION, String.valueOf(user.getId()))`.
Prefer `create…WithRestriction(..., false)` when several tests read the same flag
in parallel — it appends rather than replacing, and `false` leaves the global
default alone. Order matters: **create the user → set the restricted flag →
`loginByPass`.**

Never set a flag globally and leave it: the weight applies to the whole box, other
tests reading it fail randomly, and featuregw can evaluate a global weight as
DISABLE in user context — so you believe the flag is on while running with it off.

> **`getFeatureConfig` THROWS on 404, it never returns null.** `Clients.getFGW`
> uses WebClient `.retrieve()`, whose `try/catch` wraps only the Jackson mapping.
> So the common idiom `if (getFeatureConfig(FLAG.name()) == null) { seed... }` is
> **dead code that blows up** on exactly the box where the flag was never defined.
> Catch the 404 (or add a `getFeatureConfigOrNull` to test-data-client) if you
> need that guard.

Server-side flag propagation is not instant. A test that flips a flag mid-run
must poll (see the list-wait note above), not assume the next page load reflects it.

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
| **Mandatory `-D` set** | Every CLI run ALSO needs `-Dspring.profiles.active=testbox -Denv.launchpad=<...> -Dui.browser.type=chrome` (+ `-Dchrome.version=<v>` on selenoid). Each is hard-required: without the profile the `@Profile("testbox")` app config class is invisible to Spring's scan → `initializationError: Unable to find a @SpringBootConfiguration`; without `env.launchpad` logback's `WorkspacePropertyDefiner` NPEs; without `ui.browser.type` `WebDriverFactory.initDriver` NPEs. |
| Language run | `-Dtest.lang=en` — executes ONLY `@Tag(CommonTag.LANGUAGE)` tests; the tag is ANDed into the selection automatically. A `--tests`-named target bypasses the filter and then **fails** with `LanguageTagMissingException` if untagged (loud on purpose, never a silent skip). Add `-Dlang.audit=true` for the AI localization audit. See `hektor-write-language-test`. |
| **`-Dapi.url=<dc>tb<dc><id>`** | **MANDATORY and missing from most copy-pasted command blocks.** `client.properties` declares `api.url=${sys:api.url}` with no default, so without it the MySQL datasource resolves the literal host `api.url` and the whole Spring context fails to load (`UnknownHostException: api.url`). Reads like a broken build, not a missing flag. |
| Re-running | `--no-build-cache` for a first run. For a **byte-identical repeat**, add `cleanTest` — `--no-build-cache` does NOT defeat Gradle's up-to-date check, and the repeat prints `BUILD SUCCESSFUL` with `Task :test UP-TO-DATE` having run **zero** tests. Do **NOT** use `--rerun-tasks`: it re-runs `:generate-method-plugin:instrumentCode` and the named test is then not discovered (`No tests were executed!`). |
| JDK (macOS) | The Gradle daemon MUST run the same major JDK as the Java 17 toolchain: the test task copies every daemon system property into the forked test JVM, and a 21-daemon's `java.home` makes the 17 worker load JDK-21 CLDR classes → `UnsupportedClassVersionError`. Pass `-Dorg.gradle.java.home=<jdk17>` (and ensure `<jdk17>/Packages` exists — empty dir is fine — or `:generate-method-plugin:instrumentCode` fails). |

**The testbox is non-negotiable.** Every Hektor session asks for the
reserved testbox before running anything; the value is recorded in
`docs/hektor/run-status.json` and inherited by every `gradle test`
invocation. Running without `-Dui.testbox` against a non-local
launchpad targets `http://xtbx` (no suffix) which hits nothing real —
and even if it did, it would clash with someone else's reservation.

**Use only the box the user reserved.** A box answering an HTTP probe is not an
allocation; a Test Onay's TESTBOX field records where manual QA ran — information,
never authority. **161 and 230 are for preprod testing only, never for authoring
or debugging.** If the reserved box is broken for the surface under test, record
the blocker with evidence, leave the ticket honestly unvalidated and un-parked, and
ask — never self-allocate.

### Never trust `BUILD SUCCESSFUL` — gate every run

`BUILD SUCCESSFUL` prints **alongside** failing tests, so it carries no
information in either direction. Three separate mechanisms produce a result that
means nothing. Before reading ANY outcome, green or red:

| Grep | Must be | Failure mode it catches |
|---|---|---|
| `testbox : <id>` | present, never `production` | flags never landed → **fake green** |
| `UnknownHostException: api.url` | 0 | `-Dapi.url` missing → context never loaded |
| `Task :test UP-TO-DATE` | 0 | zero tests ran, output replayed → **fake green** |
| `initializationError` | 0 | box down / DB unreachable → **meaningless red** |
| `Failed to load ApplicationContext` | 0 | same |
| `Running test:` | == the tests you named | the only proof of real execution |

`Running test:` alone is not enough — it also appears for `initializationError`.
When a red trips the init checks, re-probe the box before touching code:
`curl -H "Host: www.sahibinden.com" -H "X-Forwarded-Proto: https" http://<dc>tb<dc><id>:9081/`
(the plain `http://<dc>tb<dc><id>` is the Testbox Management Tool, not the app;
web REST is on `:8081/sahibinden-web/rest`).

When running tests as part of a Hektor phase, ALWAYS:
1. Run against the reserved testbox first (matches CI shape).
2. Confirm the test also passes locally (`-Denv.launchpad=local`) before
   committing — `review.md` requires both.
3. For anything timing-sensitive (feature flags, indexing, async writes), a
   single green proves nothing — repeat the run and show the count.

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
24. A negative assertion (`doesNotContain`, `isZero`, `isEmpty`) with nothing
    proving the actual is non-empty — it passes when the page never rendered.
    **(WARNING)**
25. `assertThat(List<String>).contains(fragment)` where the expected value is a
    *substring* of the actual (filename vs full URL, class fragment vs full
    `class` attribute) — element equality can never match. **(WARNING)**
26. A bare `loginByPass(...)` followed by assertions with no `.go(url)` in
    between — the browser is on the home page. **(WARNING)**
27. `cookies.setLanguage()` / `setLanguageEN()` / a pinned `BASE_URL_EN` inside a
    `@Tag(CommonTag.LANGUAGE)` method — the run already set the cookie.
    **(WARNING)**
28. A method-level `@Tag(MainTag.SERIAL)` inside a `@Tag(MainTag.PARALLEL)`
    class — the method runs **twice**. **(WARNING)**
29. `sleepSecond(n)` used as a wait where a generated wait or `waitForPageLoad()
    ` would do. Fixed sleeps only when nothing observable marks the transition,
    and then with a comment saying why. **(WARNING)**
30. A class in `web-ui-test/` that `extends AbstractService`, is named
    `*ResourceClient`, or is a REST/HTTP client util (WEBT-255458
    `PromotionWizardClient`). REST helpers belong in test-data-client.
    **(BLOCKER)**
31. A class in `web-ui-test/` that `extends AbstractDAO` or is named `*DAO` /
    `*DAOImpl`, or SQL inlined in a `*Test.java`. SQL helpers belong in
    test-dao. **(BLOCKER)**

Items 1–16 and 30–31 are reviewer **BLOCKERs** — refuse to commit code that trips one.
Items 17–29 (and 9 above where inline) are reviewer **WARNINGs**: they don't
block the merge, but the bot leaves an inline comment, so fix them in the same
pass unless there's a documented reason. If you catch any BLOCKER in code the
user asked you to commit, refuse and explain which rule was violated. The
downstream `hektor-test-composer` self-checks against this list before
declaring its work done, and the `pr-rules-gate.sh` hook scans your working
tree at write-time.

---

## Sibling repos: test-data-client and test-dao

Search sibling **source** first and reuse. If a helper is missing, load
**`hektor-resource-client`** (REST, branch `tech/TDC-<n>`) or
**`hektor-test-dao`** (SQL, branch `tech/DAO-<n>`). Do not implement either
in `web-ui-test/`.

Resource-client headline rules (full set in `hektor-resource-client`):

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
- `hektor-resource-client` — REST helpers in test-data-client (`tech/TDC-<n>`).
- `hektor-test-dao` — SQL helpers in test-dao (`tech/DAO-<n>`).
- `hektor-write-language-test` — the language-test authoring rule: one method,
  both `-Dtest.lang` runs, `LanguageText.pick` constants, `CommonTag.LANGUAGE`.
- `.cursor/hooks/pr-rules-gate.sh` — the local diff-scanner that runs the
  reviewer's deterministic (Katman 1a) regex checks against your working tree
  at write-time, so a violation is caught before the PR. Kill switch:
  `HEKTOR_PR_RULES_GATE=off`.
- `web-ui-test/generateMethods.md` — the annotation processor doc.
- `readme.md` — VM options, env, Selenoid/Grid setup.
- `web-ui-test/build.gradle.kts` — dependency versions, test task setup.
- `web-ui-test/src/main/java/com/sahibinden/web/util/suite/tag/` — tag taxonomy.
- `web-ui-test/src/main/java/com/sahibinden/web/annotation/` — every test /
  field annotation the framework recognises.
