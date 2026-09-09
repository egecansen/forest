---
name: hektor-bug-discovery
description: >
  Adversarially probe the sahibinden app for behaviour the existing suite
  doesn't lock — race conditions, lifecycle edges, gated routes,
  permission/role boundaries, invalid input, mid-flow refresh, language
  mid-flow toggle. Produces docs/hektor/adversarial-findings.md plus
  regression tests for confirmed bugs and @ScheduledDisable annotations
  with bug IDs (the team's convention from
  com.sahibinden.web.annotation.disable) for app bugs awaiting product fix. Triggers on "find bugs in <X>",
  "bug hunt", "adversarial test", "stress test the flow", or when
  hektor-coverage-expansion dispatches the adversarial Passes 4-5.
---

# Hektor bug discovery

You probe the **live app first** ("first-time effect" — fresh eyes catch
what familiarity blinds you to) then cross-reference findings against the
existing 940 tests. The output is a deduplicated, prioritised bug ledger
plus regression specs.

You do not test what existing tests already cover. You go around them.

---

## Inputs

Caller passes:

- `scope: <section-or-journey>` — `search`, `j-classified-post-vehicle`,
  `whole-app` (rare).
- (Optional) `journey-block` — the relevant block from
  `docs/hektor/journey-map.md`.

---

## Procedure

### 1. Pre-flight

1. Read `hektor-conventions`.
2. Read the journey block(s) in scope.
3. List existing tests covering the scope. These are the things you are
   NOT going to re-probe.

### 2. Probe matrix

Walk this matrix against the scope. Each cell is a probe; each probe
produces zero or more findings.

| Axis | Probes |
|---|---|
| **Input validation** | empty / very-long / unicode / RTL / SQL-shape / XSS-shape / numeric-overflow / negative-numeric / wrong-format input |
| **Lifecycle edges** | expired session mid-flow, deleted account, suspended account, account with 0 listings, account at listing quota, abandoned classified post |
| **Permission boundaries** | individual accessing corporate routes, corporate accessing individual myaccount, regional access (London, KKTC), age-gated content |
| **Concurrency / races** | two tabs editing same listing, message thread refreshed mid-typing, two purchases of last quota item, doping payment race |
| **Navigation edges** | back/forward through auth, deep-link to gated route, deep-link to expired classified, query-string injection (`?utm_source=`, `?lang=en`), language toggle mid-flow |
| **Mobile-specific** | viewport rotation mid-flow, soft-keyboard overlap, deep-link from app intent, swipe gestures, pull-to-refresh interruption |
| **Network conditions** | slow 3G, intermittent disconnects mid-payment, payment provider 5xx, EDR endpoint 5xx (silently drops EDR? test) |
| **Locale / i18n** | `lang=en` toggle on Turkish-only pages, date format edge, currency format edge, KKTC vs Türkiye region toggle |
| **Cookie / consent** | reject cookies → flow still works? accept cookies → analytics fires? consent withdrawn mid-flow |
| **Cross-domain leaks** | search → classified-detail → message: does the message UI carry the correct seller identity? does logout-from-detail return to search context? |

For each scope, focus on the 3-4 axes most relevant to the scope's user
flow. Don't blanket-probe everything for every scope.

### 2.5 Rule-derived probes (qagent, if available)

The matrix above is generic. The richest scope-specific probes come from
the **documented rules** — each numbered rule is an invariant you can try to
break. Per `hektor-qagent`:

```
mcp__qagent__query_collection(
  collection_name="<section>_business_rules",   # arama_, ilan_, alisveris_, bireysel_, kurumsal_*, s360_
  query="<the flow in scope>",
  n_results=10)
```

For each rule, derive a probe that violates its precondition (e.g. rule
"address filter is preserved as a URL parameter when moving to results" →
probe: deep-link results with the param stripped / mutated; does the UI
recover or silently drop the filter?). A confirmed violation is a finding;
cite the `confluence::<pageId>::<chunk>` id in its row. If `qagent` is
unavailable, rely on the generic matrix only.

### 3. Execute probes

Two modes:

- **Manual / Selenium ad-hoc** — drive the live app via WebDriver (or
  manual browser). Capture HAR + screenshot + last-N steps for any
  unexpected behaviour.
- **Test-as-probe** — write a temporary `@WebTest` that drives the probe;
  if it surfaces a finding, the temp test becomes the regression test (see
  §5).

**Hard rules:**
- Probe non-destructively on production. Don't post real classifieds.
- Use test users from `UserResourceClient`; don't use real customer
  accounts.
- For payment probes, use the masterpass / payment provider's sandbox
  values documented in `util/payment/`.
- Redact credentials/tokens and user PII (phone numbers, names) from any
  screenshot, HAR, or page-source before saving it to a probe artefact —
  this suite hits a live marketplace; reuse
  `hektor-flaky-triage/core/sanitize-text.py`.

