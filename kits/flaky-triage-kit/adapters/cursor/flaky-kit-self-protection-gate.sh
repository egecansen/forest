#!/bin/bash
# flaky-kit-self-protection-gate.sh — Hektor flaky-triage kit self-protection (Cursor port).
#
# Hook  : beforeShellExecution (Bash)  +  preToolUse matcher Write|Edit
# Mode  : DENY
# Env   : HEKTOR_FLAKYKIT_UNLOCK=1  required to modify the kit's own safety surface
#
# Cursor port of .claude/hooks/flaky-kit-self-protection-gate.sh — SAME
# detection logic (including the shared core/shell-guard.py quote/subshell-aware Bash check), Cursor I/O
# via cursor-compat.sh. Protects core/ + hooks/ + SKILL.md from silent self-modification.
#
# NOTE: Cursor exposes no reliable before-file-edit block, so the Write|Edit branch is best-effort. The
# OS-level wall that holds in EVERY harness (and against interpreter/compiled writers) is `core/lock-kit.sh lock`.
#
# Round2 — path canonicalization (honest framing: defense-in-depth, raising the bar against
# NATURAL, single-command, accidental/self-defeating bypasses — NOT a hard wall against a
# shell-capable agent; `base64 | bash`, a compiled helper, etc. always exist). SAME fix as the
# Claude gate: `canon_path()` realpath-canonicalizes a presented path (anchored on the reported
# cwd when relative) before the surface check, closing `./`, `../`, symlink, and bare cwd-relative
# bypasses; the Bash branch threads that same cwd into core/shell-guard.py (HEKTOR_FK_CWD) for its
# cd-chain tracking, and no longer prefilters with a plain grep (see the Claude gate's comment —
# a canonicalizable reference can lack the literal substring the prefilter greps for). Kept in
# sync with the Claude gate MANUALLY (this file has no shared-module mechanism with `.claude/`) —
# diffed after each change to confirm the detection core stays identical.
#
# Round 3 (LAST Bash-gate round) — two bypasses the Round-2-rereview REWRITE ITSELF introduced were
# closed in core/shell-guard.py: its MAX_SUBSHELL_DEPTH bound used to fail OPEN past the bound
# (allowing a surface write wrapped in one nesting level too many), and `{ ...; }` brace groups went
# untracked entirely (their `cd` never matched, so the write inside sailed through). Both now deny.
# Honest framing, stated plainly because this is the last round that chases shell constructs here:
# this gate (Write/Edit best-effort match + Bash/shell-guard.py string analysis) is BEST-EFFORT
# defense-in-depth against natural/accidental and simple adversarial surface writes. It CANNOT be
# made complete against a shell-capable agent — `base64 ... | bash`, `eval`, process substitution,
# exotic quoting, and compiled writers all bypass it by construction, no matter how much more
# pattern-matching is added. The REAL wall is `core/lock-kit.sh lock` (an OS-level read-only bit,
# now directory-level) — this gate is friction on top of that wall, never a substitute for it.
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
_AUDIT="$_DIR/lib/audit.sh"
if [ -f "$_AUDIT" ]; then . "$_AUDIT"; else hektor_audit() { :; }; fi
_COMPAT="$_DIR/lib/cursor-compat.sh"
if [ -f "$_COMPAT" ]; then . "$_COMPAT"; else exit 0; fi

cc_have_jq || exit 0   # jq absent -> fail-open
cc_read_input

# Patterns mirror the Claude gate's bash-ERE prefilter (kept in sync with core/shell-guard.py's python flavor).
# Round2 re-review: also covers both harnesses' gate scripts + vendored libs (`.cursor/hooks/*` and
# `.claude/hooks/lib/*` previously sat outside this pattern entirely — see the Claude gate's comment).
SURF_RE='\.claude/skills/hektor-flaky-triage/core/|\.claude/hooks/flaky-kit-self-protection-gate\.sh|\.cursor/hooks/(flaky-kit-self-protection-gate\.sh|lib/)|\.claude/hooks/lib/|\.claude/skills/hektor-flaky-triage/SKILL\.md'
# Fallback ONLY when python3/shell-guard.py is unavailable (degraded precision, documented).
MUT_RE='(>>?|[[:space:]]tee[[:space:]]|sed[[:space:]]+-i|(^|[;&|[:space:]])(cp|mv|rm|chmod|chown|truncate|dd|install|ln|rsync|patch)([[:space:]]|$)|(^|[;&|[:space:]])git[[:space:]]+(checkout|apply|restore|stash|reset|clean)([[:space:]]|$))'

