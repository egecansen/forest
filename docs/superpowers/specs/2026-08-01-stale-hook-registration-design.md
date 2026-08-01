# Stale hook registrations — design spec

**Date:** 2026-08-01
**Repos affected:** `APPS/forest` (the launcher). `SKLS/hektor` was in scope and
was dropped — see Part 1.
**Status:** Part 2 approved by Egecan, pending implementation. Part 1 dropped.

## Problem

A session in `.forest/wt/web-test/tech-WEBT-254904` emitted this on every Bash
tool call:

    PreToolUse:Bash hook error
    Failed with non-blocking status code: /bin/sh:
      .../.claude/skills/hektor-flaky-triage/hooks/flaky-kit-self-protection-gate.sh:
      No such file or directory

Exit code 127 — the shell could not find the file. The gate was registered but
absent, so **the gate was not running**: a hook whose job is to protect the kit
from being silently weakened had itself silently stopped enforcing.

### What actually happened (verified 2026-08-01)

Neither tool is broken. This is version skew across a relocation.

The kit used to install its gate *inside* the kit tree at
`.claude/skills/hektor-flaky-triage/hooks/`. It now installs to
`.claude/hooks/` (`install.sh:153`) and registers that path (`:163`). The
installer already handles the upgrade properly: it deletes the stale in-tree
directory (`:92`) **and** strips the stale registration from `settings.json`
with a jq filter keyed on `OLD_GATE_CMD` (`:168-175`). Its own comment names
this exact failure — *"the registration would also start failing to execute."*

So the disk state converges as soon as the current installer runs. Forest's
provision record for that worktree is stamped 17:30, and forest runs the kit's
own installer during provisioning (`lib/packs.mjs:166`, commit da63d72) — that
run is what repaired it. Evidence after the fact: `settings.json` registers only
`.claude/hooks/...`, that file exists and is executable, no settings source
anywhere names the old path, and forest's own scope resolver reports 47 active
hooks and 0 missing.

### The two windows that remain

1. **A session already running when the migration happens.** Claude Code loads
   hook configuration at session start. The installer's cleanup fixes disk but
   cannot reach a live session, which keeps exec'ing the path just deleted.
   Observed directly: 16 errors in session `bae8aeaa` before the repair and 4 in
   `cf96228d` after it.
2. **A worktree whose kit tree was updated without the installer running.** The
   new kit tree ships no `hooks/` directory, so copying it over an old install
   removes the script while the old registration survives in `settings.json` —
   `registered but missing`, with the gate silently off until something
   re-wires it.

## Decisions

Settled during brainstorming (2026-08-01):

- **Fix both layers.** The kit closes window 1; forest closes window 2. Neither
  alone is sufficient — nothing forest does can change a running session's hook
  config, and nothing the kit does can stop a launch into an unwired worktree.
  *(Revised 2026-08-01: window 1 is accepted rather than fixed. See Part 1.)*
- **Forest never mutates a worktree without a yes.** The launch guard offers to
  repair; it does not repair silently.
- **The shim is a grace period, not a replacement.** The installer keeps
  stripping the stale registration exactly as it does today.

## Part 1 — Kit: forwarder instead of deletion — **DROPPED (2026-08-01)**

> **Not implemented.** Decided after the design was approved, once the plan
> exposed a conflict the design had assumed away.
>
> `core/tests/install-guard-test.sh:68` asserts that `$SKILL_DIR/hooks` must not
> exist after an upgrade — *"it predates the shadow check and travels with the
> tree on a rename."* The forwarder re-creates that directory, so shipping it
> means relaxing a deliberate safety invariant in a repo we do not own, and
> rewriting the test that guards it. `SKLS/hektor` also has uncommitted work on
> `main`, so the change would land on top of someone else's in-flight edits.
>
> The value had also largely expired. The relocation is a one-time event: the
> kit source has already migrated, `tech-WEBT-254904` is repaired, and forest
> runs the installer on every provision (`lib/packs.mjs:166`). The forwarder
> only protects a session that is live *during* a migration — a window that has
> already closed for this one. It would pay off at the next relocation, if there
> is another.
>
> **Residual risk accepted:** a session running during a future relocation will
> still emit exit-127 hook errors until it restarts. Restarting the session
> clears it, and Part 2 stops a *new* session from starting into that state.
>
> The design below is kept as the record of what was considered and why it was
> not built. Reopen it if another relocation is planned.

**Repo:** `SKLS/hektor`, `kits/flaky-triage-kit/install.sh:92-99`

Today the upgrade path removes the whole directory:

```sh
if [ -e "$SKILL_DIR/hooks" ]; then
  if rm -rf "$SKILL_DIR/hooks" 2>/dev/null; then ...
```

Keep the removal — every stale file must still go — then write a forwarder back
in its place, and make it executable:

