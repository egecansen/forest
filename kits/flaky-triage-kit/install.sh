#!/bin/bash
# install.sh — install the Hektor flaky-triage kit into a project as native Cursor assets.
#
# Self-contained: copies the engine + skill + both gates, vendors the I/O libs, and idempotently
# registers the gates in .cursor/hooks.json. Re-runnable (won't duplicate anything).
#
# The engine itself is harness-agnostic bash — core/*.sh runs from any terminal with no agent at
# all. What this installer wires is the agent-facing half: the skill Cursor loads, and the gates
# that stop that agent editing the kit's own safety surface or ending a session unproven.
#
# Usage:
#   ./install.sh [--project <dir>] [--no-autoconfig]
#     --project        target project root (default: current directory)
#     --no-autoconfig  skip JDK-17 / source_roots detection
#
# After install: edit <proj>/.cursor/skills/hektor-flaky-triage/core/config.json — set `source_roots`
# (your test packages) and `run.workdir`; export HEKTOR_FK_JAVA_HOME=/path/to/jdk-17. Then read SKILL.md.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v jq >/dev/null || { echo "install: jq is required" >&2; exit 69; }

PROJ="$(pwd)"; AUTOCFG=1
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJ="${2:-$(pwd)}"; shift 2 ;;
    --no-autoconfig) AUTOCFG=0; shift ;;
    --harness) shift 2 ;;   # accepted and ignored: the pack is Cursor-only now
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "install: unknown arg: $1" >&2; exit 64 ;;
  esac
done
[ -d "$PROJ" ] || { echo "install: no such project dir: $PROJ" >&2; exit 66; }
PROJ="$(cd "$PROJ" && pwd)"

KIT=".cursor/skills/hektor-flaky-triage"
SKILL_DIR="$PROJ/$KIT"

# Set by the registration merges below and read by the closing block at the very bottom. Declared
# HERE, at top level, rather than inside the block that sets them: `set -u` is on, and the closing
# block runs whether or not that block was reached.
#
# The install RUNS TO COMPLETION either way and only the ending changes. A partial install that
# aborts in the middle is worse than one that finishes and reports: the engine, the skill, the
# self-protection gate(s) and the other harnesses' registrations are all independent of either merge,
# and leaving them half-written would turn one repairable failure into several.
stop_failed=0
stop_failed_file=""
cursor_failed=0
cursor_failed_file=""

