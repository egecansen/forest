---
name: hektor-edr-contract
description: >
  Lock the Kafka EDR (event-driven reporting) contract between the web app
  and downstream analytics — event name, action enum, field shape — so a
  silent producer-side change cannot break analytics without failing a test.
  Mirrors @civitas-cerebrum/achilles' contract-testing skill but customised
  for sahibinden's existing EDR plumbing (EdrTestCycleDataCtx, KafkaEdrFields,
  @Tag(MainTag.EDR)). Triggers on "lock EDR contract for <event>", "kafka
  contract test", "add EDR assertion to <flow>", or when the journey block
  has an `EDR:` field but no EDR test exists.
---

# Hektor EDR contract

The framework already produces Kafka EDR events as part of normal user
flows. The existing tests assert on them via `EdrTestCycleDataCtx` and the
`KafkaEdrFields` / `KafkaEdrNames` enums. This skill is the workflow for
adding new EDR assertions or upgrading a flow's EDR coverage from "we fire
something" to "we fire the right action with the right fields".

---

## When to add an EDR assertion

Add EDR coverage when:

- The journey block in `docs/hektor/journey-map.md` lists an `EDR:` line
  enumerating expected actions.
- A new product flow emits new EDR events (the product PR mentions a new
  action).
- A regression bug found that an EDR event was missing or had a wrong
  field.

Don't add EDR coverage when:
- The flow doesn't emit EDR events (asserting absence is brittle; use
  contract negative tests sparingly).
- The product team is mid-migration to a new event name (locking against
  a draft contract creates churn).

---

## Procedure

### 1. Read the contract source

The action enum lives in `com.sahibinden.client.edr.EdrNames`. Look up:

- `KafkaEdrNames.<EVENT>` — the topic name (e.g., `SEARCH`).
- `KafkaEdrFields.<FIELD>` — the field key (e.g., `ACTION`, `SEARCH_TYPE`,
  `CATEGORY_ID`).
- The valid `ACTION` enum values (e.g., `SEARCHED`,
  `SEARCH_RESULT_VIEWED`, `SEARCH_RESULT_FILTER_SELECTED`).

If the action you're locking doesn't exist in the enum, refuse — ask the
product team to add it before writing the test. Tests must lock against a
canonical enum, not magic strings.

### 2. Test structure (mirror existing pattern)

**Critical:** the EDR context is **injected as a test-method parameter**
annotated with `@EdrName(...)`. It is NOT retrieved via a static call.
Match the pattern from existing tests like
`ResponsiveYepySimpleLandingPageTest` and
`ResponsiveVehicleProClassifiedDetailInfoBoxTest`.

```java
@Tags({
    @Tag(MainTag.PARALLEL),
    @Tag(MainTag.EDR),
    @Tag(Kure.SEARCH),
    @Tag(SearchDomain.HYBRID_SEARCH)
})
@Slf4j
public class HybridSearchEdrTest extends TestDataResource {

  @AutowiredBean private HybridSearchPage hybridSearchPage;
  // edrKafkaClient is provided by TestDataResource; do NOT redeclare.

  @WebTest
  @Description("Hybrid search filtering emits SEARCH funnel events in order")
  public void testHybridSearchFilterEdrActions(
      @EdrName(KafkaEdrNames.SEARCH_FUNNEL_EDR) EdrTestCycleDataCtx edrCtx) {

    hybridSearchPage
        .go(HybridSearchPageUrls.SEARCH_RESULT_PAGE);

    // Start the consumer BEFORE the user actions that emit events.
    edrKafkaClient.createKafkaConsumer(edrCtx);

    hybridSearchPage
        .sendKeysSearchInput("audi")
        .clickSubmit()
        .getLeftFilterLayout()
        .clickRefreshOnClickButton()
        .clickFilterByKeyword();

    // Assertion shape: each existing EDR test in this repo wires assertions
    // through the same edrCtx parameter — see the test files referenced
    // above for the exact assertion helpers in use for the topic you're
    // locking (the helpers differ per topic / funnel; cargo-cult the
    // nearest neighbour rather than inventing).
  }
}
```

Rules:
- `@Tag(MainTag.EDR)` class-level so CI knows to start the EDR collector.
- `@EdrName(KafkaEdrNames.<EVENT>)` annotates the **`EdrTestCycleDataCtx`
  parameter** of the test method — it does not annotate the method
  itself, and there is no `EdrTestCycleDataCtx.getCurrent()` static.
- The `KafkaEdrNames.<EVENT>` field is a `String` constant; pass it
  through `@EdrName(KafkaEdrNames.X)` and the framework wires the consumer.
- `edrKafkaClient` is inherited from `TestDataResource`; call
  `edrKafkaClient.createKafkaConsumer(edrCtx)` once before the actions
  that should emit events.
- For the actual assertion helpers, **find the closest existing test for
  the same funnel/topic** and mirror its assertion shape. The repo
  exposes per-topic assertion patterns (Map<KafkaEdrFields, List<String>>
  expected vs observed, ordered-events vs unordered, etc.). Don't invent.

### 3. Negative tests (sparingly)

If you need to assert that an event MUST NOT fire (e.g., filter
interaction with autocomplete should NOT emit `SEARCHED`):

```java
@WebTest
@Description("Autocomplete suggestion click does NOT emit SEARCHED")
public void testAutocompleteDoesNotEmitSearched(
    @EdrName(KafkaEdrNames.SEARCH_FUNNEL_EDR) EdrTestCycleDataCtx edrCtx) {
  edrKafkaClient.createKafkaConsumer(edrCtx);
  // ... drive the autocomplete suggestion click ...
  // Assert absence using the same per-topic assertion helper the
  // positive tests use (mirror the closest existing neighbour test).
}
```

Use sparingly; negative EDR tests are brittle to event-ordering changes.
Find the closest neighbour test for the same `KafkaEdrNames` topic and
mirror its absence-assertion shape — don't reach for `.getActions()` or
other invented APIs.

### 4. Validate

Run the test on Selenoid (where the EDR collector runs) AND local (where
EDR might be no-op). The EDR assertion is environment-sensitive — confirm
the test author's expectation matches the environment.

If the test fails because EDR events aren't reaching the collector,
that's an infra issue (Kafka, collector config) — not a test bug. Diagnose
via the team's EDR debug dashboard, don't patch the test.

---

## Refusal cases

- Action / event / field doesn't exist in the canonical enum. Refuse.
- Caller asks to assert on a "shape" of event that the EDR system doesn't
  natively support (e.g., regex on a field). Refuse; ask the product team
  to expose a structured field.
- Caller asks to lock an event the product team has flagged as
  in-migration. Refuse until the migration completes.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-edr-contract",
    "status": "contract-locked | needs-enum-extension | bug-filed",
    "next-action": "advance"
  },
  "topic": "KafkaEdrNames.SEARCH",
  "actions-locked": ["SEARCHED", "SEARCH_RESULT_VIEWED", "SEARCH_RESULT_FILTER_SELECTED"],
  "fields-locked": ["ACTION", "SEARCH_TYPE"],
  "test-class": "ui.website.search.hybridsearch.HybridSearchEdrTest",
  "test-methods-added": 1,
  "summary": "Locked SEARCH topic contract for hybrid filter flow (3 actions, 2 fields)."
}
```
