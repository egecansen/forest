#!/bin/bash
# core/_integrity.sh — is this tree still the tree that was locked?
#
# WHY: core/lock-kit.sh can now establish a HARDENED tier (core/** owned by root, so only a
# password-gated sudo can reopen it) or fall back to a DEGRADED tier (chmod a-w only, which the
# owning user — and therefore the agent — can always reverse). A kit that silently slipped from the
# first to the second would still LOOK locked while enforcing nothing. Source this and ask.
#
# LIMIT, stated up front: this check lives INSIDE the tree it validates, so it cannot detect
# SHADOWING (`mv` the kit dir aside and put a fake one in its place) — a shadowed tree carries its
# own state file and is indistinguishable from a fresh un-hardened install. That case is the
# relocated gate's job (.claude/hooks/, outside the shadowable tree). This check catches ACCIDENTS:
# an upgrade that dropped ownership, a kit installed but never hardened, a maintenance unlock left
# open. Two different jobs, deliberately not conflated.
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

# integrity_tier <owner_uid> <recorded_tier> -> hardened|unlocked|degraded|mismatch|stale
# Ranks protection: root-owned is 2, anything else is 1; a recorded "hardened" expects 2, all else 1.
# Weaker-than-recorded is the dangerous direction and is the only one that yields `mismatch`.
integrity_tier() {
  local owner="${1:-}" recorded="${2:-}" actual=1 expected=1
  [ "$owner" = "0" ] && actual=2
  [ "$recorded" = "hardened" ] && expected=2
  if [ "$actual" -lt "$expected" ]; then echo mismatch; return 0; fi
  if [ "$actual" -gt "$expected" ]; then echo stale; return 0; fi
  case "$recorded" in
    hardened|unlocked|degraded) echo "$recorded" ;;
    *)                          echo degraded ;;
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
      echo "integrity: DEGRADED tier — the surface is read-only but still owned by this user, so this account can reverse it. Harden with: core/lock-kit.sh lock (needs sudo)" >&2
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
