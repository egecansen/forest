# ECC → Hektor improvement backlog

Ranked, cited backlog from a 5-facet audit of the ECC repo (`github.com/affaan-m/ECC`)
for patterns a single-maintainer QA methodology pack can adopt. Tiers are ordered by
value × (1/effort) × fit. `[status]` tracks what's built.

**Headline finding:** the highest-value patterns all attack one theme — Hektor trusts
the agent to self-police (green-proof, "is this an app bug", "don't weaken a test");
ECC replaces that trust with mechanical checks. That is exactly the optimistic-
misclassification failure Hektor's MEMORY repeatedly flags.

---

## Tier 1 — kill self-grading  `[built]`

| Item | ECC evidence | Effort | Verdict |
|---|---|---|---|
| **pass^N gate → `verifier-result.json`** — turn flaky-triage's prose "green-proof = pass^N" into a jq gate emitting accept/reject/inconclusive | `skills/eval-harness/SKILL.md:254-258` (pass^3=1.00 for release-critical); `examples/evaluator-rag-prototype/verifier-result.json` (shape) | S | Adopt |
| **Two-key rule** — "fixed" requires the pass^N gate AND a *separate* reviewer subagent to accept; reuses Hektor's reviewer-attestation hooks (`reject` already in the schema) | `skills/gan-style-harness/SKILL.md:17,256` (separate evaluator, generator doesn't grade) | S | Adopt |
| **`council` anti-anchoring** — dispatch the reviewer with the artifact + criteria only, never the author's narration | `skills/council/SKILL.md` ("fresh subagents with only the question and relevant context") | S | Adapt |
| **`delivery-gate` Stop hook** — Hektor has no Stop slot; add one that greps the session for rationalizations ("skipping tests for now", "4/5 runs is fine") | `skills/delivery-gate/hooks/quality-gate.py:22-27,80-118` (RATIONALIZE regex + stale-memory mtime, exit 2) | M | Adopt |
| **Hedge-word pre-screen** — grep the fixer's own summary for "should work / only ran once" → auto-escalate before a judge call | `skills/agent-self-evaluation/scripts/evaluate.py:66-76,349-351` (danger_patterns → Redo) | S | Adopt |
| **loop-design antibodies** — "green AND no spec deleted/weakened AND coverage not lowered"; independent judge | `skills/loop-design-check/SKILL.md` (anti-Goodhart boundary clause) | S–M | Adopt |

## Tier 2 — safety & hygiene  `[built]`

| Item | ECC evidence | Effort | Verdict |
|---|---|---|---|
| **Invisible-Unicode / ASCII-smuggling scan** on written `.md`/`.java`/frontmatter — blocks hidden prompt-injection a reviewer can't see | `scripts/ci/check-unicode-safety.js:109-143` (U+200B-200D, bidi, **U+E0000-E007F tag block**); `the-security-guide.md:200-218` | S/M | Adopt |
| **Scrub-before-persist** (one idea, 3 sites): secret-scrub in `lib/audit.sh`; secret-scrub in the capture hook; **PII-redact screenshots/DOM** in verify/VRT/bug-discovery (extend `sanitize-text.py`) | `scripts/hooks/session-activity-tracker.js:31-43` (redactSecrets); `skills/browser-qa/SKILL.md:22-29` (redact before saving) | S | Adopt |
| **Destructive-command guard** — block `rm -rf`, `git reset --hard`, `git clean -fdx` on the suite | `scripts/hooks/governance-capture.js:40-46` (APPROVAL_COMMANDS) | S | Adopt |
| **Missing-baseline ⇒ inconclusive** — stop VRT's first run silently auto-baselining and "passing" | `skills/browser-qa/SKILL.md:55-57,93-96` (no baseline ⇒ INCONCLUSIVE, never silent PASS) | S | Adapt |

## Tier 3 — pack self-consistency  `[built]`

| Item | ECC evidence | Effort | Verdict |
|---|---|---|---|
| **`hektor doctor`** — referential integrity (no orphan gate/schema, every routed skill resolves) + gate-install check (each gate in settings.json and `+x`) + ≤30-word description warnings | `scripts/harness-audit.js:392-412`; `docs/architecture/observability-readiness.md` (file-backed readiness gate) | M | Adopt |
| **`hektor-skill-stocktake`** — periodic Keep/Improve/Retire/Merge with mtime-diff quick-scan | `skills/skill-stocktake/SKILL.md` + `scripts/quick-diff.sh` | M | Adopt |
| **Authoring convention** — single-purpose SKILL.md + explicit "does NOT do X → see Y" boundaries | cross-cutting ECC habit (`loop-design-check` ↔ `autonomous-loops`) | S | Adopt |

## Tier 4/5 — learning + ergonomics  `[built]`

| Item | ECC evidence | Effort | Verdict |
|---|---|---|---|
| **`observe.sh` capture + `/distill`** — ~15-line PostToolUse jsonl hook (secret-scrub) + manual Haiku pass that *proposes* MEMORY.md entries (never auto-writes) | `skills/continuous-learning-v2/hooks/observe.sh:344-354` (linear-time scrub); `agents/observer.md`, `agents/observer-loop.sh:252-254` (`claude --model haiku --print`) | S–M | Adapt |
| **Context-budget** — keep every skill/subagent `description` ≤30 words (loads on every dispatch) | `skills/context-budget/SKILL.md:63-64,133-134` | S | Adopt |
| **Hook-profile tiers** — `HEKTOR_HOOK_PROFILE=minimal\|standard\|strict` (CI minimal, local strict) | `scripts/lib/hook-flags.js:12-69` (ECC_HOOK_PROFILE / ECC_DISABLED_HOOKS) | S | Adopt |
| **`additionalContext` steering** — feed structured "missing field" guidance into the model, not stderr | `scripts/hooks/pretooluse-visible-output.js:25-35` | S | Adapt |
| **Fail-open stdin hardening** — cap stdin at 1 MB, emit nothing on parse fail | `run-with-flags.js:17,144-166` (bug #2222) | S | Adapt |

---

## Skipped (already have / too heavy / external deps)

- pass^k *concept alone* (already in Hektor prose), `agent-introspection-debugging` (≈ `hektor-failure-diagnosis`), `e2e-testing` quarantine (≈ `@ScheduledDisable(reason)`).
- `codehealth-mcp` (external CodeScene MCP), `canary-watch` (post-deploy monitoring), `codebase-onboarding` / `code-tour` / `benchmark-methodology` (domain-tangential).
- clv2 daemon + SIGUSR1 + confidence-scoring + project-hash promotion (over-engineered for one maintainer).
- ECC manifest/module installer layer, `ecc2` Rust control plane, `plan-orchestrate` fleet catalogue (scale features).
