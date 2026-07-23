# Iterative, Cluster-First Triage Loop — Design

**Date:** 2026-07-23 · **Status:** approved for planning · **Owner:** Egecan Sen
**Applies to:** `kits/flaky-triage-kit` (kernel §4 operating contract — self-protected) + `apps/console` (minor)

Reorder the triage loop from *"rerun everything up front, then batch-fix"* to *"cluster from the report first,
pick, then rerun only the picked cluster before fixing, then re-cluster and continue."* Faster to the first
decision, cheaper targeted reruns, iterative rhythm — without losing the safety the up-front rerun provided.

## Decisions taken (with the user)

| Decision | Choice |
|---|---|
| Cluster before any full rerun | Yes — cluster straight from the ingested report |
| Broken-box guard | **Keep** a cheap tb health-check up front (I9), NOT a full rerun |
| Confirm-real-vs-flaky | Moves to **per picked cluster, before applying** (the user's "run only that cluster before applying") |
| Iteration | Re-cluster after each round; **multi-pick allowed** per round |

## The loop — before vs after

**Before (kernel §4 today):**
`ingest → rerun ALL fails on tb (confirm) → cluster by meaning + present + STOP (pick) → fix picked batch (apply→compile→green-proof) → converge (report once)`

**After:**
```
0. ingest            pin build, pull FAILED docs (unchanged)
1. health-check tb   cheap broken-box guard (I9) — a known-good probe / ES history, NOT a full rerun.
                     Near-all-fail / unreachable box → stop, report "broken box", don't present a table.
2. cluster-from-report + present + STOP
                     Root-cause meaning buckets straight from the report data (no confirmation rerun).
                     One table, easy-fix → likely-bug, test names per row. Ask: which cluster(s)?  (multi-pick ok)
3. per picked cluster:
   a. rerun THAT cluster on the box   confirm real-vs-flaky for exactly its tests (I4/I9 evidence:
                                      golden-before vs tb-now). Dismiss any that pass / are already-green.
   b. apply → compile → green-proof   fix from that run + findings; pass^N on the box (unchanged discipline).
4. re-cluster + return updated clusters
                     Re-run cluster.sh over the remaining + any newly-surfaced failures; present the updated
                     set. Loop to step 2's decision. Converge/summary when the user stops or nothing remains.
```

## What's preserved (safety)

- **I9 broken-box** — the up-front health-check stays; we just don't rerun *everything*.
- **I4 mask-a-regression** — the confirm-on-box moves to *before applying the picked cluster* (per the user's
  own step). A test is only fixed after its failure is re-confirmed real on the box; a vanished element is still
  a 🐛, not a fix. Evidence (golden *before* vs tb *now*) is gathered for exactly the tests we act on.
- **I2/I3/I5/I7/I10/I11 unchanged** — existence-intersection, source-root confinement, re-derive-from-source,
  I7 summary allowlist, rev-pin, and the `validate --final` session-end gate all hold.
- Net: we stop *pre-confirming tests we'll never touch* (the wasted up-front full rerun), and gain the
  broken-box guard cheaply. No safety invariant is dropped — one moves and one shrinks to a health-check.

## Changes

### Kit (kernel §4 + adapters)
- **kernel.md §4** — rewrite "The loop" to the After sequence above; adjust §2/§5 cross-references
  (classification still from the delta, now gathered per-cluster at 3a). Note the health-check is I9 and the
  per-cluster confirm is I4 — reorder, not removal.
- **adapters/claude/SKILL.md + cursor/.mdc** — rewrite the loop steps + presentation discipline to the
  iterative model: cluster-from-report is the FIRST table (no up-front confirmation rerun); after each cluster
  reaches a terminal verdict, re-cluster the remaining/emergent fails and re-present. The Stage-2 ledger
  discipline is unchanged (publish provisional clusters at the mechanical cut; record cluster-state/events;
  `validate --final` before the final summary). Add: "rerun only the picked cluster's FQCNs at 3a" and
  "re-cluster and re-present at step 4 — the table recurs each round."
- **No `core/*.sh` signature changes** — `rerun.sh` already takes an FQCN csv (running "only that cluster" =
  pass just its FQCNs); `cluster.sh` already produces clusters from FAILED docs (running it at step 4 over the
  remaining set is a sequencing change). This is a **discipline/ordering** change, not an engine rewrite.

### Console (minor)
- The board is already ledger-driven and the AskUserQuestion pick already supports multi-select and recurrence,
  so the iterative loop mostly *already works*: each round the agent re-`set_clusters`/ledger-upserts and asks
  the pick again; the watcher renders the updated set.
- **Phase model** (`ingest→cluster→pick→fix→verify→report`, forward-only): in an iterative loop, pick/fix/verify
  recur. Treat phases as a **high-water mark** (furthest stage reached); `report` completes only at final
  convergence. Add a small **round counter** (e.g. "round 2") to the run header / Clusters eyebrow so recurring
  rounds are legible; clusters that are new this round get a subtle "new" marker (reuse the existing state
  chips). No phase-machine rewrite — forward-only stays; re-entered phases just don't regress.
- The Clusters tab already distinguishes states; "returned newly created clusters" surface as new `proposed`
  rows appended by the watcher — verify the carry-forward (Stage-2 fix) keeps prior terminal clusters visible
  across rounds so the board accumulates the full picture.

## Testing

- **Kit:** kernel/SKILL are prose — verify by one real (or `HEKTOR_DISABLE_MCP`) triage that follows the new
  order: table appears *before* any full rerun; picking one cluster triggers a rerun of only its FQCNs; after
  it converges a fresh table with the remaining clusters is presented. No new `core/*.sh` unit tests (no
  signature change), but add a SKILL-adherence check to the acceptance protocol.
- **Console:** round-counter + new-cluster marker get RTL tests; watcher carry-forward across rounds already
  tested (Stage-2) — add a multi-round fixture asserting round-2 clusters append without dropping round-1
  terminal ones.
- **Acceptance:** one live triage exhibiting ≥2 rounds; broken-box health-check verified by pointing at a
  degraded/unreachable tb (should refuse to present a table).

## Out of scope

Parallel per-cluster reruns (still serialized on the gradle lock) · auto-picking clusters · any change to
apply/compile/green-proof mechanics or safety invariants I1–I11 beyond the I4/I9 *reorder* above · the
kit-hardening items from the concurrent security audit (separate follow-up round).
