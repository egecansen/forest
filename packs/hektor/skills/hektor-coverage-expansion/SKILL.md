---
name: hektor-coverage-expansion
description: >
  Iteratively expand test coverage across a sahibinden domain (or the whole
  suite) by walking docs/hektor/journey-map.md in priority order, dispatching
  hektor-test-composer per journey, deduping at the end of each pass, and
  optionally running adversarial passes via hektor-bug-discovery. Triggers on
  "expand coverage", "iterate coverage", "deep coverage pass", or when
  hektor-orchestrator routes an expand-coverage entry. Does NOT compose
  tests itself — that is hektor-test-composer.
---

# Hektor coverage expansion

You orchestrate the per-journey composition loop. You hold the journey-map
index, the independence graph, the pass counter, and the dedup ledger.
Journey-level reasoning happens inside dispatched `hektor-test-composer`
subagents with isolated context.

---

## Two valid exits — read this first

There are exactly two ways for a run to terminate:

1. **All passes for the requested mode complete**, with every priority-tier
   journey dispatched in every pass.
2. **Commit-what-landed + write `docs/hektor/coverage-expansion-state.json`
   + stop with "resume needed"** — naming the completed passes, the in-flight
   pass, and the pending journeys.

There is no third exit. Phrases like "pragmatic Pass 1 only", "honest
deferral of Passes 2+", "scope-reduced given session length" are the
contract violations this skill exists to prevent. Mirror Achilles'
coverage-expansion contract here.

Exit #2 requires at least one dispatch in flight. A state file with zero
recorded dispatches is the pre-emptive-stop anti-pattern.

Deferrals require an `authorizer` field with a verbatim user quote unless
the reason starts with `blocked-on-app-bug:<id>`,
`test-data-prerequisite:<thing>`, or `user-authorised:<verbatim>`. Self-
imposed reasons (`budget-cap`, `session-length`, `auto-mode`) are not
authorisation.

---

## Loop antibody (per-pass boundary)

An autonomous pass must not lower coverage, delete, weaken, or quarantine
existing specs, or loosen assertions to go green. The per-pass done-
criterion is **new coverage added AND nothing existing weakened** — going
green by subtracting a test is a contract violation, not progress. The
independent judge that adjudicates a red result (`hektor-failure-diagnosis`)
must stay structurally separate from the `hektor-test-composer` agent that
composed it — the composer never grades its own homework.

---

## Modes

| Mode | Composition passes | Adversarial passes | Per-journey strict? | When |
|---|---|---|---|---|
| `breadth` | 1 horizontal sweep | 0 | First pass only | Fast smoke of a new domain |
| `standard` (default) | 3 | 2 | Pass 1 strict; Passes 2-5 may group by section | Daily |
| `depth` | 3 | 2 | Every pass strict per-journey | Quarterly audits, P0 business domains |

Pass 1 = scaffold (happy paths). Pass 2 = error states. Pass 3 = edge cases.
Passes 4-5 = adversarial (delegated to `hektor-bug-discovery`).

---

## State file

`docs/hektor/coverage-expansion-state.json` (gitignored):

```json
{
  "hektor-coverage-state-version": 1,
  "scope": "search",
  "runMode": "standard",
  "currentPass": 2,
  "passes": {
    "1": {
      "kind": "compositional",
      "journeys-dispatched": ["j-hybrid-search-istanbul", "j-map-search"],
      "journeys-returned": ["j-hybrid-search-istanbul", "j-map-search"],
      "deduped-at": "2026-05-21T11:00:00Z"
    },
    "2": {
      "kind": "compositional",
      "journeys-dispatched": ["j-hybrid-search-istanbul"],
      "journeys-returned": [],
      "in-flight-since": "2026-05-21T11:05:00Z"
    }
  },
  "deferredJourneys": [],
  "lastUpdate": "2026-05-21T11:05:00Z"
}
```

The state file is post-action ledger, not a pre-action plan. Write a pass
row when the pass dispatches; update `journeys-returned` as subagents
return; only mark `deduped-at` after the dedup step actually ran.

---

## Procedure

### 0. Preconditions

1. `docs/hektor/journey-map.md` exists, line 1 sentinel present. If not,
   stop and tell the caller to run `hektor-journey-mapping`.
2. Working tree clean.
3. `gradle build -x test` passes.

### 1. Read the map

Load the journey-map index — IDs, priorities, surfaces, sections, and
`Existing test classes:`. Build the independence graph: two journeys are
independent if their `Pages touched:` don't overlap.

**Coverage census (qagent, if available; see `hektor-qagent`).** Before
ordering the work, gauge where coverage is already dense vs thin so you
dispatch effort where it pays. `get_collection_info("testlist")` for the
total, then per in-scope journey:

```
mcp__qagent__query_collection("testlist", "<journey in one sentence>",
  n_results=10, where={"kure": "<domain-kure>"})
```

