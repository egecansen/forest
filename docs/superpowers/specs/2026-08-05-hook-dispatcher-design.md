# Hook dispatcher — design spec

**Date:** 2026-08-05
**Repos affected:** `APPS/forest` now; `SKLS/hektor` and `web-test` in later
phases (not ours to change unilaterally — see Rollout).
**Status:** Forest phase IMPLEMENTED (2026-08-05, suite 299/299) per
`docs/superpowers/plans/2026-08-05-hook-dispatcher.md`. Phases 2–3
(`SKLS/hektor`, `web-test`) not started.

## Problem

Every hook incident this month is one disease with three presentations:
`settings*.json` pins a concrete script path, the scripts move or vanish, and
the two drift — with a live session holding a third copy (its startup
snapshot).

1. **Relocation drift.** The flaky-triage gate moved from
   `.claude/skills/hektor-flaky-triage/hooks/` to `.claude/hooks/`. The
   installer's cleanup rewrites `settings.json` only, so the stale registration
   survived in `web-test/.claude/settings.local.json` and spammed exit-127
   errors on every tool call (observed 2026-08-05; file deleted by hand).
2. **Snapshot drift.** Claude Code reads hook config at session start and never
   again. The `tech-WEBT-250873` worktree was repaired on disk at 13:47; the
   session already running in it kept exec'ing paths deleted minutes earlier
   ("I cannot even use it"). The 2026-08-01 stale-hook-registration spec
   accepted this as residual risk ("window 1") because no disk change can reach
   a live session — true only while registrations name per-script paths.
3. **Copy drift.** Provisioning that copies registrations and scripts as two
   separate steps can be interrupted or partially superseded, leaving
   registered-but-missing hooks the launch guard has to catch after the fact.

## Decision

Registrations stop naming scripts. Each (event, matcher) pair registers **one
permanent command** — a dispatcher — and the scripts live in a directory the
dispatcher enumerates at call time (the run-parts pattern):

```json
{ "matcher": "Bash",
  "hooks": [{ "type": "command",
              "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh\" PreToolUse-Bash" }] }
```

`dispatch.sh <slug>` runs every entry in `.claude/hooks/<slug>.d/`, in name
order, feeding each the stdin payload; the first non-zero exit wins, exactly
like Claude Code's own first-blocking-verdict rule.

What this buys, mapped to the three presentations:

- **Relocation drift becomes impossible.** Renaming, moving, adding, or
  removing a gate is a file operation in the `.d` directory; no settings file
  is touched, so there is nothing to go stale and no jq surgery with a blind
  spot for `settings.local.json`.
- **Snapshot drift heals itself.** The session snapshot pins the command
  *string*. When the string is a never-moving dispatcher, a repair or
  re-provision reaches an already-running session on its very next tool call.
  The forwarder shim the 2026-08-01 spec designed and dropped (Part 1) becomes
  unnecessary by construction.
- **Copy drift shrinks to one step.** Provisioning copies scripts and writes
  `.d` symlinks; the settings line is written once and never changes, so there
  is no window where registrations and scripts disagree.

## Mechanism

### Directory scheme

- Slug = `<event>` for a matcher-less event, else `<event>-<matcher>` with
  every non-alphanumeric run in the matcher collapsed to `_`:
  `PreToolUse` + `Write|Edit` → `PreToolUse-Write_Edit`, `Stop` → `Stop`.
- Scripts stay where they are today (`.claude/hooks/<name>.sh`, libs under
  `.claude/hooks/lib/`). The `.d` directory holds **relative symlinks**
  (`10-commit-gate.sh -> ../commit-gate.sh`), prefixed `10-`, `20-`, … in the
  order the settings fragment declared, so gate ordering survives.

### Why symlinks, not copies or forwarder scripts

- **Not copies:** `commit-gate.sh` locates its lib via
  `dirname "${BASH_SOURCE[0]}"` (line 35). A copy in the `.d` directory would
  resolve `lib/` inside `.d/` and break. Forest does not own these scripts and
  must not need them rewritten.