# Same canon_path()/match_surface() as the Claude gate (kept in sync manually — see header note).
canon_path() {
  local raw="$1" cwd="$2"
  [ -n "$raw" ] || { printf '%s' "$raw"; return; }
  if command -v python3 >/dev/null 2>&1; then
    CWD="$cwd" python3 -c '
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

match_surface() {
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

CMD="$(cc_command)"
FP="$(cc_file_path)"
CWD="$(cc_json '.cwd // .workspace_roots[0] // .workspaceRoots[0] // .workspace_root // empty')"

# Shadow check: SAME detection as the Claude gate (kept in sync manually — see header note). The
# kit tree can be renamed aside and replaced without touching a single root-owned file, because
# rename() is governed by the parent directory. We cannot PREVENT that from here — but we hold the
# expectation OUTSIDE the kit tree, so we can say so out loud. Root is resolved via cc_repo_root()
# (this file's own project-root accessor — workspace_roots/cwd, falling back to git) rather than
# through Claude's CLAUDE_PROJECT_DIR, which does not exist in this harness. The expectation PATH
# itself stays identical to the Claude gate's (.claude/hooks/.flaky-kit-expect) — lock writes
# exactly one record regardless of which harness reads it.
#
# Honest limit: .claude/hooks/.flaky-kit-expect lives in a directory that must stay user-writable
# (this pack's own installer writes hooks there without sudo), so the SAME actor who can rename the
# kit tree aside can also delete this file — the record is not tamper-proof. What it still buys: a
# silent single `mv` becomes a two-step act, and a forgotten/incomplete cleanup (the common
# accidental case) still gets caught. Detection, not prevention.
_ROOT="$(cc_repo_root)"
_EXPECT="$_ROOT/.claude/hooks/.flaky-kit-expect"
if [ -r "$_EXPECT" ] && [ "$(cat "$_EXPECT" 2>/dev/null)" = "hardened" ] \
   && [ ! -d "$_ROOT/.claude/skills/hektor-flaky-triage/core" ]; then
  echo "flaky-kit gate: SHADOW WARNING — this project recorded a hardened flaky-triage kit, but the kit tree is no longer present at its expected path. It may have been renamed aside and replaced. Verify before trusting anything the kit reports." >&2
fi

if [ -n "$CMD" ]; then
  # beforeShellExecution: no cheap grep prefilter (see header note) — go straight to the shared
  # quote/subshell/canonicalization-aware surface-write check, threading cwd for its cd tracking.
  REPO="$(cc_repo_root)"
  GUARD="$REPO/.claude/skills/hektor-flaky-triage/core/shell-guard.py"
  if command -v python3 >/dev/null 2>&1 && [ -f "$GUARD" ]; then
    printf '%s' "$CMD" | HEKTOR_FK_CWD="$CWD" python3 "$GUARD" || exit 0
  else
    printf '%s' "$CMD" | grep -qE "$SURF_RE" || exit 0
    printf '%s' "$CMD" | grep -qE "$MUT_RE" || exit 0
  fi
  SURFACE="kit safety surface (Bash write)"; TARGET="$CMD"
elif [ -n "$FP" ]; then
  # Check the CANONICAL form first (closes ./ ../ symlink/cwd-relative bypasses); fall back to the
  # raw FP so an already-literal path still matches even if canon_path degraded to a no-op.
  if match_surface "$(canon_path "$FP" "$CWD")"; then :; elif match_surface "$FP"; then :; else exit 0; fi
  TARGET="$FP"
else
  exit 0
fi

# Unlock honoured (and audited) — same human-consent flag as the Claude gate + lock-kit.sh.
if [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ]; then
  hektor_audit "flaky-triage kit safety surface unlocked for write (Cursor): ${TARGET} (HEKTOR_FLAKYKIT_UNLOCK=1)"
  exit 0
fi

cc_deny "[BLOCKED — flaky-kit self-protection-gate] Refusing to modify the flaky-triage kit's safety surface (${SURFACE}).

Target: ${TARGET}

The kit's core/ scripts, config, and SKILL.md encode its safety invariants (input sanitization,
working-tree isolation, caps, the never-commit/ticket/disable rules, the data-not-instructions
discipline). Editing them from agent context — e.g. via a misclassification or a prompt injection
carried in untrusted report / qagent / Confluence text — is how the kit would be silently weakened.

If this is legitimate kit maintenance, set HEKTOR_FLAKYKIT_UNLOCK=1 in the environment for the command.
The unlock is recorded in docs/hektor/.hook-audit.log. For an OS-level wall, run: core/lock-kit.sh lock."
exit 0
