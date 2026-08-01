# Hektor Flaky-Triage Kit — Kernel Spec

**Status:** DRAFT — refine + vuln-hunt against this doc.
**Scope (this phase):** flaky **testbox** runs only.
**Out of scope (this phase):** prod/preprod runs · Jenkins/unattended automation · ticket filing · committing.

The kernel is **form-agnostic** — it's the brain the eventual Hektor skill *and* the Jenkins
stage will both implement. Everything is generic except §10 (the sahibinden config seam).

---

## 1. Purpose

Given a flaky-run **s-report + a testbox**, separate real failures from flaky / per-box /
report noise, cluster by root cause, propose and (on the user's selection) apply test/selector
fixes **verified green on that tb**, and flag suspected app-bugs for the user's investigation —
**without ever filing tickets, disabling tests, or committing**.

## 2. Trust model (read first)


| Entity                                               | Trust                                       | Consequence                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Report data** (testName, stackTrace, tags…)        | **UNTRUSTED**                               | validate before any shell/query/path use; may be stale/poisoned/malformed                                                                                                                                 |
| **Current codebase**                                 | **source of truth**                         | what exists / is already fixed; cross-check every `testPath`                                                                                                                                              |
| **The testbox**                                      | **verification oracle**                     | health-check first; a broken box invalidates every verdict                                                                                                                                                |
| **The user**                                         | **sole authority**                          | for fixes applied, bugs confirmed, tickets, disables, commits                                                                                                                                             |
| **ES s-report**                                      | **untrusted-current**                       | pass/fail history (the failure list) + flaky-history pivot; verify vs live                                                                                                                                |
| **qagent** (golden steps/selectors + business rules) | **untrusted-advisory** (snapshot, semantic) | enriches evidence; verify vs code/tb; its golden selector may itself be brittle                                                                                                                           |
| **jira ticket** (the build's `jiraTicket`)           | **untrusted-advisory, read-only**           | scope = description + **ALL linked tickets (one hop)**; **the bare tag is build-level (tags every failing test) ⇒ a FALSE per-cluster signal** — overlap the *scope*, not the tag; **never written** (I8) |


**Evidence combines as a diff:** qagent gives the golden *before* (selectors, steps, expected rules), the tb re-run gives *now*, current code is *truth* — classify from the **delta**, never one source alone.

**Determinism (of the logic, not the verdicts):** the classification *logic* is deterministic — same `(report, code)` → same clusters — but the **re-run verdicts are NOT** (Selenium / timing / live data / ads), which is exactly why flaky = a *confidence* over N runs, not one pass. The report and the re-run are also **time-shifted**: a pass can mean flaky / resolved-upstream / data-drift / per-box — four verdicts with four actions. **Disambiguate; never collapse all four to "flaky."**

## 3. Inputs & validation

- `sReportUrl` — host **allowlisted**; extract `fullTestBuildName` + `buildStartTime`.
- `tb` — target testbox id, must be **numeric** (`^[0-9]+$`).
- `testBuildName` — must match the known job pattern.
- **Build disambiguation:** resolve by exact `testBuildName.keyword` **AND** `@timestamp ≈ buildStartTime`. Never by build number alone — they're reused (stale-build trap).

## 4. The loop (operating contract)

```
0. INPUT        s-report + tb                                    [validated §3]
1. INGEST&PIN   pull FAILED docs for the pinned build from ES
2. HEALTH-CHECK cheap tb probe (I9) — a known-good check / per-test ES history, NOT a full
   /tb          rerun. Near-all-fail or unreachable box ⇒ broken box: stop, say so, present NO
                table (a broken box makes every failure look real). Seconds, not minutes.
3. CLUSTER      group the report's FAILED docs by MEANING a human recognizes (selector moved ·
   (from report) VRT baseline drift · app behavior change · redesign migration · flaky-infra ·
                likely-bug) — re-group the mechanical signature; NEVER raw-exception buckets.
                per cluster: bucket · fix-vs-🐛 (evidence-gated) · action · its tests.
                skip clusters already green in current code.
                ONE table, easy-fix → likely-bug, one line each  ── STOP: which cluster(s)? ──
                (multi-pick allowed; NO confirmation rerun has run yet — cluster from the report)
4. CONFIRM&APPLY for each picked cluster: RE-RUN ONLY ITS TESTS on tb (clean) — confirm real vs
   (per cluster) flaky/already-green (I4/I9 evidence: golden BEFORE vs tb NOW; dismiss any that
                pass). Then take the confirmed-real ones END-TO-END: apply to the WORKING TREE
                (clean-tree check, diff, never commit) → GREEN-PROOF (widen to the shared-layout
                blast radius when the edit hits a shared Page/Layout). Report the batch ONCE.
5. RE-CLUSTER   re-cluster the REMAINING + any newly-surfaced failures; present the UPDATED table.
   &RE-ENGAGE   steering may split/redefine. loop to 3's decision (pick the next). one prompt,
                not per-item.
6. CONVERGE     emit the convergence summary. user reviews the diff and commits.  ── kit NEVER commits ──
```

Two human gates only: **cluster-selection** (step 3) and **review-commit** (step 6) — do not
add a third by stopping for mechanics or per-item micro-approvals.

**Keep it simple (the operating style).** The user drives this and reads every turn; give the
map and the decision, not the engine. ONE easy→bug table, minimal per-row detail, clusters by
meaning. Keep build ids / run anomalies / rerun+dom mechanics / task ids OUT of the reply — use
the tools silently and surface conclusions. Between the two gates, execute end-to-end and report
once. This style is the kit's contract, not a preference; a long, stop-heavy turn means you've
drifted. (Regressions still get flagged, never masked — I4.)

## 5. Classification

### 5.0 Evidence sources (all advisory except code + tb)


| Source                                           | Gives                                                                                                                                                                                          | Trust                             | Used for                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ES s-report                                      | build-over-build pass/fail                                                                                                                                                                     | untrusted-current                 | the failure list; flaky-history pivot                                                                                                                    |
| qagent `*_teststeps`                             | golden selector + step sequence + navigate URL **+ client/API calls (FeatureGateway/user clients) + the golden testbox**                                                                       | untrusted-snapshot                | moved-vs-vanished *before*; repro; recipe siblings; **flag/user-dependency detection; control-box candidate**                                            |
| qagent `*_business_rules`                        | documented expected behavior (Confluence)                                                                                                                                                      | untrusted-snapshot                | the fix-vs-🐛 evidence (does the app violate a *documented* rule?)                                                                                       |
| current code                                     | what exists / already fixed                                                                                                                                                                    | **truth**                         | existence (I2); shared-layout blast radius                                                                                                               |
| tb re-run                                        | live *now* behavior                                                                                                                                                                            | **oracle**                        | green-proof; the "now" half of the diff                                                                                                                  |
| jira ticket (`build.jiraTicket` → Atlassian MCP) | the ticket's **description** + **EVERY linked ticket, one hop** (DEP Issue Distribution / Story cloners + parent epic + siblings, each read for its description/dev-PR) = the change **scope** | untrusted-advisory, **read-only** | reweight flaky→real only when a cluster overlaps the ticket's **scope** — the bare tag is **build-level (tags every test) = a FALSE per-cluster signal** |


**Core move — diff golden *before* vs *now*:**

- gone now **but a same-semantic element exists under another locator** → *moved* → 🔧 (re-locate by the **robust sibling**, never the golden brittle id).
- gone now, **no robust locator finds it**, business rule says it should exist → *vanished* → 🐛.
- test self-consistent but app contradicts a **documented business rule** → 🐛 (cite the rule id).

Use `where:{testName}` for an exact flow; semantic query only for sibling/recipe discovery. Never adopt a qagent hit without verifying against current code + the tb.

### 5.1 Buckets (flaky-testbox signatures)


| Signature                                                                     | Meaning                                                                    | Default action                                   | Bucket     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ | ---------- |
| passes on re-run                                                              | flaky / race                                                               | dismiss (record flaky-confidence)                | infra      |
| whole-class Timeout / NotInteractable / NoSuchElement                         | **broken box**                                                             | invalidate verdict, re-run elsewhere (I9)        | infra      |
| `ElementClickIntercepted` (`ot-sdk-row`)                                      | OneTrust cookie overlay                                                    | 🔧 recipe: dismiss-in-setup                      | easy-fix   |
| `VisualRegressionTrackerException`                                            | baseline drift                                                             | advisory (baseline review)                       | vrt        |
| `NoSuchElement` on a generated/hard-coded id                                  | brittle selector                                                           | 🔧 re-locate by name (T1/T3)                     | selector   |
| `NoSuchElement` on a filter-value-by-text (`//label[text()='Sıfır']`, `'5G'`) | **data/flag-dependent** (option renders only with matching inventory/flag) | re-run on a control box — **not** a selector fix | infra      |
| `IndexOutOfBounds` (empty list)                                               | data-dependent                                                             | 🔧 empty-guard (T2)                              | easy-fix   |
| `AssertionFailedError`, self-consistent test                                  | **app contract violation**                                                 | 🐛 suspected bug (T4)                            | likely-bug |
| `AssertionFailedError`, testbox-data assumption                               | brittle assertion                                                          | 🔧 make data-aware (T2)                          | app-change |

**Canonical presentation buckets (closed enum):** easy-fix · selector · vrt · app-change · infra · likely-bug — every cluster carries exactly one (§8).

**Signature extraction:** cluster on the **root cause**, not the first stack line — wrapped / `MultipleFailures` (e.g. `AssertionFailedError: Multiple Failure : [VRT…]`) misbucket otherwise; split `MultipleFailures` into sub-failures (V6).
**Cluster homogeneity:** before applying one fix to a cluster, verify its tests truly share that one fix — else re-cluster (V10).

### 5.2 Tiers (present easy → hard)

- **T1 clean fix** — test-local, single file, high-confidence selector fix, re-runs green.
- **T2 moderate** — data / assertion-resilience, still test-local.
- **T3 risky** — shared-layout fix → needs blast-radius green-proof.
- **T4 investigate** — 🐛 suspected app-bug, or low-confidence / ambiguous.

### 5.3 Fix vs 🐛 bug — evidence-gated

- 🔧 **FIX** only if the test's own logic is brittle/stale (selector moved/renamed but the element **still exists in changed form**; data assumption; flaky timing).
- 🐛 **SUSPECTED BUG** if the test is **self-consistent** and the *app* broke its contract, **or the target element vanished** (feature break).
- **Mask-regression invariant (I4):** never propose a selector fix for a *vanished* element — that's a 🐛, not a 🔧. Otherwise we silently paper over a real break.
- **Confirm at pass^N, not pass^1:** a fix counts as "fixed" only when green on *all* N re-runs (`rerun` `confidence==1.0` over `runs≥N`). A single green run is the most likely **false** "fixed" — a flaky test passes ~half the time. Classify fix-vs-🐛 skeptically: require evidence, default to 🐛 when unsure (a separate hard look beats optimistic self-grading).

### 5.4 Signature → fix-recipe catalog (grows over time)


| Signature                                            | Recipe                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| OneTrust `ot-sdk-row` intercept                      | dismiss/accept OneTrust in setup (no-op on boxes that auto-dismiss) |
| generated `_cllpsID_aNN` facet id                    | re-locate by attribute **name** (`clickAttributeName`), not the id  |
| empty-list `IndexOutOfBounds`                        | guard empty results / pick an in-inventory param                    |
| testbox-inventory assertion (e.g. toplist on page 2) | make inventory-aware / relax the env-specific assert                |


## 6. Actions

- **🔧 Fix** — recipe-driven edit, in the **working tree** (clean-tree check), **path-confined** to the source
roots (§10), shown as a **diff for approval**, **green-proofed** before it's offered. Idempotent.
- **🐛 Suspected bug — ADVISORY ONLY** — show the evidence; the **only** code action is a
`// TODO: possible bug — investigate (<cluster>)` comment on top of the test.
**NEVER** create/comment a Jira ticket; **NEVER** apply `@ScheduledDisable`.
The user investigates and owns whether it's a bug, whether a ticket is needed, and whether to disable.
- **Skip already-handled** — if current code shows the test already fixed/disabled/de-tagged,
mark *resolved-upstream*; don't re-litigate.

## 7. Safety invariants (hard gates)


| #       | Invariant                                                                                                                                                                                                                                                                                | Closes                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **I1**  | Validate user inputs + every report-derived `testName/testPath` (FQCN regex) before any shell/query/path use; parameterize ES queries. **I2's existence-intersection is the *primary* defense for the run path — the regex is belt-and-suspenders**                                      | injection from untrusted report/inputs  |
| **I2**  | Act only on tests that **exist in current code** — prefer gradle's own discovery (`isFailOnNoMatchingTests=false`) over a hand-rolled check; **flag semantic drift** (same FQCN, changed test)                                                                                           | stale / renamed / poisoned entries      |
| **I3**  | Edits to the **working tree** (git-tracked → `git restore`-reversible), **confined to `source_roots`**, on a **clean tree** (refuse / branch if dirty); the kit **never commits** — you review the diff + commit. *(Worktree isolation deferred to the Jenkins/unattended phase — §11.)* | wrong-file / corrupt edit               |
| **I4**  | **Moved-vs-vanished is ambiguous → bias to 🐛.** A 🔧 selector fix is allowed ONLY if a *same-semantic* element is found by a robust locator — **qagent golden *before* vs tb *now* is the evidence**; absent by **any** locator → 🐛, never a fix                                       | **masking a real regression (V1)**      |
| **I5**  | **Re-derive "already applied" from the source**, not the (agent-authored) ledger — the ledger is an optimization, not the truth                                                                                                                                                          | non-idempotent re-runs (V4)             |
| **I6**  | Cap **per-cluster** (keep ≥1 representative of *every* signature) — never a global truncation that hides a whole cluster; confirm above threshold; log drops                                                                                                                             | runaway runs / silent truncation (V7)   |
| **I7**  | **Allowlist** the fields emitted into any artifact (testName, signature, status) — **never raw stackTrace / PII / tokens**; denylist-scrub is insufficient (you triage the *sensitive-data* suite)                                                                                       | data leakage (V3)                       |
| **I8**  | Never commit · file/comment a ticket · disable a test · act only on **selected** clusters. **Honesty: re-running tests executes real testbox side-effecting flows (not fully "reversible") — flag tests with irreversible external actions (payment/email)**                             | overreach / unflagged side effects (V5) |
| **I9**  | tb health-check is **necessary-not-sufficient** (misses *partial* degradation); cross-check suspicious whole-cluster flips vs a **control box / per-test ES history** — **qagent's golden testbox is a ready control-box candidate**                                                     | per-box confound (V9)                   |
| **I10** | **Pin one code revision** for classify + apply + green-proof (mismatched revs = inconsistent verdicts); **bound re-clustering** — every cluster must reach a terminal status; max iterations                                                                                             | rev-drift / non-convergence (V8, V10)   |
| **I11** | **A session may not end while any cluster is `selected`/`applied`** — run `core/ledger.sh validate --final <ledger>` before the convergence summary; non-zero exit means the run is NOT done (collect verdicts; never background the green-proof and quit)                                  | premature completion / unverified "fixed" claims |


## 8. State / ledger (resumable · idempotent · auditable)

```
run:     { id, sReportUrl, build{name,@timestamp}, tb, startedBy, version: 2 }
cluster: { id, title,                  # ≤80 chars, human phrasing — I7-governed: never raw stackTrace
           detail,                     # ≤600 chars evidence summary; may quote signatures, never full traces
           signature, tier, bucket,    # bucket ∈ the six (closed enum, kernel-canonical)
           fixVsBug, evidence,
           tests[ {fqcn, status?, vrt?} ], # status ∈ red|green|skipped, present only when diverging
           status: proposed|selected|applied|green|deferred|flagged|resolved-upstream,
           passes, runs,               # green-proof progress; integers; passes ≤ runs
           diffRef, lineage, greenProofScope }
event:   { who, what, when, phase? }   # what gains 'phase-enter'; phase ∈ ingest|confirm|cluster|pick|fix|verify|report
```

vrt = baseline-vs-regression URL for a VRT failure (ingest's vrt_url tag), set via ledger.sh cluster-vrt.

All writes go through ledger.sh subcommands (cluster-upsert / cluster-state / event) — hand-edited JSON violates P2. v1 files (no version) remain readable.

## 9. Output — convergence summary

Sections: **fixed (+green proof)** · **flagged-as-suspected-bug** (TODO + evidence, *not* filed)
· **deferred** · **resolved-upstream**. This is the artifact the user reviews and commits against.
*(A 5th "still-flaky" section was removed — kernel §8's `status` enum has no such value; its would-be
members are exactly the four terminal statuses above, each already rendered under its own heading.)*

## 10. Config seam (sahibinden defaults — the portable part)

Everything above is generic; another team/app swaps **only** this section.

- **ES:** host `report-with-elastic-data.apps.ocptbox.tzla.sahibindenlocal.net`, index `web-report`, `POST /api/web-report/_search`, no auth.
- **Run:** from `web-ui-test/`; `JAVA_HOME=…/ms-17.0.16`; `-x :generate-method-plugin:instrumentCode`; Selenoid launchpad; select via `-Dtests=<csv-fqcns>` (preferred for a fix-list) or `-DincludeTags`; `-Dspring.profiles.active=testbox -Dui.testbox=<tb> -Denv.data.center=x -Dui.browser.type=chrome`.
- **Edit allowlist (source roots):** `web-ui-test/src/test/java/`**, `web-ui-test/src/main/java/com/sahibinden/web/client/**` (Pages/Layouts).
- **Build pattern / signatures / recipes:** §3, §5.

## 11. Deferred (later phases)

- **Jenkins / unattended:** safe-by-default **advisory** (open a PR, never merge), least-privilege CI token (no protected-branch push, no Jira), **server-side branch protection** as the real guarantee. *(Final phase — the commit-gate hook is a bypassable string match, not a wall.)* CODEOWNERS + Bitbucket branch-permission runbook drafted in [`enforcement-codeowners.md`](./enforcement-codeowners.md) — **INERT** in web-test (kit is gitignored, 0 tracked files); activates when the kit is committed to a tracked repo.
- **Worktree isolation:** apply each fix in a scratch git worktree (isolates code for concurrent / parallel-CI runs). *Not* needed for the single-user interactive loop — git + diff-review + never-commit already give reversibility; it earns its keep only under concurrency.
- **Form factor:** Hektor skill vs standalone toolkit vs portable-core+skill. *(The portable-core+skill
  form is realised: the `core/*.sh` engine runs from any terminal harness; Cursor support is wired
  (`.cursor/hooks/flaky-kit-self-protection-gate.sh` + rule), and the cross-harness gradient + recipe for
  other LLMs is documented in [`cross-harness.md`](./cross-harness.md). The shared `core/shell-guard.py`
  is the write-once surface-write detector used by both the Claude and Cursor gates.)*
- **Toggles:** diff-preview-before-apply, control-box health check, defect evidence bundle.
- **DEFERRED: `ledger.sh`'s `mkdir`-spinlock (macOS fallback, P7) has no PID-staleness recovery.** If
  the lock holder is `SIGKILL`'d mid-write, `$FILE.lock.d` is orphaned forever — every subsequent
  writer just spins for the full 30s and `die`s, rather than detecting the dead holder and stealing
  the lock. `core/_lock.sh`'s `gradle_lock_acquire` already has this exact pattern (`kill -0 "$p"` on
  a PID written into the lock dir; steal if the holder is dead or the lock is pidless-and-stale) —
  reuse it in `ledger_lock()` in a future pass rather than inventing a second staleness scheme.
- **Multi-stack adapter (Cypress / non-Gradle) — PARKED.** Run the kit against `admin-e2e-cy` (Cypress, JS/TS)
  and other non-Selenium suites. Reusable as-is: the loop + safety, `apply` (set `source_roots` to `cypress/e2e`),
  `cluster`/`summary`/`ledger`, sanitizer, gate, lock-kit, install/cross-harness. Needs adapting: `ingest`
  (Cypress result source — Cypress Cloud / Currents / Sorry-Cypress / mochawesome|junit XML) and `rerun`
  (`npx cypress run --spec … --reporter …` + a new output parser; "rerun N× to confirm real-vs-flaky" is
  unchanged); `compile` → `tsc --noEmit`/lint or no-op; `dom-capture` → Cypress's native screenshots/video.
  Clean design: extend the config seam to `run.kind: gradle-junit|cypress` + `report.kind: es|junit-xml|mochawesome|currents`
  (one engine, adapter selected by config) — preferred over forking a separate kit. **Prereq: investigate
  `admin-e2e-cy`'s reporter / result source / spec layout / CI before building the adapter (don't guess).**

## 12. Vulnerability register (seed — vuln-hunt starts here)


| Vuln                                                                                    | Mitigation                                            | Residual                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| Stale build (number reuse)                                                              | pin by `@timestamp` (§3)                              | report re-index lag                         |
| Untrusted report → injection                                                            | I1                                                    | —                                           |
| Act on nonexistent/renamed test                                                         | I2                                                    | —                                           |
| Misclassify fix↔bug                                                                     | evidence-gate (§5.3) + I4                             | ambiguous cases → T4 (human)                |
| **Mask a real regression**                                                              | **I4**                                                | —                                           |
| Shared-layout silent break                                                              | green-proof widening (§4 step 4)                      | dynamic/runtime coupling not in static deps |
| Per-box confound                                                                        | I9                                                    | —                                           |
| Wrong-file / corrupt edit                                                               | I3                                                    | —                                           |
| Data/PII/secret leak                                                                    | I7                                                    | log scrubbing completeness                  |
| Runaway run / 15k-doc build                                                             | I6                                                    | —                                           |
| Double-apply on re-run                                                                  | I5 (re-derive from source)                            | —                                           |
| "Flaky" overloaded / time-shifted (flaky vs resolved-upstream vs data-drift vs per-box) | §2 + run on report's box + N-runs                     | report's box may be gone                    |
| Re-run side effects (payment/email/data) irreversible                                   | I8 (flag side-effecting tests)                        | inherent to verification                    |
| First-line misbuckets wrapped/MultipleFailures                                          | §5.1 root-cause clustering                            | obfuscated/empty traces                     |
| Heterogeneous cluster / unbounded re-clustering                                         | §5.1 homogeneity + I10 bound                          | —                                           |
| Determinism overclaimed (verdicts aren't)                                               | §2 qualifier + flaky-confidence                       | —                                           |
| Recipe over-fit (global side effects)                                                   | diff-preview + green-proof + recipe blast-radius flag | novel edge cases                            |
| Green-proof runs against shared tb/Selenoid/live-data (concurrency)                     | I10 (rev-pin) + tb exclusivity / N-run averaging      | shared-infra contention                     |
| qagent snapshot stale (golden selector outdated)                                        | verify vs current code + tb; advisory only            | snapshot lag                                |
| qagent golden selector is itself the brittle one                                        | use robust *sibling* selectors, not the golden        | no robust sibling exists                    |
| qagent semantic search imprecise                                                        | `where:{testName}` for exact; advisory only           | embedding drift                             |
| **RCE via `buildStartTime` → bash arith-eval `$((startMs/1000))` (V-1)**                 | **I1** digits-only validate before arithmetic (ingest.sh); `set -u` does NOT stop it | — (fixed 2026-06-30) |
| **I3 confinement bypass via non-canonical `../` path (V-2)**                             | **I3** realpath-canonicalize, then assert under realpath'd source_roots (apply.sh)    | — (fixed 2026-06-30) |
| **Silent ES truncation hides clusters > `size` (G-1)**                                   | read `hits.total`; loud warn + `truncated`/`failTotal` flags (ingest.sh)             | raise `size` to see all |
| **I6 cluster cap was dead config (LLM-discipline only) (G-2)**                           | enforce `bounds` in cluster.sh; keep ≥`per_cluster_keep_min`/sig; emit `dropped`     | — (fixed 2026-06-30) |
| **Committed summary leaked raw `sig` (stackTrace slice) (G-3)**                          | summary emits structured tokens only (`.bucket`, or an exception-TYPE label derived from `.signature` — never the raw `.signature`/stackTrace); `.recipe`/`.tier_hint` don't exist on the v2 ledger schema and are no longer read (updated 2026-07-23, R4 — the original "recipe/bucket/tier" wording here was stale against the current `summary.sh`) | — (fixed 2026-06-30, wording corrected 2026-07-23) |
| **`ledger set` raw jq-filter injection**                                                 | `--arg`/`--argjson` setter binds untrusted data as `$vars` (ledger.sh)               | — (fixed 2026-06-30) |
| **Standalone `dom-capture` left unscrubbed DOM (no GC)**                                 | self-GC sweep (>1 day) in dom-capture.sh                                             | — (fixed 2026-06-30) |
| **`rerun.sh` false-green: a test seen in only 1-of-N passes still read `confidence: 1.0`** | per-test completeness check — a test with `runs < runs_requested` AND `fail==0` gets `confidence` forced to `null` (never a false `1.0`) and is listed in a new top-level `insufficient_runs` array; a test with any observed failure keeps its real (already-honest) confidence and is never flagged | **DONE (2026-07-23)** — `core/rerun.sh`; `core/tests/rerun-test.sh` (21/21) |
| **`apply.sh` `source_roots` trusted verbatim: absolute/`../`-escaping root bypassed I3 confinement (arbitrary-file overwrite)** | every configured `source_root`'s `realpath` is asserted under the repo's `realpath` before use (reject, exit 77, otherwise); clean-tree check now treats a git error (e.g. out-of-repo pathspec) as UNSAFE, never clean-by-default; `REPO` resolution itself is fail-closed (non-empty/absolute/existing or exit 78) so a failed `git rev-parse` can no longer silently rebase confinement onto the caller's cwd | **DONE (2026-07-23)** — `core/apply.sh`; `core/tests/apply-test.sh` (9/9) |
| **`lock-kit.sh` locked files only — `rm`+recreate or a brand-new file under a "locked" kit both succeeded** (governed by the parent DIRECTORY's write bit, not the file's) | `chmod a-w` every directory under `core/`+`hooks/` (recursively) plus the kit root itself, alongside the existing per-file lock; `unlock` restores `u+w` symmetrically | **DONE (2026-07-23)** — `core/lock-kit.sh` |
| **Self-protection gate / `shell-guard.py` bypassed by `./`, `../`, symlinks, bare cwd-relative paths, `cd`-chains (incl. subshells/command-subs/nested), and `{ ...; }` brace groups; missing `git checkout/apply/restore/stash/reset/clean`, `rsync`, `patch` in the mutate-verb set; gate scripts didn't protect each other or their own vendored libs** | `realpath`-canonicalize the presented path before substring-matching; `HEKTOR_FK_CWD`-seeded `cd`-chain tracking recursing into subshells/command-subs (bounded depth, **fails CLOSED** past the bound — not open); brace groups tracked as same-chain delimiters; verb-set extended; `SURF_RE`/`SURF` extended so each gate + its vendored libs protect the OTHER harness's gate/libs too. **Honest framing (kept, not weakened): this Bash string-gate is best-effort defense-in-depth — `base64 …\|bash`, `eval`, process substitution, and compiled writers all bypass it by construction; the real wall, at the hardened tier, is `core/lock-kit.sh lock` chown'ing the surface (directory-level as of this round) to root — below hardened it degrades to the same chmod-only friction this gate already is — not more pattern-matching.** | **DONE (2026-07-23)** — `core/lock-kit.sh`, `adapters/claude/flaky-kit-self-protection-gate.sh`, `adapters/cursor/flaky-kit-self-protection-gate.sh`, `core/shell-guard.py`, `adapters/_lib/audit.sh`; `core/tests/self-protection-test.sh` (74/74, count grows as later tasks add fixture coverage — verify against the file, not this number) |
| **Grep-newline anchor-asymmetry: `grep -qE '^…$'` is LINE-oriented, so an embedded-newline value (e.g. FQCN/URL/build-name with a trailing `\n$(payload)`) sails past an anchored shape check that a whole-string match would reject** | shared `core/_strict.sh` `strict_match <value> <ere>` — rejects any value containing a newline, then anchors `[[ =~ ^ERE$ ]]` (bash's own whole-string anchoring, no `REG_NEWLINE`); replaces the ad hoc `grep -qE '^…$'` validators in `ingest.sh`/`rerun.sh`/`dom-capture.sh`/`dom-on-failure.sh` | **DONE (2026-07-23)** — `core/_strict.sh` (new) + 4 call sites; `core/tests/strict-test.sh` (23/23) |
| **`sanitize-text.py` let raw ANSI CSI/OSC escapes and C0/C1 control bytes through (terminal-title spoof / hidden-text vector into the human review gate)** | strip C0 (0x00-0x1F, keep `\t`/`\n`) + C1 (0x80-0x9F) control ranges and whole CSI/OSC escape sequences, before the existing zero-width/bidi/variation-selector/Tag-block Unicode stripping; `ingest.sh`'s `sanitize()` now warns to stderr (instead of silently passing text through unsanitized) when python3/the helper is missing | **DONE (2026-07-23)** — `core/sanitize-text.py`, `core/ingest.sh`; `core/tests/sanitize-test.sh` (14/14) |
| **P7 ledger write races: concurrent `jset`/`set` read-modify-write could lose writes (40 concurrent calls → 19/40 survived)**; `validate` didn't check `bucket`/`tier` enums, allowed duplicate cluster ids, and reported bare ids instead of a reason; `init` could silently clobber a non-empty ledger; a flag given with no value crashed on `set -u` instead of a clean usage error | `flock`(Linux)/`mkdir`-spinlock(macOS, no `flock` binary) exclusive lock around the read-modify-write, atomic `mktemp`+`mv`; `validate` also checks `bucket` ∈ the six buckets and `tier` ∈ 1-4 via the shared jq `fullmatch` helper (also now used for id/fqcn/vrt), rejects duplicate cluster ids (`dup-id`), and emits `{id, reason}` per violation; `init` refuses (exit 65) to overwrite a ledger with existing clusters unless `--force`; every subcommand's flags now check `[ $# -ge 2 ]` before consuming a value, `die … 64` otherwise | **DONE (2026-07-23)** — `core/ledger.sh`; `core/tests/ledger-test.sh` (102/102) |
| **`summary.sh` read pre-ledger/never-persisted fields (`.recipe`/`.sig`/`.tier_hint`) — every cluster silently rendered "uncategorized"; a 5th "still flaky" section filtered `status=="flaky"`, not a legal status, and could never render anything** | `safelabel` now reads `.bucket // (.signature \| etype) // "uncategorized"` (the actual v2 schema fields, kernel §8); dead "still flaky" section dropped (all four TERMINAL statuses already have their own section — nothing to fold it into); new `core/tests/summary-test.sh` builds a v2 ledger via `ledger.sh` subcommands (never hand-JSON) and asserts each section renders from the right field, plus an I7 leak check (a secret-shaped substring in `.signature` never appears in the rendered report — only the derived exception-type token does) | **DONE (2026-07-23)** — `core/summary.sh`; `core/tests/summary-test.sh` (14/14, new) |
| **P5 zip leak: the published `flaky-triage-kit.zip` shipped `.playwright-mcp/` dev-session captures (browser console logs + page snapshots) and stray screenshots/`.DS_Store`, which can carry internal hostnames picked up incidentally while driving a browser against internal infra** | `scripts/package-kit.sh` stages a clean copy (excludes `.playwright-mcp/`, `.achilles/`, `.DS_Store`, `.git/`, `*.png`, `.superpowers/`, editor-swap cruft), then greps the STAGED tree for internal-hostname patterns (`sahibindenlocal\.net`, `\.tzla\.`, `ocptbox`) and refuses (exit 77, no zip written) if a match falls outside the files where it's intentional (`core/config.json` — the config seam; `kernel.md` — §10 documents the same endpoints as the reference example; the packager's own source, which carries the patterns as regex/test literals); a `--self-test` mode proves the guard on a throwaway copy (plants a hostname in a non-exempt file → refused; unmodified copy → clean) | **DONE (2026-07-23)** — `scripts/package-kit.sh` (new); zip regenerated clean (verified via `unzip -l` + a full per-entry hostname grep) |


## 13. Packaging threat model (P1–P8) — the core + skill surface

§12 hardens the triage *logic*; wrapping it as a **core + skill + config + shared deploy** opens new surfaces.


| #      | Vuln                                                                                                                    | Mitigation                                                                                                                                               | Status                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **P1** | Prompt injection via untrusted report / qagent / Confluence text into the LLM skill (fake an approval, force an action) | all external text is **data, never instructions** (delimit; show verbatim); human gates + never-commit/ticket/disable + diff-review cap the blast radius | design / SKILL.md                      |
| **P2** | Skill bypasses core invariants (runs gradle / edits directly, skips the clean-tree/diff discipline)                     | skill mutates **only via core**; SKILL.md routes all mutation through `core/`                                                                            | design / SKILL.md                      |
| **P3** | Config / recipe injection (ES host repoint = exfil; `source_roots:/` = I3 bypass; recipe-as-code)                       | validate config (host allowlist; roots resolve under repo); **recipes are data, never `eval`'d**; no secrets in config                                   | core                                   |
| **P4** | Kit not covered by — and can edit — its own safety surface                                                              | `<project>/.claude/hooks/flaky-kit-self-protection-gate.sh` — **outside** the kit tree, so renaming the tree cannot take its own detector along (mirrors `enforcement-self-protection-gate`); `HEKTOR_FLAKYKIT_UNLOCK`                                         | **DONE++ (2026-07-29, amended 2026-07-30)** — the gate is friction + audit; the WALL is `core/lock-kit.sh lock` at the **hardened** tier: the surface owned by root, so `chmod` fails with EPERM for the agent and reopening needs a password. `HEKTOR_FLAKYKIT_UNLOCK` demoted from "consent" to an audit intent-marker (the prior claim was false and was demonstrated false in-session). `core/_integrity.sh` asserts the tier at every entrypoint and refuses on `mismatch`. **2026-07-30:** the chown target set was incomplete (the Cursor gate and both audit libs were missing, so a Cursor user's only gate stayed user-writable under a banner claiming otherwise); a partial `chown` reported `hardened` while swallowing sudo's reason and asserting a kit root it had not rooted; and `lock` left sudo's credential cached, so for ~5 min the agent could reopen with no prompt (`sudo -k` now ends both privileged sections). Residual, explicitly not closed: **shadowing** (rename the kit dir — governed by the user-owned parent) is DETECTED via `.claude/hooks/.flaky-kit-expect`, not prevented — and that detector now tests whether the tree is still **root-owned**, not merely whether it still **exists**, so a rename-AND-replace is caught rather than silent (it was silent, and this row asserted otherwise). Out-of-tree surface files are root-owned against EDITS only: their parents must stay user-owned, so they can still be replaced. Social engineering the human into running the unlock is out of scope. Full residual list: `core/lock-kit.sh`'s header. **2026-07-30:** the gate's own WIRING is now checked too. A registration pointing at a path the kit no longer installs to made every tool call emit a non-blocking "No such file" while nothing stated the protection was off (observed in a web-test worktree carrying a pre-relocation path), and deleting that registration was allowed outright. The harness settings files are now surface — by outcome on Write/Edit (deny only if the registration would not survive, so unrelated permission/env edits still pass) and as mutation targets on Bash, where no content is available to inspect. Residual, stated rather than implied: unlike core/**, `.claude/settings.json`, `.claude/settings.local.json`, and `.cursor/hooks.json` — all three — carry no chown protection at all — they must stay user-writable for the harness's own unrelated edits, so this gate is their only defense and shares the same heuristic-bypass limits already stated for the rest of it. The guard reads nothing from the environment — a per-process cache of its verdict was designed and rejected, because a cache of the answer is indistinguishable from a forgery of it. **2026-07-31:** the kit now REPAIRS its own wiring rather than only reporting it. Detection was not enough: whether a project ends up wired depends on which tool provisioned it, and a worktree was twice observed holding the kit with none of it wired and nothing saying why. The registration is rewritten at every tier that lets the run proceed; the gate file is restored there too, from a copy vendored into `core/gate-src`. **At every tier that REFUSES — `hardened`, `stale` and `mismatch` — nothing is written at all, registration included.** The first draft repaired the registration there too and still refused, on the theory that a written registration does not arm the session that wrote it. Measured, that held for exactly one call: `integrity_guard` recomputes both axes from the filesystem every time, so the very next entrypoint read the registration it had just written, saw `wired`, and returned 0 while the session's harness still had no gate loaded — one call refusing, every call after it silently unprotected. Corrected: at those tiers `wiring_repair` detects, says what is wrong, and returns without touching disk, so the guard's refusal holds on every call because nothing ever changes. `mismatch` was missed by the first correction, which was phrased "where the tree is root-owned" and so reached `hardened` and `stale` but not the one tier whose whole meaning is a recorded root ownership the tree does **not** have — measured there, the repair copied the gate script out of a tree the same run declares untrustworthy into the kit's own protection-hook path and flipped the axis from `dangling` to `wired`. Self-repair is a convenience for the tiers that admit they are conveniences; every tier that refuses keeps its wall. |
| **P5** | Internal-infra disclosure when shared (ES/Selenoid/qagent/testbox/bean names)                                           | all endpoints in `config.json` (§10 seam); internal-only until genericized                                                                               | **DONE+ (2026-07-23)** — the config seam itself was always the *intended* disclosure; the actual gap was a *packaging* leak (dev-session `.playwright-mcp/` captures + screenshots shipped in the zip). `scripts/package-kit.sh` now excludes that cruft and greps the staged tree for internal hostnames outside `config.json`/`kernel.md` §10 (see §12 register row) — refuses to package on a hit. |
| **P6** | qagent absent/swapped + untracked tool supply chain in shared/headless runs                                             | qagent advisory + verify endpoint; pin/declare tool versions                                                                                             | core                                   |
| **P7** | Ledger poisoning / shared-state races                                                                                   | I5 (re-derive from source) + integrity + locking                                                                                                         | **DONE+ (2026-07-23)** — `flock`/`mkdir`-spinlock now serializes the read-modify-write (closes the 55%-write-loss race); `validate` checks `bucket`/`tier` enums + rejects duplicate cluster ids; `init` refuses to clobber a non-empty ledger without `--force` (see §12 register row). Residual: the `mkdir`-spinlock fallback has no PID-staleness recovery yet (§11 deferred note). |
| **P8** | Works-on-my-box (jq/gradle/JDK/qagent-snapshot drift)                                                                   | pin prerequisites; snapshot-version qagent                                                                                                               | core                                   |


The scariest (P1) is capped by choices already locked: a fully-hijacked skill can still only **propose a diff a human reviews**.

## 14. Findings from live driving (s4-flaky-1232 / 1234)

These surfaced *only* by running the kit on real builds — they are the discipline that paper design missed:


| #        | Finding                                                                                                                                        | Mitigation                                                                                                                  | Status                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **N1**   | **"the run didn't run"** — gradle served `:test FROM-CACHE` ⇒ 0 tests executed ⇒ a **silent false verdict** (the scariest mode for a verifier) | `test --rerun-tasks --no-build-cache`; `runs_with_tests`/`incomplete_runs`/`run_anomalous` guards                           | fixed; guards new/lightly-tested |
| **N2**   | **DOM-blind fix authoring** (V1 reborn) — without the rendered DOM, a selector fix could mask/mis-fix                                          | `**dom-capture` step** (the gap) + I4 bias-to-🐛 (stop, don't guess)                                                        | **PROVEN tb128 2026-06-22** — `dom-capture.sh` + `PageDomCaptureTest`: 385 KB rendered DOM, 14 `_cllpsID_a…` filter ids via `getPageSource()`; **kit-sourced** via `capture.init.gradle` init-script — zero suite footprint (CSS-scope skill-side). **Flow-gated breaks** (payment/posting/flag, unreachable by URL) → `dom-on-failure` + `DomDumpOnFailure` (AfterTestExecution dump) **proven tb161 2026-06-23** |
| **N3**   | **ticket text as injection** (extends P1) — `correlate` feeds Jira summaries/descriptions to the LLM                                           | data-not-instructions; `correlate` is **read-only** (I8)                                                                    | design                           |
| **N4**   | **kept rerun logs unscrubbed** — raw stackTraces/PII in `/tmp` (the price of keeping causes)                                                   | GC >1d + local-transient + **never ship**; only the truncated `cause` reaches shared artifacts                              | mitigated                        |
| **N5**   | `**jiraTicket` is build-level** — tags *every* failing test ⇒ a FALSE per-cluster signal                                                       | reweight on the ticket **scope** (description + **ALL linked tickets**, one hop), not the bare tag                          | fixed (`correlate`)              |
| **N6**   | **driver drifted heavy** — raw-exception clusters, tooling narration (build ids / run anomalies / rerun+dom mechanics / task ids), and per-item approval stops made the loop hard to read & track (the kit made a simple pre-kit flow *worse*) | re-group clusters **by meaning**, **ONE** easy→bug table, **two gates only**, no tooling narration, execute end-to-end between gates (§4 *Keep it simple* + SKILL *Presentation discipline*) | fixed 2026-06-25 (user feedback on s4-flaky-1394) |
| **META** | **CORRECTED 2026-06-30: PreToolUse `deny` IS enforced by the current CLI.** Observed live this session — an `enforcement-self-protection-gate` deny BLOCKED a `settings.json` Edit (file unchanged, tool error returned). The earlier "denies aren't enforced" claim is superseded: a gate's denials are really applied. **AMENDED 2026-07-30 — the sentence that followed ("the gates are real walls when locked") did not follow from that and is retracted.** An enforced `deny` makes the gate effective friction; it does not make a heuristic string-matcher a wall. Two independent reasons, both concrete: the decision is a pattern match over a command string, which `base64 … \| bash`, `eval`, process substitution and any compiled writer evade by construction; and the pattern itself was found to match no DIRECTORY operand at all, so `mv <kit> /tmp/x`, `rm -rf <kit>` and `rm -rf .claude/hooks` were ALLOWED and unaudited on every install until 2026-07-30. A wall does not have a gap that shape. The gate is friction + audit; the wall is the hardened tier. | kit gate **logic verified 2026-06-25** (deny on `core/**` + `SKILL.md`; allow + `.hook-audit.log` entry on `HEKTOR_FLAKYKIT_UNLOCK=1`; passthrough otherwise) → enforces wherever the CLI honors PreToolUse. A `chmod -w` bit was ADDED as defense-in-depth at the time (`core/lock-kit.sh`) — since superseded by the **hardened** (chown-to-root) tier, see the P4 row above; `chmod -w` alone is now only the **degraded** fallback. The claim "so the gate itself walls too" that stood here is withdrawn for the reasons in the left column; the original *friction, not a wall* stance (§13 P2/P4) stands, and the gate's own header has said so since it was rewritten. | **corrected, then amended** — deny honored live; gate extended to Bash and to directory operands; chmod-lock helper added and superseded by the hardened tier. Caveat: the kit is **gitignored** in web-test (0 tracked files), so CODEOWNERS/branch-protection are INERT until it lands in a tracked repo (see `enforcement-codeowners.md`). |


