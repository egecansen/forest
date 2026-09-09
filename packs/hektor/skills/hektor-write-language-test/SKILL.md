---
name: hektor-write-language-test
description: Use when authoring a language test — a single test method that passes in BOTH the `-Dtest.lang=tr` and `-Dtest.lang=en` runs — and when running or reading a foreign-language run. Triggers on "write a language test", "make this test pass in EN", "add English coverage to this flow", "run the suite in English", "-Dtest.lang=en", "language audit", "-Dlang.audit", "LANG_AUDIT", "translation gaps", "localization report", or any request to make one domain test resolve locale-dependent values per run. Applies to web-ui-test/src/{test,main}/java/**/*.java.
---

# Language Test Authoring Rule

Apply this rule only when producing a language test.

Target output: a SINGLE method living in a domain test class that passes in **both**
the `-Dtest.lang=tr` and `-Dtest.lang=en` runs.

Language is a property of the run, not of the test. The test is an ordinary TR test — the
flow is identical in both runs; only the language-dependent values resolve according to the
run's language.

**Sources.** The authoring rule (§1-6 + templates + Forbidden) mirrors
`web-ui-test/.cursor/rules/write-language-test.mdc` — that file is authoritative for the
rule; keep the two in sync. The run mechanics, the audit and the AI check come from
`web-ui-test/docs/localization-testing.md`, the team's localization doc.

---

## Flow

### 1. Find whether a test already runs this flow

If the domain already has a test for the same page / same flow / same assertion, **work on
that method** — do not open a new class, a new method, or an "EN version." The fact that the
test does not yet assert the text does not make it unsuitable — the test that drives the flow
is the right place.

If a test is found, continue directly from step 3.

### 2. If no test exists, write an ordinary TR test

Add a new method to the domain's `XxxTest` class. Write the method as an ordinary TR test
that has no idea it is a language test: same setup, same flow, same assertion style. Apply
the method template below.

If the class does not exist, create it under the domain name; take the class skeleton
(directory, class tags, base class, page injection) verbatim from a neighboring test class in
the same domain.

### 3. Make the test run identically in both languages

The same method drives the TR page in the `tr` run and the EN page in the `en` run. To do
this, adjust every language-dependent point in the test so it resolves according to the run's
language — the TR equivalent in the TR run, the EN equivalent in the EN run:

- asserted UI text (title, error message, button, label)
- url / path whose equivalent changes by language (`/hakkimizda` → `/about-us`)
- localized data selected by the flow (category name, model, picklist value)
- an element found via text — link text, text-based xpath: a locator written with TR text
  will not find the element in the EN run

Everything that does not change by language (id, flag, user, listing data) is identical in
both runs and is left untouched.

### 4. Bind values and element text to the run's language

- **Value**: defined in a layout / page constant via `LanguageText.pick`; the test only
  references the constant.
- **Element**: if a language-independent locator (id, css, attribute) exists, use it. If the
  element can only be found by its text, extract the text fragment of the locator into a
  parameter and pass the same `pick` constant as the argument.

In both cases the run's language resolves the value; there is no language check in the test.
Template below.

### 5. Add the `LANGUAGE` tag to the method

`@Tag(CommonTag.LANGUAGE)` (`MainTag.CommonTag.LANGUAGE`, value `"language"`) is what puts
the method into the foreign-language run — see **Running** below; without it the method
simply is not part of that run. If the method already has other tags, combine them inside
`@Tags({...})`.

The tag is at the method level. Move it to the class level only if **all** methods in the
class are language tests.

### 6. Run in both languages

The method must pass separately with `-Dtest.lang=tr` and `-Dtest.lang=en`. The only thing
that differs between the two runs is the value that the `pick` constants resolve to; the flow
is the same.

If the expected value does not hold in the EN run, the correct value is in the run's own
output (`expected <turkish> but was <english>`); update the constant from there.

Commands and the gate semantics of the EN run: see **Running** below.

---

## Method template

```java
@Tag(CommonTag.LANGUAGE)
@Description("Turkish description of what the scenario does")
@WebTest
public void testScenarioName() {
  User user = userResourceClient.createUser();

  xxxPage
      .loginByPass(user.getId())
      .go(XxxPageUrls.PAGE)
      .getXxxLayout()
      .doAction()
      .assertx(l -> assertThat(l.getTextMessage()).isEqualTo(XxxLayout.ERROR_MESSAGE));
}
```

