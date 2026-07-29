# hektor-flaky-triage / core — deterministic engine

No LLM here. Each module is config-driven, standalone-runnable (so Jenkins can call it
later), and maps 1:1 to kernel invariants so the code stays auditable against the spec
(`docs/hektor/flaky-triage-kit/kernel.md`). The **skill** (`../SKILL.md`) does the reasoning
and calls these; it MUST NOT mutate state except through them (kernel P2).

| Module | Contract (in → out) | Enforces |
|---|---|---|
| `config.(load)` | `config.json` → validated config | **P3** host_allowlist; source_roots resolve under repo; recipes are data |
| `ingest` | `sReportUrl` → pinned build + FAILED docs (JSON) | **I1** sanitize inputs · pin by `@timestamp` (anti-stale) · tags each fail `working_tree_modified` (phantom "already-fixed" guard, N6-C) + `vrt_url` (N6-D) |
| `compile` | (none) → `{ok, errors[]}` | compile-check post-`apply` with the resolved JDK + `gradle_excludes` — no hand-typed `JAVA_HOME` (N6-B); shares the gradle lock |
| `_lock` *(sourced)* | working-copy path → mutex | serialize gradle on one working copy — concurrent `--rerun-tasks` corrupt `build/` (N6-A); used by `rerun`/`dom-capture`/`dom-on-failure`/`compile` |
| `cluster` | FAILED docs → clusters by **root-cause** signature (+ tier hint) | **V6** root-cause not first-line · **I6** per-cluster cap, log drops |
| `qagent` *(skill-side, MCP)* | testName / signature → golden steps+selectors, business rules | advisory-only; `where:{testName}` exact; verify vs code/tb |
| `correlate` *(parse; fetch is skill-side MCP)* | jira issue JSON → **ALL** `dev_links` (DEP Issue Distribution / Story cloners + parent epic) | reweight on the ticket **scope** (descriptions + linked, one hop), **NOT the build-level tag**; **read-only** (I8) |
| `dom-capture` | **real site URL** (e.g. `https://www.sahibinden.com/otomobil`) + tb → rendered DOM; `-Dui.testbox` routes to the box | author fixes from the real DOM (N2, **proven tb128**); **I1** validates url+tb; output LOCAL-TRANSIENT; **kit-sourced** test (no suite class) |
| `dom-on-failure` | test-fqcn + tb → DOM dumped **at the failure point** (runs the real test; `DomDumpOnFailure` auto-registered) | flow-gated selector breaks (payment / posting / flag-detail) that single-URL `dom-capture` can't reach (N2); **proven tb161** |
| `rerun` | FQCN list + `tb` → pass/fail (+ flaky-confidence over N) | **I2** existence via gradle discovery · **I9** health-check tb first |
| `gate` | `rerun` JSON → `verifier-result` (`accepted` / `rejected` / `inconclusive` per test + `all_accepted`) | **I11**/§5.3 pass^N is a machine-checked DECISION, not the fixer grading its own work · **I9** an untrustworthy box/run decides nothing · read-only |
| `hedge-scan` | fixer's own summary text → clean (0) / HEDGED + matched phrases (2) | cheap deterministic pre-screen: self-reported uncertainty ("should work", "only ran once") is not a green — catch it before spending a reviewer call |
| `apply` | a fix patch → applied in the working tree (git-tracked, clean-tree check) + diff | **I3** confined to `source_roots`, git-reversible, kit never commits · **I10** rev-pin |
| `ledger` | read/write run state via validated subcommands (v2: cluster-upsert / cluster-state / event / validate · cluster-vrt) | **I5** re-derive "applied" from source, never trust ledger for safety · **I11** `validate --final` gates session end |
| `summary` | ledger → convergence report | **I7** allowlist emitted fields (no raw stackTrace / PII / tokens) |

## Invariant → module index (for review)

I1 ingest · I2 rerun · I3 apply · I4 (skill, evidence-gated) · I5 ledger ·
I6 cluster · I7 summary · I8 (skill — never commit/ticket/disable) · I9 rerun + gate ·
I10 apply · I11 rerun (per-test completeness) + gate (the accept/reject decision).
P3/P5/P6 config · P7 ledger · P4 `../hooks/flaky-kit-self-protection-gate.sh`.

## Status

Implemented + exercised: `ingest` (+ **N6** phantom guard & `vrt_url`) · `cluster` · `correlate` ·
`rerun` · `compile` (**N6-B**) · `apply` (guards proven: confinement→77, non-unique→65) · `ledger` ·
`summary` · `dom-capture` (**proven tb128**: 385 KB DOM, 14 `_cllpsID` ids via `getPageSource()`) ·
`dom-on-failure` (**proven tb161**). Gradle serialized via `_lock` (**N6-A** — concurrent `--rerun-tasks`
corruption fixed). `ledger` v2 has its own test suite: `bash core/tests/ledger-test.sh` (74 cases). The full `apply → compile → green-proof → converge` loop ran live on **s4-flaky-1394**
(e.g. `testAllCriteriaPopup` fixed + green on tb161; `testWebSuggestionMapClassifiedsResults` VRT→count refactor green).

The self-protection gate guards this dir (edits need `HEKTOR_FLAKYKIT_UNLOCK=1`). Its logic is
**verified** (2026-06-25: deny on `core/**` + `SKILL.md`, allow + audit on the unlock, passthrough
otherwise) and the gate now also matches **Bash** writes (redirect/`sed -i`/`cp`/`mv`/`rm`/`chmod`).
**2026-06-30 correction:** PreToolUse `deny` **is** enforced by the current CLI (observed live — a
sibling gate blocked a `settings.json` edit), so the gate is a real wall when locked, not just an
audit signal (kernel §14 META). For an OS-level wall independent of the CLI, `core/lock-kit.sh
lock` flips the surface read-only (consent-gated unlock via the same flag).