Journeys whose top hits are close, web-scoped, and many → already dense
(dispatch later / lighter). Journeys with no close web hit → thin (prioritise
within their tier). A journey covered only on native is a parity gap worth a
web pass. This refines priority *within* a tier; it never reorders P0 above
P1. Verify named classes in the repo — the index can lag. Skip if qagent is
unavailable.

### 2. Pass-1 dispatch (compositional, scaffold)

Order: P0 → P1 → P2 → P3.

- Dispatch one `hektor-test-composer` per journey **in parallel** up to the
  host's max parallelism cap. Pass 1 is **strict per-journey** in both
  `standard` and `depth` modes — no grouping.
- Each subagent's brief: `journey: <id>`, `surface: <from-map>`, plus the
  pointer to `docs/hektor/journey-map.md`.
- Wait for ALL Pass-1 subagents to return before Pass 2 dispatch.

### 3. Per-pass dedup

After every pass, walk the new test methods and check for duplicate
scenarios within the pass. Drop or merge. Record the merge under the
pass's `deduped-at` timestamp.

Sahibinden-specific dedup heuristics:
- **qagent `testlist`** (if available) — semantic-search each newly added
  method's scenario; a close pre-existing web hit that the composer missed
  is a cross-pass duplicate to fold. Catches conceptual dupes a literal
  `@Description` match won't.
- Same `@Description(...)` text across two methods → near-certain duplicate.
- Two methods exercising the same `clickX → assertY` chain with only data
  difference → fold into one `@ParameterizedWebTest`.
- A `website` test and a `responsivesite` test with identical step lists
  are NOT duplicates — they're the surface-pair the journey block called
  for.

### 4. Pass 2 (error states)

For each journey, dispatch `hektor-test-composer` with an explicit brief:
"add the error-state variants from j-X's Test expectations:". Composer
already covers this in §1's variant table — your brief reminds it which
expectations are pending.

Pass 2 may use section-grouped dispatches under `runMode: standard` when a
section has >5 journeys (e.g., search domain alone might have 15+ P2/P3
journeys). Group cap: 7 journeys per group; group by section.

Under `runMode: depth`, no grouping — every journey gets its own dispatch.

### 5. Pass 3 (edge cases)

Same as Pass 2 but the brief asks for the edge-case + data-lifecycle
expectations.

### 6. Passes 4–5 (adversarial)

Delegate to `hektor-bug-discovery` per journey (under depth) or per
section group (under standard). Findings land in
`docs/hektor/adversarial-findings.md`. Each finding either becomes a
regression test or gets the `@bug` flag for human triage. See the
bug-discovery skill for the full protocol.

### 7. Coverage gate

After all passes complete, build the final coverage matrix:

| Journey | Priority | Steps | Steps covered | Status |
|---|---|---|---|---|
| j-hybrid-search-istanbul | P1 | 5 | 5 | Complete |
| j-classified-post-vehicle | P0 | 12 | 11 | **Missing: payment-failure variant** |

Gate rules (mirror Achilles):
- Any P0 journey with <100% step coverage → must fix before reporting done.
- Any P0 journey without error-state coverage → must fix.
- P1 < 75% → should fix.
- P2/P3 < 50% → nice to have, document the gap.

### 8. Ledger update (no auto-commit)

- **Do not commit.** `hektor-test-composer` does not commit either.
  Surface all ready files and wait for the user.
- Update `docs/hektor/run-status.json` with pass results.
- Optional: dispatch `hektor-work-summary-deck` if the user requested a
  report.

---

## Refusal / blocking

- `hektor-test-composer` returns `blocked` 3 times for the same journey →
  defer that journey with `reason: blocked-on-app-bug:<id>` or
  `reason: blocked-on-flaky-app` and continue with the rest. Surface to
  the user at run end.
- The map is missing the sentinel → refuse, ask for re-mapping.
- The map's `Java targets (suggested):` paths don't exist as packages and
  the user hasn't authorised package creation → ask before letting
  `hektor-page-authoring` create new package trees.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-coverage-expansion",
    "status": "expansion-complete",
    "next-action": "report or repair"
  },
  "scope": "search",
  "runMode": "standard",
  "passes-completed": 5,
  "journeys-dispatched": 14,
  "journeys-completed": 12,
  "journeys-deferred": [
    {
      "id": "j-search-360-tour",
      "reason": "blocked-on-app-bug:#WEBT-251142",
      "authorizer": null
    }
  ],
  "new-test-classes": 18,
  "new-test-methods": 47,
  "adversarial-findings": 6,
  "regression-tests-from-findings": 4,
  "summary": "Search domain expansion complete: 12/14 journeys covered, 2 deferred on app bugs, 6 adversarial findings (4 regressions, 2 @bug)."
}
```