If it is a responsive test, use `@MobileSiteTest` instead of `@WebTest`.

| Field | Rule |
|-------|------|
| Class | Domain name + `Test`; prefer the existing class |
| Method name | Scenario name — no `Language` / `English` / `Translated` |
| Description | Ordinary scenario description; no language/translation emphasis |
| Tag | `@Tag(CommonTag.LANGUAGE)` at the method level |
| Assert | Only the layout/page constant; no UI text inside the test |

---

## Layout template — constant

```java
import com.sahibinden.core.i18n.LanguageText;

public static final String ERROR_MESSAGE = LanguageText.pick(
    "Turkish text",
    "English text");
```

- First argument is TR, second is EN
- The constant lives in the layout or page class, not inside the test
- The constant name reflects what it means; it takes no language suffix — a new constant and
  an existing one follow the same rule
- If a single-language constant already exists, replace it **in place** with `pick`: keep its
  name and call sites, do not add a second constant next to it
- `pick` returns the TR value in runs with no language setting; therefore other tests using
  the same constant are not affected

---

## Layout template — element found by text

If the locator constant contains TR text, the element will not be found in the EN run.
Extract the text fragment into a parameter and have the call pass the `pick` constant:

```java
@FindBy(xpath = "//div[@class='row'][starts-with(normalize-space(.), '{title}')]")
private WebElement rowByTitle;

public String getTextRowValue(String title) {
  return browser.getText(LocatorUtil.getDynamicWebElement(rowByTitle, title));
}
```

```java
.assertx(l -> assertThat(l.getTextRowValue(XxxLayout.ROW_TITLE)).isEqualTo(...));
```

- If a language-independent locator (id, css, attribute) is possible, try that first; a
  parametric text is needed only when the element is found solely by its text
- The constant passed as the parameter is also defined with `pick` — the locator resolves in
  the run's language

---

## Site language

The language comes entirely from the run: it is selected with `-Dtest.lang`, the `language`
cookie is applied accordingly at session start, and `pick` resolves the expected value
accordingly.

The test does not set the language: it does not navigate to the English url, does not set the
cookie manually, and does not change the language from within the page. The same method drives
the same flow in both languages with no extra code.

Two narrow exceptions, both documented below: a test whose SUBJECT is the language switcher,
and the AI page-language check (which pins the url on purpose). Neither is setup.

---

## Running

Two independent settings. Each has a Jenkins name and a local name:

| What it does | Jenkins param | Local JVM flag | Default |
|---|---|---|---|
| Picks the language the tests run in | `TEST_LANG` (`tr` / `en`) | `-Dtest.lang=en` | `tr` |
| Scans pages, produces the translation report | `LANG_AUDIT` | `-Dlang.audit=true` | off |

Jenkins jobs carrying both: **web-test-s4-tag** and **web-test-s4-flaky**.

Local, on top of the standard testbox flag set (see `CLAUDE.md`):

```bash
gradle test --tests "<FQCN>.<method>" \
    -Dspring.profiles.active=testbox \
    -Denv.launchpad=selenoid -Denv.data.center=<dc> -Dui.testbox=<id> \
    -Dui.browser.type=chrome \
    -Dtest.lang=en
```

### The foreign-language run is a hard gate

A run with `-Dtest.lang=en` executes **only** `@Tag(CommonTag.LANGUAGE)` tests. Every other
test asserts Turkish text and would fail for a reason unrelated to the change under test.
Two mechanisms, and the difference between them matters when reading a result:

- **Tag selection** (a suite, a Jenkins `TAG` job) — `applyLanguageTag()`
  (`web-ui-test/build.gradle.kts:614`) ANDs `language` into whatever was requested, so
  `TAG=search_tests` becomes `(search_tests) & language`. You never write `language` in the
  `TAG` field yourself; if it is already there it is left alone. An untagged test is simply
  outside the requested set — dropped silently, and that is correct.
