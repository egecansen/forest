#!/bin/bash
# flaky-kit-self-protection-gate.sh — stops the gated party (incl. the
#   hektor-flaky-triage skill itself) from silently weakening the kit's
#   own safety logic.
#
# Hook    : PreToolUse:Write|Edit|Bash
# Mode    : DENY
# State   : none
# Env     : HEKTOR_FLAKYKIT_UNLOCK=1   required to edit the kit's safety surface
#
# Why
# ---
# The flaky-triage kit encodes its safety invariants (I1 sanitize, I3 working-tree
# isolation, I6 caps, the config seam, the data-not-instructions discipline) in
# its `core/` scripts, its `config.json`, and its `SKILL.md`. Those are editable
# by the same agent the kit constrains — so a misclassification, a prompt
# injection (kernel.md §Packaging P1), or plain drift could neuter the kit with
# one Edit (P2/P4). This gate denies Write/Edit to the kit's safety surface:
#   - .claude/skills/hektor-flaky-triage/**             (the whole kit tree — invariant logic,
#                                                        config, skill prompt — AND the tree itself
#                                                        as an operand, so `mv`/`rm` of it is caught)
#   - .claude/hooks/flaky-kit-self-protection-gate.sh   (this gate — protect the protector; lives
#                                                        outside the kit tree so it can't be
#                                                        renamed away along with it, see Task 5/6)
#   - .claude/hooks/.flaky-kit-expect                   (the out-of-tree lock-tier record this gate's
#                                                        own shadow check reads)
#   - .claude/hooks/lib/, .cursor/hooks/{gate,lib/}     (the audit lib + the other harness's gate)
#   - .claude/hooks, .cursor/hooks                      (the DIRECTORIES, as operands — removing one
#                                                        removes the gate, the lib and the record)
#
# Mirrors .claude/hooks/enforcement-self-protection-gate.sh. This is FRICTION, not a wall:
# PreToolUse `deny` **is** enforced by the current CLI (verified 2026-06-30, observed live — see
# kernel §14 META and the Failure -> action table below, which treats DENY as the actual runtime
# outcome) — the earlier claim here that "this harness doesn't honor PreToolUse deny" is stale and
# retracted. What still keeps this friction rather than a wall: the unlock is settable by the very
# agent this gate constrains, and the match itself is a heuristic pattern a shell-capable agent can
# evade by construction (see Round 2/3 below) — the point is to convert casual / injected
# self-modification into a deliberate, audited act, not to be unbypassable. It did not even take
# construction to evade it until 2026-07-30: every surface alternative ended in `/`, so no DIRECTORY
# operand matched at all and `mv <kit> /tmp/x`, `rm -rf <kit>` and `rm -rf .claude/hooks` were silent
# ALLOWs. Fixed — and kept here as the standing argument for why "enforced deny" does not equal "wall".
# It now also matches
# Bash commands that mutate the surface (redirect / sed -i / cp / mv / rm / chmod / git checkout|apply|restore|
# stash|reset|clean / rsync / patch), closing the Write|Edit-only gap heuristically.
# The wall, when reached, is `core/lock-kit.sh lock`'s **hardened** tier: the safety surface — core/**,
# SKILL.md, both harnesses' gate scripts, their vendored libs — plus the kit ROOT directory, chown'd to
# root, so reopening needs a password rather than merely tripping this gate. Even there the out-of-tree
# files are protected against EDITS only: their parent directories must stay user-owned, so they can
# still be replaced. `core/lock-kit.sh`'s header carries the full residual list — read it rather than
# summarising the tier as "protected".
# Below hardened — chmod-only "degraded," or never locked at all ("unprotected") — this gate is the
# only friction there is; naming it "an OS read-only bit" without the tier would describe the
# degraded case, which a same-user chmod reverses. HEKTOR_FLAKYKIT_UNLOCK is an intent marker, not
# consent. Legitimate kit maintenance sets it; THIS gate logs that use to docs/hektor/.hook-audit.log
# when it (not `core/lock-kit.sh` itself) intercepts the matching call — see the Failure -> action
# table below, and `core/lock-kit.sh`'s own header for why running it directly is never logged there.
#
# Round2 — path canonicalization (honest framing: this is defense-in-depth, raising
# the bar against NATURAL, single-command, accidental/self-defeating bypasses — it
# is NOT a hard wall against a shell-capable agent; `base64 | bash`, a compiled
# helper, or any writer that doesn't go through this literal command string always
# exists). The Write/Edit `case` glob and the Bash SURF_RE both required literal
# path adjacency, so a `./` no-op segment, a `../`-then-back-in reversal, a symlink
# whose OWN path doesn't mention the surface, or a bare cwd-relative reference all
# sailed past unmatched. `canon_path()` resolves the presented path with realpath
# (same realpath-first discipline as core/apply.sh's I3 fix), anchored on the
# hook's `.cwd` when the path itself is relative, before the surface check —
# degrades to the raw string if python3 is unavailable (best-effort, not silently
# unsafe: the raw check still runs). The Bash branch also THREADS that same `.cwd`
# into core/shell-guard.py (HEKTOR_FK_CWD) so its own cd-chain tracking can anchor
# a bare relative reference on the command's REAL starting directory, not just
# text parsed out of the command itself.
#
# Round 3 (LAST Bash-gate round) — two bypasses the Round-2-rereview REWRITE ITSELF introduced were
# closed in core/shell-guard.py: its MAX_SUBSHELL_DEPTH bound used to fail OPEN past the bound
# (allowing a surface write wrapped in one nesting level too many), and `{ ...; }` brace groups went
# untracked entirely (their `cd` never matched, so the write inside sailed through). Both now deny.
# Honest framing, stated plainly because this is the last round that chases shell constructs here:
# this gate (Write/Edit case-glob + Bash/shell-guard.py string analysis) is BEST-EFFORT
# defense-in-depth against natural/accidental and simple adversarial surface writes. It CANNOT be
# made complete against a shell-capable agent — `base64 ... | bash`, `eval`, process substitution,
# exotic quoting, and compiled writers all bypass it by construction, no matter how much more
# pattern-matching is added. The wall, at the **hardened** tier, is `core/lock-kit.sh lock` chown'ing
# the safety surface (core/**, SKILL.md, both gate scripts and their vendored libs) and the kit ROOT to
# root — not merely a read-only bit, which a same-user chmod reverses; below hardened it degrades to
# exactly that chmod-only bit. This gate is friction on top of whichever tier is actually reached,
# never a substitute for either.
#
# Failure -> action
# -----------------
# - Write/Edit to the kit safety surface, unlock NOT set  -> DENY
# - Same, with HEKTOR_FLAKYKIT_UNLOCK=1                    -> ALLOW (audited)
# - Anything else                                         -> silent allow
set -uo pipefail

