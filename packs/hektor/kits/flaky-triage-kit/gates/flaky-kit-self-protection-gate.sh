#!/bin/bash
# flaky-kit-self-protection-gate.sh — Hektor flaky-triage kit self-protection.
#
# Events: beforeShellExecution  +  preToolUse
# Mode  : DENY
# Env   : HEKTOR_FLAKYKIT_UNLOCK=1  required to modify the kit's own safety surface
#
# What it guards
# --------------
# The kit's safety surface: the kit tree (`core/**` + `SKILL.md`, and the tree itself as a command
# operand), this gate and the delivery gate beside it, their vendored libs, the out-of-tree
# `.flaky-kit-expect` lock-tier record, the hooks directory as an operand, and the registration
# file without which none of the rest ever runs.
#
# There is no in-tree `hooks/` directory — the gates live outside the kit tree so a rename of that
# tree cannot take its own detector along with it.
#
# Two branches, two different rules
# ---------------------------------
# * beforeShellExecution — a path match plus a mutation check. The real work is
#   core/shell-guard.py, which is quote-, subshell- and cd-chain-aware; the plain-grep pair below
#   is the degraded fallback for when python3 is unavailable.
# * preToolUse — for the registration file specifically the payload is available, so this branch
#   answers the actual question rather than a proxy for it: with this change applied, is the kit's
#   gate still registered? Deny only on a LOSS. See the `match_surface` comment.
#
# Honest limits — read these before adding more pattern-matching
# ---------------------------------------------------------------
# This gate is BEST-EFFORT defence-in-depth, not a wall, and it cannot be made into one. Against a
# shell-capable agent, `base64 ... | bash`, `eval`, process substitution, exotic quoting and
# compiled writers all bypass it by construction, no matter how much more pattern-matching is
# added. Three separate rounds of chasing shell constructs here hit diminishing returns; the
# answer is the OS layer, not more regex.
#
# The wall, at the hardened tier, is `core/lock-kit.sh lock` chown'ing the safety surface (core/**,
# SKILL.md, the gate scripts and their vendored libs) and the kit ROOT to root — not merely a
# read-only bit, which a same-user chmod reverses. Below hardened it degrades to exactly that
# chmod-only bit. This gate is friction on top of whichever tier is actually reached, never a
# substitute for either.
#
# Rename-aside is detectable, not preventable: rename() is governed by the parent directory, so the
# expectation is held OUTSIDE the kit tree (`.flaky-kit-expect`) and the shadow check below reports
# a mismatch rather than blocking one. That record sits in a directory which must stay
# user-writable, so it is not tamper-proof either — but a silent single `mv` becomes a two-step
# act, and the common accidental case still gets caught.
#
# `canon_path()` realpath-canonicalizes a presented path (anchored on the reported cwd when
# relative) before the surface check, closing `./`, `../`, symlink and bare cwd-relative
# references. The shell branch threads that same cwd into core/shell-guard.py (HEKTOR_FK_CWD) for
# its cd-chain tracking, and deliberately does not prefilter with a plain grep — a canonicalizable
# reference can lack the literal substring such a prefilter would look for.
#
# Two design choices in the write branch, stated because they are choices and not oversights: an
# edit to a registration file that carries NO registration today passes (the rule is "would lose
# what it has", never "must always end registered" — a project that never installed this kit is not
# frozen out of its own config), and unparseable proposed JSON is DENIED (survival cannot be
# verified, and writing malformed config is itself a defect — the pack's run-status-write-gate sets
# that precedent).
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
_AUDIT="$_DIR/lib/audit.sh"
if [ -f "$_AUDIT" ]; then . "$_AUDIT"; else hektor_audit() { :; }; fi
_CURSOR="$_DIR/lib/cursor.sh"
if [ -f "$_CURSOR" ]; then . "$_CURSOR"; else exit 0; fi
hektor_hook_enabled() { return 0; }   # the kit's gates are not profile-tiered

