#!/bin/bash
# flaky-kit-self-protection-gate.sh — Hektor flaky-triage kit self-protection (Cursor port).
#
# Hook  : beforeShellExecution (Bash)  +  preToolUse matcher Write|Edit
# Mode  : DENY
# Env   : HEKTOR_FLAKYKIT_UNLOCK=1  required to modify the kit's own safety surface
#
# Cursor port of .claude/hooks/flaky-kit-self-protection-gate.sh — SAME
# detection logic (including the shared core/shell-guard.py quote/subshell-aware Bash check), Cursor I/O
# via cursor-compat.sh. Protects the kit tree (core/ + SKILL.md, and the tree itself as an operand),
# both harnesses' gate scripts and vendored libs, the Claude-only delivery gate (the Stop hook that
# enforces I11), the out-of-tree `.flaky-kit-expect` tier record, and the two hook directories as
# operands. There is no in-tree `hooks/` directory — the gate was moved out
# of the kit tree so a rename of that tree cannot take its own detector along.
#
# NOTE: Cursor exposes no reliable before-file-edit block, so the Write|Edit branch is best-effort. The
# OS-level wall that holds in EVERY harness (and against interpreter/compiled writers) is
# `core/lock-kit.sh lock`'s **hardened** tier (chown to root, password-gated reopen); without `sudo`
# it degrades to a chmod-only bit the same user can reverse — friction, not a wall.
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
# pattern-matching is added. Nor did it take construction to evade until 2026-07-30: every surface
# alternative ended in `/`, so no DIRECTORY operand matched and `mv <kit> /tmp/x` was a silent ALLOW.
# The wall, at the **hardened** tier, is `core/lock-kit.sh lock` chown'ing the safety surface (core/**,
# SKILL.md, both gate scripts and their vendored libs) and the kit ROOT to root — not merely a read-only
# bit, which a same-user chmod reverses; below hardened it degrades to exactly that chmod-only bit. This
# gate is friction on top of whichever tier is actually reached, never a substitute for either.
#
# Round 4 — NOT another shell-construct chase (Round 3 above is still the last of those): this widens
# WHAT counts as surface for the BASH branch ONLY, not HOW a command is parsed and not the Write/Edit
# branch below. Every fix through Round 3 protected the gate and what it reads; none protected the
# registration that makes the gate run at all. `.claude/settings.json` / `.claude/settings.local.json`
# / `.cursor/hooks.json` join the Bash-branch surface for exactly that reason (`SURF_RE` below) — see
# the SURF_RE comment for the full reasoning, including why Cursor gets no arm of its own at all (it
# has no project-level settings.json, `.local` or otherwise). `match_surface` — the Write/Edit
# matcher — is deliberately UNCHANGED: that branch's rule is deny only when the kit's registration
# would not survive the edit, which needs the payload Round 5 inspects, not a path match.
#
# Round 5 — the Write/Edit half of the same hole, and deliberately NOT the same rule. That branch has
# the proposed content (`tool_input.content`, or `old_string`/`new_string` reconstructed against the
# file), so it can answer the property instead of a proxy for it: with this change applied, is the
# kit's gate still registered? Deny only when it currently is and would not be. Matching "the gate
# command string appears in the payload" would be the textual proxy, and a proxy standing in for a
# property has caused three separate defects in this kit already. Two consequences worth stating
# because they are choices, not oversights: an edit to a settings file that carries NO registration
# today passes (the rule is "would lose what it has", never "must always end registered" — a project
# that never installed this kit is not frozen out of its own settings), and unparseable proposed JSON
# is DENIED (survival cannot be verified, and writing malformed settings is itself a defect — the
# pack's run-status-write-gate sets that precedent). See the Claude gate for the same note in full.
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
_AUDIT="$_DIR/lib/audit.sh"
if [ -f "$_AUDIT" ]; then . "$_AUDIT"; else hektor_audit() { :; }; fi
_COMPAT="$_DIR/lib/cursor-compat.sh"
if [ -f "$_COMPAT" ]; then . "$_COMPAT"; else exit 0; fi

cc_have_jq || exit 0   # jq absent -> fail-open
cc_read_input
JQ="$CC_JQ"            # so _reg_slots() below stays byte-identical with the Claude gate's copy