_LIB="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/.claude/hooks/lib/audit.sh"
if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | "$JQ" -r '.cwd // empty' 2>/dev/null || echo "")

# Shadow check: the kit tree can be renamed aside and replaced without touching a single root-owned
# file, because rename() is governed by the parent directory. We cannot PREVENT that from here — but
# we hold the expectation OUTSIDE the kit tree, so we can say so out loud.
#
# It tests the kit's PROTECTION, not its PRESENCE. The first version fired only when core/ was
# ABSENT, so a rename-and-REPLACE — the case this warning's own text describes ("renamed aside and
# replaced") — was silent, and the five places that asserted this detection as fact were all untrue.
# Ownership is the unforgeable signal: a replaced tree cannot be root-owned without the password the
# whole hardened tier is built on, so "recorded hardened, but core/ is missing OR not owned by uid 0"
# is the condition. A legitimate maintenance window does not trip it, because `unlock` refreshes the
# record to `unlocked` for exactly this reason (see core/lock-kit.sh's write_expect()).
#
# Honest limit: .claude/hooks/.flaky-kit-expect lives in a directory that must stay user-writable
# (this pack's own installer writes hooks there without sudo), so the SAME actor who can rename the
# kit tree aside can also delete this file — the record is not tamper-proof. What it still buys: a
# silent single `mv` becomes a two-step act, and a forgotten/incomplete cleanup (the common
# accidental case) still gets caught. Detection, not prevention. The record and the directory holding
# it are now part of the matched surface below, so erasing them is at least denied and audited here.
#
# Root resolution: falls back to git-toplevel CLIMBED FROM $CWD, same idea as _LIB/GUARD below but
# anchored on the reported tool-call cwd rather than this script's own process cwd — $CWD is
# frequently a SUBDIRECTORY of the project when CLAUDE_PROJECT_DIR is unset, and using it AS the
# root (the old behavior) put _EXPECT under the wrong directory, so `[ -r "$_EXPECT" ]` failed and
# this check silently never warned. `git -C "$CWD" rev-parse --show-toplevel` climbs from that
# subdirectory to the true top level, mirroring the Cursor gate's cc_repo_root() (which climbs from
# the same JSON-reported cwd) so the two gates agree instead of one silently missing the shadow.
_ROOT="${CLAUDE_PROJECT_DIR:-$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)}"
_EXPECT="$_ROOT/.claude/hooks/.flaky-kit-expect"
_CORE="$_ROOT/.claude/skills/hektor-flaky-triage/core"

