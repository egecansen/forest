#!/bin/bash
# core/_integrity.sh — is this tree still the tree that was locked?
#
# WHY: core/lock-kit.sh can establish a HARDENED tier (the safety surface owned by root, so only a
# password-gated sudo can reopen it) or fall back to a DEGRADED tier (chmod a-w only, which the
# owning user — and therefore the agent — can always reverse). A kit that silently slipped from the
# first to the second would still LOOK locked while enforcing nothing. Source this and ask.
#
# LIMIT, stated up front: this check lives INSIDE the tree it validates, so it cannot detect
# SHADOWING (`mv` the kit dir aside and put a fake one in its place) — a shadowed tree carries its
# own state file and is indistinguishable from a fresh un-hardened install. That case is the
# relocated gate's job (.claude/hooks/, outside the shadowable tree), and the gate does it by asking
# whether the tree is still ROOT-OWNED rather than whether it still exists — an ownership check is the
# one question a replacement tree cannot answer in its own favour without the password. This check
# catches ACCIDENTS: an upgrade that dropped ownership, a kit installed but never hardened, a
# maintenance unlock left open. Two different jobs, deliberately not conflated.
#
# Never wedges a caller: every function returns 0 and prints its answer, mirroring hektor_audit's
# "a broken check must not break the run" discipline.

# The repair unit. Sourced here so `integrity_guard` can call it, kept in its own file so the
# detector functions below stay free of any filesystem write. At LOAD time and from THIS file's own
# directory — not from `integrity_guard`'s argument. That argument previously only selected what to
# report on: stat, cat, jq, no execution. Sourcing from it would make the guard execute code from a
# path its CALLER chose, as its first act, before it has learned anything about that tree's
# ownership — not exploitable by any of the thirteen current callers, since all of them pass
# `$HERE/..`, but that is a property of the callers, not of this function, and the kind of property
# that decays silently the moment a fourteenth caller does not.
#
# The shape below is `if`/`fi` + `declare -F`, NOT the one-line `[ -r X ] && . X || fallback` that
# stood here. In that form the `||` branch fires on the STATUS OF THE SOURCE, so a `_wiring_repair.sh`
# whose last statement happened to return non-zero would load fine and then be immediately REDEFINED
# as a no-op — the whole repair silently disabled, nothing printed, nothing failed. Proven by
# appending a single `false` to a fixture's copy: the registration was not repaired and the run said
# nothing. It worked only because the file happens to end on a function definition, which is a
# property of that file today, not of this line. `declare -F` asks the question the fallback actually
# means — "is `wiring_repair` defined as a FUNCTION?" — instead of a proxy for it. `command -v` stood
# here first and was itself a proxy: it resolves PATH executables as readily as shell functions, so a
# `wiring_repair` binary early on PATH (with `_wiring_repair.sh` absent) satisfied the check, the
# no-op fallback never installed, and the integrity path went on to exec that binary with
# `<kit_root> <tier> <wiring>` — a proxy standing in for a property, the fifth time that shape has
# caused a defect in this kit (the four are catalogued at `_wiring_slots` below). `declare -F` is
# bash 3.2-safe and answers only "is this a function", which is the question being asked.
#
# `|| :` on the source keeps the "never wedge a caller" contract: thirteen entrypoints source this
# file, some under `set -e`, where a non-zero `.` inside an `if` body would abort the caller outright.
#
# The `elif` is the third state, previously indistinguishable from the second: a file that is PRESENT
# but unreadable (a chmod, a bad install) took the same silent no-op path as one that was never
# installed. They are different facts and only one of them is a defect, so the one that is says so.
_INTEGRITY_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -r "$_INTEGRITY_HERE/_wiring_repair.sh" ]; then
  . "$_INTEGRITY_HERE/_wiring_repair.sh" || :
elif [ -e "$_INTEGRITY_HERE/_wiring_repair.sh" ]; then
  echo "integrity: _wiring_repair.sh is present but unreadable — self-repair is disabled for this run." >&2
