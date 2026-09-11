---
name: hektor-qagent
description: >
  The retrieval kernel for sahibinden's QA corpus — a read-only ChromaDB
  (Gemini-embedded) semantic index of EVERY existing test (web + Android +
  iOS), the documented domain business rules (from Confluence), and the
  step-level execution traces of past runs. Exposed via the `qagent` MCP
  (tools: list_collections, get_collection_info, query_collection). Load
  this BEFORE composing a test (to dedup against existing coverage), BEFORE
  mapping a journey or hunting bugs (to ground in the documented rules), and
  during page-authoring / failure-diagnosis (to recover the selector a flow
  historically used). Triggers on "has this been tested", "does a test exist
  for X", "what are the business rules for <domain>", "search the test
  corpus / test history", "what selector does <flow> use", or whenever
  another Hektor skill needs to consult prior QA knowledge.
---

# Hektor qagent — the QA-corpus retrieval kernel

This skill is a **reference, not a workflow** — like `hektor-conventions`.
Load it when you need to ask the existing QA knowledge base a question
instead of re-deriving the answer from the live app or a `grep`.

`qagent` is a **read-only** MCP. It has no add/update/delete tools, so
nothing you do here mutates the corpus. It is a snapshot index that can lag
`master` — **everything it returns must be verified against the live repo
or live app before you rely on it** (see Guardrails).

---

## What's behind it

- **Server:** `chroma-gemini-mcp` → ChromaDB at
  `chroma-s-test-applications.apps.ocptbox.tzla.sahibindenlocal.net`.
- **Embeddings:** Gemini `gemini-embedding-001` (768-dim). Semantic, so a
  natural-language query in Turkish or English matches conceptually — you do
  NOT need the exact method name.
- **Scope:** the whole QA org — web (`com.sahibinden.web.ui.*`), Android
  (`sahibinden.tests.mainapp.*`), and iOS. For web work you must scope your
  results (see Guardrails → scope).

## The three tools

When the MCP is loaded they appear as:

| Tool | Args | Returns |
|---|---|---|
| `mcp__qagent__list_collections` | — | all 28 collections + ids |
| `mcp__qagent__get_collection_info` | `collection_name` | record count, embedding info |
| `mcp__qagent__query_collection` | `collection_name`, `query`, `n_results?` (default 5), `where?` (exact metadata filter) | ranked semantic matches with content + metadata |

`where` is an **exact** metadata filter, e.g. `{"kure": "Arama"}` or
`{"testClassName": "...HybridSearchFilterTest"}`. Use it to scope; don't
post-filter in your head when the filter can do it.

---

## The corpus — three families + regression sets

### 1. `testlist` (≈6800 records) — the existing-coverage index

One record per **test method**, across web + Android + iOS. This is what
you query to answer *"does a test already exist for X?"*

Metadata: `testClassName`, `testMethodName`, `kure`, `description`, `tags`.

- Web desktop → `testClassName` starts `com.sahibinden.web.ui.website.`,
  tag `web_tests`.
- Web mobile → `com.sahibinden.web.ui.responsive.`, tags
  `mobile_site_tests` / `responsive`.
- Native → `sahibinden.tests.mainapp.*` (`kure` = `Android` / iOS).

### 2. `*_business_rules` — the oracle (sourced from Confluence)

One record per **documented, numbered product rule**, chunked by Confluence
heading from the "Otomasyon RAG Info : <…> Küre" pages. This is the
acceptance-criteria / invariant source — query it to ground *what correct
behaviour is*, instead of inferring from the UI.

Metadata: `pageId`, `pageTitle`, `heading`. IDs look like
`confluence::<pageId>::<chunk>` — cite them in `@Description` rationale and
in adversarial findings.

Available: `arama_`, `ilan_`, `alisveris_`, `bireysel_`, `kurumsal_temel_`,
`kurumsal_ek_`, `s360_business_rules`. (No business_rules for london / yepy
/ reklam / operasyon yet — fall back to their `*_teststeps`.)

### 3. `*_teststeps` — step-level execution traces

One record per **executed step** of a past run: action, detail, page name,
selector, assertion args, step number, status code, response time. Query it
to recover *the selector a flow actually used* and *the page object it
touched* before re-deriving locators or diagnosing a stale one.

Metadata: `testName`, `stepNumber`, `step` (action), `stepDetail`,
`pageName`, `elementSelector`, `assertionArgs`, `statusCode`,
`responseTime`. IDs look like `<testName>::<stepNumber>`.

Available: `arama_`, `ilan_`, `alisveris_`, `bireysel_`, `kurumsal_temel_`,
`kurumsal_ek_`, `reklam_`, `operasyon_`, `s360_`, `london_`, `yepy_`,
`android_`, `ios_teststeps`.

### Regression / approval sets

`android_regression_set`, `ios_regression_set`, `ios_test_onay`,
`yepy_test_onay`, `arama_reklam_test_onay`,
`merkez_test_mobil_test_onay`, `testdama` — curated mobile subsets; rarely
relevant to web work.

### Section → collection map (aligns with `hektor-journey-mapping` IDs)