- **Named test** (`--tests`, or a single run from the IDE) — the tag filter is deliberately
  NOT applied (`hasNamedTestTarget()`, `build.gradle.kts:651`). The test is selected, reaches
  `TestExecutionCondition.checkLanguage()`
  (`web-ui-test/src/main/java/com/sahibinden/web/engine/TestExecutionCondition.java:66`) and
  **fails** with `LanguageTagMissingException` — not skipped. A test someone asked for by
  name must never disappear into "0 tests executed".

So: `LanguageTagMissingException` in an EN run is not a broken test. It means the method has
no `@Tag(CommonTag.LANGUAGE)`. Add the tag, or drop `-Dtest.lang`.

The default TR run is untouched by all of this — every test runs as before.

---

## Language audit (`-Dlang.audit=true`)

A separate concern from the authoring rule: the audit answers *"is there untranslated text
left on the pages?"*, not *"does my test pass in EN?"*. It only makes sense together with
`-Dtest.lang=en` — in a TR run the expected language is already Turkish, so there is nothing
to find.

How it works:

1. `LanguageAuditPageAspect` (`web-ui-test/src/main/java/com/sahibinden/web/i18n/LanguageAuditPageAspect.java:38`)
   hooks **every public action on `PageFacility+`** — so every page object and layout,
   including inherited `go(url)` / navigation helpers. Bound to the type, not the package.
2. Each resulting page state is captured (visible text + screenshot) and deduped by
   address + content, so the same state is never sent to the model twice. A popup or a
   content change IS a new state.
3. The model splits every word into a **translation gap** or an **elimination candidate**
   (brand, proper noun, code, already-English word).
4. **A test with a translation gap FAILS.** That failure means a product defect was found, not
   that the test is wrong — read it together with the report.
5. Report: `build/reports/language-audit/index.html` locally; **Localization Audit** in the
   Jenkins left menu.

Reading the report — per-step labels: `YENİ SAYFA` (new page, audited) /
`SAYFA İÇERİĞİ DEĞİŞTİ` (same url, new content, audited) / `DURUM DEĞİŞMEDİ` (no state change,
not re-audited) / `DENETLENEMEDİ` (blank or unscannable — **never counted as clean**). Each
step also prints the page language; a `DİL: EN → TR` flip is usually the actual root cause.

Cost and privacy: one AI call per new page state — this is why `LANG_AUDIT` is off by
default. Numbers (price, phone, listing id) are stripped from the text before it is sent.

### Brand glossary

`web-ui-test/src/main/resources/language-audit-ignore.txt` — the site's own brand/product
names, given to the model as fact so "Param Güvende" is not reported as a gap. One name per
line, `#` comments.

**Never add an ordinary word.** Adding "Merkez" to silence a place name also silences
"Mesaj Merkezi" — a genuine gap. When in doubt, leave it out: a false finding costs one glance
at the report, a missing finding ships untranslated text. Third-party brands (Facebook,
Instagram…) are not listed — the model already gets those right.

---

## AI page-language check

Per-string assertions cannot prove a whole page is translated. For that there is a direct
check on `AIFacility`, available on any page/layout:

- `getWrongLanguageWords("English")` → `List<String>` of genuine gaps, brands excluded
  (`web-ui-test/src/main/java/com/sahibinden/web/client/facility/AIFacility.java:158`)
- `isPageInLanguage("English")` → the `boolean` form of the same check (`AIFacility.java:149`)

Tag the method `@Tag(CommonTag.AI)` alongside `@Tag(CommonTag.LANGUAGE)` — it is an AI-backed
test and belongs to that selection too.

```java
@Tags({@Tag(Kure.SEARCH), @Tag(CommonTag.LANGUAGE), @Tag(CommonTag.AI)})
@WebTest
@Description("Ana sayfa içeriğinin İngilizce olup olmadığının AI ile doğrulanması")
public void testHomePageIsInEnglish() {
  User user = userResourceClient.createUser();

  List<String> wrongWords = homePage.loginByPass(user.getUsername())
      .go(BaseUrls.BASE_URL_EN)
      .getWrongLanguageWords("English");

  assertThat(wrongWords)
      .as("Found non-English words on home page: %s", wrongWords)
      .isEmpty();
}
```

One AI call, sharing the audit's scan machinery. Reference:
`HomePageTest.testHomePageIsInEnglish`.