# --- post-copy verification: nothing here may claim an artefact that is not on disk ---------------
#
# There is no `set -e` and no `cp || exit` anywhere below, and NONE of the six non-zero exits above
# observes a copy result — the first copy happens after all of them. So a copy that failed was
# invisible: a full disk, a permission error, a partial `cp`, or a $HERE that does not hold what this
# installer expects all produced a run that wrote core/.harness, merged three hook registrations,
# printed "Claude Code wired (…)" and "install: done", named `lock-kit.sh lock` as step 2, and exited
# 0 — over a project with NO engine, NO SKILL.md and hook commands pointing at paths that do not
# exist. Measured: `chmod 500` on $SKILL_DIR/core before the run reproduces it exactly, and invoking
# this script through a symlink (install.sh does not walk the chain, so every `cp` source is missing)
# reproduces the whole-tree version of it. A user is told they are wired and protected while nothing
# is installed, and enforcement is the only thing this kit is for.
#
# NOT `set -euo pipefail`. `-u` and `pipefail` are already on; `-e` is the wrong instrument here and
# would break paths that are deliberately permissive, each of which ends a statement on a command
# that is ALLOWED to be false: `[ -n "$_kv" ] && printf … > core/.version` (no jq/manifest is a
# recorded non-event, not a failure), `[ "$AUTOCFG" = 1 ] && autoconfig` (`--no-autoconfig` would
# abort the installer), the `[ -n "$r" ] && [ -d … ] && existing=…` body of autoconfig's while-loop
# (every root that does not exist here), and `{ [ -f "$AG" ] && printf '\n'; cat <<EOF …` in the
# AGENTS.md block (every project that has no AGENTS.md yet). And the load-bearing reason: `-e`
# observes ATTEMPTS — what returned zero — while the property that matters is what is ON DISK, so a
# partial `cp` that exits 0, or one whose failure an existing `|| true` swallows, still yields a
# broken install under `-e`. Checking outcomes is what closes that; see the block below for why rc
# observation is nevertheless carried alongside it rather than instead of it.
#
# RUN-TO-COMPLETION NOW HAS AN EXCEPTION, and it is deliberate. The note at the top of this file says
# the install runs to completion and only then reports; `verify_report` breaks that, exiting mid-flow,
# so a failed Claude gate copy skips the Cursor and AGENTS.md blocks entirely. That rule was written
# for REGISTRATION MERGE failures, where every other artefact is independent of the merge that broke
# and landing them is strictly better than not — which is why rc 74 still completes the run and the
# P4/P6 fixtures assert exactly that. A failed COPY is different in kind: the blocks below depend on
# what did not land, so continuing produces more false claims rather than more useful work. Two
# endings by severity: rc 73 stops where the damage is, rc 74 finishes and reports.
#
# Each check runs where its own artefact has just been written and BEFORE anything claims that
# artefact landed — the engine check precedes both harness blocks (either would otherwise print
# "… wired"), and each gate check precedes its own harness's registration merge and its own success
# line. The closing call re-runs every check over the finished tree as one statement.
verify_missing=""
verify_note() { verify_missing="${verify_missing}  - $1
"; }
verify_file() { # $1=path  $2=what it is
  [ -f "$1" ] || verify_note "MISSING: $1  ($2)"
}
verify_exec() { # $1=path  $2=what it is
  if [ ! -f "$1" ]; then verify_note "MISSING: $1  ($2)"
  elif [ ! -x "$1" ]; then verify_note "NOT EXECUTABLE: $1  ($2)"
  fi
}
verify_dir_nonempty() { # $1=path  $2=what it is
  if [ ! -d "$1" ]; then verify_note "MISSING: $1  ($2)"
  elif [ -z "$(ls -A "$1" 2>/dev/null)" ]; then verify_note "EMPTY: $1  ($2)"
  fi
}
# The rc half — see the block below. `cp`/`mkdir` wrappers rather than bare calls, so that a copy
# added later without a check is a visible inconsistency at the call site rather than an invisible one.
verify_cp() {    # $1=src  $2=dest  $3=what it is
  cp "$1" "$2" || verify_note "COPY FAILED: $2  ($3)"
}
verify_mkdir() { # $1=dir  $2=what it is
  mkdir -p "$1" || verify_note "MKDIR FAILED: $1  ($2)"
}
# The named files are not an arbitrary sample: they are exactly the ones the closing next-steps block
# tells the reader to go and open (1 -> core/config.json, 2 -> core/lock-kit.sh, 3 -> SKILL.md and
# core/README.md), plus the wiring record. "core/ is non-empty" alone is too weak to carry that and
# was measured to be: run through a symlink, every `cp` source is missing, yet `core/.harness` still
# gets written INTO core/ a few lines later — so the directory is non-empty with no engine in it.
verify_engine() {
  verify_dir_nonempty "$SKILL_DIR/core" "the engine directory"
  verify_file "$SKILL_DIR/SKILL.md" "the skill — next-step 3"
  verify_file "$SKILL_DIR/core/README.md" "the engine contracts — next-step 3"
  verify_file "$SKILL_DIR/core/config.json" "the engine config — next-step 1 tells you to verify it"
  verify_exec "$SKILL_DIR/core/lock-kit.sh" "the hardening script — next-step 2 tells you to run it"
  verify_file "$SKILL_DIR/core/.harness" "the wiring record the integrity axis reads"
}
verify_cursor_gates() {
  verify_exec "$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh" "the self-protection gate — registered at beforeShellExecution + preToolUse"
  verify_exec "$PROJ/.cursor/hooks/flaky-kit-delivery-gate.sh" "the delivery gate — registered at stop"
  verify_file "$PROJ/.cursor/hooks/lib/cursor.sh" "the hook I/O lib both gates load"
  verify_file "$PROJ/.cursor/hooks/lib/audit.sh" "the audit lib both gates load"
}
# --- and the OTHER half, which is why both are here -----------------------------------------------
#
# The assertions above check outcomes. That was chosen over `set -e` for good reasons (see the block
# above), but it took on an ENUMERATION, and an outcome assertion is only ever as complete as its
# list. Three artefacts this installer copies sat outside that list, and each one reproduced the
# original defect in full — rc 0, "… wired", "install: done":
#
#   * `.cursor/rules/hektor-flaky-triage.mdc` and `.cursor/hooks/lib/cursor-compat.sh`. Measured with
#     those two directories unwritable: the banner still said "Cursor wired (.cursor/: rule + …)"
#     with an EMPTY rules directory, and the installed gate — which does
#     `if [ -f "$_COMPAT" ]; then . "$_COMPAT"; else exit 0; fi` — was driven with a real
#     `rm -rf` of the kit tree on stdin and returned 0 without blocking. Registered, reported
#     wired, enforcing nothing. `--harness all` is the default, so this is the ordinary path.
#   * `core/gate-src/`, which is where `core/_wiring_repair.sh` restores a DELETED gate from. With it
#     unwritable the install printed the full success banner and "install: vendored audit.sh" twice
#     over an empty directory. `verify_dir_nonempty "$SKILL_DIR/core"` cannot see it: core/ is full.
#
# Return-code observation is total by construction; outcome assertion is specific and actionable.
# NEITHER ALONE IS ENOUGH, and that is the point of carrying both. The rc check catches everything
# nobody thought to list, including "the file is present but is not the one we just tried to copy";
# the assertion turns it into a message that names the artefact. Every `cp`, and every `mkdir` a
# `cp` depends on, is checked from here on — adding a copy without a check is the way back in.
#
# Names the artefact, because "install failed" alone leaves the reader with the same question the
# whole defect created. rc 73 (EX_CANTCREAT) is distinct from 74 (INCOMPLETE: everything landed, a
# registration merge did not) — this is the stronger failure and must not be read as that one.
verify_report() {
  [ -z "$verify_missing" ] && return 0
  {
    echo ""
    echo "install: FAILED in $PROJ — this install did not produce what it was about to report."
    echo "These artefacts did not land (a copy failed: out of disk, a permission error, a partial cp, or"
    echo "a kit source at $HERE that does not hold them):"
    printf '%s' "$verify_missing"
    echo "The kit's safety surface is not fully on disk, so nothing this run would have registered can be"
    echo "trusted to enforce anything. Fix the cause above and re-run this installer against this project."
    echo "Do NOT run '$KIT/core/lock-kit.sh lock' over it — hardening a broken install turns one repairable"
    echo "failure into unlock (password) -> fix -> reinstall -> relock."
  } >&2
  exit 73
}

# --- engine + skill: the canonical home for EVERY harness (the gate's surface + the AGENTS.md/rule
#     pointers all reference this path; the engine runs from here in any terminal). Always installed. ---
verify_mkdir "$SKILL_DIR/core" "the kit directory"

# Refuse to overwrite a hardened install. cp -R would hit EACCES on every root-owned file and bury
# the real message under a wall of errors — and that EACCES is the protection working, not a bug.
#
# The signal is OWNERSHIP, not the recorded tier. Reading .lock-state was the same inversion Task 3
# corrected inside lock-kit.sh, and it cut both ways here: a tree whose chown succeeded but whose state
# write failed got no wall at all, while an agent could block every future upgrade permanently by
# forging one line of JSON — a denial of service on the maintenance path, mounted from inside exactly
# the scope this kit exists to constrain. Ownership cannot be forged without the password.
#
# A record that CLAIMS hardened over a tree that is not root-owned is a `mismatch`: it is reported
# loudly and the install PROCEEDS, because reinstalling is the repair for that state rather than
# something that state should be able to veto.
if [ -r "$HERE/core/_integrity.sh" ]; then
  . "$HERE/core/_integrity.sh"          # the INSTALLER's own bundled copy, never the target tree's
  if [ "$(integrity_owner_uid "$SKILL_DIR/core")" = "0" ]; then
    echo "install: this project already has a HARDENED flaky-triage kit at $SKILL_DIR ($KIT/core is owned by root)." >&2
    echo "install: refusing to overwrite it. To upgrade, unlock first:" >&2
    echo "install:   HEKTOR_FLAKYKIT_UNLOCK=1 $SKILL_DIR/core/lock-kit.sh unlock" >&2
    echo "install: then re-run this installer, and re-lock afterwards with 'core/lock-kit.sh lock'." >&2
    exit 75
  fi
  if [ -f "$SKILL_DIR/core/.lock-state" ] \
     && grep -q '"tier"[[:space:]]*:[[:space:]]*"hardened"' "$SKILL_DIR/core/.lock-state" 2>/dev/null; then
    echo "install: WARNING the kit already here RECORDS the hardened tier, but $KIT/core is NOT owned by root — that is a MISMATCH, not a hardened kit." >&2
    echo "install: proceeding with the install, because reinstalling is the repair for a mismatched tree. Re-lock afterwards with 'core/lock-kit.sh lock'." >&2
  fi
fi

# PRESENCE IS NOT FRESHNESS, and the refusal above only catches ONE of the two protected tiers.
# It keys on root ownership, i.e. `hardened`. The DEGRADED tier is `chmod a-w` over the whole
# surface with the owner unchanged — what `lock-kit.sh lock` leaves on any machine without sudo,
# and step 2 of this installer's own next-steps block tells EVERY user to run lock. Measured on
# that shape: a re-install printed 44 "Permission denied" lines, replaced NOT ONE file, and still
# exited 0 with "Claude Code wired" and "install: done". Every outcome assertion passed, because
# they check that the artefacts are PRESENT and the old ones all still were — a planted marker in
# core/gate.sh survived, and core/.version still named the version the project was installed from.
# An upgrade that silently upgrades nothing is precisely the staleness this branch exists to end.
#
# Refuse before touching anything, and name the remedy: `unlock` is what reopens a degraded tree,
# the same command the hardened tier needs, and nobody learns that from a wall of cp errors. rc 75
# is deliberately the SAME code the hardened refusal uses — from a caller's point of view these are
# one contract ("a protected kit is already here; reopen it, then re-run"), and splitting them
# would make a scripted upgrade handle the two tiers differently for no reason.
#
# `-w` on the directory is the cheap, total check for the shape lock actually creates. A tree whose
# directory is writable but whose FILES are read-only slips past it — and is caught by the `cp`
# return codes below, which is the whole reason both mechanisms are here.
#
# Conditioned on `core/lock-kit.sh` existing, i.e. on a kit ACTUALLY being here, not merely on an
# unwritable directory called core/. Everything this refusal says — "already has a kit", "that is a
# PROTECTED kit", "reopen it with unlock" — is false of a bare unwritable directory with no install
# in it, and that shape is a plain copy failure the assertions below already report as such. Using
# the hardening script itself as the marker keeps the condition and the remedy in step: the file the
# message tells you to run is the file whose presence made the message apply.
if [ -f "$SKILL_DIR/core/lock-kit.sh" ] && [ ! -w "$SKILL_DIR/core" ]; then
  echo "install: this project already has a flaky-triage kit at $SKILL_DIR, and $KIT/core is NOT WRITABLE." >&2
  echo "install: that is a PROTECTED kit — normally the degraded tier ('lock-kit.sh lock' without sudo:" >&2
  echo "install: read-only, owner unchanged), or a hardened tree this installer could not identify." >&2
  echo "install: refusing to half-overwrite it. Every copy would fail, nothing would be replaced, and the" >&2
  echo "install: install would still look successful, because the OLD files are all still there — you would" >&2
  echo "install: be told you upgraded and keep running the version you already had. Reopen it first:" >&2
  echo "install:   HEKTOR_FLAKYKIT_UNLOCK=1 $SKILL_DIR/core/lock-kit.sh unlock" >&2
  echo "install: then re-run this installer, and re-lock afterwards with 'core/lock-kit.sh lock'." >&2
  exit 75
fi

cp -R "$HERE/core/." "$SKILL_DIR/core/" \
  || verify_note "COPY FAILED: $SKILL_DIR/core/  (the engine, from $HERE/core/)"
# .lock-state describes the TREE IT SITS IN, not the tree it was copied from. `cp -R` above just
# copied the source's own record along with everything else, so a fresh install made from an
# already-locked (or already-unlocked) source landed claiming a tier it never earned. At `hardened`
# that record over a user-owned destination reads as `mismatch` (integrity_tier in _integrity.sh) —
# and `mismatch` REFUSES every entrypoint (see the header comment above and install.sh:83-87, whose
# own printed remedy — "reinstalling is the repair" — is exactly what recreates this). At `unlocked`
# it is quieter but just as false: the destination would claim it was locked and then deliberately
# reopened, which never happened to it. A freshly installed tree has never been locked at all, so it
# must carry NO record — `lock-kit.sh status` then reports `unprotected`, whose own wording ("lock has
# never run here") is exactly accurate for a tree seconds old. Do not read/reuse the source's file;
# just remove whatever the copy brought over.
rm -f "$SKILL_DIR/core/.lock-state"

# npm RENAMES .gitignore to .npmignore when it EXTRACTS a package — the tarball carries
# core/.gitignore, npm's extractor writes core/.npmignore, and a plain `tar xzf` of the very
# same tarball writes core/.gitignore. So an npm-installed kit is the one delivery path where
# the file arrives under a name git never reads, which silently undoes the whole reason it
# ships: without it the project does not ignore core/.lock-state, so a user who follows step 2
# below (`lock-kit.sh lock`) commits a record saying `hardened` — and a teammate who clones onto
# a tree that is not root-owned gets `mismatch` from integrity_tier, which REFUSES every
# entrypoint. Normalise the name here rather than in one delivery path's packaging, so source
# checkout, `tar xzf`, and `npm i -g` all converge on the same installed tree.
#
# UNCONDITIONAL, and that is the point. A first draft guarded this with
# `[ ! -f "$SKILL_DIR/core/.gitignore" ]`, which made it first-install-only: on RE-install the
# `cp -R` above lands the new .npmignore, the guard sees the OLD .gitignore already sitting
# there and skips, and the `rm -f` below then deletes the incoming copy — so a rule added in a
# later kit version reached source-path users on upgrade and silently never reached npm-path
# users. That is the staleness this whole branch exists to end, reintroduced one path over. The
# two names cannot coexist in any source tree (npm writes one, git writes the other), so the
# guard protected against nothing and cost the upgrade path.
if [ -f "$SKILL_DIR/core/.npmignore" ]; then
  mv -f "$SKILL_DIR/core/.npmignore" "$SKILL_DIR/core/.gitignore"
fi
rm -f "$SKILL_DIR/core/.npmignore"

verify_cp "$HERE/skill/SKILL.md" "$SKILL_DIR/SKILL.md" "the skill"
chmod +x "$SKILL_DIR"/core/*.sh "$SKILL_DIR"/core/*.py 2>/dev/null || true

# The wiring check must require exactly the harnesses this kit was installed for. Written under
# core/, which harden_targets already chowns, so at the hardened tier an agent cannot rewrite it to
# require nothing.
#
# First token: the install target. Remaining tokens: capabilities this install shipped.
# A record without `stop` is an install that predates the delivery gate and must go on requiring
# exactly the slots it already required — that is what keeps the wiring axis from refusing every
# entrypoint on every existing project the moment a new capability ships.
printf 'cursor stop\n' > "$SKILL_DIR/core/.harness"

# The version of the ENGINE this project received, and when it received it.
# Written here rather than shipped in the source tree: a version SHOULD travel
# with a copy (it says which build this is), which is the opposite of
# core/.lock-state, whose defect was travelling — see the rm -f above. Writing it
# per-install means there is no source .version for `cp -R` to carry, so the two
# cannot be confused into "fixing" one by breaking the other.
# No readable manifest -> no record, deliberately: an invented version is worse
# than an absent one, and `status` already reads absence as "unknown".
if [ -r "$HERE/package.json" ] && command -v jq >/dev/null 2>&1; then
  _kv="$(jq -r '.version // empty' "$HERE/package.json" 2>/dev/null)"
  [ -n "$_kv" ] && printf '%s %s\n' "$_kv" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SKILL_DIR/core/.version"
  unset _kv
fi

# The engine, the skill and the wiring record, checked before ANYTHING claims them. This runs ahead
# of both harness blocks on purpose: each of those prints its own "… wired" line, and a registration
# whose engine never landed points at nothing. `core/.version` is deliberately not required — it is
# written only when a readable manifest and jq are both present, and `status` already reads its
# absence as "unknown", so demanding it would fail installs from trees where it was never a claim.
verify_engine
verify_report
echo "install: engine + SKILL.md -> $KIT/"

# UPGRADE PATH. Before the relocation, the gate installed INSIDE the kit tree at
# $SKILL_DIR/hooks/flaky-kit-self-protection-gate.sh. Nothing removed it, so upgrading an existing
# install left the project with TWO gates: the new one plus a stale in-tree copy that predates the
# shadow check and the relocated surface patterns — and that still travels with the tree when the tree
# is renamed aside, which is precisely the case the relocation exists to survive. Remove the file and
# its directory here; the stale settings.json registration is dropped by the jq filter in the Claude
# block below.
if [ -e "$SKILL_DIR/hooks" ]; then
  if rm -rf "$SKILL_DIR/hooks" 2>/dev/null; then
    echo "install: removed the stale in-tree gate directory $KIT/hooks/ (the gates now live at .cursor/hooks/)"
  else
    echo "install: WARN could not remove the stale in-tree gate at $SKILL_DIR/hooks — remove it by hand, or this project keeps a second, outdated gate that a rename of the kit tree would carry along" >&2
  fi
fi

# --- auto-configure the installed config so there's no manual step (never clobbers valid values) ---
autoconfig() {
  CFG="$SKILL_DIR/core/config.json"
  # JDK 17: fill run.java_home if it's empty or points nowhere on this machine.
  cur="$(jq -r '.run.java_home // ""' "$CFG")"
  if [ -z "$cur" ] || [ ! -d "$cur" ]; then
    jh=""
    [ -x /usr/libexec/java_home ] && jh="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
    [ -z "$jh" ] && [ -n "${HEKTOR_FK_JAVA_HOME:-}" ] && [ -d "${HEKTOR_FK_JAVA_HOME:-/nope}" ] && jh="$HEKTOR_FK_JAVA_HOME"
    [ -z "$jh" ] && [ -n "${JAVA_HOME:-}" ] && [ -d "$JAVA_HOME" ] && case "$JAVA_HOME" in *17*) jh="$JAVA_HOME";; esac
    if [ -n "$jh" ] && [ -d "$jh" ]; then
      t="$(mktemp)"; jq --arg j "$jh" '.run.java_home=$j' "$CFG" >"$t" && mv "$t" "$CFG"
      echo "install: auto-detected JDK 17 -> run.java_home"
    else
      echo "install: WARN no JDK 17 found — set HEKTOR_FK_JAVA_HOME or edit core/config.json run.java_home (toolchain needs 17)" >&2
    fi
  fi
  # source_roots: only re-detect if NONE of the configured roots exist here (i.e. wrong for this repo).
  existing=0
  while IFS= read -r r; do [ -n "$r" ] && [ -d "$PROJ/$r" ] && existing=$((existing+1)); done < <(jq -r '.source_roots[]?' "$CFG")
  if [ "$existing" -eq 0 ]; then
    roots="$(cd "$PROJ" && find . -type d -path '*/src/test/java' 2>/dev/null | sed 's#^\./##' | sort | head -5)"
    if [ -n "$roots" ]; then
      arr="$(printf '%s\n' "$roots" | jq -R . | jq -s .)"
      t="$(mktemp)"; jq --argjson a "$arr" '.source_roots=$a' "$CFG" >"$t" && mv "$t" "$CFG"
      echo "install: auto-detected source_roots ($(printf '%s ' $roots)) — VERIFY (this is the write-confinement seam; add main/page dirs if fixes touch them)" >&2
    else
      echo "install: WARN could not auto-detect source_roots — edit core/config.json source_roots (your test packages)" >&2
    fi
  fi
}
[ "$AUTOCFG" = 1 ] && autoconfig

