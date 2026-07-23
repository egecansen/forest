# Kit Hardening Remediation Plan

> Remediation of the 2026-07-23 three-way kit audit. REQUIRED SUB-SKILL: subagent-driven-development, run SEQUENTIALLY (the kit is one self-protected surface — never two kit-editing agents at once). Each round is TDD'd + reviewed.

**Goal:** Close the audit's Critical + Important findings without weakening any invariant.

**Lifecycle:** Kit is UNLOCKED once at program start and stays unlocked between rounds; every kit write is prefixed `HEKTOR_FLAKYKIT_UNLOCK=1`. Round 5 re-locks + regenerates the zip. Probes run against `/tmp` copies, never the live kit dir.

## Global Constraints
- No AI-attribution commit trailers.
- Preserve all existing behavior + the 74-case ledger suite + every kernel invariant; add regression tests for each fix.
- bash 3.2 + jq 1.7.1 compatible; `set -uo pipefail`; untrusted values via `--arg`, never interpolated.
- Honest framing in code comments: the self-protection gate is defense-in-depth (raise-the-bar), NOT a hard wall against a shell-capable agent.

---

### Round 1 — Correctness Criticals (rerun green-proof + apply confinement)
**Files:** `core/rerun.sh`, `core/apply.sh`, new `core/tests/rerun-test.sh` + `core/tests/apply-test.sh`.
1. **rerun.sh false-green (#1):** the pass-health guards check "did anything report," not per-test. Add a per-test completeness check: compare each test's own `runs` to `runs_requested`; a test with `runs < runs_requested` gets `confidence` capped (NOT 1.0) and appears in a new `insufficient_runs` list in the JSON output. A test that only reported in 1 of N passes must NOT read `confidence: 1.0`. TDD with 3 synthetic pass logs where one test reports once → assert it's flagged `insufficient` and confidence < 1.
2. **apply.sh source_roots (#3):** before use, assert every configured `source_root`'s `realpath` starts with the repo's `realpath` (+ separator); reject (exit 77) any root that escapes or is absolute-outside-repo. Fix the clean-tree gate so a git error on an out-of-repo path is treated as UNSAFE (refuse), not clean. TDD: an absolute out-of-repo source_root → apply refuses; a normal in-repo root → still works.

### Round 2 — Self-protection hardening (#2)
**Files:** `core/lock-kit.sh`, `adapters/claude/flaky-kit-self-protection-gate.sh`, `adapters/cursor/flaky-kit-self-protection-gate.sh`, `core/shell-guard.py`, `adapters/_lib/audit.sh`.
1. **lock-kit.sh — lock directories, not just files:** `chmod a-w` (e.g. `555`) on `core/`, `hooks/`, and the kit root so `rm`+recreate and new-file creation both fail at the OS layer. `unlock` restores dir write bits. Keep the `HEKTOR_FLAKYKIT_UNLOCK` gate.
2. **Gate + shell-guard path canonicalization:** resolve the presented `file_path` / command path with `realpath`-equivalent (reuse `apply.sh`'s pattern) BEFORE substring-matching the surface — closes `./`, `../`, and symlink bypasses. Add `git\s+(checkout|apply|restore|stash|reset|clean)`, `rsync`, `patch` to the mutate-verb set.
3. **shell-guard.py cwd tracking:** parse leading `cd <dir> &&`/`cd <dir>;` and resolve subsequent relative refs against it before the fragment check — closes cwd-blindness.
4. **Audit log protection:** make `docs/hektor/.hook-audit.log` append-only where possible / covered by the surface, and stop `hektor_audit()` from silently no-op'ing on failure (emit a stderr warning).
5. Comment each with the honest defense-in-depth framing. Probe-driven: the audit's exact bypass commands (`cd core && rm && printf >`, symlink, `./`/`../`) must now DENY against a /tmp copy.

### Round 3 — Input-validation hygiene
**Files:** new `core/_strict.sh` (shared helper), `core/ingest.sh`, `core/rerun.sh`, `core/dom-capture.sh`, `core/dom-on-failure.sh`, `core/sanitize-text.py`.
1. **Shared whole-string matcher:** `strict_match <value> <ERE>` — rejects any value containing a newline, then `[[ =~ ^ERE$ ]]`. Replace the `grep -qE '^…$'` validators in ingest/rerun/dom-capture/dom-on-failure with it. TDD: an embedded-newline build-name/FQCN/URL is rejected (the anchor-asymmetry class, closed in one place).
2. **sanitize-text.py:** also strip C0/C1 controls (keep `\t`/`\n`) and ANSI CSI/OSC escape sequences; on missing python3/helper, ingest's `sanitize()` warns to stderr instead of silently passing through. TDD the ANSI/ESC stripping.

### Round 4 — Ledger + summary robustness
**Files:** `core/ledger.sh`, `core/summary.sh`, `core/tests/ledger-test.sh`, new `core/tests/summary-test.sh`.
1. **ledger.sh:** (a) `flock` the read-modify-write in `jset`/`set` (P7 — closes 55% concurrent write-loss); (b) `validate` also checks `bucket` ∈ six and `tier` ∈ 1-4 (mirror the write-path enum enforcement) — reuse the shared jq `fullmatch`; (c) `init` refuses to clobber a non-empty ledger without `--force`; (d) flag-with-no-value → clean `die 64` for every subcommand's flags; (e) reject duplicate cluster ids in `validate`; (f) `validate` emits `{id, reason}` instead of a bare id list.
2. **summary.sh:** fix field names to the v2 schema (`.sig`→`.signature`; drop never-persisted `.recipe`/`.tier_hint`; derive exception-type label from `.signature`); replace the dead `status=="flaky"` section with a real terminal state (fold into deferred/flagged or drop). Add `summary-test.sh` (first summary tests) incl. an I7 leak check (no raw signature/stackTrace in output).

### Round 5 — Packaging, kernel register, re-lock
**Files:** new `scripts/package-kit.sh` (or the zip step), `kernel.md` §12/§13, re-lock.
1. **Zip hygiene (P5 leak):** a packaging step that excludes `.playwright-mcp/ .achilles/ .DS_Store .git/` and greps the staged tree for internal hostnames (`*.sahibindenlocal.net`, `*.tzla.*`) — refuse to package if found outside the intentional `config.json`. Regenerate `flaky-triage-kit.zip` clean.
2. **install.sh:** note/optionally checksum the vendored libs (embed SHA-256, warn on mismatch) — at least warn when `vendor()` skips a pre-existing file.
3. **kernel.md §12/§13:** add register rows for every fix in Rounds 1-4 (rerun per-test completeness, apply source_root confinement, dir-lock + gate canonicalization + cwd tracking, grep-newline whole-string helper, sanitize ANSI, ledger flock/validate-enum/init-guard, summary schema fix, zip exclude) with status DONE (2026-07-23).
4. Reinstall into web-test, regenerate zip, **re-lock** (`core/lock-kit.sh lock`).

## Self-review notes
- Coverage: every audit Critical (rerun/apply/self-protection) + Important (grep-newline, sanitize, ledger flock/validate, summary, zip leak) mapped to a round. Test-coverage improvement is folded in (new rerun/apply/summary suites + ledger additions).
- Sequencing: rerun.sh touched R1 then R3 (order matters — R1 first); the shared helper (R3) predates the ledger jq `fullmatch` reuse note (R4). Self-protection (R2) is independent files.