fi
declare -F wiring_repair >/dev/null 2>&1 || wiring_repair() { return 0; }

# integrity_owner_uid <path> -> numeric uid, or empty. BSD and GNU stat take different flags.
integrity_owner_uid() {
  local p="${1:-}"
  [ -n "$p" ] && [ -e "$p" ] || return 0
  case "$(uname -s 2>/dev/null)" in
    Darwin|*BSD) stat -f %u "$p" 2>/dev/null ;;
    *)           stat -c %u "$p" 2>/dev/null ;;
  esac
  # Explicit, NOT decorative: without it the function exits with `stat`'s status, so a missing or
  # failing stat returns non-zero and aborts any caller running under `set -e` — the exact
  # "never wedge a caller" violation this file's header promises not to commit.
  return 0
}

# integrity_project_root <kit_root> -> the project root, or empty when this is not an installed kit.
#
# Verifies the SHAPE of the installed layout — <proj>/.claude/skills/hektor-flaky-triage — rather
# than counting three levels up. Counting is a proxy that happens to be right for one layout; the
# shape is the property being asked about. It also means running the suite from the source tree
# (kits/flaky-triage-kit) yields nothing and the wiring check stays silent there, instead of
# accidentally resolving to some unrelated directory.
integrity_project_root() {
  local kit="${1:-}" k s c
  [ -n "$kit" ] || return 0
  k="$(cd "$kit" 2>/dev/null && pwd -P)" || return 0
  [ -n "$k" ] || return 0
  [ "$(basename "$k")" = "hektor-flaky-triage" ] || return 0
  s="$(dirname "$k")"; [ "$(basename "$s")" = "skills" ] || return 0
  c="$(dirname "$s")"; [ "$(basename "$c")" = ".claude" ] || return 0
  dirname "$c"
  return 0
}

# _wiring_want <kit_root> <project_root> -> "<claude> <cursor>", each 1 if that harness is required.
#
# The install-time record decides. `--harness` was previously a flag that vanished after the run, so
# the check had to infer a requirement from "a settings file exists" — which flags a project that
# carries a .cursor/hooks.json from some unrelated tool while the kit was only ever installed for
# Claude. The record is written into core/, which harden_targets already chowns, so at the hardened
# tier an agent cannot rewrite it to require nothing.
#
# No record means the kit predates this file: fall back to the old inference rather than silently
# requiring nothing, which would turn every existing install into a green "wired".
_wiring_want() {
  local kit="${1:-}" root="${2:-}" h c=0 u=0
  h="$(cat "$kit/core/.harness" 2>/dev/null)"
  case "$h" in
    all|both) echo "1 1"; return 0 ;;
    claude)   echo "1 0"; return 0 ;;
    cursor)   echo "0 1"; return 0 ;;
    agents)   echo "0 0"; return 0 ;;
  esac
  { [ -r "$root/.claude/settings.json" ] || [ -r "$root/.claude/settings.local.json" ]; } && c=1
  [ -r "$root/.cursor/hooks.json" ] && u=1
  echo "$c $u"
  return 0
}