# Patterns mirror the Claude gate's bash-ERE prefilter (kept in sync with core/shell-guard.py's python flavor).
# Round2 re-review: also covers both harnesses' gate scripts + vendored libs (`.cursor/hooks/*` and
# `.claude/hooks/lib/*` previously sat outside this pattern entirely — see the Claude gate's comment).
# Later review: DIRECTORY OPERANDS could not match at all, because every alternative ended in `/` —
# so `mv <kit> /tmp/x`, `rm -rf <kit>`, `mv <kit>/core /tmp/x` and `rm -rf .cursor/hooks` were all
# ALLOWED and unaudited, and `.claude/hooks/.flaky-kit-expect` (the record the shadow check above
# depends on) was not on the surface at all while the gate script beside it was. Both closed; see the
# Claude gate's comment for the full reasoning, including why an ordinary file inside `.claude/hooks/`
# is still deliberately NOT surface.
#
# HARNESS SETTINGS FILES, added because none of the above protects the thing that makes any of it RUN:
# the registration itself. `sed -i '' .claude/settings.json` (or `rm -f` it, or truncate it with a
# redirect) was a verified ALLOW — unregistering the gate is cheaper than editing it, and every other
# entry on this surface is downstream of that one registration existing. `.claude/settings.local.json`
# is included because Claude Code merges hook config from both project settings files. Cursor's real
# registration file is `.cursor/hooks.json` — checked, not assumed: Cursor has no project-level
# `settings.json` of ANY kind (not merely no `.local` variant — user settings are a SQLite blob, not a
# file, and a `.vscode/settings.json`-style per-project override does not work in Cursor at all), so no
# `.cursor/settings.json` arm is added, `.local` or otherwise. Bash-branch pattern ONLY: `match_surface`
# below (the Write/Edit matcher) is deliberately untouched by these settings paths; see the Claude
# gate's comment for the same reasoning in full.
#
# THE DELIVERY GATE (`.claude/hooks/flaky-kit-delivery-gate.sh`) joins the same alternative as its
# sibling. It shipped onto `core/lock-kit.sh`'s `harden_targets` and onto no self-protection surface
# at all, and membership of a chown list is not protection below the hardened tier — `rm -f` on it
# was a verified ALLOW, unaudited, on a real install fixture. Carried here even though this is the
# CURSOR gate and the delivery gate is Claude-only, for the reason the header states about the
# Cursor gate's own presence in the Claude pattern: a session in one harness must not be able to
# disable the OTHER harness's controls. No `.cursor/hooks/` arm for it — Cursor has no stop event, so
# that file never exists there. See the Claude gate's comment for the full reasoning.
SURF_RE='\.claude/skills/hektor-flaky-triage(/|$|[[:space:]";)&|])|\.claude/hooks/(flaky-kit-self-protection-gate\.sh|flaky-kit-delivery-gate\.sh|\.flaky-kit-expect|lib/)|\.cursor/hooks/(flaky-kit-self-protection-gate\.sh|lib/)|\.(claude|cursor)/hooks($|[[:space:]";)&|])|\.claude/settings(\.local)?\.json|\.cursor/hooks\.json'
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