vendor() { # $1=src  $2=dest (only if absent — never clobber an existing install)
  # Skipping is intentional (re-running install.sh must never stomp a project's local edits to a
  # vendored lib), but a SILENT skip also means a stale or tampered destination file is invisible
  # — nothing here ever tells you the on-disk copy no longer matches the kit's. Emit a stderr
  # WARNING so that's at least observable; a future version could go further and checksum $1 vs
  # $2 (e.g. embed each vendored lib's SHA-256 and compare) to actually detect drift, not just
  # flag "we didn't touch it."
  if [ -f "$2" ]; then
    echo "install: WARN $(basename "$2") already exists at $2 — leaving it AS-IS (not overwriting); if it's stale or was hand-edited/tampered with, remove it and re-run install.sh to re-vendor from $1" >&2
  # "install: vendored X" used to print whether or not the `cp` worked — measured printing twice over
  # a directory the copies could not be written into. It is a success claim like any other and must
  # follow the write, not accompany it.
  elif mkdir -p "$(dirname "$2")" && cp "$1" "$2"; then
    chmod +x "$2" 2>/dev/null || true; echo "install: vendored $(basename "$2")"
  else
    verify_note "COPY FAILED: $2  (the vendored lib $(basename "$2"), from $1)"
  fi
}

# --- gates + vendored libs + hooks.json registration ---------------------------------------------
verify_mkdir "$PROJ/.cursor/hooks/lib" "the hooks lib directory"