# _wiring_slots <settings-file> -> one "<event>:<tool><TAB><command>" line per TOOL that a registered
# slot covers, e.g. "PreToolUse:Bash", "preToolUse:Write", "beforeShellExecution:*". Silent and empty
# for an unreadable or unparseable file.
#
# ONE slot model, shared with the gate's own `_reg_slots`
# (adapters/*/flaky-kit-self-protection-gate.sh, whose comment states the same rule): split the
# matcher on `|`, treat `*` — and an absent matcher — as covering everything, emit one entry per tool.
# The two integrity axes have to ask the same question or they contradict each other, and they did:
# this function used to compare the matcher STRING against the literals `Write|Edit` and `Bash`, so
# the two edits the gate deliberately ALLOWs as strictly-better registrations (widening `Write|Edit`
# to `Write|Edit|MultiEdit`; collapsing both matchers into a single `*`) were read here as `partial`
# and `unregistered` — a REFUSAL at the hardened and stale tiers, i.e. a kit wedged by a change its
# own gate had just approved, whose printed repair (re-run the installer) install.sh itself refuses
# on a root-owned tree. The tool set is the property; the matcher's spelling was a proxy for it, and
# a proxy standing in for a property has now caused four separate defects in this kit.
#
# It returns the COMMAND alongside each slot, not a yes/no: the harness runs whatever path that string
# names, so the existence check must land on it. Asking "does some command mention the gate?" and then
# stat-ing the path this kit would have installed are two different questions, and a settings.json
# copied between machines answers the first yes while the gate never runs.
#
# Cursor's `preToolUse` entries carry a `matcher` exactly as Claude's `PreToolUse` ones do, and are
# keyed the same way here. Keying them by event alone — which this file used to do — would let a
# Cursor matcher be retargeted to an inert tool and read as a survival while the identical Claude-side
# change is caught, and the gate DENIES the edit that produces it, so one branch of one feature was
# enforcing a rule the other silently waived. `beforeShellExecution` is the one event with no matcher
# concept in either harness: it fires for every shell execution, so it covers `*` by construction
# rather than by omission — the same reasoning the gate's `_reg_slots` records, not a new rule.
_wiring_slots() {
  jq -r '
    def gate: select((.command // "") | test("flaky-kit-self-protection-gate\\.sh"));
    def tools($m): (if ($m // "") == "" then "*" else $m end) | split("|") | .[];
    [ (.hooks.PreToolUse // [])[]? | .matcher as $m | (.hooks // [])[]? | gate | "PreToolUse:\(tools($m))\t\(.command)" ]
    + [ (.hooks.preToolUse // [])[]? | .matcher as $m | gate | "preToolUse:\(tools($m))\t\(.command)" ]
    + [ (.hooks.beforeShellExecution // [])[]? | gate | "beforeShellExecution:*\t\(.command)" ]
    | unique | .[]
  ' "$1" 2>/dev/null
}

# _wiring_cover <slots> <event> <tool> -> the command registered for that event/tool, or empty.
#
# An "<event>:*" slot covers every tool of that event, which is what makes a collapsed wildcard
# registration a covering one rather than a missing one — the same rule as the gate's `_slots_kept`,
# stated once and applied on both axes.
_wiring_cover() {
  local slots="${1:-}" ev="${2:-}" tool="${3:-}" line key
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    key="${line%%$'\t'*}"
    if [ "$key" = "$ev:$tool" ] || [ "$key" = "$ev:*" ]; then
      printf '%s' "${line#*$'\t'}"
      return 0
    fi
  done <<SLOTS
$slots
SLOTS
  return 0
}

# _wiring_resolve <command-string> <project_root> -> an absolute path, or empty.
#
# Read `install.sh` for the exact strings both harnesses are registered with — that file is the
# authority on the format, not this comment — and handle at minimum: surrounding quotes, a
# $CLAUDE_PROJECT_DIR or ${CLAUDE_PROJECT_DIR} prefix, an absolute path, and a path relative to the
# project root. Trailing arguments after the script path are dropped.
#
# Bash parameter expansion for the substitution, NOT sed: `$root` is interpolated directly into the
# replacement text, and sed gives that text two live special characters — `&` (splices in the whole
# match) and its own `|` delimiter (a root containing one breaks the command outright, printing a
# parse error to stderr). A root like "R&D" or "Ben & Co" silently produced a garbage path; a root
# containing `|` errored. Both failed CLOSED (dangling/unregistered on a genuinely wired install,
# never a false `wired`), but a check whose job is to be believed must not corrupt a plausible real
# path. `${p//pattern/replacement}` has neither failure mode: the replacement text is literal, with
# no metacharacter re-interpreted, and it drops a subprocess besides.
#
# Known limitation, to be stated rather than hidden: a registered path containing spaces resolves to
# its first token.
_wiring_resolve() {
  local cmd="${1:-}" root="${2:-}" p
  [ -n "$cmd" ] || return 0
  p="$(printf '%s' "$cmd" | tr -d '"'\''')"
  p="${p%%[[:space:]]*}"
  p="${p//\$\{CLAUDE_PROJECT_DIR\}/$root}"
  p="${p//\$CLAUDE_PROJECT_DIR/$root}"
  case "$p" in
    '') : ;;
    /*) printf '%s' "$p" ;;
    *)  printf '%s' "$root/$p" ;;
  esac
  return 0
}

# _wiring_one <gate-file> <tier> <registered-count> <expected-count> -> a wiring value for one harness
_wiring_one() {
  local gate="$1" tier="$2" got="$3" want="$4"
  [ "$got" -eq 0 ] && { echo unregistered; return 0; }
  [ "$got" -lt "$want" ] && { echo partial; return 0; }
  [ -f "$gate" ] || { echo dangling; return 0; }
  # Identity comes free from the tier: harden_targets chowns the gate, and a replacement cannot be
  # root-owned without the password. `stale` is included because it means the tree IS root-owned and
  # only the record disagrees — keying on the record here while integrity_report keys on ownership
  # would split one property across two conditions. Below those, ownership proves nothing, so
  # existence is all there is to check; claiming more would be the overclaim this kit keeps retracting.
  case "$tier" in
    hardened|stale)
      if [ "$(integrity_owner_uid "$gate")" != "0" ]; then echo foreign; return 0; fi ;;
  esac
  echo wired
  return 0
}

# _wiring_rank <value> -> a severity rank. Higher is worse. `absent` ranks 0 — it means "nothing is
# configured here", so it loses to every real value and never drags down a harness that is wired.
_wiring_rank() {
  case "${1:-}" in
    wired) echo 1 ;; partial) echo 2 ;; dangling) echo 3 ;;
    unregistered) echo 4 ;; foreign) echo 5 ;; *) echo 0 ;;
  esac
}

# _wiring_worse <a> <b> -> whichever of the two is worse. The seed is `absent`, so the `absent` arm of
# _wiring_rank is on the live path and a mutation to it changes a public answer — which is the point:
# a rank branch no call can reach is a claim no test can check.
_wiring_worse() {
  if [ "$(_wiring_rank "${2:-}")" -gt "$(_wiring_rank "${1:-}")" ]; then echo "${2:-}"; else echo "${1:-}"; fi
  return 0
}

# integrity_wiring <kit_root> <tier> -> wired|unregistered|dangling|foreign|partial|absent
#
# The SECOND axis, deliberately separate from integrity_tier. A hardened install can be miswired and
# a never-locked one can be wired perfectly; folding them into one vocabulary would repeat the
# collapse that once reported a plainly-writable fresh install as "degraded — read-only".
#
# THREE things resolve to `absent` and print nothing, because in each of them the check genuinely
# cannot run: no `jq`; a layout that is not an installed kit; and no `core/.harness` record combined
# with no harness settings file at all (nothing was ever asked for here — the kit runs standalone
# from a terminal). A check that cannot run must not wedge the caller.
#
# A settings file that is UNREADABLE or UNPARSEABLE while the record says that harness is REQUIRED is
# deliberately NOT one of them: it reports `unregistered`, exactly as a deleted settings file does.
# That is not failing to know — it is knowing the gate will not run as registered, because a harness
# cannot load hooks from a file it cannot open or parse. The "every failure mode is `absent` and
# silent, not knowing is not the same as broken" rule that stood here was written when file ABSENCE
# was the only signal available, before `core/.harness` existed to say a harness is required; with
# the record present, silence there is a false all-clear on a chmod or a truncation an agent can
# perform. Pinned by fixture for all three record-present cases (deleted / unreadable / malformed),
# because the distinction is load-bearing at the refusing tiers.
integrity_wiring() {
  local kit="${1:-}" tier="${2:-}" root f p t s slots cmd g gate got want out=absent wc wu
  root="$(integrity_project_root "$kit")"
  [ -n "$root" ] || { echo absent; return 0; }
  command -v jq >/dev/null 2>&1 || { echo absent; return 0; }

  # Which harnesses this kit was installed for. EVERY variable is declared local above, loop
  # variables included: this file is sourced by thirteen entrypoints, and `t`, `p`, `cmd` and `out`
  # are already globals in core/apply.sh, core/_lock.sh, core/compile.sh and core/cluster.sh, so an
  # undeclared one is a collision waiting for someone to reorder two lines.
  set -- $(_wiring_want "$kit" "$root")
  wc="${1:-0}"; wu="${2:-0}"

  # Claude: slots from EITHER settings file count — Claude Code merges hook config from both, and
  # requiring both would fail every project that uses only one. All three tools must be covered by
  # some registered slot, because a tool the gate is not registered for is a tool the gate cannot see:
  # Write and Edit are the payload branch, Bash is the branch that closed the settings/shell vector.
  if [ "$wc" = 1 ]; then
    slots=''
    for f in "$root/.claude/settings.json" "$root/.claude/settings.local.json"; do
      if [ -r "$f" ]; then
        s="$(_wiring_slots "$f")"
        if [ -n "$s" ]; then slots="$slots$s
"; fi
      fi
    done
    got=0; want=3; gate=''
    for t in Write Edit Bash; do
      cmd="$(_wiring_cover "$slots" PreToolUse "$t")"
      [ -n "$cmd" ] || continue
      got=$((got+1))
      g="$(_wiring_resolve "$cmd" "$root")"
      # Prefer a path that is missing. If any covered tool points somewhere that does not exist, the
      # gate does not run for that tool call, and `dangling` is the honest answer for the set.
      if [ ! -f "$g" ] || [ -z "$gate" ]; then gate="$g"; fi
    done
    out="$(_wiring_worse "$out" "$(_wiring_one "$gate" "$tier" "$got" "$want")")"
  fi

  # Cursor: one file, the same three slots in that harness's spelling. `beforeShellExecution` is where
  # the shell vector lands (no matcher concept, so it covers `*`), and `preToolUse` carries a matcher
  # exactly as Claude's `PreToolUse` does — so it is asked about Write and Edit by name, not by event.
  if [ "$wu" = 1 ]; then
    slots=''
    f="$root/.cursor/hooks.json"
    if [ -r "$f" ]; then slots="$(_wiring_slots "$f")"; fi
    got=0; want=3; gate=''
    for p in 'beforeShellExecution:*' 'preToolUse:Write' 'preToolUse:Edit'; do
      cmd="$(_wiring_cover "$slots" "${p%%:*}" "${p#*:}")"
      [ -n "$cmd" ] || continue
      got=$((got+1))
      g="$(_wiring_resolve "$cmd" "$root")"
      if [ ! -f "$g" ] || [ -z "$gate" ]; then gate="$g"; fi
    done
    out="$(_wiring_worse "$out" "$(_wiring_one "$gate" "$tier" "$got" "$want")")"
  fi

  echo "$out"
  return 0
}

# integrity_state <kit_root> -> the recorded tier, or empty when absent/unreadable.
integrity_state() {
  local f="${1:-}/core/.lock-state"
  [ -n "${1:-}" ] && [ -r "$f" ] || return 0
  # `[^}]*` before the key, not `.*`: a greedy `.*` walks past the FIRST "tier" to the last one on
  # the line, so a state file carrying two tier keys resolves to last-wins on one line and
  # first-wins when the same content is split across lines (head -1). Anchoring the prefix with
  # `[^}]*` (non-brace characters) makes it stop at object boundaries, ensuring the first "tier"
  # key (typically in the first nested object) is matched in both layouts. The legitimate writer
  # (Task 3) emits exactly one flat {"tier":...,"at":...}; this is about not being ambiguous when
  # handed something else.
  sed -n 's/^[^}]*"tier"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$f" 2>/dev/null | head -1
  return 0
}

# integrity_tier <owner_uid> <recorded_tier> -> hardened|unlocked|degraded|unprotected|mismatch|stale
# Ranks protection: root-owned is 2, anything else is 1; a recorded "hardened" expects 2, all else 1.
# Weaker-than-recorded is the dangerous direction and is the only one that yields `mismatch`.
#
# `unprotected` vs `degraded` is a real distinction, not a synonym pair, and collapsing them was a
# bug: `degraded` means the surface IS read-only (chmod a-w) but this user can chmod it back;
# `unprotected` means `lock` never ran at all and the files are plainly writable. A fresh install is
# the second one — verified: no .lock-state, mode -rwxr-xr-x, a write succeeds. While both mapped to
# `degraded`, every message describing "read-only but reversible" was simply false for the fresh
# case, and `status` contradicted itself by printing `rw core/apply.sh` directly above
# `tier: degraded`. Anything unrecognised also lands here: an unreadable record means we do not know,
# and not-knowing must never read as protected.
integrity_tier() {
  local owner="${1:-}" recorded="${2:-}" actual=1 expected=1
  [ "$owner" = "0" ] && actual=2
  [ "$recorded" = "hardened" ] && expected=2
  if [ "$actual" -lt "$expected" ]; then echo mismatch; return 0; fi
  if [ "$actual" -gt "$expected" ]; then echo stale; return 0; fi
  case "$recorded" in
    hardened|unlocked|degraded) echo "$recorded" ;;
    *)                          echo unprotected ;;
  esac
  return 0
}

# integrity_report <tier> <wiring> -> 0 to proceed, 76 to refuse. Prints to stderr, never stdout, so
# it can never contaminate a script whose stdout is a JSON contract (rerun, gate, ledger, summary).
#
# Split out from integrity_guard so the messaging/decision half is a PURE function of the tier
# string and can be driven directly by the test suite. An earlier draft kept them fused and let the
# tests inject a fake uid through an environment-variable override — which handed anyone able to
# set that variable a silent bypass of this very check: forcing the fake uid to root turned a
# `mismatch` tree into `hardened` and the guard returned 0 without printing a word. A one-variable
# skeleton key to a control whose entire premise is that bypassing costs a password is not a test
# seam, it is a hole. The seam now runs through the function boundary instead of through the
# environment, so nothing in production reads an override at all — the test suite greps this file
# to make sure that variable never reappears here.
integrity_report() {
  local tier="$1" wiring="$2" rc=0
  case "$tier" in
    hardened) rc=0 ;;
    stale)
      echo "integrity: core/ is root-owned but .lock-state disagrees — treating as hardened; re-run 'core/lock-kit.sh lock' to refresh the record" >&2
      rc=0 ;;
    unlocked)
      echo "integrity: the kit is UNLOCKED (maintenance window open) — its safety surface is writable right now. Re-lock when done: core/lock-kit.sh lock" >&2
      rc=0 ;;
    degraded)
      echo "integrity: DEGRADED tier — the surface is read-only but still owned by this user, so this account can reverse it with a single chmod. Harden with: core/lock-kit.sh lock (needs sudo)" >&2
      rc=0 ;;
    unprotected)
      echo "integrity: UNPROTECTED — lock has never run here, so the safety surface is plainly writable by this user and by any agent running as them. Nothing is enforcing the kit's invariants. Protect it with: core/lock-kit.sh lock (needs sudo)" >&2
      rc=0 ;;
    mismatch)
      echo "integrity: MISMATCH — this kit was locked at the hardened tier, but core/ is no longer root-owned." >&2
      echo "integrity: this is not the tree that was hardened. Refusing: nothing it produces — summary, verdict, cluster table — should be trusted." >&2
      echo "integrity: if you unlocked deliberately, run 'core/lock-kit.sh lock' to re-establish the tier." >&2
      rc=76 ;;
  esac
  # The wiring axis. `absent` is silent at every tier: the kit runs standalone from a terminal, so
  # "no gate configured" and "a gate that should be here and isn't" are different facts, and warning
  # on the first would train the reader to ignore the second.
  case "$wiring" in
    wired|absent) : ;;
    *)
      echo "integrity: WIRING $wiring — the kit's self-protection gate is not going to run as registered." >&2
      case "$wiring" in
        dangling)     echo "integrity: a harness registration points at a gate file that does not exist (a pre-relocation path, or the file was removed)." >&2 ;;
        unregistered) echo "integrity: a harness settings file is required here but carries no registration for the kit's gate — or cannot be read or parsed, which the harness cannot load hooks from either." >&2 ;;
        partial)      echo "integrity: the gate is registered for some of the tools it must cover but not all of them, so part of the surface is unguarded." >&2 ;;
        foreign)      echo "integrity: the registered gate file is not root-owned while this tree is, so it is not the file this kit installed." >&2 ;;
      esac
      # The remedy has to be one the reader can actually execute. install.sh REFUSES with 75 whenever
      # $SKILL_DIR/core is root-owned — true at exactly the two tiers that refuse below — so "re-run
      # the installer" is correct advice at the warning tiers and impossible advice at the refusing
      # ones, where the repair genuinely costs the password. Printing an instruction that cannot be
      # carried out is how a wedged kit stays wedged, and `dangling` is the defect this axis exists
      # to catch.
      case "$tier" in
        hardened|stale)
          echo "integrity: refusing — the tree is root-owned, and the gate also carries the out-of-tree shadow record, so losing it means losing the only detector for a replaced kit tree. That is weaker than the protection actually in place." >&2
          echo "integrity: to repair, unlock FIRST — the installer refuses to overwrite a root-owned tree: HEKTOR_FLAKYKIT_UNLOCK=1 core/lock-kit.sh unlock, then re-run the kit installer against this project, then core/lock-kit.sh lock." >&2
          rc=76 ;;
        *)
          echo "integrity: re-run the kit installer against this project to repair it." >&2 ;;
      esac ;;
  esac
  return "$rc"
}

# integrity_guard <kit_root> -> 0 to proceed, 76 to refuse.
# The composition of both axes. It reads NO environment: every answer is recomputed from the
# filesystem on every call. An earlier draft cached the computed result in an exported variable to
# spare a triage the two extra evaluations its execs cost. That cache is indistinguishable from a
# forgery — the environment belongs to whoever launches the entrypoint — so it would have restored
# the INTEGRITY_FAKE_UID hole this kit removed, under a new name and past a name-specific test.
# Recomputing costs at most three jq calls per entrypoint. That is the price of the check being real.
integrity_guard() {
  local kit="${1:-}" tier wiring
  tier="$(integrity_tier "$(integrity_owner_uid "$kit/core")" "$(integrity_state "$kit")")"
  wiring="$(integrity_wiring "$kit" "$tier")"
  # Repair first, report the PRE-repair verdict. `wiring_repair` may write the registration and the
  # gate file; at every tier that refuses — `hardened`, `stale`, `mismatch` — it writes NOTHING: a
  # registration written there would read as `wired` on the very next entrypoint (this recomputes
  # from disk every call), so the refusal would hold for exactly one call and then silently stop.
  # The refusal here does not depend on anything the repair did; it depends on nothing having
  # changed. (The rule is keyed on the tier refusing, not on root ownership alone: `mismatch` is the
  # one refusing tier whose whole meaning is a recorded root ownership the tree does NOT have — keying
  # this on ownership was tried once, missed `mismatch`, and is the mistake `core/README.md`'s
  # `_integrity` row repeated until this same correction.)
  wiring_repair "$kit" "$tier" "$wiring"
  integrity_report "$tier" "$wiring"
}