- **Not one-line `exec` forwarders:** they work, but the registration list
  stops being machine-readable — the scope resolver would parse shell text to
  learn what is wired. A symlink is data: `readlink` names the target,
  `stat` says whether it resolves, deletion is deregistration. `ls -l` of the
  `.d` directory *is* the audit view.
- **The cost:** the dispatcher must `realpath` each entry before exec so
  `$0`/`BASH_SOURCE` is the real script and `dirname`-relative libs still
  resolve. `realpath` ships on macOS 13+ and everywhere Linux; where it is
  somehow absent the dispatcher execs the symlink directly, which still works
  for every script that locates libs via `$CLAUDE_PROJECT_DIR` (the kit's
  gates do).

### The dispatcher

~20 lines of POSIX sh, owned and written by forest at provision time,
byte-identical everywhere so `copyTree`'s sha-conflict rule never fires on it:

```sh
#!/bin/sh
# dispatch.sh <slug> — run every entry in .claude/hooks/<slug>.d/, name order.
# Registered once per (event, matcher); the .d directory is the registration
# list. Missing directory = nothing wired here (an unprovisioned tree), which
# is a fact, not an error.
d="${CLAUDE_PROJECT_DIR:-$(pwd)}/.claude/hooks/${1:?usage: dispatch.sh <slug>}.d"
[ -d "$d" ] || exit 0
payload="$(cat)"
for h in "$d"/*; do
  [ -e "$h" ] || continue                 # empty glob
  t="$(realpath "$h" 2>/dev/null || printf '%s' "$h")"
  if [ ! -x "$t" ]; then
    echo "dispatch: $h -> $t is not executable — this gate is wired but not running" >&2
    continue
  fi
  printf '%s' "$payload" | "$t" || exit $?
done
exit 0
```

Two deliberate choices inside it:

- **A broken symlink warns and continues rather than failing the tool call.**
  Same fail-open-never-silently rule the kit's gates follow: the stderr line
  makes the gap observable, the launch guard (below) makes it actionable, and
  a policing layer must never be the reason no work can happen.
- **First non-zero exit propagates immediately** — blocking verdicts keep
  their semantics and their relative order.

### Scope resolver and launch guard

`resolveSessionScope` currently answers "does each registered command's file
exist". A dispatcher registration would trivially answer yes and hide the real
question, so the resolver learns one expansion: when a registration's resolved
file is `dispatch.sh`, enumerate its slug's `.d` directory and report each
entry as its own active/missing record (a symlink whose target does not
resolve is `missing`, source = the symlink path). The launch guard, repair
flow, and the `gates N · missing M` badge then keep working unchanged, at
entry granularity.

### Reconciliation (the interim rule made code)

`registerDispatch` — the successor to `mergeHooks` — writes the dispatcher
line and, in the same pass, **removes any per-script registration in the
worktree's `settings.local.json` whose command basename matches a script it
just linked**. That is the migration path for worktrees provisioned under the
old scheme: one re-provision (or the repair button) converts them. Forest only
ever edits the worktree `settings.local.json` it owns; checked-in
`settings.json` and other repos' files are never touched.

## Rollout

Forest cannot convert what it does not wire. Three phases, ours first:

