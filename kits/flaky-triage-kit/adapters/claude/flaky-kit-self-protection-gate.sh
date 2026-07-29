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
#   - .claude/skills/hektor-flaky-triage/core/**        (invariant logic + config)
#   - .claude/hooks/flaky-kit-self-protection-gate.sh   (this gate — protect the protector; lives
#                                                        outside the kit tree so it can't be
#                                                        renamed away along with it, see Task 5/6)
#   - .claude/skills/hektor-flaky-triage/SKILL.md       (the skill prompt + safety rules)
#
# Mirrors .claude/hooks/enforcement-self-protection-gate.sh. This is FRICTION,
# not a wall — this harness doesn't honor PreToolUse `deny`, and the unlock is
# settable — the point is to convert casual / injected self-modification into a
# deliberate, audited act. It now also matches Bash commands that mutate the
# surface (redirect / sed -i / cp / mv / rm / chmod / git checkout|apply|restore|
# stash|reset|clean / rsync / patch), closing the Write|Edit-only gap heuristically.
# The REAL wall (an OS read-only bit) is `core/lock-kit.sh`, also keyed to
# HEKTOR_FLAKYKIT_UNLOCK. Legitimate kit maintenance sets the unlock flag; the use
# is logged to docs/hektor/.hook-audit.log.
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
# pattern-matching is added. The REAL wall is `core/lock-kit.sh lock` (an OS-level read-only bit,
# now directory-level) — this gate is friction on top of that wall, never a substitute for it.
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
# Honest limit: .claude/hooks/.flaky-kit-expect lives in a directory that must stay user-writable
# (this pack's own installer writes hooks there without sudo), so the SAME actor who can rename the
# kit tree aside can also delete this file — the record is not tamper-proof. What it still buys: a
# silent single `mv` becomes a two-step act, and a forgotten/incomplete cleanup (the common
# accidental case) still gets caught. Detection, not prevention.
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
if [ -r "$_EXPECT" ] && [ "$(cat "$_EXPECT" 2>/dev/null)" = "hardened" ] \
   && [ ! -d "$_ROOT/.claude/skills/hektor-flaky-triage/core" ]; then
  echo "flaky-kit gate: SHADOW WARNING — this project recorded a hardened flaky-triage kit, but the kit tree is no longer present at its expected path. It may have been renamed aside and replaced. Verify before trusting anything the kit reports." >&2
fi

# Surface = the kit's invariant logic, config, protection hooks, and skill prompt — PLUS both
# harnesses' self-protection gate scripts and their vendored libs (Round2 re-review: a prior audit
# found `.cursor/hooks/*` and `.claude/hooks/lib/*` sat OUTSIDE this pattern entirely, so a Claude
# session could freely Edit the Cursor gate — or this gate's own audit lib — and neither gate would
# notice. Kept precise: only the gate filenames + their lib/ dirs, not the whole `.cursor/`/
# `.claude/hooks/` trees, which hold plenty of unrelated, legitimately-editable files).
SURF_RE='\.claude/skills/hektor-flaky-triage/core/|\.claude/hooks/flaky-kit-self-protection-gate\.sh|\.cursor/hooks/(flaky-kit-self-protection-gate\.sh|lib/)|\.claude/hooks/lib/|\.claude/skills/hektor-flaky-triage/SKILL\.md'
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
  case "$1" in
    */.claude/skills/hektor-flaky-triage/core/*)          SURFACE="kit core (invariant logic + config)"; return 0 ;;
    */.claude/skills/hektor-flaky-triage/SKILL.md)        SURFACE="kit skill prompt"; return 0 ;;
    */.claude/hooks/flaky-kit-self-protection-gate.sh)    SURFACE="kit protection hook (Claude)"; return 0 ;;
    */.cursor/hooks/flaky-kit-self-protection-gate.sh)    SURFACE="kit protection hook (Cursor)"; return 0 ;;
    */.cursor/hooks/lib/*)                                SURFACE="kit protection hook lib (Cursor)"; return 0 ;;
    */.claude/hooks/lib/*)                                SURFACE="kit protection hook lib (Claude)"; return 0 ;;
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