# _reg_slots <json-file> -> one sorted "<event>:<tool>" line per TOOL the kit's gate is registered to
# cover, e.g. "PreToolUse:Bash" / "preToolUse:Write" / "beforeShellExecution:*". Silent and empty for
# an unreadable or unparseable file.
#
# Kept BYTE-IDENTICAL with the OTHER harness's gate (asserted by core/tests/self-protection-test.sh);
# only the I/O boundary that feeds it differs between the two harnesses.
#
# `test(...)` on the gate FILENAME, not on a whole command string, because we are asking whether the
# REGISTRATION exists — not whether some text happens to appear.
#
# Survival is measured per slot by the TOOLS THE SLOT COVERS, not as a count over a flattened list and
# not by the matcher's literal spelling:
#   - A count (`… | length > 0`) asks "does some command mention the gate?" — the Task 1 defect's
#     shape. It reads deleting the whole `Bash` matcher as a survival, because the `Write|Edit` arm
#     still names the gate, and that unwires exactly the branch the Bash surface work closed.
#     core/_integrity.sh already calls half a registration `partial`; a count here would have the kit
#     calling one state broken on one axis and fine on the other.
#   - The matcher STRING would deny an edit that widens `Write|Edit` to `Write|Edit|MultiEdit` — a
#     change that leaves the registration strictly better than it found it. That is the same
#     over-denial this branch forbids, arriving through string identity instead of a path match.
# So: split the matcher on `|`, one line per tool, and treat `*` (or an absent matcher) as covering
# everything. Cursor's `preToolUse` entries carry a `matcher` exactly as Claude's `PreToolUse` ones
# do and are keyed the same way — keying them by event alone would let a Cursor matcher be retargeted
# to an inert tool and read as a survival while the identical Claude-side change is caught.
# `beforeShellExecution` is the one event with no matcher concept in either harness: it fires for
# every shell execution, so it covers `*` by construction rather than by omission.
#
# `Stop:*` is the DELIVERY gate's slot, and it is here because without it this branch could not see
# the cheapest way to unwire that gate. Measured before it existed, on a real `install.sh --harness
# claude` fixture: a Write applying `del(.hooks.Stop)` with the PreToolUse registration left intact
# was an ALLOW, because every key this function read was untouched — the outcome test was blind to
# the one key the write removed. `Stop` fires once at end-of-session and has no matcher concept, so
# it covers `*` by construction, exactly as `beforeShellExecution` does.
#
# A SEPARATE `delivery` predicate, not the delivery gate's name folded into `gate` above. `gate` is
# consulted for the PreToolUse/preToolUse tools too, so one shared predicate would let a PreToolUse
# registration of the DELIVERY gate count as covering Write, Edit or Bash — a different gate
# satisfying a slot it does not guard, which is the same proxy-for-a-property shape this kit keeps
# retracting. core/_integrity.sh's `_wiring_slots_stop` splits it for exactly this reason and this
# is the same split, so the two axes go on deriving the same slots from the same document.
#
# On Cursor this arm is silent by construction: `.cursor/hooks.json` has no `Stop` key, so it emits
# nothing there BEFORE an edit and nothing AFTER — and `_slots_kept` only ever denies on a LOSS, so
# absent-before/absent-after is not a dropped registration. That is what lets the function stay
# byte-identical across the two harnesses while naming a Claude-only control.
_reg_slots() {
  "$JQ" -r '
    def gate: select((.command // "") | test("flaky-kit-self-protection-gate\\.sh"));
    def delivery: select((.command // "") | test("flaky-kit-delivery-gate\\.sh"));
    def tools($m): (if ($m // "") == "" then "*" else $m end) | split("|") | .[];
    [ (.hooks.PreToolUse // [])[]? | .matcher as $m | (.hooks // [])[]? | gate | "PreToolUse:\(tools($m))" ]
    + [ (.hooks.preToolUse // [])[]? | .matcher as $m | gate | "preToolUse:\(tools($m))" ]
    + [ (.hooks.beforeShellExecution // [])[]? | gate | "beforeShellExecution:*" ]
    + [ (.hooks.Stop // [])[]? | (.hooks // [])[]? | delivery | "Stop:*" ]
    | unique | .[]
  ' "$1" 2>/dev/null
}

# _slots_kept <before> <after> -> 0 when every tool covered by a registered slot today is still
# covered by some registered slot afterwards. Added coverage is fine; only a LOSS denies. An
# "<event>:*" line in <after> covers every tool of that event, which is what makes collapsing two
# matchers into one wildcard a survival rather than a loss.
#
# Kept BYTE-IDENTICAL with the OTHER harness's gate (asserted by core/tests/self-protection-test.sh).
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
    */.claude/skills/hektor-flaky-triage/core/*)          SURFACE="kit core (invariant logic + config)"; return 0 ;;
    */.claude/skills/hektor-flaky-triage/SKILL.md)        SURFACE="kit skill prompt"; return 0 ;;
    */.claude/skills/hektor-flaky-triage|*/.claude/skills/hektor-flaky-triage/*) \
                                                          SURFACE="kit tree"; return 0 ;;
    */.claude/hooks/flaky-kit-self-protection-gate.sh)    SURFACE="kit protection hook (Claude)"; return 0 ;;
    */.claude/hooks/flaky-kit-delivery-gate.sh)           SURFACE="kit delivery hook (Claude)"; return 0 ;;
    */.cursor/hooks/flaky-kit-self-protection-gate.sh)    SURFACE="kit protection hook (Cursor)"; return 0 ;;
    */.cursor/hooks/lib/*)                                SURFACE="kit protection hook lib (Cursor)"; return 0 ;;
    */.claude/hooks/lib/*)                                SURFACE="kit protection hook lib (Claude)"; return 0 ;;
    */.claude/hooks/.flaky-kit-expect)                    SURFACE="kit lock-tier record (out-of-tree)"; return 0 ;;
    */.claude/hooks|*/.cursor/hooks)                      SURFACE="harness hooks directory (holds the gate, its lib, and the lock-tier record)"; return 0 ;;
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
# It tests the kit's PROTECTION, not its PRESENCE. The first version fired only when core/ was
# ABSENT, so a rename-and-REPLACE — the case this warning's own text describes — was silent. Ownership
# is the unforgeable signal: a replaced tree cannot be root-owned without the password the hardened
# tier is built on. A legitimate maintenance window does not trip it, because `unlock` refreshes the
# record to `unlocked` (see core/lock-kit.sh's write_expect()).
#
# Honest limit: .claude/hooks/.flaky-kit-expect lives in a directory that must stay user-writable
# (this pack's own installer writes hooks there without sudo), so the SAME actor who can rename the
# kit tree aside can also delete this file — the record is not tamper-proof. What it still buys: a
# silent single `mv` becomes a two-step act, and a forgotten/incomplete cleanup (the common
# accidental case) still gets caught. Detection, not prevention. The record and the directory holding
# it are now part of the matched surface, so erasing them is at least denied and audited here.
_ROOT="$(cc_repo_root)"
_EXPECT="$_ROOT/.claude/hooks/.flaky-kit-expect"
_CORE="$_ROOT/.claude/skills/hektor-flaky-triage/core"

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
  TARGET="$FP"
  TOOL_NAME="$(cc_tool)"
  # Settings files are surface for Bash (no content to inspect there) but decided by OUTCOME here,
  # where the payload is available: deny only when the kit's registration would not survive. Blanket-
  # denying would make this kit block unrelated permission/env/model edits in every project it is
  # installed into — heavy for a component that claims to be standalone — so `match_surface` carries
  # no settings arm and this arm sits in front of it. Same decision as the Claude gate; only the three
  # payload accessors below differ, per this file's I/O-boundary-only porting rule.
  case "$(canon_path "$TARGET" "$CWD")" in
    */.claude/settings.json|*/.claude/settings.local.json|*/.cursor/hooks.json)
      [ -r "$TARGET" ] || exit 0                     # nothing registered yet -> nothing to lose
      _before="$(_reg_slots "$TARGET")"
      # NOT "must always end registered": a project that never installed this kit must not be frozen
      # out of its own settings file, malformed content included.
      [ -n "$_before" ] || exit 0                    # not currently registered -> nothing to lose
      _prop="$(mktemp)"
      if [ "$TOOL_NAME" = Write ]; then
        cc_content > "$_prop"
      else
        OLD="$(cc_old_string)"
        NEW="$(cc_new_string)"
        # `replace_all` is a first-class Edit parameter. Reconstructing with a single replacement
        # while the tool replaces every occurrence means judging a document that is not the one
        # being written — and a decoy mention of the gate filename, plantable by an edit this gate
        # allows, turns that gap into a two-step removal of both registrations.
        ALL="$(cc_json '.tool_input.replace_all // .toolInput.replace_all // .replace_all // .tool_input.replaceAll // .replaceAll // false')"
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
        SURFACE="harness settings — this change would leave the kit's gate unregistered"
      else
        SURFACE="harness settings — the proposed content is not parseable JSON, so the registration's survival cannot be verified"
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
# flag as the Claude gate + lock-kit.sh, but HEKTOR_FLAKYKIT_UNLOCK is an intent marker, not
# consent; calling it "the human-consent flag" is the exact claim this kit's docs retract elsewhere
# (core/lock-kit.sh's header). The real consent, where the hardened tier requires any, is the sudo
# password lock-kit.sh prompts for — and lock-kit.sh's own direct invocations of `unlock` are never
# logged to the audit log at all, unlike this gate's interception of an agent's call.
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
That use is recorded in docs/hektor/.hook-audit.log by this gate. For an OS-level wall independent of
any gate, run: core/lock-kit.sh lock — reaches the hardened tier (password-gated reopen) when sudo is
available, else only a chmod-only degraded bit the same user can reverse."
exit 0