| Journey section | business_rules | teststeps |
|---|---|---|
| `search` | `arama_business_rules` | `arama_teststeps` |
| `classified-detail` / `post-classified` / `doping` | `ilan_business_rules` | `ilan_teststeps` |
| `shopping` | `alisveris_business_rules` | `alisveris_teststeps` |
| `myaccount` (individual) | `bireysel_business_rules` | `bireysel_teststeps` |
| `corporate` | `kurumsal_temel_business_rules`, `kurumsal_ek_business_rules` | `kurumsal_temel_teststeps`, `kurumsal_ek_teststeps` |
| `s360` | `s360_business_rules` | `s360_teststeps` |
| `london` | — | `london_teststeps` |
| `yepy` | — | `yepy_teststeps` |
| ads / `reklam` | — | `reklam_teststeps` |

---

## Query recipes (per consuming skill)

**Dedup before composing** (`hektor-test-composer`, `hektor-coverage-expansion`):
```
mcp__qagent__query_collection(
  collection_name="testlist",
  query="<the journey/scenario in one sentence>",
  n_results=8,
  where={"kure": "<domain-kure>"})   # then keep only com.sahibinden.web.ui.* hits
```
A close hit on `com.sahibinden.web.ui.website.*` / `.responsive.*` means the
scenario likely already exists — open that class in the live repo and
**extend the matching method** (strengthen its assertion) instead of writing
a sibling method or a new class. A new method is only justified when no
existing method visits that screen. A hit only on native
(`sahibinden.tests.mainapp.*`) is a cross-platform parity gap, not a dup.

A generated method already on **this** page's layouts is reused. The same
CSS on a different UI layout is a real field, not a clone.

**Ground in the documented rules** (`hektor-journey-mapping`,
`hektor-test-composer`, `hektor-bug-discovery`):
```
mcp__qagent__query_collection(
  collection_name="<section>_business_rules",
  query="<feature / flow you're mapping or attacking>",
  n_results=6)
```
Each returned rule is a candidate `Test expectation:` (composer), a journey
branch/state-variation (mapping), or an invariant to attack (bug-discovery).
Cite the `confluence::<pageId>::<chunk>` id.

**Recover a historical selector / page object** (`hektor-page-authoring`,
`hektor-failure-diagnosis`):
```
mcp__qagent__query_collection(
  collection_name="<section>_teststeps",
  query="<the interaction, e.g. 'POI location suggestion click'>",
  n_results=5)
# or pin to one test's trace:
  where={"testName": "com.sahibinden.web.ui.website.search...Test.testX"}
```
Returns the `elementSelector` + `pageName` past runs used. It's a **lead,
not a fact** — confirm it on the live DOM before writing `@FindBy`.

**Coverage census** (`hektor-coverage-expansion`, `hektor-test-catalogue`):
`get_collection_info("testlist")` for the total, then `query_collection`
per journey with `where={"kure": ...}` to gauge existing density and rank
thin areas.

---

## Guardrails (hard rules)

1. **Snapshot, not truth.** The index can lag `master`. Any
   `testClassName` / `testMethodName` / `elementSelector` it returns must be
   confirmed in the live repo (or on the live DOM) before you edit, extend,
   or cite it. Same discipline the rest of Hektor already enforces.
2. **qagent informs *what*, never *how*.** `review.md`,
   `web-ui-test/generateMethods.md`, and `hektor-conventions` remain the
   sole authority on how Java is shaped. qagent tells you what to test and
   what already exists — it never overrides a framework rule.
3. **Scope to web.** `testlist` mixes platforms. Filter to
   `com.sahibinden.web.ui.*` / `web_tests` / `responsive`, or `where` by the
   web `kure`. A native-only match is a parity signal, not a duplicate.
4. **Calibrate similarity empirically.** Scores run low even for good
   matches (~0.31–0.44 in practice) — don't hard-code a threshold. Read the
   top-N content and judge relevance; treat the ranking as ordinal.
5. **Don't invent collection or metadata names.** Use the tables above; if
   unsure, call `list_collections` first. A wrong `collection_name` returns
   a 404, not a guess.

---

## Availability / troubleshooting

- The MCP is registered per-project in Cursor's MCP settings
  (`.cursor/mcp.json`, or the global `~/.cursor/mcp.json`), so the entry is
  not committed unless you commit that file.
- MCP servers load at **session start**. If the qagent tools aren't present,
  the server was added mid-session — **reload the Cursor window**
  (`Cmd/Ctrl+Shift+P` → *Developer: Reload Window*) to surface them, and
  confirm the server shows as connected under *Settings → MCP*.
- If a query errors, re-check `collection_name` against `list_collections`
  (names are Turkish-domain-prefixed, e.g. `arama_`, not `search_`).
- This is augmentation. If qagent is unavailable, every consuming skill
  must fall back to its existing method (`grep @Description`, live-DOM
  inspection, reading `review.md`) — never block on it.

---

## Used by

`hektor-journey-mapping` (rule grounding) · `hektor-test-composer` (dedup +
`@Description` grounding) · `hektor-coverage-expansion` (census + dedup) ·
`hektor-bug-discovery` (rule-derived probes + dedup) ·
`hektor-page-authoring` (historical selectors) ·
`hektor-failure-diagnosis` (historical step trace) ·
`hektor-test-catalogue` (cross-reference).
