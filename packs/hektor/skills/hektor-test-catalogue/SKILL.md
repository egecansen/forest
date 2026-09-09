---
name: hektor-test-catalogue
description: >
  Produce a stakeholder-facing inventory of the existing 940-test suite —
  organised by Kure, domain, surface, and priority — that answers "what
  scenarios are we running, and why?". Reads class-level @Tags and per-
  method @Description annotations across web-ui-test/src/test/, dedups,
  cross-references the journey map if present, and emits
  docs/hektor/test-catalogue.md (and optionally PDF). Opt-in and
  on-demand; never auto-activates during test writing or repair.
  Triggers on "generate the test catalogue", "scenario report", or
  "client-ready catalogue".
disable-model-invocation: true
---

# Hektor test catalogue

The deliverable is a single markdown document (renderable to PDF) that a
non-engineer can read to understand the test surface. Not a test report
— that's `hektor-work-summary-deck`. This is the structured scenario
inventory.

---

## Inputs

- (Optional) Scope filter — Kure, domain, surface. Default: whole suite.
- (Optional) Output format — markdown only (default) or markdown + PDF.

---

## Procedure

### 1. Gather

Walk `web-ui-test/src/test/java/com/sahibinden/web/ui/` and for each
`*Test.java`:

- Extract class FQCN.
- Read class-level `@Tags({...})` — pick PARALLEL/SERIAL, Kure, domain
  tags, gating tags (PRODUCTION, FASTTRACK, HOTFIX).
- For each test method: name, `@Description(...)` value, method-level
  tags, test-annotation type (`@WebTest`, `@MobileSiteTest`, etc.).
- Surface: `ui.website.*` → desktop, `ui.responsive.*` → mobile.

Store as a flat table in memory.

**The live repo is authoritative for the catalogue.** This is a stakeholder
document — its counts must come from walking `src/test/`, not from the
`qagent` index (which can lag). Use `qagent` only to *enrich* the journey
cross-reference in §3 below (semantic "which test covers journey j-X?"),
never to source the scenario counts.

### 2. Aggregate

Group by:
- Kure (sphere).
- Domain.
- Surface.
- Priority (derived: PRODUCTION-tagged = P0/P1; otherwise from the
  journey map if it exists; default P2).

Counts per group:
- Total scenarios.
- Production-gated.
- VRT-covered.
- EDR-covered.
- Security-tagged.
- @ScheduledDisable (with reason).

### 3. Author the catalogue

Write `docs/hektor/test-catalogue.md`:

```markdown
# Sahibinden Web-Test — Scenario Catalogue
**Generated:** 2026-05-21
**Suite snapshot:** master @ <commit-sha>
**Total scenarios:** 940
**Surfaces:** website (760), responsivesite (180)

---

## At a glance

| Kure / Sphere | Scenarios | Production-gated | VRT | EDR | Security |
|---|---|---|---|---|---|
| SEARCH | 187 | 64 | 12 | 18 | 4 |
| CLASSIFIED | 224 | 96 | 8 | 22 | 11 |
| INDIVIDUAL | 156 | 53 | 4 | 9 | 18 |
| ... | ... | ... | ... | ... | ... |

---

## By Kure

### SEARCH — 187 scenarios

#### HybridSearchFilterTest — `ui.website.search.hybridsearch`
- **Tags:** PARALLEL, READ_ONLY, Kure.SEARCH, HYBRID_SEARCH, FILTER_SEARCH
- **Surface:** desktop
- **Methods:**

  | Method | Description | Gating | Notes |
  |---|---|---|---|
  | `testOpenLeftMenuList` | Hybrid arama sayfasında filter tooltip kontrolü | PRODUCTION | |
  | `testClickCriteriaList` | Gelişmiş sıralama URL değişim kontrolü | PRODUCTION, FASTTRACK | |
  | `testDependedSectionVisibility` | Site içi seçim kontrolü | PRODUCTION | |
  | `testSearchResultImageTypeControl` | Avif görüntü class/src kontrolü | | |
  | ... |

#### HybridSearchEdrTest — `ui.website.search.hybridsearch`
- ...

### CLASSIFIED — 224 scenarios
...

---

## By surface

### Desktop (`ui.website.*`) — 760 scenarios
...

### Mobile (`ui.responsive.*`) — 180 scenarios
...

---

## Disabled tests — 8

| Test | Reason | Disabled at |
|---|---|---|
| HybridSearchFilterTest#testTooltipText | WEBT-251142 — tooltip text wrong in prod | 2026-05-21 |
| ... |

---

## Coverage cross-reference (if journey-map present)

<!-- To map journeys → tests, semantic-search qagent's `testlist` per journey
(see `hektor-qagent`), then confirm each named class exists in src/test
before listing it. Falls back to matching journey `Java targets:` against the
walked tree when qagent is unavailable. -->

| Journey | Priority | Covered by |
|---|---|---|
| j-hybrid-search-istanbul | P1 | HybridSearchFilterTest (3 methods) |
| j-classified-post-vehicle | P0 | PostClassifiedVehicleTest, ClassifiedDetailVehicleTest |
| ... |

| Journey | Priority | **Gap** |
|---|---|---|
| j-yepy-sell-iphone | P2 | no test class found |
| ... |
```

### 4. Render PDF (optional)

If the caller asked for PDF, pipe the markdown through
`pandoc` (or the team's chosen converter). A4 landscape orientation for
the by-Kure tables, regular A4 for prose.

---

## Refusal cases

- Caller asks for "every test" with no Kure/domain filter on a 940-test
  suite expecting a one-paragraph answer. Ask for the actual scope or
  confirm "OK to walk all 940? Output will be ~50 pages."
- Caller asks for a metrics dashboard. That's `hektor-work-summary-deck`,
  not this. Redirect.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-test-catalogue",
    "status": "catalogue-emitted",
    "next-action": "share"
  },
  "scope": "whole-suite",
  "snapshot-commit": "<sha>",
  "scenarios-total": 940,
  "by-kure": {
    "SEARCH": 187,
    "CLASSIFIED": 224,
    "INDIVIDUAL": 156
  },
  "by-surface": { "website": 760, "responsivesite": 180 },
  "disabled-tests": 8,
  "catalogue-path": "docs/hektor/test-catalogue.md",
  "pdf-path": null,
  "summary": "940 scenarios catalogued across 10 Kure; 8 disabled (bug-blocked)."
}
```