hektor_gate_init flaky-kit-self-protection-gate
JQ="$CC_JQ"

# The shell-branch prefilter, kept in step with core/shell-guard.py's python flavour.
#
# Three things about this pattern are easy to get wrong, and each was, historically:
#
# 1. DIRECTORY OPERANDS must match. Every alternative used to end in `/`, so moving or recursively
#    deleting the kit tree — or the hooks directory itself — was a silent, unaudited ALLOW. Hence
#    the `($|[[:space:]";)&|])` arms. An ordinary file inside the hooks directory is still
#    deliberately NOT surface; only the kit's own gates, their lib, and the tier record are.
#
# 2. THE REGISTRATION is surface too, because nothing else here protects the thing that makes any
#    of it run. Unregistering the gate is cheaper than editing it, and every other entry on this
#    surface is downstream of that registration existing. `.cursor/hooks.json` is the real and only
#    registration file — checked, not assumed: Cursor has no project-level `settings.json` of any
#    kind (user settings are a SQLite blob, and a `.vscode/settings.json`-style per-project
#    override does not work in Cursor at all), so there is no settings arm to add.
#
# 3. THE DELIVERY GATE and the tier record are surface. Both shipped onto `core/lock-kit.sh`'s
#    `harden_targets` and onto no self-protection surface at all — and membership of a chown list
#    is not protection below the hardened tier.
#
# Shell-branch pattern ONLY. `match_surface` below (the write branch) deliberately carries no
# hooks.json arm: that path is decided by outcome, not by a path match. See that function.
SURF_RE='\.cursor/skills/hektor-flaky-triage(/|$|[[:space:]";)&|])|\.cursor/hooks/(flaky-kit-self-protection-gate\.sh|flaky-kit-delivery-gate\.sh|\.flaky-kit-expect|lib/)|\.cursor/hooks($|[[:space:]";)&|])|\.cursor/hooks\.json'
# Fallback ONLY when python3/shell-guard.py is unavailable (degraded precision, documented).
MUT_RE='(>>?|[[:space:]]tee[[:space:]]|sed[[:space:]]+-i|(^|[;&|[:space:]])(cp|mv|rm|chmod|chown|truncate|dd|install|ln|rsync|patch)([[:space:]]|$)|(^|[;&|[:space:]])git[[:space:]]+(checkout|apply|restore|stash|reset|clean)([[:space:]]|$))'

# Realpath-canonicalize a presented path, anchored on the reported cwd when relative.
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