# The BSD/GNU stat branch is INLINED here rather than sourced from the kit's own core/_integrity.sh,
# deliberately: this check exists to judge a tree that may have been swapped out, and a helper read
# FROM that tree could be a replacement that reports whatever the replacer wants. A detector must not
# take its evidence from the thing it is auditing — which is the same reason the record and this
# script live outside the kit in the first place. Same uname branch as _integrity.sh and
# adapters/_lib/audit.sh; returns 0 always so a missing stat can never wedge the gate.
_owner_uid() {
  [ -n "${1:-}" ] && [ -e "$1" ] || return 0
  case "$(uname -s 2>/dev/null)" in
    Darwin|*BSD) stat -f %u "$1" 2>/dev/null ;;
    *)           stat -c %u "$1" 2>/dev/null ;;
  esac
  return 0
}

if [ -r "$_EXPECT" ] && [ "$(cat "$_EXPECT" 2>/dev/null)" = "hardened" ]; then
  if [ ! -d "$_CORE" ]; then
    echo "flaky-kit gate: SHADOW WARNING — this project recorded a hardened flaky-triage kit, but the kit tree is no longer present at its expected path. It may have been renamed aside and replaced. Verify before trusting anything the kit reports." >&2
  elif [ "$(_owner_uid "$_CORE")" != "0" ]; then
    echo "flaky-kit gate: SHADOW WARNING — this project recorded a hardened flaky-triage kit, but the tree at its expected path is NOT root-owned. It may have been renamed aside and replaced with a tree this account controls, or the hardened tier was lost (a chown, a reinstall, an unlock that never re-locked). Run 'core/lock-kit.sh status' and verify before trusting anything the kit reports." >&2
  fi
fi

