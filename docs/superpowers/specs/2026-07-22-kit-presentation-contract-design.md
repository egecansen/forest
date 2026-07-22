# Kit Presentation Contract (Stage 2) — Design

**Date:** 2026-07-22 · **Status:** approved for planning · **Owner:** Egecan Sen
**Applies to:** `kits/flaky-triage-kit` (kernel-governed, self-protected) + `apps/console` (consumer)

Make the flaky-triage kit's run state fully machine-readable ground truth for every harness
(console, terminal, Cursor, future CI): human-readable cluster titles/details, a closed bucket
vocabulary, verified green-proof progress, phase events, and a hard session-end rule — all in
`ledger.json`, validated at the write seam. The console's MCP fast-path becomes optional garnish.

## Decisions taken (with the user)

| Decision | Choice |
|---|---|
| Granularity | Cluster-level + counts; per-test `status` only where a test diverges from its cluster |
| Bucket vocabulary | Kernel adopts the console's six as canonical: `easy-fix · selector · vrt · app-change · infra · likely-bug`, with a §5.1 signature→bucket mapping |
| Write seam | Hybrid: validated `ledger.sh` subcommands for all writes **plus** `ledger.sh validate [--final]` gate |
| Contract location | In-place `kernel.md §8` amendment, `ledger.version: 2` (no second artifact, no event-sourcing rewrite) |
| Session-end rule | Both halves: SKILL hard Don't **and** machine enforcement via `validate --final` |

## 1. Schema — kernel §8 v2

```
run:     { id, sReportUrl, build{name,@timestamp}, tb, startedBy, version: 2 }
cluster: { id, title,                  # ≤80 chars, human phrasing — I7-governed: never raw stackTrace
           detail,                     # ≤600 chars evidence summary; may quote signatures, never full traces
           signature, tier, bucket,    # bucket ∈ the six (closed enum, kernel-canonical)
           fixVsBug, evidence,
           tests[ {fqcn, status?} ],   # status ∈ red|green|skipped, present only when diverging
           status: proposed|selected|applied|green|deferred|flagged|resolved-upstream,
           passes, runs,               # green-proof progress; integers; passes ≤ runs
           diffRef, lineage, greenProofScope }
event:   { who, what, when, phase? }   # what gains 'phase-enter'; phase ∈ ingest|confirm|cluster|pick|fix|verify|report
```

The `phase` vocabulary is kernel-side (7 values — `confirm` is the pre-pick confirmation rerun);
display consumers map it to their own pipeline (the console folds `confirm` into its Cluster phase).

- §5.1 gains a **bucket column**: every signature row maps to one of the six (e.g. OneTrust → easy-fix,
  brittle selector → selector, VRT drift → vrt, app contract violation → likely-bug, broken box → infra,
  changed-app-text assertion → app-change). Recipes/tiers unchanged.
- §7 gains an invariant row (**I11**): *a session may not end while any `selected` cluster is
  non-terminal; `ledger.sh validate --final` must pass before the convergence summary.*
- v1 ledgers (no `version` field) remain valid; consumers key behavior on `version`.

## 2. `ledger.sh` v2 surface (core, P3-validated)

- `init` — stamps `version: 2` (unchanged shape otherwise).
- `cluster-upsert <id> --title T --detail D --bucket B --tier N --tests fqcn,…` — validates: id slug,
  title/detail length caps, bucket ∈ six, FQCN regex (I1), creates or updates.
- `cluster-state <id> <status> [--passes N --runs N] [--test fqcn=red|green|skipped]…` — validates the
  status **transition table** (proposed→selected→applied→{green|flagged|deferred}; any→resolved-upstream;
  no terminal→non-terminal) and `passes ≤ runs`.
- `event <what> [--phase P]` — appends provenance/phase events (`who` from env/user, `when` stamped).
- `validate [--final]` — jq schema check of the whole file; `--final` additionally fails (non-zero, with
  the offending cluster ids) when any `selected` cluster lacks a terminal status.
- All subcommands are the ONLY sanctioned ledger writers (kernel P2 extended to state); hand-edited
  JSON is a discipline violation the validate gate will usually catch.

## 3. SKILL discipline (both adapters: claude SKILL.md + cursor .mdc)

1. **Route all ledger writes through the subcommands** — never edit ledger.json by hand.
2. **Publish early, refine before the pick:** upsert provisional clusters at mechanical-cut time
   (short provisional titles fine); refine title/detail/bucket before presenting the pick — the pick
   table is *read from the ledger*, so table and state cannot diverge.
3. **Hard Don't:** never end the session while a `selected` cluster is non-terminal. Run
   `ledger.sh validate --final` before the convergence summary; failure means you are not done —
   collect verdicts (wait for reruns; never background-and-quit). The summary's five §9 sections map
   1:1 to terminal statuses.

## 4. Console watcher upgrade (v2 consumer)

- Detect `version: 2` → the watcher may **create** clusters (title/detail/bucket present), update
  verified `passes/runs`, surface per-test divergence, and drive phase state from `phase-enter`
  events. Bash command-sniffing remains as the v1 fallback only.
- MCP tools (`set_clusters`/`cluster_status`) stay for instant updates but are no longer load-bearing:
  with them disabled, the board must reach a complete, correct final state within one poll interval.

## 5. Cross-harness, packaging, unlock

- Files touched: `kernel.md` (§5.1 column, §7 I11, §8 v2), `core/ledger.sh`, `core/README.md`
  (ledger contract row), `adapters/claude/SKILL.md`, `adapters/cursor/hektor-flaky-triage.mdc`.
- Process: `HEKTOR_FLAKYKIT_UNLOCK=1 core/lock-kit.sh unlock` → edit → test → `lock` → re-run
  `install.sh --project ~/sahibinden/repo/web-test` (idempotent) → regenerate `flaky-triage-kit.zip`.
- Migration: none. v1 ledgers readable forever; `init` stamps v2 for new runs; other harnesses adopt
  by re-running install, and lose nothing if they don't.

## 6. Testing

- **Kit:** first test file for `ledger.sh` (plain bash asserts, kit idiom): enum/length/FQCN/transition
  rejections; `validate --final` failing on non-terminal selected; v1-file tolerance; idempotent upsert.
- **Console:** watcher unit tests on v2 fixtures (creation, divergence, phase events, passes/runs);
  existing v1 fixture tests unchanged (regression).
- **Acceptance:** one real triage with the MCP tools disabled — board completeness from the ledger
  alone is the pass criterion.

## Out of scope

Per-test full ledger records · event-sourced state · CI/Jenkins consumers · auto-resume on validate
failure (the console's paused-parking already covers the console side) · any change to apply/rerun
semantics or safety invariants I1–I10.
