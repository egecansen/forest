---
name: hektor-journey-mapping
description: >
  Map user journeys for a sahibinden domain (search / classified posting /
  classified detail / myaccount / yepy / london / shopping / etc.) BEFORE
  writing tests. Discovers routes via the live app, prioritises journeys
  P0/P1/P2/P3, and writes docs/hektor/journey-map.md as a sentinel-bearing
  blueprint that hektor-test-composer and hektor-coverage-expansion consume.
  Triggers on "map the app", "discover journeys", "what flows does
  <domain> have", or when hektor-orchestrator routes an expand-coverage
  entry without a prior map. Mandatory prerequisite for coverage expansion.
---

# Hektor journey mapping

Same purpose as Achilles' journey-mapping skill, customised for the
sahibinden domain shapes and the existing 940-test surface. You produce
`docs/hektor/journey-map.md` — the single document downstream skills
parse to know what to test.

**Core principle:** Understand the app like a user before testing it like an
engineer. Discovery comes before selectors. Journeys come before locators.

---

## Pre-flight

1. **Decide the scope.** Are you mapping a single domain (e.g., hybrid
   search) or the whole app? Hektor defaults to single-domain — the suite is
   already 940 tests across 20+ domains, full-app mapping is rarely useful.
2. **Read `hektor-conventions`** so the discovery output uses correct
   vocabulary (Kure, domain tags, surface).
3. **Check for an existing map.** `docs/hektor/journey-map.md`:
   - Line 1 is `<!-- hektor:journey-mapping -->` → resume; update only
     what changed.
   - Line 1 anything else → ask the user. Don't overwrite.
4. **Identify the two surfaces.** Sahibinden runs `website` (desktop) and
   `responsivesite` (mobile). For each journey, decide whether it applies to
   one or both. Tests will be authored per surface.

---

## Sahibinden section vocabulary (canonical IDs)

The Achilles canonical list (`auth`, `catalog`, `cart`, etc.) is too generic
for a Turkish classifieds + shopping + automotive + real-estate platform.
Use this customised list instead.

| ID | Typical Turkish routes | Notes |
|---|---|---|
| `home` | `/`, `/index` | Homepage, masthead, category tree, popular brands. |
| `search` | `/arama`, `/<category-slug>`, `/kelime-ile-arama` | Hybrid search, faceted filters, query text, map search. |
| `category-landing` | `/kategori`, `/<top-category>/<sub>` | Category landing pages with showcase. |
| `classified-detail` | `/ilan/<slug>-<id>` | Classified detail (DOP), gallery, message box. |
| `post-classified` | `/ilan-ekle`, `/ilan-ekle/<step>` | Classified posting flow (category select → fill details → preview → success → doping). |
| `doping` | `/doping`, `/doping/<id>`, doping selection pages | Listing promotions / boosts. |
| `myaccount` | `/mhesabim`, `/mhesabim/<section>` | Personal account, favourites, messages, classifieds, statistics. |
| `corporate` | `/mhesabim/kurumsal`, `/mağaza/<name>`, `/showroom/<id>` | Pro / corporate listing tools. |
| `auth` | `/giris`, `/uye-ol`, `/sifre-sifirlama`, `/kvkk-aydinlatma` | Login, signup, password reset. |
| `payment` | `/odeme`, masterpass flows | Payment for doping, premium plus, etc. |
| `moneyinsafe` | `/guvenli-para-transferi`, related shopping pages | Escrow / safe-money flow. |
| `shopping` | `/alışveriş`, shopping product detail, basket | Shopping vertical (cell phones, etc.). |
| `yepy` | `/yepy`, device sell flow | Used-device buyback. |
| `s360` | `/360`, real-estate 360 tour | Virtual-tour vertical. |
| `london` | `/londra`, `londonprojects` | London vertical. |
| `network` | `/sahinet`, professional network | Professional network feature. |
| `kvkk` | `/kvkk-*`, `/uyelik-sozlesmesi` | KVKK compliance pages. |
| `helppage` | `/yardim`, `/destek`, `/iletisim` | Help, support, contact. |
| `cookie` | cookie banner + management modal | Cookie consent flow. |
| `seo` | `/sitemap`, SEO landing routes | SEO-only routes, link discoverability. |
| `errors` | `/404`, `/500`, maintenance | Error / fallback pages. |
| `sahiai` | `/sahiai`, AI chat | AI assistant feature. |
| `header-footer` | (cross-cutting layout) | Header nav, footer links, language toggle. |

Use the closest match. Novel categories are allowed but must justify
themselves with a one-sentence rationale at the top of the journey block.

**Pick the right test directory.** Each section maps to a Java package:

| Section | Java test package |
|---|---|
| `home` | `ui.website.home`, `ui.responsive.homepage` |
| `search` | `ui.website.search.*`, `ui.responsive.search` |
| `classified-detail` | `ui.website.classified.classifieddetail`, `ui.responsive.classified.classifieddetail` |
| `post-classified` | `ui.website.classified.postclassified`, `ui.responsive.classified.postclassified` |
| `myaccount` | `ui.website.myaccount.*`, `ui.responsive.myaccount.*` |
| `corporate` | `ui.website.corporate.*` |
| `payment` | `ui.website.classified.postclassified.payment` etc. |
| `yepy` | `ui.website.yepy`, `ui.responsive.yepy` |
| `kvkk` | `ui.website.aggrements` |
| etc. | match the existing tree |

---

## Phases (matching Achilles' shape, sahibinden-customised)

### Phase 0 — Ground in the documented rules (qagent, if available)

Before walking routes, ask the corpus what the product is *supposed* to do.
Per `hektor-qagent`, query the domain's business-rules collection:

```
mcp__qagent__query_collection(
  collection_name="<section>_business_rules",   # arama_, ilan_, alisveris_, bireysel_, kurumsal_*, s360_
  query="<the domain / feature you're mapping>",
  n_results=8)
```

Each returned rule is a candidate **journey, branch, or State variation**,
and its `confluence::<pageId>::<chunk>` id is a citation you carry into the
journey block's `Test expectations:`. This turns discovery from "infer the
spec from the UI" into "confirm the documented spec on the UI". The corpus
is a snapshot — treat each rule as a lead to verify live, not gospel. If
`qagent` is unavailable, skip this phase and discover normally.

### Phase 1 — Route discovery

For the in-scope domain(s):

1. Open the live app (default: dev or staging URL the user provides — or
   `https://www.sahibinden.com` for read-only discovery if no other target).
2. Walk the section's routes breadth-first. Capture every reachable URL,
   route parameter shape, and gated route.
3. Note the Turkish heading on each page (for journey naming) AND the
   English equivalent if the page has a language toggle.
4. Record empty / loaded / errored / authed / unauthed state variations.

You may use Selenium WebDriver (the same one the suite uses) via a quick
ad-hoc Java main class, or browse manually and dictate what you see. **Do
not** invent routes from URL guessing.

### Phase 2 — Flow identification

For each section, derive user flows by following CTAs, dropdowns, tabs,
gallery carousels, accordions, and the cross-section links the section
exposes (e.g., a search-result item links into `classified-detail`).

### Phase 3 — Prioritisation

| Tier | Definition | Examples |
|---|---|---|
| **P0** | Revenue/identity-critical. Failure here is a P1 incident. | Classified posting end-to-end, login, payment for doping/premium-plus, search result loading. |
| **P1** | Core experience. Heavy daily usage; failure is escalated. | Hybrid filter selection, classified detail viewing, favourites, masthead navigation, mobile nav. |
| **P2** | Important but secondary. | Yepy device sell, 360 tour, professional network, shopping basket variants. |
| **P3** | Nice-to-have / SEO / smoke. | Footer links, language toggle, cookie banner, KVKK static pages. |

Sahibinden-specific rule: anything tagged `@MainTag.PRODUCTION` in existing
tests should map to a P0 or P1 journey. Cross-check before classifying.

### Phase 3.5 — Redundancy revision

- Collapse viewport-only variants (mobile vs desktop) into one journey
  with `Surfaces: website + responsivesite`.
- Promote sub-journeys (`sj-`) when 3+ journeys share the same prefix
  (login, category selection, filter application).
- Flag journeys whose steps are entirely a strict subset of another's —
  fold them as State variations on the parent.

### Phase 4 — Author the map

Write `docs/hektor/journey-map.md` with this shape:

```markdown
<!-- hektor:journey-mapping -->
# Journey Map — sahibinden web-test

**Generated by:** hektor-journey-mapping
**Date:** YYYY-MM-DD
**Scope:** <domain or "full">
**Surfaces:** website + responsivesite
**Sections covered:** X
**Flows identified:** X
**Priority breakdown:** X P0, X P1, X P2, X P3
**Mapping completeness:** converged at cycle <N>

## Site Map
[URL list grouped by section]

## Sub-journeys (reusable segments)

### sj-login-authed-individual
- **Pages:** /giris
- **Steps:** 1. enter email / 2. enter password / 3. submit / 4. land on /mhesabim
- **Used by:** [j-fav-classified, j-msg-send, j-post-classified, ...]

## Journeys

### j-hybrid-search-istanbul
**Priority:** P1
**Surfaces:** website + responsivesite
**Section:** search
**Suggested Kure:** Kure.SEARCH
**Suggested domain tags:** SearchDomain.HYBRID_SEARCH, SearchDomain.FILTER_SEARCH
**Entry:** /real-estate-for-sale (HybridSearchPageUrls.SEARCH_RESULT_PAGE)
**Pages touched:** /real-estate-for-sale, /ilan/<slug>
**Existing test classes:** HybridSearchFilterTest (covers OpenLeftMenuList + CriteriaList)
**Sub-journey refs:** []
**Steps:**
1. Open search result page → page loads, filter sidebar visible
2. Click refresh-on-click toggle → spinner appears
3. Wait spinner disappears → results re-render
4. Scroll to keyword filter → filter visible
5. Click tooltip icon → tooltip displayed
**Branches:** different sorting, different filter category
**State variations:** empty results, max-results, gated (login required) for some filters
**Exit:** assertion: tooltip is displayed
**Test expectations:**
- Happy path (entry to exit)
- Error state: no results found
- Edge case: filter combination that yields 0 results
- Mobile: yes — responsive version exists
- EDR: SEARCHED, SEARCH_RESULT_VIEWED, SEARCH_RESULT_FILTER_SELECTED actions
**Java targets (suggested):**
- `ui.website.search.hybridsearch.HybridSearchIstanbulTest` (add `testIstanbulFilterTooltip`)
- `ui.responsive.search.ResponsiveHybridSearchTest` (mirror for mobile)
**UI-covers:** filter-toggle, filter-tooltip, criteria-list

### j-<next>
...

## Section → Journey Map

| Section | Journeys covering it | Existing test packages |
|---|---|---|
| search | j-hybrid-search-istanbul, j-map-search, j-keyword-search | ui.website.search.hybridsearch, ui.website.search.mapsearch |
| ... | ... | ... |

## Gated Areas (Not Mapped)
[admin / paid-features / SSO routes that need provisioned credentials]
```

Rules:
- Line 1 sentinel is `<!-- hektor:journey-mapping -->`. Any file missing
  this is not a Hektor map. Downstream skills refuse to consume it.
- Every journey block carries `Suggested Kure:` and `Suggested domain tags:`
  pointing at real entries in `util/suite/tag/`. Do not invent tags.
- Every journey block carries `Java targets (suggested):` pointing at
  concrete `ui.website.<...>.<Name>Test` package paths. The test composer
  uses these.
- `Existing test classes:` lists any `*Test.java` already covering part of
  the journey. The composer reads this before adding a new class.
- When a `Test expectations:` bullet comes from a documented rule, append
  its citation, e.g. `- URL preserves address filter [rule: confluence::207042280::22]`.
  The composer and bug-discovery skills use these to ground assertions.

---

## Iterative discovery cycles

Same shape as Achilles: at least 2 cycles (1 discovery + 1 edge-probe), up
to 5, written to `docs/hektor/.journey-cycle-state.json` (gitignored):

```json
{
  "hektor-cycle-state-version": 1,
  "scope": "search",
  "cycles": {
    "1": { "kind": "discovery", "sections": ["search"], "completed-at": "..." },
    "2": { "kind": "edge-probe", "sections": ["search"], "completed-at": "..." }
  },
  "convergence-status": "converged"
}
```

Edge-probe explicitly looks for: gated filter behaviour, language=en
variants, EDR-triggering interactions, mobile-only flows, error states
(invalid IDs, expired classifieds, deleted users), cross-section transitions
(search → detail → message → myaccount).

---

## Gate

After writing the map:

> "Journey map written to `docs/hektor/journey-map.md`. I identified X
> journeys across N sections (X P0, X P1, X P2, X P3). Surfaces:
> website + responsivesite where applicable. Please review before I begin
> test composition."

Wait for approval before triggering `hektor-test-composer` or
`hektor-coverage-expansion`.

---

## Return shape (when invoked by `hektor-orchestrator`)

```json
{
  "handover": {
    "role": "hektor-journey-mapping",
    "status": "journey-map-authored",
    "next-action": "advance to phase 3 (test composition) or phase 5 (coverage expansion)"
  },
  "scope": "search",
  "cycles-consumed": 2,
  "convergence-status": "converged",
  "journey-map": {
    "path": "docs/hektor/journey-map.md",
    "sections-mapped": 1,
    "flows-identified": 14,
    "priority-breakdown": { "P0": 2, "P1": 6, "P2": 4, "P3": 2 }
  },
  "gated-areas-not-mapped": 0,
  "summary": "Search domain mapped: 14 flows, no gated areas."
}
```