1. **`APPS/forest` (this spec's implementation):** everything forest itself
   wires goes through the dispatcher — a pack's gate set (`hooks: true`) and
   convention kits without `install.sh`. Planned in
   `plans/2026-08-05-hook-dispatcher.md`.
2. **`SKLS/hektor` kit installer:** `install.sh` writes its two gates into
   `.d` directories and registers the dispatcher instead of per-script paths;
   the kit's self-protection surface extends to `dispatch.sh` and the `.d`
   directories — deleting a symlink is now deregistering a gate, so the wall
   moves to cover it. Separate change, that repo's owners' call; this spec is
   the reference.

   **Landed early (2026-08-05), separable from the rest:** the installer's
   stale-registration strip now runs on `settings.local.json` too
   (`install.sh`, the `for SF in` loop in the Claude block; asserted in
   `core/tests/install-guard-test.sh` §"the same strip must reach
   settings.local.json"). Strip-only: the kit never registers into, nor
   creates, the local file. That closes presentation 1 without touching the
   registration scheme.

   **Why the rest stays a handoff — the registration shape is load-bearing
   across the kit's enforcement core.** Consumers found 2026-08-05, each of
   which must learn "registered" means a dispatcher line plus a resolvable
   `.d` symlink before the scheme can change, or every entrypoint refuses
   with rc 76 at the hardened/stale tiers:
   - `install.sh` — the jq registration merges (PreToolUse ×2, Stop);
   - `core/_wiring_repair.sh` — `_wr_register` / `_wr_register_stop` replay
     the same merges and their comments promise install and repair "cannot
     disagree";
   - `core/_integrity.sh`, `core/lock-kit.sh` (the wiring axis),
     `core/shell-guard.py` — read the registration state;
   - `core/tests/install-guard-test.sh`, `self-protection-test.sh`,
     `integrity-test.sh`, `lock-tier-test.sh` — assert the exact shape.

   One unrelated hardening for the same owners, found 2026-08-05: the
   build-refusal fixture (`install-guard-test.sh:1057`) copies the kit source
   with `cp -R`, so a `.tgz` already sitting in the working tree — a normal
   leftover of running `hektor-triage-kit build` — is copied in and trips
   "a refused pack must leave no artifact behind" (line 1062) even though the
   refused build wrote nothing. Verified both ways: 246/1 with a stray
   tarball present, 247/0 with it set aside. Fix: exclude pre-existing
   `*.tgz` when building the fixture (or copy via `git archive`).
3. **`web-test` hand-maintained hooks:** mechanical move of the 16 gate
   registrations into `.d` symlinks, one dispatcher line per matcher block.
   Tooled (2026-08-05): `bin/migrate-hooks-to-dispatcher.mjs` — dry-run by
   default, `--apply` backs up each settings file to `<name>.pre-dispatcher`
   first, and registrations matching `flaky-kit-` are left verbatim (the
   phase-2 boundary: the kit's wiring axis reads those exact lines). It is an
   operator tool by design — the kit's self-protection gate blocks agents
   from settings files, and from a plain terminal no gate runs. Sequencing:
   remove the stale `settings.local.json` (or re-run the fixed kit installer)
   BEFORE `--apply`, because the stale old-path lines match the keep-pattern
   and the migrator will not touch them.

Until 2 and 3 land, the narrow rule that prevents recurrence stands: whatever
writes a registration owns cleaning it from every settings source, keyed on
script basename, not full path.

## Out of scope

- Changing Claude Code's snapshot behaviour, or any hook semantics.
- Rewriting any gate script. The design's constraints exist precisely so
  scripts run unmodified from their current location.
- Editing `web-test` or `SKLS/hektor` from forest. Phases 2–3 are documented
  handoffs, not forest commits.
- The kit's `install.sh`-owned wiring path in `provisionKit` — untouched until
  phase 2; the installer remains the authority on its own layout.

## Testing

Forest phase, `node:test` house style:

- `matcherSlug` is total and collision-free for the matchers in use
  (`Bash`, `Write|Edit`, `Agent`, `Edit|Write|Bash`, matcher-less `Stop`).
- `registerDispatch` on a fresh tree: dispatcher written executable, `.d`
  symlinks in fragment order, exactly one settings line per (event, matcher);
  idempotent on re-run (no duplicate lines, no re-prefixed links).
- `registerDispatch` over an old-style tree: legacy per-script lines for the
  same basenames are gone, unrelated lines survive.
- Dispatcher behaviour (run as a subprocess against a fixture tree): runs
  entries in order, propagates the first non-zero exit and its stderr, skips a
  broken symlink with the warning line, exits 0 on a missing `.d` directory.
- `resolveSessionScope`: dispatcher registration expands to its entries;
  broken symlink reports `missing`; empty `.d` reports nothing.
- End-to-end: `provisionPack` with `hooks: true` on a scratch dir produces a
  tree where the resolver reports every gate active and zero missing.
