# Hektor on Cursor — what maps, and the one thing that doesn't

Hektor was originally a Claude Code pack with a Cursor *shim*: one rule that
pointed at `.claude/skills/hektor-*/SKILL.md`, plus an `adapter.sh` that
reshaped Cursor's hook JSON into Claude tool-call JSON so the unmodified Claude
gates would run. That shim is gone. The pack is now Cursor-native, and this
document records what that changed — including the places where the old
cross-harness doc was simply wrong about what Cursor can do.

## What the migration assumed, and what is actually true

The shim was built against an older Cursor. Four of its load-bearing assumptions
no longer hold:

| Old assumption | Reality |
|---|---|
| "Cursor has no skills — route it to SKILL.md files by hand" | `.cursor/skills/<name>/SKILL.md` is native, and uses **the same `name` + `description` frontmatter** Hektor already had. Migration was near-1:1. |
| "Cursor has no subagents — run the phases sequentially" | `.cursor/agents/*.md` with parallel Task dispatch and isolated worktrees. The fan-out in the orchestrator, coverage-expansion, test-composer, from-jira and multi-ticket **ports**. |
| "Cursor has no reliable pre-edit block — pr-rules must be advisory" | `preToolUse` takes a matcher and returns `permission: deny`. PR-reviewer BLOCKERs are now a **hard block**, an upgrade over the shim. |
| "Cursor has no Stop analogue — the delivery gate can't run" | `stop` exists and returns `followup_message`. It runs. |

Seven gates that previously failed open on Cursor — the whole reviewer /
dispatch / schema cluster — are live, re-homed onto `subagentStart` and
`subagentStop`.

## Capability map

| Layer | How it works now |
|---|---|
| Skills | `.cursor/skills/<name>/SKILL.md`. Auto-invoked by `description`; explicit as `/<name>`; `paths:` glob-scopes the two Java kernels; `disable-model-invocation: true` on the four on-demand-only skills. |
| Subagents | `.cursor/agents/hektor-*.md`. Roles are named on the first line of the dispatch (`role: composer-j-x`) because `subagentStart` carries `task` but no `description`. |
| Router | `.cursor/rules/hektor-kernel.mdc`, `alwaysApply: true`, ~80 lines. Deliberately thin — it routes and states the testbox contract; every method lives in a skill. |
| Gates | `.cursor/hooks/*.sh` + `.cursor/hooks.json`. One shared I/O lib (`lib/cursor.sh`); the gates' rule logic is unchanged from the originals. |
| Kernel injection | `sessionStart` → `additional_context`. |

## The one real degradation

**Approval attribution.** The `run-status-write-gate` enforces that the
orchestrator cannot write its own `reviewerVerdict: "approved"`. On Claude Code
it proved this by matching the write's `parent_tool_use_id` against a registry of
dispatched reviewer subagents — i.e. it could tell that the approval was written
*from inside* the reviewer.

Cursor exposes no parent-call link on an ordinary tool call. So the check degrades
to a **lease**: `reviewer-approver-registry` opens a 30-minute window on
`subagentStart` when an approver role starts, and an approval may only land while
a window is open.

- **Kept:** an approval cannot land unless a reviewer subagent actually ran, recently.
- **Lost:** proof that the write came from *within* that subagent rather than from
  the orchestrator while one happened to be open.

This is the only place the pack knowingly enforces less than it used to. It is
documented here rather than quietly widened, because a gate that looks like an
identity check but is a time window is worse than one that says what it is.

## Deliberately not used

- **`beforeSubmitPrompt`** for kernel injection. Its output schema is
  `{continue, user_message}` — it can veto a prompt, not add context to it.
  `sessionStart` is the injection point.
- **`afterFileEdit`** for the PR-rule advisory half. It carries no documented
  output channel; `postToolUse` carries `additional_context`, so that is where the
  WARNING half lives.
- **`tool_name` matching** in the file gates. Cursor's edit-tool field naming has
  moved across versions (`file_path` / `path` / `target_file`, `content` /
  `new_string` / `code_edit`). The gates key on the *shape* of `tool_input`
  instead, so an upstream rename degrades them to fail-open rather than to
  allow-everything.

## Debugging the payload shape

Cursor's exact hook JSON varies by version. If a gate mis-fires, set
`HEKTOR_HOOK_DEBUG=1` — `lib/cursor.sh` tees every raw payload to
`docs/hektor/.cursor-hook-payload.log`, so you can tune an accessor against real
input rather than against the docs.

## Install

```bash
./install.sh --project /path/to/repo      # or: hektor package install
./install.sh --project ... --no-kits      # skip the bundled kits' installers
```

Re-runnable and idempotent: a re-run replaces Hektor's own registrations in place
and leaves any hook you added yourself untouched. Reload the Cursor window
afterwards so the skills and hooks load.