```sh
if [ -e "$SKILL_DIR/hooks" ]; then
  if rm -rf "$SKILL_DIR/hooks" 2>/dev/null; then
    echo "install: removed the stale in-tree gate directory $KIT/hooks/ (the gate now lives at .claude/hooks/)"
  else
    echo "install: WARN could not remove the stale in-tree gate at $SKILL_DIR/hooks — remove it by hand, or this project keeps a second, outdated gate that a rename of the kit tree would carry along" >&2
  fi
  # Leave ONLY a forwarder behind, so a session that started before the
  # relocation keeps working until it restarts.
  mkdir -p "$SKILL_DIR/hooks"
  cat > "$SKILL_DIR/hooks/flaky-kit-self-protection-gate.sh" <<'SHIM'
#!/bin/sh
# Forwarder left by install.sh when the gate relocated to .claude/hooks/.
# A session that started before the relocation still holds the OLD path in its
# hook config and cannot be told otherwise; without this it fails with exit 127
# on every tool call and the gate stops enforcing. Sessions started after the
# relocation never touch this file. Safe to delete once no old session is live.
_p="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../../../.." && pwd)}"
_g="$_p/.claude/hooks/flaky-kit-self-protection-gate.sh"
if [ ! -x "$_g" ]; then
  echo "flaky-kit gate forwarder: $_g is missing — the kit is not installed here; not gating" >&2
  exit 0
fi
exec "$_g" "$@"
SHIM
  chmod +x "$SKILL_DIR/hooks/flaky-kit-self-protection-gate.sh" 2>/dev/null || true
fi
```

Three details that are load-bearing:

- **`chmod +x`.** Without it the forwarder fails with exit 126 instead of 127 —
  the same broken session, a different number.
- **The `$CLAUDE_PROJECT_DIR` fallback.** The forwarder sits four levels below
  the project root (`.claude/skills/hektor-flaky-triage/hooks/`), so
  `dirname $0/../../../..` resolves the root when the variable is unset.
- **Missing target → exit 0, with a message.** This is a deliberate
  fail-open, and the only one in the design. It is scoped to the case where the
  *real* gate does not exist at all, which means the kit is not installed in
  that project — and a compatibility bridge for an uninstalled kit should not
  block every tool call in the session. When the kit *is* installed the
  forwarder execs the real gate, which keeps its own fail-closed behaviour
  intact.

The jq filter still strips the stale registration exactly as today, so this
forwarder is dead weight for every session started after the upgrade.

### Why this does not re-create the problem the deletion solved

The removal exists because a stale in-tree gate meant **two gates**, the second
outdated, "and that still travels with the tree when the tree is renamed aside"
(`install.sh:87-91`). A forwarder carries no policy logic, so it cannot go
stale or diverge — it always executes whatever the current gate is. It is also
already inside the kit's self-protection surface: `SURF_RE` matches
`\.claude/skills/hektor-flaky-triage(/|$|...)`, the whole tree.

## Part 2 — Forest: launch guard

**Repo:** `APPS/forest`

### Server — `lib/actions.mjs:281-304`

`/api/launch` currently resolves scope *after* `launchInteractive` (line 297)
and reports the count, which is too late to act on. Resolve it **before**
launching, and when scripts are missing, return without launching:

```json
{ "blocked": "missing-hooks",
  "missing": [{ "command": "...", "source": "..." }],
  "repairable": true }
```

`repairable` is `readProvisionRecord(path) !== null` — repair re-runs the kit's
installer from the recorded selections and returns 409 `no provision record`
without one (`lib/actions.mjs:181-184`).

A new `force: true` in the body skips the check and launches, which is what
"Launch anyway" sends. The post-launch scope journal line stays.

### Client — `public/app.js`, launch flow at `:310` / `:571`

On a `blocked` response, show:

    Launch Claude in tech-WEBT-254904?

      2 registered hook scripts are missing:
        flaky-kit-self-protection-gate.sh

      Repairing re-runs the kit's installer.

      [ Launch anyway ]   [ Repair, then launch ]

- **Repair, then launch** → `POST /api/worktree/repair`, then re-launch with
  `force: true`, and toast the resulting active/missing counts.
- **Launch anyway** → re-launch with `force: true`.
- **`repairable: false`** → the dialog says repair is unavailable because the
  worktree has no provision record, and offers the picker instead — the same
  fallback `app.js:316` already uses for that 409.

The existing `gates N · missing M` badge (`app.js:51`) and 🩹 row button
(`app.js:88`) are unchanged; this adds the gate at the one moment it matters.

## Testing

**Kit** (`SKLS/hektor`) — its own test harness
(`core/tests/self-protection-test.sh` is the existing suite):

- after an upgrade install over an old-layout project, the old gate path exists,
  is executable, and running it yields the same verdict as the relocated gate
- the stale registration is still stripped from `settings.json`
- every *other* file that was under the old `hooks/` directory is gone — the
  forwarder is the only survivor
- with the relocated gate absent, the forwarder exits 0 and prints the
  not-installed message rather than exiting 126/127

**Forest** (`APPS/forest`) — `lib/actions.test.mjs`, following the existing
source-assertion style for HTTP glue, and a real-worktree test for the decision
itself:

- a worktree with a registered-but-missing hook returns `blocked: "missing-hooks"`
  and does **not** call `launchInteractive`
- the same worktree with `force: true` launches
- a clean worktree launches with no prompt
- `repairable` is `false` when no provision record exists

The launch path shells out to Terminal, so `launchInteractive` is injected or
stubbed in the test rather than actually opening a window.

## Out of scope

- Making Claude Code re-read hook configuration mid-session. Not ours to change;
  the forwarder exists precisely because we cannot.
- Auto-repair without confirmation.
- Any change to the `gates N · missing M` badge or the 🩹 repair button.
- Back-filling provision records for hand-installed kits.