> **`BASE_URL_EN` here is deliberate, and the one sanctioned exception to "never navigate to a
> language-specific url".** A `LANGUAGE`-tagged method also runs in the default TR run, where
> the site is Turkish — `getWrongLanguageWords("English")` would then report the whole page
> and fail. There is no run-following argument to use instead: the expected language is a
> plain string handed to the model (`LanguageAuditCapture.scanCurrentPage(String)`), and
> `LanguageText.languageName()` returns `"English"` for `en` but the raw code `"tr"`
> otherwise. So the url pins the language the assertion is written against, and the test holds
> in both runs.
>
> This applies to the AI page-language check ONLY. For ordinary text assertions the run's
> `-Dtest.lang` + `pick` is the mechanism — `BASE_URL_EN` there stays forbidden.

---

## Testing the language switcher itself

Changing the language from inside the page is forbidden **as setup** (see Forbidden). It is a
legitimate scenario when the switcher IS the subject under test — the expected result being
the `language` cookie and the choice surviving navigation:

```java
@Tag(CommonTag.LANGUAGE)
@Description("SHBDN-216969 - Footer'dan dil İngilizce seçildiğinde farklı sayfalarda seçimin korunması")
@WebTest
public void testChangeLanguage() {
  User user = userResourceClient.createUser();

  homePage.loginByPass(user.getUsername())
      .go(BaseUrls.MY_ACCOUNT_PAGE_URL)
      .waitForPageLoad()
      .getFooterLayout()
      .changeLanguageEN(HomePage.class);

  String languageCookie = homePage.getCookieValueByName(LANGUAGE_COOKIE);
  homePage.assertx(l -> assertThat(languageCookie).isEqualTo("en"));
}
```

`LANGUAGE_COOKIE` is `IndividualDomain.Cookie.LANGUAGE_COOKIE`. Reference:
`FooterLinksTest.testChangeLanguage`.

---

## Branching on the run language

`LanguageText.isEnglish()` / `isTurkish()` / `lang()` exist and are permitted **only** when the
FLOW genuinely differs by language — a last resort. Selecting expected TEXT this way stays
forbidden; that is what `pick` is for. Branching splits the test into two paths and doubles
its maintenance.

---

## Artifact & VRT naming

- **VRT**: in the `-Dtest.lang=en` run, `-en` is appended to the snapshot name automatically,
  so TR and EN baselines never overwrite each other. The `checkVisualRegression` identifier
  stays language-independent and is not updated manually.
- **Report / screenshot / mhtml**: `LanguageNaming.withLanguageSuffix`
  (`web-ui-test/src/main/java/com/sahibinden/web/i18n/LanguageNaming.java:35`) appends
  `_<lang>` — so the same method reports to Elasticsearch as `FooTest.testBar_en` and its
  artifacts are filed under that name. Look for `_en` when hunting the evidence of a
  foreign-language run. A TR run is untouched.

---

## Forbidden

- Asserting hardcoded UI text inside the test
- Selecting text with `if (LanguageText.isEnglish())` — branching for a genuinely different
  FLOW is the one exception, see above
- Navigating to a language-specific url (`BASE_URL_EN`), setting the language cookie, or
  changing the language from within the page **as setup**. Two exceptions, both above: the
  switcher itself being the subject under test, and `BASE_URL_EN` in an AI page-language check
- Defining only an `_EN` constant, or adding a second-language constant next to the TR
  constant
- Opening a separate class, a separate method, or an "EN version" for language
- Using `Language` / `English` / `Translated` in a class or method name
- Putting language/translation emphasis in the description
- Writing `-en` into the VRT identifier

### Legacy patterns in the repo — do not copy

The rule is not applied retroactively, so the suite still contains code that predates it:

- `.go(BaseUrls.BASE_URL_EN)` (`BASE_URL + "/en"`) to force the English site in an **ordinary**
  text-assertion test — the run's `-Dtest.lang` does this now. (In an AI page-language check
  it is correct and required; see that section.)
- class names like `ForgotPasswordLanguageTest`, `LanguageSupportForBanaOzelPagesTest`,
  `ZeroVehicleSearchEnglishTest`, `PersonalInformationPageEnglishTranslationTest`

They still run. Do not take them as the model when writing a new language test, and do not
mass-rename them as a side effect of unrelated work.
