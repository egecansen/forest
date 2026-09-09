# Hektor gates

The enforcement layer. Each gate is one bash script that reads Cursor's hook JSON
on stdin and prints a verdict — so a rule that would otherwise be prose the agent
is trusted to honour becomes **binding**.

Registered in `.cursor/hooks.json` (merged from the pack's [`hooks.json`](../hooks.json)
by `install.sh`, idempotently).

## Harness contract

Everything harness-specific lives in one file: [`lib/cursor.sh`](./lib/cursor.sh).
It provides the accessors (`hektor_command`, `hektor_file_path`,
`hektor_added_text`, `hektor_role`, `hektor_summary`, …) and the emitters
(`hektor_deny`, `hektor_context`, `hektor_followup`). No gate parses Cursor's
JSON itself, and no gate knows what Cursor is.

Two consequences worth stating, because both are deliberate:

- **Gates never match on `tool_name`.** Cursor's edit-tool naming has moved
  across versions (`file_path` / `path` / `target_file`; `content` /
  `new_string` / `code_edit`). The file gates key on the *shape* of
  `tool_input` instead, so a rename upstream degrades them to fail-open rather
  than silently to allow-everything.
- **Every gate fails OPEN.** Missing `jq`, an unrecognised payload, a `python3`
  that isn't there → `exit 0`. A gate that wedges the agent because its own
  dependency is absent is a worse bug than the rule it was enforcing going
  unchecked for one call.

Verdict shapes, per event:

| Event | Output | Can it stop the action? |
|---|---|---|
| `beforeShellExecution` | `{permission:"deny"}` | yes — the command never runs |
| `preToolUse` | `{permission:"deny"}` | yes — the write never lands |
| `subagentStart` | `{permission:"deny"}` | yes — the subagent never starts |
| `postToolUse` | `{additional_context}` | no — advisory, after the fact |
| `subagentStop` / `stop` | `{followup_message}` | no — forces another turn |
| `sessionStart` | `{additional_context}` | no — injects context |

Exit code `2` also blocks. Any other non-zero is read as "the hook broke" and the
action is allowed through.

## Installed gates

### Commit + destructive discipline

| Gate | Event | Does | Kill switch |
|---|---|---|---|
| [`commit-gate.sh`](./commit-gate.sh) | `beforeShellExecution` | Denies agent `git commit` / `git push` (enforces the manual-commit rule) and `--no-verify` / `--no-gpg-sign` bypass flags. | `HEKTOR_COMMIT_GATE=off` |
| [`destructive-command-gate.sh`](./destructive-command-gate.sh) | `beforeShellExecution` | Denies irreversible commands that wipe in-progress work — `rm -rf`, `git reset --hard`, `git clean -f`, whole-tree `git checkout/restore .`, `git stash clear/drop`. | `HEKTOR_DESTRUCTIVE_GATE=off` |

Scope note: these fire on commands the **agent** runs. A command you type in
Cursor's own terminal is not routed through the agent and is not gated — so this
blocks the agent, not you.

### PR-reviewer mirror (catch it before the PR)

Every PR is scanned by a bot that marks it **Needs Work** on a BLOCKER.
`pr-rules-gate` runs the same deterministic checks at write-time.

| Gate | Event | Does | Kill switch |
|---|---|---|---|
| [`pr-rules-gate.sh`](./pr-rules-gate.sh) | `preToolUse` + `postToolUse` | On `*.java` under `web-ui-test/` (`*Page`/`*Layout`/`*Test`) or `test-data-client/` (`*ResourceClient`/`AbName.java`): **DENY** on reviewer BLOCKERs (`new …Page()`, XPath-in-`@FindBy`, `getRemoteWebDriver()`/`getShadowRoot()`/`findElement(By.)`, `@ScheduledDisable` w/o `reason`, `@PageLayout` name suffix, `extends AbstractService`/`AbstractDAO`/`*ResourceClient`/`*DAO` **in web-ui-test** (WEBT-255458), TDC `*ResourceClient` `extends AbstractService`/`@Component`, `clients.*` URL `/`+`//`, `AbName` SCREAMING_SNAKE); advisory note on WARNINGs (Layout-var-in-test, `@FindBy` URL, `stream().map(getText)`, `checkVisualRegression*`-in-`assertx`, commented-out code, non-camelCase, `log` `+`-concat, `log` w/o `@Slf4j`, unused import, magic-number-3×). | `HEKTOR_PR_RULES_GATE=off` |

It is registered on **both** events on purpose. `preToolUse` can veto a write but
carries no channel for advisory text; `postToolUse` carries `additional_context`
but runs after the write landed. So BLOCKERs veto up front and WARNINGs come back
as a note once the file is on disk — one script, no duplicated rule logic. A
WARNING-only file is never blocked, matching the reviewer, which leaves those as
inline comments.

