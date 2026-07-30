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

# _wiring_gate_claude <settings-file> <matcher> -> the command string registered for that matcher, or
# empty. Returns the COMMAND, not a yes/no: the harness runs whatever path that string names, so the
# existence check must land on it. Asking "does some command mention the gate?" and then stat-ing the
# path this kit would have installed are two different questions, and a settings.json copied between
# machines answers the first yes while the gate never runs.
_wiring_gate_claude() {
  jq -r --arg m "$2" '
    (.hooks.PreToolUse // [])
    | map(select(.matcher == $m))
    | map((.hooks // []) | map(.command // "")) | flatten
    | map(select(test("flaky-kit-self-protection-gate\\.sh")))
    | first // ""
  ' "$1" 2>/dev/null
}

# _wiring_gate_cursor <hooks-file> <event> -> the command string registered for that event, or empty.
_wiring_gate_cursor() {
  jq -r --arg e "$2" '
    ((.hooks[$e]) // []) | map(.command // "")
    | map(select(test("flaky-kit-self-protection-gate\\.sh")))
    | first // ""
  ' "$1" 2>/dev/null
}

# _wiring_resolve <command-string> <project_root> -> an absolute path, or empty.
#
# Read `install.sh` for the exact strings both harnesses are registered with — that file is the
# authority on the format, not this comment — and handle at minimum: surrounding quotes, a
# $CLAUDE_PROJECT_DIR or ${CLAUDE_PROJECT_DIR} prefix, an absolute path, and a path relative to the
# project root. Trailing arguments after the script path are dropped.
#
# Known limitation, to be stated rather than hidden: a registered path containing spaces resolves to
# its first token.
_wiring_resolve() {
  local cmd="${1:-}" root="${2:-}" p
  [ -n "$cmd" ] || return 0
  p="$(printf '%s' "$cmd" | tr -d '"'\''')"
  p="${p%%[[:space:]]*}"
  p="$(printf '%s' "$p" | sed -e "s|\${CLAUDE_PROJECT_DIR}|$root|g" -e "s|\$CLAUDE_PROJECT_DIR|$root|g")"
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
  # root-owned without the password. Below hardened, ownership proves nothing, so existence is all
  # there is to check — claiming more there would be the overclaim this kit keeps retracting.
  if [ "$tier" = hardened ] && [ "$(integrity_owner_uid "$gate")" != "0" ]; then echo foreign; return 0; fi
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
# Every failure mode resolves to `absent` and prints nothing: no jq, unreadable settings, or a
# layout that is not an installed kit. Not knowing is not the same as broken, and a check that
# cannot run must not wedge the caller.
integrity_wiring() {
  local kit="${1:-}" tier="${2:-}" root f m e cmd g gate got want out=absent wc wu
  root="$(integrity_project_root "$kit")"
  [ -n "$root" ] || { echo absent; return 0; }
  command -v jq >/dev/null 2>&1 || { echo absent; return 0; }

  # Which harnesses this kit was installed for. Every loop variable is declared local above: this
  # file is sourced by ten entrypoints and `m` and `e` are already globals in core/rerun.sh, so an
  # undeclared one is a collision waiting for someone to reorder two lines.
  set -- $(_wiring_want "$kit" "$root")
  wc="${1:-0}"; wu="${2:-0}"

  # Claude: a registration in EITHER settings file counts — requiring both would fail every project
  # that uses only one. Both matchers are required, because half a registration is half the gate.
  if [ "$wc" = 1 ]; then
    got=0; want=2; gate=''
    for m in 'Write|Edit' 'Bash'; do
      for f in "$root/.claude/settings.json" "$root/.claude/settings.local.json"; do
        [ -r "$f" ] || continue
        cmd="$(_wiring_gate_claude "$f" "$m")"
        [ -n "$cmd" ] || continue
        got=$((got+1))
        g="$(_wiring_resolve "$cmd" "$root")"
        # Prefer a path that is missing. If either matcher points somewhere that does not exist, the
        # gate does not run for that tool call, and `dangling` is the honest answer for the pair.
        if [ ! -f "$g" ] || [ -z "$gate" ]; then gate="$g"; fi
        break
      done
    done
    out="$(_wiring_worse "$out" "$(_wiring_one "$gate" "$tier" "$got" "$want")")"
  fi

  # Cursor: one file, two events.
  if [ "$wu" = 1 ]; then
    got=0; want=2; gate=''
    for e in beforeShellExecution preToolUse; do
      cmd="$(_wiring_gate_cursor "$root/.cursor/hooks.json" "$e")"
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

# integrity_report <tier> -> 0 to proceed, 76 to refuse. Prints to stderr, never stdout, so it can
# never contaminate a script whose stdout is a JSON contract (rerun, gate, ledger, summary).
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
  local tier="${1:-}"
  case "$tier" in
    hardened) return 0 ;;
    stale)
      echo "integrity: core/ is root-owned but .lock-state disagrees — treating as hardened; re-run 'core/lock-kit.sh lock' to refresh the record" >&2
      return 0 ;;
    unlocked)
      echo "integrity: the kit is UNLOCKED (maintenance window open) — its safety surface is writable right now. Re-lock when done: core/lock-kit.sh lock" >&2
      return 0 ;;
    degraded)
      echo "integrity: DEGRADED tier — the surface is read-only but still owned by this user, so this account can reverse it with a single chmod. Harden with: core/lock-kit.sh lock (needs sudo)" >&2
      return 0 ;;
    unprotected)
      echo "integrity: UNPROTECTED — lock has never run here, so the safety surface is plainly writable by this user and by any agent running as them. Nothing is enforcing the kit's invariants. Protect it with: core/lock-kit.sh lock (needs sudo)" >&2
      return 0 ;;
    mismatch)
      echo "integrity: MISMATCH — this kit was locked at the hardened tier, but core/ is no longer root-owned." >&2
      echo "integrity: this is not the tree that was hardened. Refusing: nothing it produces — summary, verdict, cluster table — should be trusted." >&2
      echo "integrity: if you unlocked deliberately, run 'core/lock-kit.sh lock' to re-establish the tier." >&2
      return 76 ;;
  esac
  return 0
}

# integrity_guard <kit_root> -> 0 to proceed, 76 to refuse.
# The trivial composition: real uid + recorded state -> tier -> report. It reads NO environment
# override — the tier always comes from the filesystem. Each half is tested on its own
# (integrity_tier with synthetic uids, integrity_report with synthetic tiers), which is the same
# split already used elsewhere in this file, so nothing here needs a back door to be exercised.
integrity_guard() {
  local kit="${1:-}"
  integrity_report "$(integrity_tier "$(integrity_owner_uid "$kit/core")" "$(integrity_state "$kit")")"
}
