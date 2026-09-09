# Hektor → Cursor migration (design)

Date: 2026-08-24
Status: approved, implementing

## Problem

Hektor ships as a Claude Code pack. Cursor "support" today is a **pointer, not a
port**: one `.cursor/rules/hektor.mdc` that tells the agent to go read
`.claude/skills/hektor-*/SKILL.md`, plus `adapters/cursor/adapter.sh` — a shim
that reshapes Cursor's hook JSON into Claude tool-call JSON so the unmodified
Claude gates run. Consequences:

- `.claude/` must exist even for a Cursor-only user; the pack is Claude-shaped.
- `pr-rules-gate` is **advisory** on Cursor (no pre-edit veto was thought to exist).
- 7 gates fail open (they need Claude's `Agent` matcher + `parent_tool_use_id`).
- `delivery-gate` is unwired (no `Stop` analogue was thought to exist).
- 4 `Write|Edit` gates are unwired.
- Skills carry Claude-only vocabulary (`Agent` tool, `claude --model haiku
  --print`, `SendMessage`, `~/.claude/projects/*/memory/`).

## What changed upstream

Cursor's current feature set invalidates the assumptions the adapter was built on:

| Capability | Cursor today |
|---|---|
| Skills | `.cursor/skills/<name>/SKILL.md` — **same frontmatter as Hektor already uses** (`name`, `description`), plus `paths`, `disable-model-invocation`, `icon`, `color`, `metadata`; bundles `scripts/`, `references/`, `assets/` |
| Invocation | auto by `description`, explicit via `/<skill-name>`, persistent via Custom Mode |
| Subagents | `.cursor/agents/*.md` (`name`, `description`, `model`, `readonly`, `is_background`); parallel Task dispatch; isolated worktrees |
| Hooks | `sessionStart`, `preToolUse`/`postToolUse` (matcher + `deny`), `beforeShellExecution`, `afterFileEdit`, `subagentStart`/`subagentStop`, `stop`, `beforeSubmitPrompt`, … |

So: skills migrate ~1:1, subagent fan-out survives, and every gate has a real
home. The adapter's whole reason to exist is gone.

## Decisions

1. **Cursor-only clean break.** `.claude/` is not produced. No AGENTS.md.
2. **`.cursor/skills/` is the primitive** — not `.mdc` rules + `.cursor/commands/`.
   One file per skill gives auto-invoke *and* `/hektor-<name>`. A single
   `alwaysApply` rule remains as a thin router.
3. **All gates port natively.** Gates read Cursor's JSON directly through one
   shared `hooks/lib/cursor.sh`. `adapter.sh` and `cursor-compat.sh` are deleted.
4. **Scope includes** tr-lan-correction, the flaky-triage kit's wiring, the
   installer, the CLI, and the docs.

## Target layout

```
.cursor/
├── skills/hektor-<name>/SKILL.md      # 22 hektor + hektor-flaky-triage + turkce-imla-anlatim
│     └── scripts/ · references/
├── agents/hektor-{composer,diagnoser,prober,mapper,reviewer}.md
├── rules/hektor-kernel.mdc            # alwaysApply: true, router only
├── hooks.json
├── hooks/
│   ├── lib/{cursor.sh,audit.sh,hook_profile.sh}
│   └── <gate>.sh
└── schemas/subagent-returns/*.json
```

Source tree in `hektor/` mirrors it: `skills/ agents/ rules/ hooks/ hooks.json
schemas/`. Deleted: `adapters/`, `settings.hooks.json`.

## Gate wiring

| Cursor event | Gates | Effect |
|---|---|---|
| `sessionStart` | `kernel-inject` | `additional_context` |
| `beforeShellExecution` | `commit-gate`, `destructive-command-gate` | hard block |
| `preToolUse` | `pr-rules`, `invisible-unicode`, `journey-map-sentinel`, `run-status-write`, `enforcement-self-protection` | hard block (upgraded from advisory) |
| `subagentStart` | `subagent-brief`, `dispatch-ordering`, `schema-preread`, `first-pass-guard` | deny |
| `subagentStop` | `subagent-return-schema`, `reviewer-attestation` | `followup_message` |
| `postToolUse` | `observe` | silent capture |
| `stop` | `delivery-gate` | `followup_message` |

`beforeSubmitPrompt` is **not** used for kernel injection — its output schema is
only `{continue, user_message}`; it cannot add context. `sessionStart`
(`additional_context`) is the injection point.

### I/O contract

`hooks/lib/cursor.sh` provides the accessors and emitters; each gate keeps its
existing detection logic verbatim.

- Input differs by event: `beforeShellExecution` carries `.command` at top
  level; `preToolUse`/`postToolUse` carry `.tool_name` + `.tool_input.*`;
  `afterFileEdit` carries `.file_path` + `.edits[]`.
- **Tool names are not matched on.** Cursor's edit-tool naming is not stable
  across versions, so file gates key on the *shape* of `tool_input` (any of
  `file_path` / `path` / `target_file`, plus `content` / `new_string` /
  `code_edit`). Unrecognised shape → fail open.
- Emitters: `hektor_deny` → `{permission:"deny", agent_message, user_message}`;
  `hektor_context` → `{additional_context}`; `hektor_followup` →
  `{followup_message}`.
- Exit 2 also blocks (Cursor honours it); non-zero other than 2 fails open.
- Kill switches (`HEKTOR_<GATE>=off`, `HEKTOR_HOOK_PROFILE`,
  `HEKTOR_DISABLED_HOOKS`) are unchanged. `HEKTOR_CURSOR_HOOKS=off` disables all.

## Skill cleanup

Mechanical across all: `.claude/` → `.cursor/`, "Claude Code" → "Cursor",
`Agent` tool → Task/subagent vocabulary, `settings.json` → `hooks.json`.

Three need real rework:

- **`hektor-distill`** — replaces `claude --model haiku --print` with a
  `readonly: true` background subagent. No CLI shell-out.
- **`hektor-multi-ticket`** — `SendMessage` has no Cursor equivalent (re-dispatch
  instead); `~/.claude/projects/*/memory/` does not exist, so the auto-memory
  contract section is removed.
- **`hektor-qagent`** — "restart Claude Code" → reload Cursor; keeps its MCP
  namespace hedge.

Frontmatter additions: `paths: web-ui-test/**/*.java` on `hektor-conventions`;
`paths` on `hektor-resource-client` for `*ResourceClient.java` / `AbName.java`.

## Out of scope

The flaky-triage kit's ~40 `core/*.sh` scripts are harness-agnostic bash. Its
**wiring** (skill, gates, installer) is ported; its internals are untouched.

## Success criteria

- `./hektor package install` produces a working `.cursor/` tree and no `.claude/`.
- `hektor doctor` passes: every skill has valid frontmatter, every registered
  hook exists and is executable, every schema parses, no dead cross-references.
- Each gate returns correct Cursor JSON for a synthetic payload of its event.
- No file in the shipped pack references `.claude/`, `adapter.sh`, or Claude-only
  tooling.