# Surface = the kit's invariant logic, config, protection hooks, and skill prompt — PLUS both
# harnesses' self-protection gate scripts and their vendored libs (Round2 re-review: a prior audit
# found `.cursor/hooks/*` and `.claude/hooks/lib/*` sat OUTSIDE this pattern entirely, so a Claude
# session could freely Edit the Cursor gate — or this gate's own audit lib — and neither gate would
# notice).
#
# DIRECTORY OPERANDS, added after a review showed the pattern could not match one at all. Every
# alternative ended in `/`, so `<kit>/core/config.json` matched but `<kit>`, `<kit>/core`,
# `.claude/hooks` and `.cursor/hooks` did not — and `mv <kit> /tmp/x`, `rm -rf <kit>`,
# `mv <kit>/core /tmp/x` and `rm -rf .claude/hooks` were therefore all ALLOWED and unaudited, at every
# tier below hardened (i.e. every existing install and every machine without sudo). The kit-tree
# alternative now matches the tree itself and everything under it, and the two harness hook
# DIRECTORIES match as operands. `.claude/hooks/.flaky-kit-expect` is listed explicitly: the gate
# script and the lib beside it were surface while the record they depend on was not, so editing the
# gate was DENY+audited and erasing its expectation was ALLOW+silent.
#
# Still kept precise where precision is right: an ordinary file INSIDE `.claude/hooks/` (this pack's
# other hooks, e.g. observe.sh) is deliberately NOT surface — only the gate, its lib/, the record, and
# the directory as an operand. Blanket-matching the whole `.claude/hooks/` tree would contradict the
# assertion in core/tests/self-protection-test.sh that an unrelated pack hook stays editable, and
# those files are legitimately edited. `mv`/`rm` of the DIRECTORY takes the gate with it, which is
# why the directory itself is in.
SURF_RE='\.claude/skills/hektor-flaky-triage(/|$|[[:space:]";)&|])|\.claude/hooks/(flaky-kit-self-protection-gate\.sh|\.flaky-kit-expect|lib/)|\.cursor/hooks/(flaky-kit-self-protection-gate\.sh|lib/)|\.(claude|cursor)/hooks($|[[:space:]";)&|])'
# Bash mutation indicators (redirect / in-place / copy / move / delete / perm / git-mutate / rsync /
# patch) — heuristic, errs toward flagging. Used as the fallback ONLY when python3/shell-guard.py
# is unavailable for the Bash branch below (degraded precision, documented, not silent).
MUT_RE='(>>?|[[:space:]]tee[[:space:]]|sed[[:space:]]+-i|(^|[;&|[:space:]])(cp|mv|rm|chmod|chown|truncate|dd|install|ln|rsync|patch)([[:space:]]|$)|(^|[;&|[:space:]])git[[:space:]]+(checkout|apply|restore|stash|reset|clean)([[:space:]]|$))'

# Best-effort realpath canonicalization of a possibly relative/./ /../ /symlinked path, anchored on
# $CWD when the path itself isn't absolute. Never fails the caller: any python3 error falls back to
# printing the raw path unchanged, so the ORIGINAL literal-match behavior is the floor, never worse.
canon_path() {
  local raw="$1"
  [ -n "$raw" ] || { printf '%s' "$raw"; return; }
  if command -v python3 >/dev/null 2>&1; then
    CWD="$CWD" python3 -c '
import os, sys
raw = sys.argv[1]
base = os.environ.get("CWD") or os.getcwd()
p = raw if os.path.isabs(raw) else os.path.join(base, raw)
try:
    print(os.path.realpath(p))
except Exception:
    print(os.path.normpath(p))
' "$raw" 2>/dev/null || printf '%s' "$raw"
  else
    printf '%s' "$raw"
  fi
}

match_surface() {  # $1 = a path -> sets SURFACE and returns 0, or returns 1
  # Kept in step with SURF_RE above, including the directory-operand arms it explains.
  case "$1" in
    */.claude/skills/hektor-flaky-triage/core/*)          SURFACE="kit core (invariant logic + config)"; return 0 ;;
    */.claude/skills/hektor-flaky-triage/SKILL.md)        SURFACE="kit skill prompt"; return 0 ;;
    */.claude/skills/hektor-flaky-triage|*/.claude/skills/hektor-flaky-triage/*) \
                                                          SURFACE="kit tree"; return 0 ;;
    */.claude/hooks/flaky-kit-self-protection-gate.sh)    SURFACE="kit protection hook (Claude)"; return 0 ;;
    */.cursor/hooks/flaky-kit-self-protection-gate.sh)    SURFACE="kit protection hook (Cursor)"; return 0 ;;
    */.cursor/hooks/lib/*)                                SURFACE="kit protection hook lib (Cursor)"; return 0 ;;
    */.claude/hooks/lib/*)                                SURFACE="kit protection hook lib (Claude)"; return 0 ;;
    */.claude/hooks/.flaky-kit-expect)                    SURFACE="kit lock-tier record (out-of-tree)"; return 0 ;;
    */.claude/hooks|*/.cursor/hooks)                      SURFACE="harness hooks directory (holds the gate, its lib, and the lock-tier record)"; return 0 ;;
    *) return 1 ;;
  esac
}

