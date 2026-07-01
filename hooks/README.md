# Hektor harness hooks

Project-scoped Claude Code hooks that make Hektor's methodology rules
*binding* rather than advisory prose. Registered in `.claude/settings.json`
(project settings) and resolved via `$CLAUDE_PROJECT_DIR`.

This is the Hektor port of [Achilles](https://www.npmjs.com/package/@civitas-cerebrum/achilles)'
`hooks/` enforcement layer. Achilles' hooks live globally in `~/.claude/`
and are installed by its `postinstall.js`; Hektor's are checked into the
repo so the whole team gets the same gates and can review them in a diff.

## Harness contract

Each hook reads the tool-call JSON on **stdin** (`tool_name`, `tool_input`,
`cwd`, …) and, to block a call, prints to **stdout**:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "…shown to the agent…" } }
```

Silent-allow = exit 0 with no output. All hooks are input-tolerant: missing
state, malformed stdin, or absent `jq` → fail-open (allow), never crash the
pipeline. Requires `jq` on PATH.

## Installed hooks

### Commit + dispatch discipline

| Hook | Event | Matcher | Purpose | Bypass |
|---|---|---|---|---|
| [`commit-gate.sh`](./commit-gate.sh) | PreToolUse | Bash | Denies agent `git commit` / `git push` (enforces the manual-commit rule) and `--no-verify` / `--no-gpg-sign` bypass flags. | `HEKTOR_COMMIT_GATE=off` |
| [`standard-mode-first-pass-guard.sh`](./standard-mode-first-pass-guard.sh) | PreToolUse | Agent | Denies `[group]` / `[P3-batch]` coverage-expansion dispatches on Pass 1 (standard) or any pass (depth). | `HEKTOR_FIRSTPASS_GUARD=off` |

### PR-reviewer mirror (catch it before the PR)

The team's PR bot runs a deterministic regex pass (Katman 1a) over newly added
lines and marks the PR "Needs Work" on any BLOCKER. This hook runs the same
checks locally at write-time, so a violation is caught while authoring instead
of on the PR. Line-based (Katman 1a) checks scan only the content the call adds
(`Write.content` / `Edit.new_string`), mirroring the diff-based pass. Two
file-wide Katman 1b checks (unused import, magic-number-3×) run against the full
proposed file — the `content` on `Write`, or the on-disk file reconstructed with
the `Edit`'s `old_string`/`new_string` — but only report a trigger that is part
of the added lines. Class-context checks (class-name suffix, `extends`,
`@Component`) fire only when the class declaration is itself in the added text.
The remaining Katman 1b rules and all Katman 2 (Gemini semantic) rules stay as
skill guidance (`hektor-conventions`, `hektor-resource-client`).

| Hook | Event | Matcher | Purpose | Bypass |
|---|---|---|---|---|
| [`pr-rules-gate.sh`](./pr-rules-gate.sh) | PreToolUse | Write\|Edit | On `*.java` under `web-ui-test/` (`*Page`/`*Layout`/`*Test`) or `test-data-client/` (`*ResourceClient`/`AbName.java`): **DENY** on reviewer BLOCKERs (`new …Page()`, XPath-in-`@FindBy`, `getRemoteWebDriver()`/`getShadowRoot()`/`findElement(By.)`, `@ScheduledDisable` w/o `reason`, `@PageLayout` name suffix, `*ResourceClient` `extends AbstractService`/`@Component`, `clients.*` URL `/`+`//`, `AbName` SCREAMING_SNAKE); **WARN** (systemMessage) on WARNINGs (Layout-var-in-test, `@FindBy` URL, `stream().map(getText)`, `checkVisualRegression*`-in-`assertx`, commented-out code, non-camelCase, `log` `+`-concat, `log` w/o `@Slf4j`, unused import, magic-number-3×). | `HEKTOR_PR_RULES_GATE=off` |

### Reviewer-attestation cluster (anti-self-grading)

