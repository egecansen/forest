# Hektor across harnesses (Claude Code · Cursor · other LLMs)

Hektor is **harness-agnostic by construction**. The durable behavior lives ONCE:

- **Skills** — `skills/hektor-*/SKILL.md` (plain markdown; any tool can read them).
- **Gates** — `hooks/*.sh` (bash; one script per rule, read the tool-call JSON on
  stdin, print a deny/warn verdict).
- **Schemas** — `schemas/subagent-returns/*.schema.json`.

Per-harness dirs only adapt *loading*, *event shape*, and *command names*. The
rule of thumb (borrowed from ECC's `cross-harness.md`): **if a change needs
editing three harness copies of the same workflow, the shared source is in the
wrong place.** Nothing in Hektor's gate *logic* is duplicated per harness — only
the I/O boundary is translated.

## Capability matrix

| Layer | Claude Code | Cursor | Any other AGENTS.md-reading LLM (Codex, Gemini, Windsurf, plain CLI) |
|---|---|---|---|
| **Skills / reasoning** | native (`.claude/skills/*/SKILL.md`) | `.cursor/rules/hektor.mdc` routes to the same SKILL.md files | point its instructions file at `.claude/skills/hektor-conventions/SKILL.md` (installer drops an `AGENTS.md` pointer) |
| **`pr-rules-gate`** (PR-reviewer mirror) | ✅ PreToolUse Write\|Edit — **hard block** on BLOCKER | ⚠️ `afterFileEdit` — **advisory** (Cursor has no reliable pre-edit block) | none (read the skill; run the gate by hand) |
| **`commit-gate`** (no agent commit/push) | ✅ PreToolUse Bash — hard block | ✅ `beforeShellExecution` — hard block | none |
| **Reviewer / dispatch / schema gates** (Agent-matcher) | ✅ | ✖ fail-open (Cursor has no `Agent` tool / `parent_tool_use_id`) | ✖ |
| **Run the gate by hand** | `echo '<json>' \| .claude/hooks/pr-rules-gate.sh` | same | same — it's just `bash`+`jq` |

Read the matrix as a **gradient, not a cliff**: skills work everywhere; the
strongest *enforcement* is on Claude Code, strong-but-advisory on Cursor for
file edits, and a hard block on Cursor for shell commands.

## How Cursor support works (the ECC adapter shim)

Cursor emits its own hook events (`beforeShellExecution`, `afterFileEdit`, …)
with a different stdin/output JSON shape than Claude Code. Rather than fork the
gates, `.cursor/hooks/adapter.sh` (a bash port of ECC's
`.cursor/hooks/adapter.js`, `github.com/affaan-m/ECC`):

1. reads Cursor's stdin,
2. **transforms** it into the Claude tool-call JSON the gate expects
   (`lib/cursor-compat.sh` → `cc_claude_payload`),
3. runs the **unmodified** `.claude/hooks/<gate>.sh`,
4. **translates** the gate's Claude verdict back into Cursor's shape —
   `permissionDecision:deny` → Cursor `permission:deny` on a *before* event, or
   `additional_context` (advisory) on an *after* event; `systemMessage` →
   `additional_context`.

Registered in `.cursor/hooks.json`:

| Cursor event | Gate | Effect |
|---|---|---|
| `beforeShellExecution` | `commit-gate.sh` | hard block on `git commit`/`push` |
| `afterFileEdit` | `pr-rules-gate.sh` | advisory PR-rule findings on the saved file |

**Why `afterFileEdit` and not a pre-edit block?** Cursor has no reliable
pre-edit hook that can veto a write. So on Cursor the PR-rules gate reports
findings *after* the file is saved — a nudge to fix before you open the PR, not
a wall. The same rule is a hard block on Claude Code and on the server-side
reviewer, so nothing slips through to `master`; Cursor just catches it one step
later.

### Compliance states (per ECC's vocabulary)

- **Native:** skills/rules (both harnesses read markdown), `commit-gate` on both.
- **Adapter-backed:** `pr-rules-gate` on Cursor (runs the real gate via the shim;
  advisory only).
- **Reference-only:** the Agent-matcher gates on Cursor (fail-open — no analogue).

## Install

```bash
./install.sh --project /path/to/repo          # all: Claude + Cursor + AGENTS.md
./install.sh --harness claude --project ...    # Claude only
./install.sh --harness cursor --project ...    # Cursor only (still lays .claude/ as the shared source)
./install.sh --harness agents --project ...    # just the AGENTS.md pointer
```

Re-runnable and idempotent. Restart Claude Code / Cursor afterwards so the hooks
load. Kill switches: each gate has its own (`HEKTOR_PR_RULES_GATE=off`,
`HEKTOR_COMMIT_GATE=off`, …); `HEKTOR_CURSOR_HOOKS=off` disables all Cursor
adaptation; `HEKTOR_DISABLED_HOOKS=commit-gate.sh,…` disables named gates on
Cursor.

## Debugging the Cursor payload shape

Cursor's exact hook JSON varies by version. If a gate mis-fires on Cursor, set
`HEKTOR_HOOK_DEBUG=1` — the shim tees each raw payload to
`docs/hektor/.cursor-hook-payload.log` so you can tune the accessor keys in
`lib/cursor-compat.sh` against a real payload.

## What is NOT ported (Claude-specific)

- **Per-subagent model routing** (Haiku/Sonnet for grunt work) uses Claude
  Code's `Agent` model override — other harnesses have their own selection.
- **Agent-matcher enforcement** (reviewer-attestation, dispatch-ordering,
  schema gates) relies on Claude's `Agent` tool + harness-issued
  `parent_tool_use_id`, which Cursor doesn't expose — those fail open there.
- We deliberately skip ECC's manifest/module/schema installer layer, its Rust
  control plane, and the observer daemon — scale features for 11 harnesses /
  277 skills, overkill for this single-maintainer pack.