### 4. Finding shape

Each finding gets a row in `docs/hektor/adversarial-findings.md`:

```markdown
<!-- hektor:adversarial-findings -->
# Adversarial Findings — sahibinden web-test

## Open

### F-search-001 — Filter combination "İstanbul + 1+0 + 5M+" yields server 500
**Section:** search
**Severity:** high (P0 surface, 500 not 200/empty)
**Steps to reproduce:**
1. Open /real-estate-for-sale/istanbul
2. Apply room-count = 1+0
3. Apply price-min = 5_000_000
4. Submit
**Expected:** 0-results page (state variation in the map)
**Observed:** Server 500, white screen
**Existing test coverage:** none (no extreme-filter combination test)
**Probe artefact:** docs/hektor/probes/F-search-001/screenshot.png
**Disposition:** **regression-spec landed** (HybridSearchFilterTest#testExtremePriceCombination)

### F-classified-002 — Post-classified flow loses progress on back-button at category-selection
**Section:** post-classified
**Severity:** medium (data-loss UX)
**Steps to reproduce:** ...
**Disposition:** **app-bug filed: SHBDN-251200** — test parked via `@ScheduledDisable(startTime = ..., reason = "Bug mevcut - SHBDN-251200")`

## Closed

### F-search-000 (closed 2026-05-15) — Filter sidebar collapse animation flickers
**Closed by:** product fix in #PR-2189; regression spec
`HybridSearchFilterTest#testSidebarCollapseAnimation` exists.
```

Line 1 is the sentinel `<!-- hektor:adversarial-findings -->`.

Severity rubric:
- **critical** — data loss, financial loss, P0 surface 5xx, security
  breach, KVKK violation.
- **high** — P0 / P1 surface broken for a class of users.
- **medium** — UX failure, recoverable; data preserved.
- **low** — cosmetic, edge-only, niche locale.
- **info** — observation, no user-visible impact yet.

### 5. Regression specs

For each confirmed finding NOT blocked on an app bug:

1. Write a new test method (or extend an existing test class) that
   reproduces the finding and asserts the **correct** behaviour. The test
   will be RED until the bug is fixed; mark it
   `@ScheduledDisable(startTime = <epoch-ms>, reason = "Bug mevcut -
   SHBDN-<id>")` if the product fix isn't merged yet.
2. For app-bug findings: file the bug (or instruct the user to file it),
   tag the test class with the bug ID via `@Tag` (the suite has
   `MainTag.HOTFIX` / `MainTag.LONDON_HOTFIX` patterns), and add to
   `docs/hektor/disabled-tests.md`.
3. For findings the suite SHOULD already cover but doesn't — add the
   covering test to the right existing class, no `@ScheduledDisable`.

### 6. Dedup

Cross-reference findings against:
- **qagent `testlist`** (if available) — semantic-search each finding's
  scenario; a close hit on `com.sahibinden.web.ui.*` means it's likely
  already covered (verify the named class in the repo before discarding).
  This catches conceptual dupes that a `@Description` grep misses.
- Existing `*Test.java` Description fields (`grep -r "@Description"`) — the
  fallback when qagent is unavailable.
- Open bugs in the team's tracker (ask the user; Hektor does not query
  trackers).
- Earlier rows in `docs/hektor/adversarial-findings.md`.

A finding that duplicates an existing test → discarded with
`Disposition: already-covered (<TestName>#<method>)`.

A finding that duplicates an open bug → consolidated into the existing
finding's row.

---

## When to stop

You stop probing the scope when:

- Every probe axis on the matrix relevant to the scope has been exercised.
- New probes are producing duplicates of earlier findings (signal of
  diminishing returns).
- A hard cap of 20 distinct findings per scope is reached — surface to the
  user before continuing; that many findings means the scope needs
  product-side triage, not more probing.

**Loop antibody (anti-Goodhart).** A bug-hunt pass is done only when
**green AND no existing spec deleted or weakened, no assertion loosened,
no locator relaxed, coverage not lowered**. Never make a test pass by
weakening it — a real bug is flagged (🐛) with evidence, not masked.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-bug-discovery",
    "status": "clean | findings-emitted | findings-blocked-on-bugs",
    "next-action": "advance or escalate"
  },
  "scope": "search",
  "probes-executed": 27,
  "findings-total": 6,
  "findings-by-severity": { "critical": 0, "high": 2, "medium": 3, "low": 1 },
  "regression-specs-added": 4,
  "app-bugs-filed": 2,
  "ledger-path": "docs/hektor/adversarial-findings.md",
  "summary": "Search scope probed across 6 axes; 6 findings (4 regressions, 2 @bug)."
}
```