case "$TOOL_NAME" in
  Write|Edit)
    TARGET=$(echo "$INPUT" | "$JQ" -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
    [ -n "$TARGET" ] || exit 0
    # Check the CANONICAL form first (closes ./ ../ symlink/cwd-relative bypasses); fall back to the
    # raw TARGET so an already-literal path still matches even if canon_path degraded to a no-op.
    if match_surface "$(canon_path "$TARGET")"; then :; elif match_surface "$TARGET"; then :; else exit 0; fi ;;
  Bash)
    # Bash file-writes bypass the Write|Edit matcher — close that gap. Flag only when a command both
    # TOUCHES the surface AND MUTATES it (a read like `cat core/x.sh` passes through untouched).
    CMDSTR=$(echo "$INPUT" | "$JQ" -r '.tool_input.command // empty' 2>/dev/null || echo "")
    [ -n "$CMDSTR" ] || exit 0
    # precise, quote/subshell/canonicalization-aware decision via core/shell-guard.py (the SAME
    # helper the Cursor adapter uses — write-once). No cheap grep prefilter here: a canonicalizable
    # (./ ../ symlink/cwd-relative) surface reference can lack the literal SURF_RE substring
    # entirely, so a prefilter that greps for it would exit 0 before shell-guard.py — which DOES
    # canonicalize — ever runs. Every Bash command now pays one python3 spawn when the guard is
    # available; correctness over the fast path for a self-protection gate. Fail-open to the
    # whole-string MUT grep only if python3/the guard is unavailable (degraded, documented).
    GUARD="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/.claude/skills/hektor-flaky-triage/core/shell-guard.py"
    if command -v python3 >/dev/null 2>&1 && [ -f "$GUARD" ]; then
      printf '%s' "$CMDSTR" | HEKTOR_FK_CWD="$CWD" python3 "$GUARD" || exit 0
    else
      printf '%s' "$CMDSTR" | grep -qE "$SURF_RE" || exit 0
      printf '%s' "$CMDSTR" | grep -qE "$MUT_RE" || exit 0
    fi
    SURFACE="kit safety surface (Bash write)"; TARGET="$CMDSTR" ;;
  *) exit 0 ;;
esac

# Unlock honoured (and audited).
if [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ]; then
  hektor_audit "flaky-triage kit safety surface unlocked for write: ${TARGET} (HEKTOR_FLAKYKIT_UNLOCK=1)"
  exit 0
fi

"$JQ" -n --arg r "[BLOCKED — flaky-kit self-protection-gate] Refusing to modify the flaky-triage kit's safety surface (${SURFACE}).

Target: ${TARGET}

The kit's core/ scripts, config, and SKILL.md encode its safety invariants
(input sanitization, working-tree isolation, caps, the never-commit/ticket/disable
rules, the data-not-instructions discipline). Editing them from agent context —
e.g. via a misclassification or a prompt injection carried in untrusted report /
qagent / Confluence text — is how the kit would be silently weakened. Denied by
default.

If this is legitimate kit maintenance, set HEKTOR_FLAKYKIT_UNLOCK=1 in the
environment for the command. The unlock is recorded in docs/hektor/.hook-audit.log
so the change is deliberate and auditable.

This gate is friction, not a security boundary — see
docs/hektor/flaky-triage-kit/kernel.md §Packaging threat model (P2/P4)." '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": $r
  }
}'
exit 0
