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
| `_integrity` *(sourced)* | kit root → tier (`hardened`/`unlocked`/`degraded`/`unprotected`/`mismatch`/`stale`) **and** wiring (`wired`/`unregistered`/`dangling`/`foreign`/`partial`/`absent`) | **P4** both are asserted at every entrypoint, not assumed. Refuses (76) on a tier `mismatch`, or when a `hardened`/`stale` tier's wiring is `dangling`/`unregistered`/`partial`/`foreign`. **2026-07-31:** `integrity_guard` now detects the wiring and repairs it (`wiring_repair`) before reporting the **pre-repair** verdict — except at every tier that refuses: `hardened`, `stale`, `mismatch` write **nothing** at all. `integrity_guard` recomputes from disk every call, so a registration written at a refusing tier would read `wired` on the very next call and return 0 while the session's harness still has no gate loaded — measured, then closed by repairing nothing at those three tiers instead |
| `_wiring_repair` *(sourced)* | re-asserts the kit's own gate registration when the guard finds it missing or dangling, but only at a tier that does not refuse the run | registration and the gate FILE alike, only where the guard proceeds — nothing at all at `hardened`/`stale`/`mismatch` · `foreign` never |
| `lock-kit` | `lock`/`unlock`/`status` → OS-level tier on the safety surface | **P4** hardened = root-owned safety surface **including the kit root** (reopen needs a password); degrades to chmod-only and names the tier it actually reached |
| `summary` | ledger → convergence report | **I7** allowlist emitted fields (no raw stackTrace / PII / tokens) |

## Invariant → module index (for review)

I1 ingest · I2 rerun · I3 apply · I4 (skill, evidence-gated) · I5 ledger ·
I6 cluster · I7 summary · I8 (skill — never commit/ticket/disable) · I9 rerun + gate ·
I10 apply · I11 rerun (per-test completeness) + gate (the accept/reject decision).
P3/P5/P6 config · P7 ledger · P4 `<project>/.claude/hooks/flaky-kit-self-protection-gate.sh`
(**outside** the kit tree, so renaming the tree cannot take its own detector along) + `lock-kit` /
`_integrity`.

## Status

Implemented + exercised: `ingest` (+ **N6** phantom guard & `vrt_url`) · `cluster` · `correlate` ·
`rerun` · `compile` (**N6-B**) · `apply` (guards proven: confinement→77, non-unique→65) · `ledger` ·
`summary` · `dom-capture` (**proven tb128**: 385 KB DOM, 14 `_cllpsID` ids via `getPageSource()`) ·
`dom-on-failure` (**proven tb161**). Gradle serialized via `_lock` (**N6-A** — concurrent `--rerun-tasks`
corruption fixed). `ledger` v2 has its own test suite: `bash core/tests/ledger-test.sh` (102 cases —
verify against the file, not this number). The full `apply → compile → green-proof → converge` loop ran live on **s4-flaky-1394**
(e.g. `testAllCriteriaPopup` fixed + green on tb161; `testWebSuggestionMapClassifiedsResults` VRT→count refactor green).

The self-protection gate guards this dir (edits need `HEKTOR_FLAKYKIT_UNLOCK=1`). Its logic is
**verified** (2026-06-25: deny on `core/**` + `SKILL.md`, allow + audit on the unlock, passthrough
otherwise) and the gate also matches **Bash** writes (redirect/`sed -i`/`cp`/`mv`/`rm`/`chmod`) —
including, since 2026-07-30, the kit tree and both harnesses' hook directories as `mv`/`rm`
**operands**, the out-of-tree `.flaky-kit-expect` record, and the harness settings files that
register the gate at all (`.claude/settings.json`, `.claude/settings.local.json`,
`.cursor/hooks.json`): Bash denies any mutation of them outright, and Write/Edit denies only an edit
that would drop the registration — neither is chown-backed the way `core/**` is (full residual in
`core/lock-kit.sh`'s header). It did not match any of those before: every surface pattern ended in
`/`, so `mv <kit> /tmp/x` and `rm -rf .claude/hooks` were allowed and unaudited on every install.

**2026-06-30 correction, itself corrected 2026-07-30:** PreToolUse `deny` **is** enforced by the
current CLI (observed live — a sibling gate blocked a `settings.json` edit), so the gate's denials are
real. That does **not** make the gate a wall, and this file said it did. The gate decides by matching a
heuristic pattern against a command string: `base64 … | bash`, `eval`, process substitution and any
compiled writer bypass it by construction, and the operand gap above sat in it, live, until it was
found. The gate's own header says FRICTION and explains why; this line now agrees with it instead of
contradicting it.

The wall, where there is one, is OS-level and independent of any CLI: `core/lock-kit.sh lock` reaches
for the **hardened** tier and chowns the safety surface to root — `core/**`, `SKILL.md`, both
harnesses' gate scripts and their vendored libs, and the kit root itself (plus an in-tree `hooks/**` if
this install predates the gate's relocation — a current install has no such directory, so do not read
that as a description of one). Reopening then needs a password, not just `HEKTOR_FLAKYKIT_UNLOCK=1`
(that flag is an intent marker, not consent — the password is; it's logged to the audit log only when a
PreToolUse gate intercepts an agent's call with it set, never by `lock-kit.sh` running directly). Both
`lock` and `unlock` end with `sudo -k`, because sudo's cached credential otherwise leaves a ~5-minute
no-prompt reopen window that `lock` itself created. Without `sudo` the tier **degrades** to the old
chmod-a-w-only behaviour, which the same user can reverse. `core/_integrity.sh` asserts both the
tier and the gate's wiring that are actually there at every entrypoint (tier: 2026-07-29; wiring:
2026-07-30), so a silent slip from hardened to degraded, or a registration that stopped resolving,
can't pass as still-protected. Since 2026-07-31 a broken wiring is also repaired at every tier that
lets the run proceed (`core/_wiring_repair.sh`) — the registration additively, and the gate FILE from
the engine's own vendored copy. At every tier that REFUSES — `hardened`, `stale` and `mismatch` —
nothing is written at all: a registration repaired there would read `wired` on the very next entrypoint
(the guard recomputes from disk every call), so the tier would stop refusing while the session's harness
still has no gate loaded. The refusal holds there instead, on every call, because nothing on disk ever
changes. `mismatch` belongs on that list for the same reason and was missed once, when the rule was
phrased "where the tree is root-owned": it is the one tier whose meaning is a recorded root ownership
the tree does **not** have, so a repair there copied the gate out of a tree the same run calls
untrustworthy and flipped the axis from `dangling` to `wired`. What the hardened tier does **not** cover is listed in full in
`core/lock-kit.sh`'s header — read that list before calling this kit protected.