# _reg_slots <json-file> -> one sorted "<event>:<tool>" line per TOOL the kit's gate is registered to
# cover, e.g. "preToolUse:Write" / "beforeShellExecution:*". Silent and empty for
# an unreadable or unparseable file.
#
# `test(...)` on the gate FILENAME, not on a whole command string, because we are asking whether the
# REGISTRATION exists — not whether some text happens to appear.
#
# Survival is measured per slot by the TOOLS THE SLOT COVERS, not as a count over a flattened list and
# not by the matcher's literal spelling:
#   - A count (`… | length > 0`) asks "does some command mention the gate?" — the Task 1 defect's
#     shape. It reads deleting the whole shell registration as a survival, because the write arm
#     still names the gate, and that unwires exactly the branch the shell surface work closed.
#     core/_integrity.sh already calls half a registration `partial`; a count here would have the kit
#     calling one state broken on one axis and fine on the other.
#   - The matcher STRING would deny an edit that widens a matcher to cover one more tool — a
#     change that leaves the registration strictly better than it found it. That is the same
#     over-denial this branch forbids, arriving through string identity instead of a path match.
# So: split the matcher on `|`, one line per tool, and treat `*` (or an absent matcher) as covering
# everything. `preToolUse` entries carry a `matcher`, so they are keyed by event AND tool — keying
# them by event alone would let a matcher be retargeted to an inert tool and read as a survival.
# `beforeShellExecution` has no matcher concept: it fires for every shell execution, so it covers
# `*` by construction rather than by omission.
#
# `stop:*` is the DELIVERY gate's slot, and it is here because without it this branch could not
# see the cheapest way to unwire that gate: a write applying `del(.hooks.stop)` leaves every other
# key this function reads untouched, so the outcome test would be blind to the one key removed.
# `stop` fires once at end-of-session and has no matcher concept, so it covers `*` by construction,
# exactly as `beforeShellExecution` does.
#
# A SEPARATE `delivery` predicate, not the delivery gate's name folded into `gate` above. `gate` is
# consulted for the preToolUse tools too, so one shared predicate would let a preToolUse
# registration of the DELIVERY gate count as covering a write tool — a different gate satisfying a
# slot it does not guard, which is the same proxy-for-a-property shape this kit keeps retracting.
# core/_integrity.sh's `_wiring_slots_stop` splits it for the same reason, so the two axes go on
# deriving the same slots from the same document.
_reg_slots() {
  "$JQ" -r '
    def gate: select((.command // "") | test("flaky-kit-self-protection-gate\\.sh"));
    def delivery: select((.command // "") | test("flaky-kit-delivery-gate\\.sh"));
    def tools($m): (if ($m // "") == "" then "*" else $m end) | split("|") | .[];
    [ (.hooks.preToolUse // [])[]? | .matcher as $m | gate | "preToolUse:\(tools($m))" ]
    + [ (.hooks.beforeShellExecution // [])[]? | gate | "beforeShellExecution:*" ]
    + [ (.hooks.stop // [])[]? | delivery | "stop:*" ]
    | unique | .[]
  ' "$1" 2>/dev/null
}

# _slots_kept <before> <after> -> 0 when every tool covered by a registered slot today is still
# covered by some registered slot afterwards. Added coverage is fine; only a LOSS denies. An
# "<event>:*" line in <after> covers every tool of that event, which is what makes collapsing two
# matchers into one wildcard a survival rather than a loss.
#
_slots_kept() {
  local s ev
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    printf '%s\n' "$2" | grep -qxF "$s" && continue
    ev="${s%%:*}"
    printf '%s\n' "$2" | grep -qxF "$ev:*" && continue
    return 1
  done <<SLOTS
$1
SLOTS
  return 0
}

match_surface() {
  # Kept in step with SURF_RE above, including the directory-operand arms it explains.
  case "$1" in
    */.cursor/skills/hektor-flaky-triage/core/*)          SURFACE="kit core (invariant logic + config)"; return 0 ;;
    */.cursor/skills/hektor-flaky-triage/SKILL.md)        SURFACE="kit skill prompt"; return 0 ;;
    */.cursor/skills/hektor-flaky-triage|*/.cursor/skills/hektor-flaky-triage/*) \
                                                          SURFACE="kit tree"; return 0 ;;
    */.cursor/hooks/flaky-kit-self-protection-gate.sh)    SURFACE="kit protection hook"; return 0 ;;
    */.cursor/hooks/flaky-kit-delivery-gate.sh)           SURFACE="kit delivery hook"; return 0 ;;
    */.cursor/hooks/lib/*)                                SURFACE="kit protection hook lib"; return 0 ;;
    */.cursor/hooks/.flaky-kit-expect)                    SURFACE="kit lock-tier record (out-of-tree)"; return 0 ;;
    */.cursor/hooks)                                      SURFACE="hooks directory (holds the gates, their lib, and the lock-tier record)"; return 0 ;;
    *) return 1 ;;
  esac
}

CMD="$(hektor_command)"
FP="$(hektor_file_path)"
CWD="$(hektor_json '.cwd // .workspace_roots[0] // .workspaceRoots[0] // .workspace_root // empty')"

# Shadow check. The kit tree can be renamed aside and replaced without touching a single root-owned file, because
# rename() is governed by the parent directory. We cannot PREVENT that from here — but we hold the
# expectation OUTSIDE the kit tree, so we can say so out loud. Root is resolved via hektor_repo_root()
# (this file's own project-root accessor — workspace_roots/cwd, falling back to git) rather than
# rather than through an injected project-dir variable. Lock writes exactly one such record.
#
# It tests the kit's PROTECTION, not its PRESENCE. The first version fired only when core/ was
# ABSENT, so a rename-and-REPLACE — the case this warning's own text describes — was silent. Ownership
# is the unforgeable signal: a replaced tree cannot be root-owned without the password the hardened
# tier is built on. A legitimate maintenance window does not trip it, because `unlock` refreshes the
# record to `unlocked` (see core/lock-kit.sh's write_expect()).
#
# Honest limit: the expectation record lives in a directory that must stay user-writable
# (this pack's own installer writes hooks there without sudo), so the SAME actor who can rename the
# kit tree aside can also delete this file — the record is not tamper-proof. What it still buys: a
# silent single `mv` becomes a two-step act, and a forgotten/incomplete cleanup (the common
# accidental case) still gets caught. Detection, not prevention. The record and the directory holding
# it are now part of the matched surface, so erasing them is at least denied and audited here.
_ROOT="$(hektor_repo_root)"
_EXPECT="$_ROOT/.cursor/hooks/.flaky-kit-expect"
_CORE="$_ROOT/.cursor/skills/hektor-flaky-triage/core"

# The BSD/GNU stat branch is INLINED rather than sourced from the kit's own core/_integrity.sh,
# deliberately: this check judges a tree that may have been swapped out, and a helper read FROM that
# tree could be a replacement that reports whatever the replacer wants. A detector must not take its
# evidence from the thing it is auditing. Returns 0 always so a missing stat cannot wedge the gate.
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

if [ -n "$CMD" ]; then
  # beforeShellExecution: no cheap grep prefilter (see header note) — go straight to the shared
  # quote/subshell/canonicalization-aware surface-write check, threading cwd for its cd tracking.
  REPO="$(hektor_repo_root)"
  GUARD="$REPO/.cursor/skills/hektor-flaky-triage/core/shell-guard.py"
  if command -v python3 >/dev/null 2>&1 && [ -f "$GUARD" ]; then
    printf '%s' "$CMD" | HEKTOR_FK_CWD="$CWD" python3 "$GUARD" || exit 0
  else
    printf '%s' "$CMD" | grep -qE "$SURF_RE" || exit 0
    printf '%s' "$CMD" | grep -qE "$MUT_RE" || exit 0
  fi
  SURFACE="kit safety surface (Bash write)"; TARGET="$CMD"
elif [ -n "$FP" ]; then
  TARGET="$FP"
  TOOL_NAME="$(hektor_tool)"
  # The registration file is surface for shell (no content to inspect there) but decided by OUTCOME here,
  # where the payload is available: deny only when the kit's registration would not survive. Blanket-
  # denying would make this kit block unrelated hook edits in every project it is installed
  # into — heavy for a component that claims to be standalone — so `match_surface` carries
  # no hooks.json arm and this arm sits in front of it.
  case "$(canon_path "$TARGET" "$CWD")" in
    */.cursor/hooks.json)
      [ -r "$TARGET" ] || exit 0                     # nothing registered yet -> nothing to lose
      _before="$(_reg_slots "$TARGET")"
      # NOT "must always end registered": a project that never installed this kit must not be frozen
      # out of its own settings file, malformed content included.
      [ -n "$_before" ] || exit 0                    # not currently registered -> nothing to lose
      _prop="$(mktemp)"
      if [ "$TOOL_NAME" = Write ]; then
        hektor_content > "$_prop"
      else
        OLD="$(hektor_old_string)"
        NEW="$(hektor_new_string)"
        # `replace_all` is a first-class Edit parameter. Reconstructing with a single replacement
        # while the tool replaces every occurrence means judging a document that is not the one
        # being written — and a decoy mention of the gate filename, plantable by an edit this gate
        # allows, turns that gap into a two-step removal of both registrations.
        ALL="$(hektor_json '.tool_input.replace_all // .toolInput.replace_all // .replace_all // .tool_input.replaceAll // .replaceAll // false')"
        # Literal (never regex) replace, matching the Edit tool's own semantics — same lesson as
        # hooks/run-status-write-gate.sh, whose awk sub() reconstruction failed OPEN on a
        # metacharacter in old_string. No python3 -> reconstruct as "unchanged", which is the
        # fail-open floor: this gate must never wedge every tool call.
        #
        # Not byte-faithful in one respect, stated so nobody reuses it where that matters: OLD/NEW
        # come through command substitution, which strips trailing newlines, so a multi-line
        # old_string ending in one reconstructs slightly short. Harmless here because _reg_slots
        # reads JSON structure, which is whitespace-insensitive.
        python3 - "$TARGET" "$OLD" "$NEW" "$ALL" > "$_prop" <<'PY' || cp "$TARGET" "$_prop"
import sys
src, old, new, all_ = open(sys.argv[1]).read(), sys.argv[2], sys.argv[3], sys.argv[4] == "true"
sys.stdout.write(src if not old else src.replace(old, new) if all_ else src.replace(old, new, 1))
PY
      fi
      if "$JQ" -e . "$_prop" >/dev/null 2>&1; then
        # Survives only if every tool covered today is still covered. Added coverage is fine.
        if _slots_kept "$_before" "$(_reg_slots "$_prop")"; then rm -f "$_prop"; exit 0; fi
        SURFACE="hook registration — this change would leave the kit's gate unregistered"
      else
        SURFACE="hook registration — the proposed content is not parseable JSON, so the registration's survival cannot be verified"
      fi
      rm -f "$_prop" ;;
    *)
      # Check the CANONICAL form first (closes ./ ../ symlink/cwd-relative bypasses); fall back to the
      # raw FP so an already-literal path still matches even if canon_path degraded to a no-op.
      if match_surface "$(canon_path "$TARGET" "$CWD")"; then :; elif match_surface "$TARGET"; then :; else exit 0; fi ;;
  esac
else
  exit 0
fi

# Unlock honoured (and audited HERE, by this gate, when it's the one intercepting the call) — same
# flag lock-kit.sh uses, but HEKTOR_FLAKYKIT_UNLOCK is an intent marker, not
# consent; calling it "the human-consent flag" is the exact claim this kit's docs retract elsewhere
# (core/lock-kit.sh's header). The real consent, where the hardened tier requires any, is the sudo
# password lock-kit.sh prompts for — and lock-kit.sh's own direct invocations of `unlock` are never
# logged to the audit log at all, unlike this gate's interception of an agent's call.
if [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ]; then
  hektor_audit "flaky-triage kit safety surface unlocked for write (Cursor): ${TARGET} (HEKTOR_FLAKYKIT_UNLOCK=1)"
  exit 0
fi

hektor_deny "[BLOCKED — flaky-kit self-protection-gate] Refusing to modify the flaky-triage kit's safety surface (${SURFACE}).

Target: ${TARGET}

The kit's core/ scripts, config, and SKILL.md encode its safety invariants (input sanitization,
working-tree isolation, caps, the never-commit/ticket/disable rules, the data-not-instructions
discipline). Editing them from agent context — e.g. via a misclassification or a prompt injection
carried in untrusted report / qagent / Confluence text — is how the kit would be silently weakened.

If this is legitimate kit maintenance, set HEKTOR_FLAKYKIT_UNLOCK=1 in the environment for the command.
That use is recorded in docs/hektor/.hook-audit.log by this gate. For an OS-level wall independent of
any gate, run: core/lock-kit.sh lock — reaches the hardened tier (password-gated reopen) when sudo is
available, else only a chmod-only degraded bit the same user can reverse."
exit 0
