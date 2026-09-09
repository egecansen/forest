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
#   - .claude/hooks/flaky-kit-delivery-gate.sh          (the Stop hook that enforces I11 — the one
#                                                        control a session that wants to STOP has a
#                                                        motive to remove, and the only thing that
#                                                        can deny that removal inside that session)
#   - .claude/hooks/.flaky-kit-expect                   (the out-of-tree lock-tier record this gate's
#                                                        own shadow check reads)
#   - .claude/hooks/lib/, .cursor/hooks/{gate,lib/}     (the audit lib + the other harness's gate)
#   - .claude/hooks, .cursor/hooks                      (the DIRECTORIES, as operands — removing one
#                                                        removes the gate, the lib and the record)
#
# The harness's own hook registration (.claude/settings.json, .claude/settings.local.json,
# .cursor/hooks.json) is deliberately NOT on that list, because the list is a path match and a
# settings file legitimately gets edited for reasons that have nothing to do with the kit
# (permissions, env vars, model). The two branches ask different questions about it:
#   - Bash    -> surface, deny on mutation (Round 4 below). No content is available there and the
#                outcome of `jq ... > tmp && mv tmp settings.json` cannot be read off the command.
#   - Write/Edit -> decided by OUTCOME (Round 5 below). The payload IS available, so the branch
#                answers whether the kit's registration survives the change instead of matching text
#                that resembles it.
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
# pack's run-status-write-gate sets that precedent).
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
#
# HARNESS SETTINGS FILES, added because none of the above protects the thing that makes any of it RUN:
# the PreToolUse registration itself. `sed -i '' .claude/settings.json` (or `rm -f` it, or truncate it
# with a redirect) was a verified ALLOW — unregistering the gate is cheaper than editing it, and every
# other entry on this surface is downstream of that one registration existing. `.claude/settings.local.json`
# is included because Claude Code merges hook config from both project settings files. Cursor's real
# registration file is `.cursor/hooks.json` — checked, not assumed: Cursor has no project-level
# `settings.json` of ANY kind (not merely no `.local` variant — user settings are a SQLite blob, not a
# file, and a `.vscode/settings.json`-style per-project override does not work in Cursor at all), so no
# `.cursor/settings.json` arm is added, `.local` or otherwise — a pattern for a file that cannot exist
# is a claim nothing can check. This is the Bash-branch pattern ONLY: `match_surface` below (the
# Write/Edit matcher) is deliberately untouched by these settings paths — that branch decides by
# OUTCOME (does the registration survive the edit), which needs the payload, not a path match; see
# Round 5 above and the settings arm of the Write|Edit `case`.
#
# THE DELIVERY GATE (`.claude/hooks/flaky-kit-delivery-gate.sh`), added because it shipped onto
# `harden_targets` and onto nothing else. Membership of that list was taken as standing in for
# "protected", and it does not: `harden_targets` is the hardened tier's chown list, so below hardened
# — every existing install and every machine without sudo — it buys nothing at all, and the wiring
# axis that WOULD notice the loss only fires when a kit entrypoint next runs. A session whose whole
# goal is to stop never runs one. Measured against a real `install.sh --harness claude` fixture
# before this line existed: `rm -f .claude/hooks/flaky-kit-delivery-gate.sh` was an ALLOW with no
# audit line, while the identical command against the sibling gate on the same fixture DENIED — an
# agent that has just been told by the Stop hook that it may not stop could delete the hook and stop.
# Worse than a silent loss: the deletion leaves `wiring=dangling`, and `integrity_report hardened
# dangling` returns 76, so on a hardened install that one free `rm` refuses all thirteen entrypoints
# and the printed remedy costs the sudo password. Named in the SAME alternative as its sibling, not a
# new one, because it lives in the same directory under the same rules. No `.cursor/hooks/` arm: the
# delivery gate is Claude-only (Cursor has no stop event), and a pattern for a file that cannot exist
# is a claim nothing can check — the same ruling as `.cursor/settings.json` above.
SURF_RE='\.claude/skills/hektor-flaky-triage(/|$|[[:space:]";)&|])|\.claude/hooks/(flaky-kit-self-protection-gate\.sh|flaky-kit-delivery-gate\.sh|\.flaky-kit-expect|lib/)|\.cursor/hooks/(flaky-kit-self-protection-gate\.sh|lib/)|\.(claude|cursor)/hooks($|[[:space:]";)&|])|\.claude/settings(\.local)?\.json|\.cursor/hooks\.json'
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
    */.claude/hooks/flaky-kit-delivery-gate.sh)           SURFACE="kit delivery hook (Claude)"; return 0 ;;
    */.cursor/hooks/flaky-kit-self-protection-gate.sh)    SURFACE="kit protection hook (Cursor)"; return 0 ;;
    */.cursor/hooks/lib/*)                                SURFACE="kit protection hook lib (Cursor)"; return 0 ;;
    */.claude/hooks/lib/*)                                SURFACE="kit protection hook lib (Claude)"; return 0 ;;
    */.claude/hooks/.flaky-kit-expect)                    SURFACE="kit lock-tier record (out-of-tree)"; return 0 ;;
    */.claude/hooks|*/.cursor/hooks)                      SURFACE="harness hooks directory (holds the gate, its lib, and the lock-tier record)"; return 0 ;;
    *) return 1 ;;
  esac
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

case "$TOOL_NAME" in
  Write|Edit)
    TARGET=$(echo "$INPUT" | "$JQ" -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
    [ -n "$TARGET" ] || exit 0
    # Settings files are surface for Bash (no content to inspect there) but decided by OUTCOME here,
    # where the payload is available: deny only when the kit's registration would not survive. Blanket-
    # denying would make this kit block unrelated permission/env/model edits in every project it is
    # installed into — heavy for a component that claims to be standalone — so `match_surface` carries
    # no settings arm and this arm sits in front of it.
    case "$(canon_path "$TARGET")" in
      */.claude/settings.json|*/.claude/settings.local.json|*/.cursor/hooks.json)
        [ -r "$TARGET" ] || exit 0                     # nothing registered yet -> nothing to lose
        _before="$(_reg_slots "$TARGET")"
        # NOT "must always end registered": a project that never installed this kit must not be frozen
        # out of its own settings file, malformed content included.
        [ -n "$_before" ] || exit 0                    # not currently registered -> nothing to lose
        _prop="$(mktemp)"
        if [ "$TOOL_NAME" = Write ]; then
          echo "$INPUT" | "$JQ" -r '.tool_input.content // ""' > "$_prop"
        else
          OLD=$(echo "$INPUT" | "$JQ" -r '.tool_input.old_string // ""')
          NEW=$(echo "$INPUT" | "$JQ" -r '.tool_input.new_string // ""')
          # `replace_all` is a first-class Edit parameter. Reconstructing with a single replacement
          # while the tool replaces every occurrence means judging a document that is not the one
          # being written — and a decoy mention of the gate filename, plantable by an edit this gate
          # allows, turns that gap into a two-step removal of both registrations.
          ALL=$(echo "$INPUT" | "$JQ" -r '.tool_input.replace_all // false')
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
        # raw TARGET so an already-literal path still matches even if canon_path degraded to a no-op.
        if match_surface "$(canon_path "$TARGET")"; then :; elif match_surface "$TARGET"; then :; else exit 0; fi ;;
    esac ;;
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