### Reviewer-attestation cluster (anti-self-grading)

The orchestrator must not grade its own work.

| Gate | Event | Does | Kill switch |
|---|---|---|---|
| [`reviewer-approver-registry.sh`](./reviewer-approver-registry.sh) | `subagentStart` | Silent-allow registration. Opens a 30-minute approval lease keyed by `subagent_id` when a `workflow-reviewer-*` / `phase-validator-*` role starts. | — (never blocks) |
| [`reviewer-brief-gate.sh`](./reviewer-brief-gate.sh) | `subagentStart` | Denies a `workflow-reviewer-*` brief that omits a `run-status.json` reference, a verification verb (Read/verify/inspect), or is < 400 chars ("just approve" patterns). | `HEKTOR_REVIEWER_BRIEF_GATE=off` |
| [`run-status-write-gate.sh`](./run-status-write-gate.sh) | `preToolUse` | Gates writes to `docs/hektor/run-status.json`: denies a phase→`reviewerVerdict:"approved"` with no open approver lease; denies a phase→`status:"skipped"` lacking an `approvedDeviations[]` entry with a verbatim `authorizer` or structural reason prefix; denies unparseable JSON. | `HEKTOR_RUN_STATUS_GATE=off` |
| [`dispatch-ordering-gate.sh`](./dispatch-ordering-gate.sh) | `subagentStart` | Denies a non-reviewer dispatch when a finished phase carries `reviewerVerdict != "approved"` (forces the reviewer first), and out-of-order `phase-<N>-` dispatches ahead of an unapproved prior phase. **Opt-in: only fires on phases carrying a `reviewerVerdict` field** — runs not using reviews are never blocked. The write-gate gates the *approval*; this gates the *sequence*. | `HEKTOR_ORDERING_GATE=off` |
| [`reviewer-attestation-gate.sh`](./reviewer-attestation-gate.sh) | `subagentStop` | Follow-up (can't reverse a finished return) when a reviewer's `verdict: approve` cites no project file path, or cites one that doesn't exist on disk. | — |

**Known degradation, stated rather than papered over.** On Claude Code the
write-gate matched a proposed approval's `parent_tool_use_id` against the
registry, which proved the approval was written from *inside* the reviewer
subagent. Cursor exposes no parent-call link on an ordinary tool call, so that
attribution is not reconstructible. The lease keeps the half that matters — an
approval cannot land unless an approver subagent actually ran, recently — and
loses the other: it cannot prove the write came from within that subagent rather
than from the orchestrator while one happened to be open.

### Subagent return-shape discipline

| Gate | Event | Does | Kill switch |
|---|---|---|---|
| [`subagent-schema-preread-gate.sh`](./subagent-schema-preread-gate.sh) | `subagentStart` | Denies a `composer-` / `probe-` / `workflow-reviewer-` / `phase-validator-` / `diagnosis-` dispatch whose brief doesn't cite its `*.schema.json`. | `HEKTOR_SCHEMA_PREREAD_GATE=off` |
| [`subagent-return-schema-guard.sh`](./subagent-return-schema-guard.sh) | `subagentStop` | Follow-up when a return is missing a schema-`required` top-level field, violates a top-level `enum`, or breaks a conditional `if`/`then` rule (e.g. `status: skipped` ⇒ `skip-authorisation`; `confirmed-bugs ≥ 1` ⇒ `findings-ledger`; `classification: app-bug` ⇒ `bug-ticket`). jq-driven, dependency-free. | — |
| [`standard-mode-first-pass-guard.sh`](./standard-mode-first-pass-guard.sh) | `subagentStart` | Denies `[group]` / `[P3-batch]` coverage-expansion dispatches on Pass 1 (standard) or any pass (depth). | `HEKTOR_FIRSTPASS_GUARD=off` |

These key on a **role label**, which Hektor dispatches put on the first line of
the task (`role: composer-j-hybrid-search`). See
[`../agents/README.md`](../agents/README.md) for the full table.

### Blueprint + safety

| Gate | Event | Does | Kill switch |
|---|---|---|---|
| [`journey-map-sentinel-gate.sh`](./journey-map-sentinel-gate.sh) | `preToolUse` | Denies writes to `docs/hektor/journey-map.md` whose line 1 isn't the `<!-- hektor:journey-mapping -->` sentinel — so the blueprint can't be hand-rolled or have its sentinel stripped. Edits that keep the sentinel pass. | `HEKTOR_JOURNEYMAP_GATE=off` |
| [`invisible-unicode-gate.sh`](./invisible-unicode-gate.sh) | `preToolUse` | Denies written `.md`/`.java`/frontmatter carrying invisible/bidi/Unicode-Tag codepoints (the ASCII-smuggling prompt-injection vector a human reviewer can't see). python3-based. | `HEKTOR_UNICODE_GATE=off` |
| [`delivery-gate.sh`](./delivery-gate.sh) | `stop` | Follow-up when the session's final message rationalises away a red/flaky test ("skipping for now", "4/5 is fine", "should work", `Thread.sleep`, scope-reduce). Stands down once `loop_count` is non-zero, and `hooks.json` caps it with `loop_limit: 1` — a false positive costs one turn, never a loop. | `HEKTOR_DELIVERY_GATE=off` |
| [`observe.sh`](./observe.sh) | `postToolUse` | Non-blocking capture: appends a secret-scrubbed one-line record per tool call to `docs/hektor/observations.jsonl` for the `hektor-distill` memory loop. Registered with no matcher, so it sees shell **and** edits. | `HEKTOR_OBSERVE=off` |
| [`kernel-inject.sh`](./kernel-inject.sh) | `sessionStart` | Injects the router and the two non-negotiables once per session via `additional_context`. Only advertises skills actually installed. | `HEKTOR_KERNEL_INJECT=off` |

`beforeSubmitPrompt` is deliberately unused: its output schema is only
`{continue, user_message}` — it can veto a prompt, not add context. `sessionStart`
is the injection point Cursor actually provides.

### Self-protection

| Gate | Event | Does | Kill switch |
|---|---|---|---|
| [`enforcement-self-protection-gate.sh`](./enforcement-self-protection-gate.sh) | `preToolUse` | Denies agent edits to the enforcement surface — `.cursor/hooks.json`, `.cursor/hooks/**/*.sh` + `lib/`, `.cursor/schemas/subagent-returns/*.schema.json` — so the layer can't be silently unregistered or neutered. `.md` docs are excluded, and skills/agents/rules are deliberately **not** on the surface: they are meant to be edited. Legitimate maintenance sets the unlock flag; the unlock is logged. | `HEKTOR_HOOKS_UNLOCK=1` |

## Profiles

One dial instead of N switches ([`lib/hook_profile.sh`](./lib/hook_profile.sh)):

- `HEKTOR_HOOK_PROFILE=minimal` — hard blockers only (commit, destructive,
  invisible-unicode, pr-rules). Good for CI / batch runs where the nag gates are noise.
- `standard` (default) — the above plus capture and the schema/journey gates.
- `strict` — plus the full reviewer-attestation cluster.

`HEKTOR_DISABLED_HOOKS=commit-gate,observe` force-disables named gates.
`HEKTOR_CURSOR_HOOKS=off` disables the whole layer.

## Vulnerabilities & threat model

**These gates are friction, not a security boundary.** Stated plainly because the
distinction keeps getting lost:

- They fire on tool calls the agent makes. They do not see a write performed by a
  compiled helper, or by anything that doesn't route through the harness.
- Every hook script in a project is plainly writable by the user the agent runs
  as. `enforcement-self-protection-gate` raises that from "one edit" to "one edit
  plus an env var, logged" — that is the whole claim.
- Every kill switch is settable by the agent being gated. They exist for
  *documented human exceptions*, and their use is recorded to
  `docs/hektor/.hook-audit.log`. That log lives inside the agent's own write
  scope, so it is an audit trail, not a tamper-proof one.

The genuine wall, where one exists, is OS-level: see the flaky-triage kit's
`core/lock-kit.sh` hardened tier (root ownership, password-gated reopen).

## Testing a gate by hand

Every gate is `bash` + `jq` reading stdin, so drive one directly:

```bash
# a shell gate
printf '{"hook_event_name":"beforeShellExecution","command":"git commit -m x"}' \
  | bash hooks/commit-gate.sh
# -> {"permission":"deny", ...}

# a file gate
printf '{"hook_event_name":"preToolUse","tool_input":{"file_path":"/r/web-ui-test/FooTest.java","content":"new SearchPage();"}}' \
  | bash hooks/pr-rules-gate.sh

# a subagent gate (role comes from the task's first line)
printf '{"hook_event_name":"subagentStart","subagent_id":"s1","task":"role: composer-j-x\\nGo."}' \
  | bash hooks/subagent-schema-preread-gate.sh
```

Silence means allow. `HEKTOR_HOOK_DEBUG=1` tees every raw payload to
`docs/hektor/.cursor-hook-payload.log`, which is the fastest way to tune an
accessor against what Cursor actually sends on your version.