The orchestrator must not grade its own work. These four interlock: a phase
can only reach `reviewerVerdict: "approved"` in `run-status.json` if a
*registered reviewer subagent* writes it, that reviewer was *briefed properly*,
and its approval *cited real files*.

| Hook | Event | Matcher | Purpose | Bypass |
|---|---|---|---|---|
| [`reviewer-approver-registry.sh`](./reviewer-approver-registry.sh) | PreToolUse | Agent | Silent-allow registration. Records `workflow-reviewer-*` / `phase-validator-*` dispatches by `tool_use_id` into `docs/hektor/.workflow-approvers.json` (TTL 30m). | — (never blocks) |
| [`reviewer-brief-gate.sh`](./reviewer-brief-gate.sh) | PreToolUse | Agent | Denies a `workflow-reviewer-*` brief that omits a `run-status.json` reference, a verification verb (Read/verify/inspect), or is < 400 chars ("just approve" patterns). | `HEKTOR_REVIEWER_BRIEF_GATE=off` |
| [`run-status-write-gate.sh`](./run-status-write-gate.sh) | PreToolUse | Write\|Edit | Gates writes to `docs/hektor/run-status.json`: denies a phase→`reviewerVerdict:"approved"` from orchestrator context or an unregistered/expired approver; denies a phase→`status:"skipped"` lacking an `approvedDeviations[]` entry with a verbatim `authorizer` or structural reason prefix; denies unparseable JSON. | `HEKTOR_RUN_STATUS_GATE=off` |
| [`reviewer-attestation-gate.sh`](./reviewer-attestation-gate.sh) | PostToolUse | Agent | WARN (can't reverse a finished return) when a reviewer's `verdict: approve` cites no project file path, or cites one that doesn't exist on disk. | — |
| [`dispatch-ordering-gate.sh`](./dispatch-ordering-gate.sh) | PreToolUse | Agent | Denies a non-reviewer dispatch when a finished phase carries `reviewerVerdict != "approved"` (forces the reviewer first), and out-of-order `phase-<N>-` dispatches ahead of an unapproved prior phase. **Opt-in: only fires on phases that carry a `reviewerVerdict` field** — runs not using reviews are never blocked. The write-gate gates the *approval*; this gates the *sequence*. | `HEKTOR_ORDERING_GATE=off` |

**Convention this cluster introduces.** The slim `run-status.json` in
METHODOLOGY.md gains an optional per-phase `reviewerVerdict: "approved"` field
(the workflow-reviewer pattern the orchestrator SKILL references but never had
a field for) and `approvedDeviations[].phase` keys. Reviewer subagents are
dispatched with a `workflow-reviewer-<phase|pass>-<N>` description; the
approval write must come from that subagent's context (`parent_tool_use_id`).

### Subagent return-shape discipline

Validate that subagents return the shape the orchestrator relies on. Contracts
live in [`.claude/schemas/subagent-returns/`](../schemas/subagent-returns/README.md)
(JSON Schema). Dispatches opt in via a role-prefix description; unrecognised
prefixes are silent-allowed (gradual adoption).

| Hook | Event | Matcher | Purpose | Bypass |
|---|---|---|---|---|
| [`subagent-schema-preread-gate.sh`](./subagent-schema-preread-gate.sh) | PreToolUse | Agent | Denies a `composer-` / `probe-` / `workflow-reviewer-` / `phase-validator-` / `diagnosis-` dispatch whose brief doesn't cite its `*.schema.json`. | `HEKTOR_SCHEMA_PREREAD_GATE=off` |
| [`subagent-return-schema-guard.sh`](./subagent-return-schema-guard.sh) | PostToolUse | Agent | WARNs when a return is missing a schema-`required` top-level field, violates a top-level `enum`, or breaks a conditional `if`/`then` rule (e.g. `status: skipped` ⇒ `skip-authorisation`; `confirmed-bugs ≥ 1` ⇒ `findings-ledger`; `classification: app-bug` ⇒ `bug-ticket`). jq-driven, dependency-free. | — |
| [`journey-map-sentinel-gate.sh`](./journey-map-sentinel-gate.sh) | PreToolUse | Write\|Edit | Denies writes to `docs/hektor/journey-map.md` whose line 1 isn't the `<!-- hektor:journey-mapping -->` sentinel — so the blueprint can't be hand-rolled or have its sentinel stripped. Edits that keep the sentinel pass. | `HEKTOR_JOURNEYMAP_GATE=off` |

### Safety & memory (adopted from ECC)

New gates ported from the ECC audit (see `docs/ecc-backlog.md`). All fail-open,
all with an env kill switch, and all profile-tagged (see below).

| Hook | Event | Matcher | Purpose | Bypass |
|---|---|---|---|---|
| [`invisible-unicode-gate.sh`](./invisible-unicode-gate.sh) | PreToolUse | Write\|Edit | DENY when written `.md`/`.java`/frontmatter carries invisible/bidi/Unicode-Tag codepoints (the ASCII-smuggling prompt-injection vector a human reviewer can't see). python3-based. | `HEKTOR_UNICODE_GATE=off` |
| [`destructive-command-gate.sh`](./destructive-command-gate.sh) | PreToolUse | Bash | DENY irreversible commands that wipe in-progress work — `rm -rf`, `git reset --hard`, `git clean -f`, whole-tree `git checkout/restore .`, `git stash clear/drop`. | `HEKTOR_DESTRUCTIVE_GATE=off` |
| [`delivery-gate.sh`](./delivery-gate.sh) | Stop | — | Block-once when the session's final message rationalises away a red/flaky test ("skipping for now", "4/5 is fine", "should work", Thread.sleep, scope-reduce). `stop_hook_active` loop-guard → a false positive costs one turn, never a loop. `=warn` softens to advisory. | `HEKTOR_DELIVERY_GATE=off\|warn` |
| [`observe.sh`](./observe.sh) | PostToolUse | Edit\|Write\|Bash | Non-blocking capture: append a secret-scrubbed one-line record per tool call to `docs/hektor/observations.jsonl` for the `hektor-distill` memory loop. | `HEKTOR_OBSERVE=off` |

**Hook-profile dial** ([`lib/hook_profile.sh`](./lib/hook_profile.sh), ECC
`hook-flags.js`): `HEKTOR_HOOK_PROFILE=minimal|standard|strict` selects which
gates run — `minimal` = hard blockers only (commit, destructive, unicode,
pr-rules) for CI; `standard` (default) = + capture + schema/journey gates;
`strict` = + the reviewer-attestation nag cluster + the delivery Stop-gate.
`HEKTOR_DISABLED_HOOKS=a,b` force-offs named gates. Currently the four gates
above + `delivery`/`observe` are profile-tagged; the legacy gates run in all
profiles (tagging them is a mechanical follow-up).

**Shared lib additions:** `lib/audit.sh` now ships `hektor_redact` (linear-time
secret scrub, reused by the audit log + `observe.sh`) and
`hektor_additional_context` (emit a model-visible steering payload).

### Self-protection

| Hook | Event | Matcher | Purpose | Bypass |
|---|---|---|---|---|
| [`enforcement-self-protection-gate.sh`](./enforcement-self-protection-gate.sh) | PreToolUse | Write\|Edit | Denies agent edits to the enforcement surface — `.claude/settings.json`, `.claude/hooks/**/*.sh` + `lib/`, `.claude/schemas/subagent-returns/*.schema.json` — so the layer can't be silently unregistered or neutered. `.md` docs are excluded. Legitimate maintenance sets the unlock flag; the unlock is logged. | `HEKTOR_HOOKS_UNLOCK=1` |

## Vulnerabilities & threat model

**This layer is effective against drift and accidental violation — it is not a
security boundary against an agent that wants out.** The gated party controls
its own shell, the state files, the environment, and (before the self-protection
gate) the hook definitions. Read this before relying on any gate as a guarantee.

- **Trust model is inverted.** Most gates read state the agent itself authors
  (`run-status.json`, `coverage-expansion-state.json`, dispatch descriptions,
  reviewer briefs, `authorizer` quotes, attestations). Those checks are
  *friction*, not walls. The **only** non-forgeable signal is the harness-set
  `parent_tool_use_id` — which is why `run-status-write-gate`'s actor-identity
  check is the one genuinely robust gate (it blocks the cheap self-grade: the
  orchestrator's own writes carry no parent id and are denied).
- **Forgeable-content checks (by design).** `authorizer` / `skip-authorisation`
  are presence-only (a fabricated quote passes); the reviewer brief-gate checks
  three paddable tokens; the attestation-gate checks file *existence*, not that
  the file was read, and is WARN-only; `[group]` markers, `phase-<N>-` prefixes,
  and schema citations are self-declared. A determined agent clears all of these.
- **commit-gate is a string match on a shell.** Bypassable by `git -C . commit`,
  `git --no-pager commit`, aliases, or write-then-`bash`. It stops the direct,
  obvious commit only. A real guarantee needs server-side branch protection.
- **Fail-open.** Missing `jq`, malformed input, or absent state silent-allows
  (availability over enforcement, so the pipeline never wedges).

### What the self-protection hardening fixed

- **Self-disable hole (closed to friction).** `enforcement-self-protection-gate`
  denies Write/Edit to the enforcement surface unless `HEKTOR_HOOKS_UNLOCK=1`
  is set — converting silent self-modification into a deliberate, audited act.
- **One fail-OPEN bug (fixed).** `run-status-write-gate`'s `Edit` reconstruction
  used `awk sub()` (ERE) — a regex metachar in `old_string` mis-reconstructed the
  file and could drop an approval transition the gate then never saw. Now a
  literal `index()`-based replace.
- **Bypass visibility.** Every `HEKTOR_*=off` / `HEKTOR_HOOKS_UNLOCK=1` use is
  appended to `docs/hektor/.hook-audit.log` (gitignored, best-effort) via
  [`lib/audit.sh`](./lib/audit.sh).

### Residual (inherent, not fixed)
The env bypasses and the self-protection gate are themselves bypassable by a
determined agent (e.g. a Bash file-write isn't a Write/Edit tool call); the audit
log is agent-deletable; the forgeable-content and commit-gate limits above are
structural. Put hard guarantees where they belong: server-side branch protection
for commits, and a human reading `run-status.json` approvals rather than trusting
them.

## Not ported (no Selenium/Hektor analogue)

`selector-development-*`, `playwright-cli-*` — bound to Playwright/the
frontend-source editing pipeline Hektor structurally lacks.

## Optional follow-ups — both now BUILT

- **Journey-map sentinel gate** — built (`journey-map-sentinel-gate.sh`, see table
  above). Enforces the `<!-- hektor:journey-mapping -->` line-1 sentinel on
  `docs/hektor/journey-map.md`. Inert until a map exists, which is fine.
- **Conditional schema enforcement** — built into `subagent-return-schema-guard.sh`
  as a **dependency-free jq+grep** evaluator of the schemas' `allOf`/`if`/`then`
  rules (handover.status const, top-level const, numeric minimum). The `node`+`ajv`
  route was declined by the sandbox (won't run `npm install` of agent-chosen
  packages unprompted) and isn't needed — the jq evaluator covers every
  conditional our schemas use. If you later want a *generic* JSON-Schema engine
  (arbitrary future schemas), authorise `npm install ajv yaml` under
  `.claude/hooks/lib/` and add a node branch that falls back to the jq evaluator.

### Not on the radar (no analogue)
- `app-wide-scan-sentinel-gate` — needs an `app-wide-patterns.md` catalogue
  concept Hektor doesn't have.
- `standard-mode-first-pass-guard` Rules 2 & 3 — journey-mapping cycle-walkthrough
  checks; no Hektor cycle-state ledger to read them against.

## Testing a hook by hand

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' \
  | .claude/hooks/commit-gate.sh
# -> emits the deny JSON
```