# Both gates install OUTSIDE the kit tree so a rename of that tree cannot take its own detectors
# along with it.
verify_cp "$HERE/gates/flaky-kit-self-protection-gate.sh" "$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh" "the self-protection gate"
verify_cp "$HERE/gates/flaky-kit-delivery-gate.sh" "$PROJ/.cursor/hooks/flaky-kit-delivery-gate.sh" "the delivery gate"
chmod +x "$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh" "$PROJ/.cursor/hooks/flaky-kit-delivery-gate.sh" 2>/dev/null || true

# The I/O lib is load-bearing for enforcement, not documentation: each gate does
# `if [ -f "$_CURSOR" ]; then . "$_CURSOR"; else exit 0; fi`, so a missing lib makes an INSTALLED,
# REGISTERED gate allow every call. Driven with a delete of the kit tree on stdin it returned 0 and
# blocked nothing, under a banner that said it was wired.
vendor "$HERE/gates/lib/cursor.sh" "$PROJ/.cursor/hooks/lib/cursor.sh"
vendor "$HERE/gates/lib/audit.sh" "$PROJ/.cursor/hooks/lib/audit.sh"

# The restore sources for core/_wiring_repair.sh. Under core/ so harden_targets covers them: at a
# root-owned tier the file a repair would copy from cannot be rewritten by an agent.
verify_mkdir "$SKILL_DIR/core/gate-src/lib" "the gate restore source directory"
verify_cp "$HERE/gates/flaky-kit-self-protection-gate.sh" "$SKILL_DIR/core/gate-src/flaky-kit-self-protection-gate.sh" "the self-protection gate restore source"
verify_cp "$HERE/gates/flaky-kit-delivery-gate.sh" "$SKILL_DIR/core/gate-src/flaky-kit-delivery-gate.sh" "the delivery gate restore source"
chmod +x "$SKILL_DIR/core/gate-src"/*.sh 2>/dev/null || true
vendor "$HERE/gates/lib/cursor.sh" "$SKILL_DIR/core/gate-src/lib/cursor.sh"
vendor "$HERE/gates/lib/audit.sh" "$SKILL_DIR/core/gate-src/lib/audit.sh"

# The gate FILES, before a single registration is merged and before any "wired" line. A
# registration is a promise that the command it names will run; registering a path that does not
# exist, and then reporting it as wired, is the defect in its purest form.
verify_cursor_gates
verify_report

H="$PROJ/.cursor/hooks.json"; [ -f "$H" ] || echo '{"version":1,"hooks":{}}' > "$H"
C=".cursor/hooks/flaky-kit-self-protection-gate.sh"
D=".cursor/hooks/flaky-kit-delivery-gate.sh"

# `[ -s "$t" ]` and the `rm -f` matter: without them this merge printed "wired" unconditionally even
# when the jq errored out — measured against a project whose `.hooks.beforeShellExecution` is a
# non-array (valid JSON, so nothing upstream rejects it): jq errors, `mv` never runs, and the
# installer claimed a registration landed over a hooks.json with nothing written. `core/.harness`
# records the capability regardless of this outcome, deliberately — a record that quietly forgot it
# would turn a loud, repairable failure into a silent downgrade — so the wiring axis reads
# `unregistered` for the affected slot from then on, and refuses every entrypoint with 76 once the
# tree is hardened.
cursor_ok=0
t="$(mktemp)"
if jq --arg c "$C" '
  .hooks //= {} |
  .hooks.beforeShellExecution //= [] |
  (if any(.hooks.beforeShellExecution[]?; .command==$c) then . else .hooks.beforeShellExecution += [{command:$c, timeout:10}] end) |
  .hooks.preToolUse //= [] |
  (if any(.hooks.preToolUse[]?; .command==$c) then . else .hooks.preToolUse += [{command:$c, timeout:10}] end)
' "$H" > "$t" 2>/dev/null \
   && [ -s "$t" ] && mv "$t" "$H"; then
  cursor_ok=1
else
  rm -f "$t"
fi
if [ "$cursor_ok" = 1 ]; then
  echo "install: self-protection gate wired (beforeShellExecution + preToolUse)"
else
  echo "install: WARN the self-protection gate's registration did NOT land — $H could not be merged (most likely .hooks.beforeShellExecution or .hooks.preToolUse is present but is not an array). core/.harness records the gate as required, so the wiring axis will report 'unregistered' for it from now on, and after 'core/lock-kit.sh lock' that refuses EVERY entrypoint with 76. Fix .cursor/hooks.json (both keys must be arrays) and re-run this installer." >&2
  cursor_failed=1
  cursor_failed_file="$H"
fi

# The delivery gate is its own event and its own merge, so one failing does not hide the other.
stop_ok=0
t="$(mktemp)"
if jq --arg d "$D" '
  .hooks //= {} |
  .hooks.stop //= [] |
  (if any(.hooks.stop[]?; .command==$d) then . else .hooks.stop += [{command:$d, timeout:10, loop_limit:1}] end)
' "$H" > "$t" 2>/dev/null \
   && [ -s "$t" ] && mv "$t" "$H"; then
  stop_ok=1
else
  rm -f "$t"
fi
if [ "$stop_ok" = 1 ]; then
  echo "install: delivery gate wired (stop)"
else
  echo "install: WARN the delivery gate's stop registration did NOT land — $H could not be merged (most likely .hooks.stop is present but is not an array). This is the control that enforces I11 at end-of-session. Fix .cursor/hooks.json and re-run this installer." >&2
  stop_failed=1
  stop_failed_file="$H"
fi

# --- what actually landed, over the FINISHED tree, before either ending -------------------------
# The in-flow calls above each guard one claim at the moment it is made. This one is the statement
# the two endings below rest on: every artefact this run was asked for is on disk, and every gate it
# registered is present and executable. It re-checks what the in-flow calls already passed, on
# purpose — those ran before later blocks could delete or overwrite anything (the stale-gate `rm -rf`
# and both `cp -R`s of gate-src/ are between them), and a check that only ever ran mid-flight cannot
# speak for the tree the user is left with. Deliberately BEFORE the rc-74 INCOMPLETE ending too: a
# tree with no engine must not be reported as "everything landed, one registration did not".
verify_engine
verify_cursor_gates
verify_report

# --- the ending, and there are two of them ------------------------------------------------------
# Everything above has already run. What differs here is what the script CLAIMS and what it hands
# back to whoever called it: the pack-level installer branches on this rc and warns by kit name, and
# `hektor-triage-kit install` execs this script, so the rc is the CLI's own.
#
# ONE non-zero ending for ANY registration merge that failed — `stop_failed` and `cursor_failed` both
# land here rather than each growing its own exit code or its own message, so a caller watching for
# "INCOMPLETE" / rc 74 sees exactly one contract regardless of which merge broke. The body names only
# the merge(s) that actually failed and claims nothing stronger: an earlier version of this paragraph,
# written for the Stop merge alone, said "the self-protection gate and every other registration ARE in
# place" — true when Stop was the only merge that could fail, and false the moment the Cursor merge
# gained the same failure mode, since a Cursor registration failure means the self-protection gate
# ITSELF (its Cursor registration, specifically) is one of the things not in place.
if [ "$stop_failed" = 1 ] || [ "$cursor_failed" = 1 ]; then
  {
    echo ""
    echo "install: INCOMPLETE in $PROJ"
    echo "The engine, the skill, and every registration that DID land are in place. The following did"
    echo "NOT (the WARN above says why):"
    [ "$stop_failed" = 1 ] \
      && echo "  - the delivery gate's stop registration — the control that enforces I11 at end-of-session"
    [ "$cursor_failed" = 1 ] \
      && echo "  - the self-protection gate's hooks.json registration"
    echo "DO NOT run '$KIT/core/lock-kit.sh lock' yet. $KIT/core/.harness records every capability this"
    echo "install was asked for regardless of merge outcome, deliberately — dropping one would make the"
    echo "wiring axis stop checking that slot, which is a silent downgrade — so the axis reads"
    echo "'unregistered' for the affected slot(s) from now on. That is a warning while the tree is yours"
    echo "and rc 76 from all thirteen entrypoints once it is root-owned, where the remedy it prints"
    echo "(re-run this installer) is itself refused with 75. Locking now turns one repairable failure"
    echo "into unlock (password) -> fix -> reinstall -> relock."
    echo "repair, in this order:"
    n=1
    if [ "$stop_failed" = 1 ]; then
      echo "  $n) fix .hooks.stop in $stop_failed_file  (it must be an ARRAY)"
      n=$((n+1))
    fi
    if [ "$cursor_failed" = 1 ]; then
      echo "  $n) fix .hooks.beforeShellExecution and .hooks.preToolUse in $cursor_failed_file  (both must be ARRAYs)"
      n=$((n+1))
    fi
    echo "  $n) re-run this installer against this project"
    n=$((n+1))
    echo "  $n) only then  $KIT/core/lock-kit.sh lock"
  } >&2
  exit 74
fi

cat >&2 <<EOF

install: done in $PROJ
auto-config: JDK 17 + source_roots set automatically (see the lines above; verify source_roots if shown).
next:
  1) verify  $KIT/core/config.json   (source_roots = your test packages · run.java_home = a JDK 17)
  2) HARDEN (do not skip — see the note below):  $KIT/core/lock-kit.sh lock
     (maintenance unlock: HEKTOR_FLAKYKIT_UNLOCK=1 $KIT/core/lock-kit.sh unlock)
  3) read    $KIT/SKILL.md   and   $KIT/core/README.md
reload the Cursor window so the new skill and hooks load. The engine works from any terminal immediately.
EOF
echo "install: then HARDEN the kit so its safety surface cannot be edited from agent context:" >&2
echo "install:   $SKILL_DIR/core/lock-kit.sh lock          # asks for your password (chowns core/ to root)" >&2
echo "install: WITHOUT that step nothing is protected — a fresh install has no lock state and its files stay plainly writable by you, and therefore by any agent running as you. It is not read-only; 'degraded' (read-only but reversible with one chmod) is what you get on a machine where lock ran but sudo was unavailable." >&2
exit 0
