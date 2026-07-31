#!/bin/bash
# Test suite for core/_integrity.sh. Plain bash asserts, no framework.
#
# Only ONE thing here needs a password and is therefore deferred to the manual checklist: making a
# path genuinely owned by uid 0. Everything else about the privileged path IS automated — the tier
# DECISION is a pure function of (owner uid, recorded tier) and is driven with synthetic inputs,
# exactly as core/tests/rerun-test.sh drives aggregate() via RERUN_LIB_ONLY; and the whole hardened
# BRANCH of lock-kit.sh runs under PATH-shimmed sudo/stat in core/tests/lock-tier-test.sh. The claim
# "the privileged path cannot be automated" that stood here is retracted — the file next to it
# disproves it — and corrected rather than deleted so the mistake stays legible.
#
# The `mismatch` REFUSAL needs no privilege at all: it fires on "recorded hardened + not root-owned",
# which is any fixture's default state. That is what the entrypoint section at the bottom exploits.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$(cd "$HERE/.." && pwd)"
. "$HERE/../_integrity.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }
is()  { [ "$(integrity_tier "$1" "$2")" = "$3" ] && ok || bad "owner=$1 state=$2 -> expected $3, got $(integrity_tier "$1" "$2")"; }

# root-owned, agrees with state
is 0 hardened hardened
# user-owned, agrees with state
is 501 unlocked unlocked
is 501 degraded degraded
# fresh install: nothing recorded, user-owned -> not merely "degraded", genuinely unprotected
is 501 "" unprotected
# THE dangerous direction: recorded hardened, no longer root-owned
is 501 hardened mismatch
# stronger than recorded is safe, but the state file is out of date
is 0 degraded stale
is 0 unlocked stale
is 0 "" stale
# any unknown recorded value is treated as unprotected, never as hardened
is 501 banana unprotected
is 0 banana stale

# --- the two readers: platform-branched stat and jq-less JSON scraping are the parts most likely
# --- to differ across environments, so they get real filesystem fixtures rather than trust.
# --- Representative uid pair: 0 (root), 501 (typical macOS user; Linux uses 1000+).
RT="$(mktemp -d)"; trap 'rm -rf "$RT"' EXIT
mkdir -p "$RT/core"; printf 'x\n' > "$RT/core/probe"

# integrity_owner_uid
[ -z "$(integrity_owner_uid /nonexistent-path-xyz)" ] && ok || bad "owner_uid on a missing path must print nothing"
integrity_owner_uid /nonexistent-path-xyz >/dev/null; [ $? -eq 0 ] && ok || bad "owner_uid on a missing path must return 0"
[ -z "$(integrity_owner_uid)" ] && ok || bad "owner_uid with no argument must print nothing, not error"
[ "$(integrity_owner_uid "$RT/core/probe")" = "$(id -u)" ] && ok || bad "owner_uid must report the real owner of an existing file"
# THE wedge case: stat unavailable must not abort a `set -e` caller (this is why return 0 is explicit)
( set -euo pipefail; . "$HERE/../_integrity.sh"; PATH=/nonexistent-bin integrity_owner_uid /tmp >/dev/null ) 2>/dev/null \
  && ok || bad "owner_uid must not abort a set -e caller when stat is unavailable"

# integrity_state
[ -z "$(integrity_state "$RT")" ] && ok || bad "state with no .lock-state must print nothing"
integrity_state "$RT" >/dev/null; [ $? -eq 0 ] && ok || bad "state with no .lock-state must return 0"
[ -z "$(integrity_state)" ] && ok || bad "state with no argument must print nothing, not error"
printf '{"tier":"hardened","at":"2026-07-29T00:00:00Z"}\n' > "$RT/core/.lock-state"
[ "$(integrity_state "$RT")" = hardened ] && ok || bad "state must read the tier the writer emits"
printf '{"at":"x","note":"no tier here"}\n' > "$RT/core/.lock-state"
[ -z "$(integrity_state "$RT")" ] && ok || bad "state must print nothing when no tier key is present"
# Ambiguity: two tier keys must resolve the SAME way regardless of line wrapping — first wins.
printf '{"history":[{"tier":"unlocked"},{"tier":"hardened"}]}\n' > "$RT/core/.lock-state"
[ "$(integrity_state "$RT")" = unlocked ] && ok || bad "two tier keys on ONE line must resolve first-wins"
printf '{"history":[{"tier":"unlocked"},\n{"tier":"hardened"}]}\n' > "$RT/core/.lock-state"
[ "$(integrity_state "$RT")" = unlocked ] && ok || bad "two tier keys across TWO lines must resolve first-wins, same as one line"

# --- integrity_report: the message + decision for each tier -----------------------
# Driven DIRECTLY with tier strings. The earlier draft went through integrity_guard and injected a
# fake uid via INTEGRITY_FAKE_UID; that override then existed in production code, where setting one
# environment variable silenced the guard entirely. The seam belongs at the function boundary, not
# in the environment — so the reporting half is tested here and the uid half is already covered by
# the integrity_tier cases above.
# `absent` is the neutral wiring value: silent at every tier (proven in the tier x wiring block
# below), so driving these tier-only cases through it reproduces the exact pre-task-2 behaviour.
rep_out() { integrity_report "$1" absent 2>&1; }
rep_rc()  { integrity_report "$1" absent >/dev/null 2>&1; echo $?; }

[ -z "$(rep_out hardened)" ] && ok || bad "hardened must be silent"
[ "$(rep_rc hardened)" = 0 ] && ok || bad "hardened must return 0"
case "$(rep_out stale)" in *"treating as hardened"*) ok ;; *) bad "stale must say it is treating the tree as hardened and ask for a refresh" ;; esac
[ "$(rep_rc stale)" = 0 ] && ok || bad "stale must not block the run"
case "$(rep_out unlocked)" in *"maintenance"*) ok ;; *) bad "unlocked must remind the user to re-lock" ;; esac
[ "$(rep_rc unlocked)" = 0 ] && ok || bad "unlocked must not block the run"
case "$(rep_out degraded)" in *DEGRADED*) ok ;; *) bad "degraded must emit a one-line notice" ;; esac
[ "$(rep_rc degraded)" = 0 ] && ok || bad "degraded must not block the run"
case "$(rep_out unprotected)" in *UNPROTECTED*) ok ;; *) bad "unprotected must say lock never ran and the surface is writable" ;; esac
case "$(rep_out unprotected)" in *"read-only"*) bad "unprotected must NOT describe the surface as read-only — a fresh install is writable" ;; *) ok ;; esac
[ "$(rep_rc unprotected)" = 0 ] && ok || bad "unprotected must not block the run"
case "$(rep_out mismatch)" in *MISMATCH*) ok ;; *) bad "mismatch must be loud" ;; esac
[ "$(rep_rc mismatch)" = 76 ] && ok || bad "mismatch must return 76 so callers refuse"
# Nothing may reach stdout: four entrypoints emit a machine-read contract there.
for t in hardened stale unlocked degraded unprotected mismatch; do
  [ -z "$(integrity_report "$t" absent 2>/dev/null)" ] || bad "integrity_report must never write to stdout (tier: $t)"
done; ok
# The production path must carry no environment override. The original bare-substring check is
# restored to its full breadth (it also catches INTEGRITY_FAKE_UID=0, export INTEGRITY_FAKE_UID,
# printenv INTEGRITY_FAKE_UID) by stripping comments first, rather than by narrowing the pattern to
# require a `$` prefix: task 2's integrity_guard comment legitimately NAMES INTEGRITY_FAKE_UID in
# prose (describing the hole it replaced), so the fix belongs to the comment scope, not the pattern.
grep -v '^[[:space:]]*#' "$HERE/../_integrity.sh" | grep -q 'INTEGRITY_FAKE_UID' \
  && bad "no environment override may remain in _integrity.sh — it silences the guard for anyone who can set a variable" || ok

# --- integrity_guard: the COMPOSITION, and that the entrypoints actually call it ----------------
# Until this section existed, `integrity_guard() { return 0; }` left the entire suite green: the two
# HALVES were covered (integrity_tier with synthetic uids, integrity_report with synthetic tiers) and
# nothing tested that they were wired together, that any entrypoint called the result, or that any
# entrypoint refused. Deleting the guard from apply.sh — the one entrypoint that writes to the repo —
# was invisible.
KF="$(mktemp -d)"; trap 'rm -rf "$RT" "$KF"' EXIT
mkdir -p "$KF/core"
for f in "$CORE"/*.sh "$CORE"/*.py "$CORE"/*.json; do [ -f "$f" ] && cp "$f" "$KF/core/"; done
# Recorded hardened, actually user-owned = `mismatch`. No privilege needed to arrange it.
printf '{"tier":"hardened","at":"x"}\n' > "$KF/core/.lock-state"

[ "$(integrity_state "$KF")" = hardened ] && ok || bad "guard fixture must record the hardened tier"
integrity_guard "$KF" >/dev/null 2>&1
[ "$?" -eq 76 ] && ok || bad "integrity_guard must compose owner+state into a tier and refuse (76) on a mismatched tree — neither half's test covers the composition"
case "$(integrity_guard "$KF" 2>&1 >/dev/null)" in *MISMATCH*) ok ;; *) bad "integrity_guard must pass the composed tier to integrity_report, so the MISMATCH text reaches stderr" ;; esac
[ -z "$(integrity_guard "$KF" 2>/dev/null)" ] && ok || bad "integrity_guard must never write to stdout"

# Every entrypoint must REFUSE, and must keep stdout clean while refusing: four of them emit a
# machine-read JSON contract there, and a caller that parses partial output is worse than one that
# gets nothing.
ENTRYPOINTS="apply cluster compile correlate dom-capture dom-on-failure gate ingest ledger qagent rerun summary triage"
for e in $ENTRYPOINTS; do
  out="$(cd "$KF" && bash "$KF/core/$e.sh" </dev/null 2>/dev/null)"; rc=$?
  [ "$rc" -eq 76 ] && ok || bad "$e.sh must refuse with 76 on a mismatched tier (got $rc)"
  [ -z "$out" ]    && ok || bad "$e.sh must keep stdout empty when it refuses (got: $out)"
done

# Pin the call sites by IDENTITY, not just by count: this fails when a guard line is deleted from one
# of the known entrypoints below. lock-kit.sh is excluded because it is the tool that establishes the
# tier (guarding it would lock the operator out of their own repair path), and hedge-scan.sh because
# it is a pure text screen that reads nothing from the kit's state.
ACTUAL_GUARDED="$(grep -lF 'integrity_guard "$HERE/.." || exit 76' "$CORE"/*.sh 2>/dev/null \
                  | while IFS= read -r f; do b="$(basename "$f")"; printf '%s\n' "${b%.sh}"; done | sort | tr '\n' ' ')"
EXPECT_GUARDED="$(printf '%s\n' $ENTRYPOINTS | sort | tr '\n' ' ')"
[ "$ACTUAL_GUARDED" = "$EXPECT_GUARDED" ] && ok \
  || bad "the set of entrypoints calling integrity_guard must be exactly [$EXPECT_GUARDED] — got [$ACTUAL_GUARDED]"

# The comment this replaces claimed the check above "fails both when a guard line is deleted and
# when a NEW entrypoint lands without one." The second half was false: ACTUAL_GUARDED is grepped FOR
# the guard line (so a new unguarded file is simply absent from it, not a mismatch) and
# EXPECT_GUARDED is the hardcoded $ENTRYPOINTS string above, which a new file on disk cannot change
# either. Both sets move together and stay equal, so a brand-new core/*.sh entrypoint that forgets
# the guard is invisible to the comparison above — proven by mutation: dropping such a file in
# core/ left the whole suite (68/0 at the time) green.
#
# Fixed by deriving the expected set from the FILESYSTEM instead of the hardcoded list: every
# core/*.sh file is an entrypoint that must carry the guard UNLESS it is a known non-entrypoint —
# the four sourced helpers (never run standalone) or one of the two functional exclusions named
# above. `_wiring_repair.sh` joins the sourced helpers here for the same reason `_integrity.sh`
# itself is excluded: it is sourced BY the file that calls integrity_guard, not a standalone
# entrypoint, and it must never call the guard itself — the mutation it performs is precisely the
# repair a refused entrypoint would never reach. A new file lands in neither carve-out by default,
# so it is guilty (must carry the guard) until someone deliberately, reviewably adds it to
# NON_ENTRYPOINTS with a stated reason — which $ENTRYPOINTS along could never enforce, since nothing
# added a new file to it automatically either.
NON_ENTRYPOINTS="_integrity.sh _lock.sh _strict.sh _wiring_repair.sh lock-kit.sh hedge-scan.sh"
UNGUARDED=""
for f in "$CORE"/*.sh; do
  [ -f "$f" ] || continue
  b="$(basename "$f")"
  case " $NON_ENTRYPOINTS " in *" $b "*) continue ;; esac
  grep -qF 'integrity_guard "$HERE/.." || exit 76' "$f" || UNGUARDED="$UNGUARDED $b"
done
[ -z "$UNGUARDED" ] && ok \
  || bad "core/*.sh file(s) missing the integrity_guard call and not in NON_ENTRYPOINTS:$UNGUARDED — add the guard, or add the file to NON_ENTRYPOINTS with a stated reason"

# --- integrity_project_root: verify the SHAPE, never a level count -------------------
# `pwd -P` immediately after mktemp, same reason as lock-tier-test.sh and install-guard-test.sh:
# on macOS mktemp -d hands back a /var/folders/... path whose /var is a symlink to /private/var, and
# integrity_project_root resolves the PHYSICAL path via `cd ... && pwd -P`. Comparing that against
# the un-resolved $PR would fail on a correct implementation for no real reason.
PR="$(mktemp -d)"; PR="$(cd "$PR" && pwd -P)"
mkdir -p "$PR/proj/.claude/skills/hektor-flaky-triage/core"
[ "$(integrity_project_root "$PR/proj/.claude/skills/hektor-flaky-triage")" = "$PR/proj" ] \
  && ok || bad "project root must be derived from an installed layout"
mkdir -p "$PR/wrong/skills/hektor-flaky-triage"
[ -z "$(integrity_project_root "$PR/wrong/skills/hektor-flaky-triage")" ] \
  && ok || bad "a layout whose grandparent is not .claude must yield no project root"
mkdir -p "$PR/nope/.claude/plugins/hektor-flaky-triage"
[ -z "$(integrity_project_root "$PR/nope/.claude/plugins/hektor-flaky-triage")" ] \
  && ok || bad "a layout whose parent is not skills must yield no project root"
[ -z "$(integrity_project_root "$PR/proj/.claude/skills")" ] \
  && ok || bad "a directory not named hektor-flaky-triage must yield no project root"
[ -z "$(integrity_project_root)" ] && ok || bad "no argument must yield no project root, not an error"

# --- integrity_wiring: one fixture builder, six outcomes ----------------------------
# wire_fixture <dir> — an installed layout with both harnesses correctly registered.
wire_fixture() {
  local d="$1" k="$1/.claude/skills/hektor-flaky-triage"
  mkdir -p "$k/core" "$d/.claude/hooks" "$d/.cursor/hooks"
  printf 'x\n' > "$d/.claude/hooks/flaky-kit-self-protection-gate.sh"
  printf 'x\n' > "$d/.cursor/hooks/flaky-kit-self-protection-gate.sh"
  cat > "$d/.claude/settings.json" <<'JSON'
{"hooks":{"PreToolUse":[
  {"matcher":"Write|Edit","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]},
  {"matcher":"Bash","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]}
]}}
JSON
  cat > "$d/.cursor/hooks.json" <<'JSON'
{"version":1,"hooks":{
  "beforeShellExecution":[{"command":".cursor/hooks/flaky-kit-self-protection-gate.sh"}],
  "preToolUse":[{"command":".cursor/hooks/flaky-kit-self-protection-gate.sh","matcher":"Write|Edit"}]
}}
JSON
  echo "$k"
}
W="$(mktemp -d)"; K1="$(wire_fixture "$W/a")"

# CONTROL, required: prove the fixture actually reaches a non-absent state. `absent` silences every
# assertion below, so a fixture that quietly fails to reproduce the installed layout would make them all vacuously
# pass — which is exactly how C1's "the fixture was too kind" defect survived a full review.
[ "$(integrity_wiring "$K1" degraded)" != absent ] \
  && ok || bad "CONTROL: the fixture must reach a non-absent wiring state, or every assertion below is vacuous"
[ "$(integrity_wiring "$K1" degraded)" = wired ] && ok || bad "a correctly registered fixture must be wired"

# dangling: registered, file gone — the case observed live in a web-test worktree
K2="$(wire_fixture "$W/b")"; rm -f "$W/b/.claude/hooks/flaky-kit-self-protection-gate.sh"
[ "$(integrity_wiring "$K2" degraded)" = dangling ] && ok || bad "a registration pointing at a missing file must be dangling"

# unregistered: settings present, no registration for the kit's gate
K3="$(wire_fixture "$W/c")"; printf '{"hooks":{"PreToolUse":[]}}\n' > "$W/c/.claude/settings.json"
printf '{"version":1,"hooks":{}}\n' > "$W/c/.cursor/hooks.json"
[ "$(integrity_wiring "$K3" degraded)" = unregistered ] && ok || bad "settings with no kit registration must be unregistered"

# partial: one matcher registered, the other dropped
K4="$(wire_fixture "$W/d")"
jq '.hooks.PreToolUse |= map(select(.matcher != "Bash"))' "$W/d/.claude/settings.json" > "$W/d/s" && mv "$W/d/s" "$W/d/.claude/settings.json"
rm -f "$W/d/.cursor/hooks.json"
[ "$(integrity_wiring "$K4" degraded)" = partial ] && ok || bad "one matcher registered and one missing must be partial"

# absent: an installed layout with no harness settings at all — terminal-only use, NOT a defect
K5="$(wire_fixture "$W/e")"; rm -f "$W/e/.claude/settings.json" "$W/e/.cursor/hooks.json"
[ "$(integrity_wiring "$K5" degraded)" = absent ] && ok || bad "no harness settings at all must be absent, not a defect"

# foreign: hardened tier, gate file present but NOT root-owned — it cannot be the kit's gate.
# Below hardened the same tree is `wired`, because ownership proves nothing there.
K6="$(wire_fixture "$W/f")"
[ "$(integrity_wiring "$K6" hardened)" = foreign ] && ok || bad "at hardened, a non-root-owned gate file must be foreign"
[ "$(integrity_wiring "$K6" degraded)" = wired ] && ok || bad "below hardened, ownership proves nothing — the same tree is wired"
# `stale` gets the identity test too: the tree IS root-owned there and only the record disagrees, so
# keying this check on the recorded tier while integrity_report keys its refusal on ownership would
# split one property across two conditions.
[ "$(integrity_wiring "$K6" stale)" = foreign ] && ok || bad "at stale, a non-root-owned gate file must also be foreign — the tree is root-owned regardless of what .lock-state claims"

# worse-value-wins across harnesses: a working half must not hide a broken half
K7="$(wire_fixture "$W/g")"; rm -f "$W/g/.cursor/hooks/flaky-kit-self-protection-gate.sh"
[ "$(integrity_wiring "$K7" degraded)" = dangling ] && ok || bad "a dangling Cursor gate must not be masked by a wired Claude gate"

# not an installed layout -> absent, silent. Running the suite from the source tree must not warn.
[ "$(integrity_wiring "$W" degraded)" = absent ] && ok || bad "a non-installed layout must be absent"

# --- review round 2, Finding 2: NO variable may leak into the sourcing shell --------------------
# core/_integrity.sh is sourced by thirteen entrypoints, several of which use these names as globals
# (`t` in apply.sh/install.sh, `p` in _lock.sh/apply.sh, `cmd` in compile.sh/dom-capture.sh/
# dom-on-failure.sh, `out` in cluster.sh). Nothing broke before this round only because the guard call
# happened to sit above those lines — ordering luck, not isolation, in a file whose header promises
# never to wedge a caller.
#
# Named as a NAME SET rather than as the two variables the original round happened to find: the fix
# wave that replaced integrity_wiring's `Write|Edit`/`Bash` matcher loop retired `m` and `e`
# outright, which would have left an assertion spelled "m and e must not leak" passing vacuously
# against a function that no longer has either — the exact failure mode this branch produced five
# times. Every local of every function in this file is listed, so removing ANY name from ANY `local`
# line goes red.
#
# Every function is invoked DIRECTLY here, never only through integrity_guard. That composition
# evaluates both of its halves inside `$( )` command substitutions, and a command substitution runs in
# a subshell whose assignments are discarded on exit — so a probe driven through integrity_guard
# cannot observe a leak AT ALL, and stays green against a function carrying no `local` line
# whatsoever. Found by mutation: deleting `t` from integrity_wiring's `local` left a
# guard-driven probe green. The same reasoning is why `_wiring_want`, `_wiring_cover`,
# `_wiring_resolve` and `_wiring_one` get their own calls: integrity_wiring only ever reaches them
# through `$( )`, so their locals are unobservable from there too.
#
# The probe runs in a SUBSHELL so a leak there cannot contaminate this test file's own variables; only
# the subshell's pass/fail exit status crosses back out, and `ok`/`bad` (which touch this file's
# pass/fail counters) are called out here in the main shell, not inside the subshell where their
# effect would be lost when it exits.
LOCAL_NAMES="kit tier root f p t s slots cmd g gate got want out wc wu h c u ev tool line key k owner recorded actual expected wiring rc"
( for v in $LOCAL_NAMES; do unset "$v"; done
  . "$HERE/../_integrity.sh"
  integrity_owner_uid   "$K1/core"                                     >/dev/null
  integrity_project_root "$K1"                                         >/dev/null
  integrity_state       "$K1"                                          >/dev/null
  integrity_tier        501 hardened                                   >/dev/null
  # TWICE, against fixtures that take different paths through it. Without a record `h` is empty, so a
  # leaked `h` is indistinguishable from no leak at all and the mutation "drop h from local" stays
  # green — verified. The second call gives every local in that function a non-empty value to leak.
  _wiring_want          "$K1" "$W/a"                                   >/dev/null
  mkdir -p "$W/leakrec/core"; printf 'claude\n' > "$W/leakrec/core/.harness"
  _wiring_want          "$W/leakrec" "$W/a"                            >/dev/null
  _wiring_slots         "$W/a/.claude/settings.json"                   >/dev/null
  _wiring_cover         "$(printf 'PreToolUse:Write\tsome-command')" PreToolUse Write >/dev/null
  _wiring_resolve       'x/y.sh' "$W/a"                                >/dev/null
  _wiring_one           '' degraded 0 3                                >/dev/null
  _wiring_rank          wired                                          >/dev/null
  _wiring_worse         absent wired                                   >/dev/null
  integrity_wiring      "$K1" degraded                                 >/dev/null
  integrity_report      degraded wired                                 >/dev/null 2>&1
  integrity_guard       "$K1"                                          >/dev/null 2>&1
  leaked=""
  for v in $LOCAL_NAMES; do
    eval "probe=\${$v:-}"
    [ -z "$probe" ] || leaked="$leaked $v"
  done
  [ -z "$leaked" ] || { echo "leaked:$leaked" >&2; exit 1; }
) 2>/dev/null && ok || bad "core/_integrity.sh must not leak ANY of its locals ($LOCAL_NAMES) into the sourcing shell"

# --- review round 2, Finding 1: dangling/wired must be decided on the RESOLVED registered path, not
# --- a hardcoded canonical one. A settings.json shared across machines (or hand-edited) can carry a
# --- registration to any path; the harness runs THAT path, not the one this kit would have installed.
# A registration resolved to an EXISTING non-canonical path must be wired, even with the canonical
# path gone — proves the check follows the registration instead of stat-ing a guess.
K8="$(wire_fixture "$W/h")"
mkdir -p "$W/h/elsewhere"; printf 'x\n' > "$W/h/elsewhere/flaky-kit-self-protection-gate.sh"
rm -f "$W/h/.claude/hooks/flaky-kit-self-protection-gate.sh"
jq --arg c "$W/h/elsewhere/flaky-kit-self-protection-gate.sh" \
   '.hooks.PreToolUse |= map(.hooks |= map(.command = $c))' \
   "$W/h/.claude/settings.json" > "$W/h/s" && mv "$W/h/s" "$W/h/.claude/settings.json"
[ "$(integrity_wiring "$K8" degraded)" = wired ] \
  && ok || bad "a registration resolved to an EXISTING non-canonical path must be wired even though the canonical path is gone"

# The inverse and the actual exploit named in review: a registration resolved to a path that does
# NOT exist must be dangling even though the canonical path is still sitting right there — reporting
# `wired` here (because some OTHER, unregistered file happens to exist at the canonical location) is
# the false assurance a security self-check must not give.
K9="$(wire_fixture "$W/i")"
jq --arg c "/nonexistent-foreign-machine-path/flaky-kit-self-protection-gate.sh" \
   '.hooks.PreToolUse |= map(.hooks |= map(.command = $c))' \
   "$W/i/.claude/settings.json" > "$W/i/s" && mv "$W/i/s" "$W/i/.claude/settings.json"
[ "$(integrity_wiring "$K9" degraded)" = dangling ] \
  && ok || bad "a registration resolved to a path that does not exist must be dangling even though an unrelated canonical-path file still exists"

# review round 3: a project root containing `&` is a plausible real path (an "R&D" or "Ben & Co"
# directory) that a sed-based substitution corrupts silently -- sed's replacement text treats `&` as
# "splice in the whole match", so the resolved path becomes garbage that happens not to exist, and the
# fixture reads `dangling` on a genuinely correctly-wired install. Bash parameter expansion has no such
# special character in its replacement text.
K9A="$(wire_fixture "$W/A&B")"
[ "$(integrity_wiring "$K9A" degraded)" = wired ] \
  && ok || bad "a project root containing '&' must still resolve \$CLAUDE_PROJECT_DIR correctly and read wired"

# --- review round 2, Finding 3: pin the most common real deployment (one harness, correctly wired,
# --- the other simply not present) to `wired` -- the property mutation 4 was supposed to prove and,
# --- before this round, could not: _wiring_rank's `absent` arm was unreachable dead code because
# --- nothing ever fed `absent` through it. _wiring_worse seeds the merge with `absent` and compares
# --- it against the first harness result, so the arm is now on the live path.
K10="$(wire_fixture "$W/j")"; rm -rf "$W/j/.cursor"
[ "$(integrity_wiring "$K10" degraded)" = wired ] \
  && ok || bad "Claude fully wired with no Cursor config at all (not merely broken) must be wired, not masked by the absent seed"
K11="$(wire_fixture "$W/k")"; rm -f "$W/k/.claude/settings.json"
[ "$(integrity_wiring "$K11" degraded)" = wired ] \
  && ok || bad "the Cursor-only mirror: Cursor fully wired with no Claude settings at all must be wired"

# --- new scope, review round 2: core/.harness pins which harnesses are REQUIRED, so the check no
# --- longer infers a requirement from "a settings file exists" -- that flagged a project carrying a
# --- .cursor/hooks.json left by some unrelated tool even though the kit was installed for Claude alone.
# A claude-only record must not be dragged down by a stray/broken Cursor config: Cursor's gate file is
# removed here (which would read as `dangling` if examined), and the record says Cursor was never
# required, so it must not be examined at all.
K12="$(wire_fixture "$W/l")"
printf 'claude\n' > "$K12/core/.harness"
rm -f "$W/l/.cursor/hooks/flaky-kit-self-protection-gate.sh"
[ "$(integrity_wiring "$K12" degraded)" = wired ] \
  && ok || bad "a claude-only .harness record must not be dragged down by a stray/broken .cursor config"

# A record REQUIRING a harness whose settings file is missing entirely must be `unregistered`, not
# `absent` -- absent means nothing was ever asked for; a record saying Claude was installed but no
# settings file exists at all is a real defect (an agent could have deleted it), and silence there
# would be exactly the false all-clear this round exists to close.
K13="$(wire_fixture "$W/m")"
printf 'claude\n' > "$K13/core/.harness"
rm -f "$W/m/.claude/settings.json"
[ "$(integrity_wiring "$K13" degraded)" = unregistered ] \
  && ok || bad "a .harness record requiring claude with no settings.json at all must be unregistered, not absent"

# No .harness record at all must still reproduce the pre-existing file-presence inference, unchanged
# -- every K1..K11 fixture above already proves this implicitly (none of them writes .harness), and
# this line names the property directly for anyone reading only this section.
[ ! -f "$K1/core/.harness" ] && [ "$(integrity_wiring "$K1" degraded)" = wired ] \
  && ok || bad "with no .harness record at all, the pre-existing file-presence inference must still apply"

# --- one fixture per _wiring_want ARM. Before this, four of the five record arms were reachable by no
# --- assertion: only `claude` was ever written (K12/K13 above), so deleting `all|both`, `cursor` or
# --- `agents` left the whole suite green. `all` is install.sh's DEFAULT value, and `agents` is the arm
# --- that keeps an agents-only install silent -- delete it and any agents-only project that happens to
# --- carry a .claude/settings.json falls to the inference, reports `unregistered`, and refuses at
# --- hardened. Each fixture is built so the RECORD and the INFERENCE disagree; a fixture where they
# --- agree reaches the arm without testing it, which is the distinction this branch keeps missing.
#
# all/both: the record REQUIRES cursor while no .cursor/hooks.json exists at all. With the arm, cursor
# is examined and reports `unregistered`; without it, the inference sees no cursor file, requires
# nothing, and the fixture reads `wired`.
for rec in all both; do
  KA="$(wire_fixture "$W/want-$rec")"
  printf '%s\n' "$rec" > "$KA/core/.harness"
  rm -f "$W/want-$rec/.cursor/hooks.json"
  [ "$(integrity_wiring "$KA" degraded)" = unregistered ] \
    && ok || bad "a '$rec' .harness record must REQUIRE cursor even with no .cursor/hooks.json present (got $(integrity_wiring "$KA" degraded))"
done
# cursor: the record requires cursor ONLY, while a .claude/settings.json sits there carrying no
# registration. With the arm, claude is never examined and the fixture is `wired`; without it, the
# inference sees the claude settings file and reports `unregistered`.
KC="$(wire_fixture "$W/want-cursor")"
printf 'cursor\n' > "$KC/core/.harness"
printf '{"hooks":{"PreToolUse":[]}}\n' > "$W/want-cursor/.claude/settings.json"
[ "$(integrity_wiring "$KC" degraded)" = wired ] \
  && ok || bad "a 'cursor' .harness record must not examine claude at all, even with an unregistered .claude/settings.json present (got $(integrity_wiring "$KC" degraded))"
# agents: the record requires NEITHER harness. Both settings files are stripped of every registration,
# so the inference would report `unregistered` (and refuse at hardened) while the arm reports `absent`
# and stays silent -- an AGENTS.md-only install has no gate to be missing.
KG="$(wire_fixture "$W/want-agents")"
printf 'agents\n' > "$KG/core/.harness"
printf '{"hooks":{"PreToolUse":[]}}\n' > "$W/want-agents/.claude/settings.json"
printf '{"version":1,"hooks":{}}\n'    > "$W/want-agents/.cursor/hooks.json"
[ "$(integrity_wiring "$KG" degraded)" = absent ] \
  && ok || bad "an 'agents' .harness record must require no harness and stay absent, even with settings files present (got $(integrity_wiring "$KG" degraded))"
# ...and the consequence the arm exists for: silent AND non-refusing at the tier where every other
# non-`wired` value costs 76. `hardened` is the tier driven here because it is the only one that is
# itself silent, so a non-empty output can only have come from the wiring half.
[ "$(integrity_report hardened "$(integrity_wiring "$KG" hardened)" 2>&1)" = "" ] \
  && ok || bad "an agents-only install must stay SILENT at hardened — that is what the 'agents' arm buys"
[ "$(integrity_report hardened "$(integrity_wiring "$KG" hardened)" >/dev/null 2>&1; echo $?)" = 0 ] \
  && ok || bad "an agents-only install must not refuse at hardened"

# --- Critical 1: the two integrity axes must agree about what a valid registration is -------------
# The gate deliberately ALLOWs a registration that is strictly better than the one it found (widened
# matcher, or both matchers collapsed into a single "*"), on the stated ground that no coverage is
# lost. This axis used to compare the matcher STRING against the literals 'Write|Edit' and 'Bash', so
# it read those same gate-approved edits as `partial` and `unregistered` -> 76 at hardened/stale ->
# all thirteen entrypoints refuse, with a printed repair (re-run the installer) that install.sh
# itself rejects with 75 on a root-owned tree. The slot model below is the gate's own: split on `|`,
# `*` covers everything, one entry per tool.
sj() { printf '%s' "$W/$1/.claude/settings.json"; }
mut_sj() { local f; f="$(sj "$1")"; jq "$2" "$f" > "$f.new" && mv "$f.new" "$f"; }
KW1="$(wire_fixture "$W/slot-widen")";  mut_sj slot-widen '.hooks.PreToolUse[0].matcher = "Write|Edit|MultiEdit"'
[ "$(integrity_wiring "$KW1" degraded)" = wired ] \
  && ok || bad "widening Write|Edit to Write|Edit|MultiEdit — which the gate ALLOWs — must stay wired, not partial (got $(integrity_wiring "$KW1" degraded))"
KW2="$(wire_fixture "$W/slot-star")";   mut_sj slot-star '.hooks.PreToolUse[0].matcher = "*" | del(.hooks.PreToolUse[1])'
[ "$(integrity_wiring "$KW2" degraded)" = wired ] \
  && ok || bad "a single \"*\" matcher covers every tool the two matchers covered — the gate ALLOWs it, so this axis must read it as wired (got $(integrity_wiring "$KW2" degraded))"
KW3="$(wire_fixture "$W/slot-reorder")"; mut_sj slot-reorder '.hooks.PreToolUse[0].matcher = "Edit|Write"'
[ "$(integrity_wiring "$KW3" degraded)" = wired ] \
  && ok || bad "an equivalent reorder (Edit|Write) covers the same tools and must be wired (got $(integrity_wiring "$KW3" degraded))"
# ...and the control that stops "tools, not strings" from collapsing into "any matcher will do":
# NARROWING really does drop coverage, and the gate DENIES it, so this axis must still call it partial.
KW4="$(wire_fixture "$W/slot-narrow")"; mut_sj slot-narrow '.hooks.PreToolUse[0].matcher = "Write"'
[ "$(integrity_wiring "$KW4" degraded)" = partial ] \
  && ok || bad "narrowing Write|Edit to Write drops Edit coverage and must be partial (got $(integrity_wiring "$KW4" degraded))"
KW5="$(wire_fixture "$W/slot-nomatch")"; mut_sj slot-nomatch 'del(.hooks.PreToolUse[0].matcher) | del(.hooks.PreToolUse[1])'
[ "$(integrity_wiring "$KW5" degraded)" = wired ] \
  && ok || bad "an ABSENT matcher covers everything, exactly as \"*\" does, and must be wired (got $(integrity_wiring "$KW5" degraded))"

# Important 2: Cursor's preToolUse entries carry a matcher exactly as Claude's do. Keying them by
# EVENT alone read a matcher retargeted to an inert tool as `wired` while the gate DENIED the edit
# that produces it — one branch of one feature enforcing a rule the other waived.
ch() { printf '%s' "$W/$1/.cursor/hooks.json"; }
mut_ch() { local f; f="$(ch "$1")"; jq "$2" "$f" > "$f.new" && mv "$f.new" "$f"; }
KU1="$(wire_fixture "$W/cur-task")"; printf 'cursor\n' > "$KU1/core/.harness"
mut_ch cur-task '.hooks.preToolUse[0].matcher = "Task"'
[ "$(integrity_wiring "$KU1" degraded)" = partial ] \
  && ok || bad "a Cursor preToolUse matcher retargeted to an inert tool must NOT read as wired (got $(integrity_wiring "$KU1" degraded))"
KU2="$(wire_fixture "$W/cur-star")"; printf 'cursor\n' > "$KU2/core/.harness"
mut_ch cur-star '.hooks.preToolUse[0].matcher = "*"'
[ "$(integrity_wiring "$KU2" degraded)" = wired ] \
  && ok || bad "a Cursor preToolUse \"*\" matcher covers Write and Edit and must be wired (got $(integrity_wiring "$KU2" degraded))"
# beforeShellExecution has no matcher concept in either harness, so it covers `*` by construction —
# it must be read as covering even though the entry carries no matcher key at all.
KU3="$(wire_fixture "$W/cur-bse")"; printf 'cursor\n' > "$KU3/core/.harness"
mut_ch cur-bse 'del(.hooks.beforeShellExecution)'
[ "$(integrity_wiring "$KU3" degraded)" = partial ] \
  && ok || bad "dropping Cursor's beforeShellExecution registration must be partial (got $(integrity_wiring "$KU3" degraded))"

# --- Important 3: with a RECORD present, a settings file that cannot be read or parsed is not
# --- "failing to know" — it is knowing the gate will not run as registered, because a harness cannot
# --- load hooks from a file it cannot open or parse. All three record-present cases report
# --- `unregistered` (and therefore refuse at hardened/stale). The deleted case above (K13) was already
# --- a deliberate, tested decision; these two were the file's own stated contract disagreeing with it.
KR1="$(wire_fixture "$W/rec-chmod")"; printf 'claude\n' > "$KR1/core/.harness"
rm -f "$W/rec-chmod/.cursor/hooks.json"; chmod 000 "$W/rec-chmod/.claude/settings.json"
[ "$(integrity_wiring "$KR1" degraded)" = unregistered ] \
  && ok || bad "a record-required settings file that is UNREADABLE must be unregistered, not absent (got $(integrity_wiring "$KR1" degraded))"
[ "$(integrity_report hardened "$(integrity_wiring "$KR1" hardened)" >/dev/null 2>&1; echo $?)" = 76 ] \
  && ok || bad "an unreadable record-required settings file must refuse at hardened — silence there is a false all-clear"
chmod 644 "$W/rec-chmod/.claude/settings.json"
KR2="$(wire_fixture "$W/rec-malformed")"; printf 'claude\n' > "$KR2/core/.harness"
rm -f "$W/rec-malformed/.cursor/hooks.json"; printf '{"hooks":\n' > "$W/rec-malformed/.claude/settings.json"
[ "$(integrity_wiring "$KR2" degraded)" = unregistered ] \
  && ok || bad "a record-required settings file that is MALFORMED must be unregistered, not absent (got $(integrity_wiring "$KR2" degraded))"
[ "$(integrity_report hardened "$(integrity_wiring "$KR2" hardened)" >/dev/null 2>&1; echo $?)" = 76 ] \
  && ok || bad "a malformed record-required settings file must refuse at hardened"
# ...and the boundary the ruling keeps on the `absent` side: NO record and NO settings files at all is
# still a check that cannot run (K5 above pins it), and so is a layout that is not an installed kit.

# --- _wiring_resolve: the BRACED ${CLAUDE_PROJECT_DIR} spelling. Every other fixture in this file uses
# --- the unbraced form install.sh writes, so the braced substitution line was exercised by nothing:
# --- deleting it left the whole suite green while a hand-written (or harness-rewritten) registration
# --- using braces resolved to a literal "${CLAUDE_PROJECT_DIR}/..." under the project root and read
# --- `dangling` on a correctly wired install.
KB="$(wire_fixture "$W/braced")"
jq '.hooks.PreToolUse |= map(.hooks |= map(.command = "\"${CLAUDE_PROJECT_DIR}/.claude/hooks/flaky-kit-self-protection-gate.sh\""))' \
   "$W/braced/.claude/settings.json" > "$W/braced/s" && mv "$W/braced/s" "$W/braced/.claude/settings.json"
[ "$(integrity_wiring "$KB" degraded)" = wired ] \
  && ok || bad "a registration written with the braced \${CLAUDE_PROJECT_DIR} spelling must resolve and read wired (got $(integrity_wiring "$KB" degraded))"

rm -rf "$PR" "$W"

# --- tier x wiring: refuse only where the tree is ROOT-OWNED (hardened AND stale) --------------
rep2()    { integrity_report "$1" "$2" >/dev/null 2>&1; echo $?; }
rep2_out(){ integrity_report "$1" "$2" 2>&1; }

# Refusal keys on ROOT OWNERSHIP, which `stale` has as surely as `hardened` — integrity_report
# already tells a stale tree it is being "treated as hardened", and the shadow-record argument for
# refusing does not care what the state file claims.
for t in hardened stale; do
  for w in wired absent; do
    [ "$(rep2 "$t" "$w")" = 0 ] && ok || bad "$t + $w must proceed"
  done
  for w in unregistered dangling foreign partial; do
    [ "$(rep2 "$t" "$w")" = 76 ] && ok || bad "$t + $w must refuse — the shadow detector went with the gate"
    case "$(rep2_out "$t" "$w")" in *WIRING*) ok ;; *) bad "$t + $w must name the wiring problem" ;; esac
  done
done
for t in degraded unprotected unlocked; do
  for w in unregistered dangling foreign partial; do
    [ "$(rep2 "$t" "$w")" = 0 ] && ok || bad "$t + $w must warn and proceed — there is no wall to have lost"
  done
  case "$(rep2_out "$t" dangling)" in *WIRING*) ok ;; *) bad "$t + dangling must still say so" ;; esac
done
# absent is silent at EVERY tier: no harness configured is not a defect.
for t in hardened degraded unprotected unlocked; do
  case "$(rep2_out "$t" absent)" in *WIRING*) bad "absent must never mention wiring (tier: $t)" ;; *) ok ;; esac
done
# mismatch still refuses regardless of wiring, and still names the tier problem.
[ "$(rep2 mismatch wired)" = 76 ] && ok || bad "a tier mismatch must refuse even when the wiring is fine"
# Minor 4: pin each wiring value's OWN detail line, not just the shared "WIRING $wiring" header —
# swapping the partial/foreign messages, or deleting the whole inner case, would still say WIRING
# and every assertion above would stay green.
case "$(rep2_out hardened unregistered)" in *"carries no registration"*) ok ;; *) bad "unregistered must name its own detail line" ;; esac
case "$(rep2_out hardened dangling)"     in *"does not exist"*)          ok ;; *) bad "dangling must name its own detail line" ;; esac
case "$(rep2_out hardened partial)"      in *"part of the surface"*)     ok ;; *) bad "partial must name its own detail line" ;; esac
case "$(rep2_out hardened foreign)"      in *"not root-owned"*)          ok ;; *) bad "foreign must name its own detail line" ;; esac
# `foreign` refuses at hardened AND at stale (task 2 extended the rule to root-owned trees generally,
# and the refusal line beside it was made tier-neutral then), so its detail line must not still
# describe the condition as holding only "at the hardened tier". Asserted at BOTH refusing tiers: the
# sentence is one string, and a claim retracted in one place coming back in the other is this
# branch's most-repeated defect.
for t in hardened stale; do
  case "$(rep2_out "$t" foreign)" in
    *"at the hardened tier"*) bad "the foreign detail line must not name the hardened tier alone — the rule covers stale too (tier: $t)" ;;
    *) ok ;;
  esac
done

# The REMEDY must be executable at the tier it is printed for. install.sh exits 75 whenever the
# target's core/ is root-owned — true at exactly the two tiers that refuse — so "re-run the installer"
# is right at the warning tiers and impossible at the refusing ones, where the repair costs the
# password. Both directions are asserted: printing the unlock advice at a tier that does not need it
# would be equally wrong, and an implementation that prints both lines everywhere passes a one-sided
# check.
for t in hardened stale; do
  case "$(rep2_out "$t" dangling)" in
    *"lock-kit.sh unlock"*) ok ;;
    *) bad "$t + dangling must tell the reader to unlock first — the installer refuses on a root-owned tree, so 're-run the installer' alone cannot be carried out" ;;
  esac
done
for t in degraded unprotected unlocked; do
  case "$(rep2_out "$t" dangling)" in
    *"re-run the kit installer"*) ok ;;
    *) bad "$t + dangling must still name the installer — it CAN run here, and this is the whole repair" ;;
  esac
  case "$(rep2_out "$t" dangling)" in
    *"lock-kit.sh unlock"*) bad "$t + dangling must NOT demand an unlock — there is nothing locked to unlock, and a remedy with a needless password step is one the reader will skip" ;;
    *) ok ;;
  esac
done
# Nothing may reach stdout: four entrypoints emit a contract there. Full tier x wiring matrix — a
# dropped >&2 on any ONE wiring value's echo line is only caught if that value is actually driven
# through here; unregistered/foreign/partial reach different echo lines than wired/dangling/absent.
for t in hardened degraded unprotected unlocked stale mismatch; do
  for w in wired unregistered dangling foreign partial absent; do
    [ -z "$(integrity_report "$t" "$w" 2>/dev/null)" ] || bad "integrity_report must never write to stdout ($t/$w)"
  done
done; ok
# Both arguments are required. Assert the BEHAVIOUR, not the spelling: a grep for `wiring="${2:-}"`
# passes happily against `wiring="${2:-absent}"`, which is the exact default the constraint names, so
# it proves only that the pattern matches itself. This file runs under `set -u`, so a one-argument
# call dies on the unbound $2 — verified empirically (rc=127, stderr "$2: unbound variable").
#
# `[ $? -ne 0 ]` was NOT that assertion: it is satisfied by ANY non-zero rc, and `wiring="${2:-}"` —
# the very default the constraint forbids — returns 76 through the wiring `*)` arm, so the check
# passed against the exact defect it names. What separates the two is not the rc but WHAT RAN: a
# required $2 dies before the function body; a defaulted one runs the whole report and announces a
# wiring problem it never checked. So the discriminating assertions are the stderr ones below.
#
# The rc is asserted only as non-zero, deliberately: this file installs an EXIT trap, which a `( )`
# subshell inherits and runs on the set -u abort, so the observed status is 1 here and 127 in a shell
# with no trap. Pinning either number would be pinning this file's trap, not the property.
# Mutation ledger: `${2:-}` -> rc 76 + "WIRING" on stderr (caught below); `${2:-absent}` -> rc 0 and
# silence (caught by the rc and the "unbound variable" checks).
ONE_ARG_ERR="$( ( integrity_report hardened ) 2>&1 >/dev/null )"
( integrity_report hardened ) >/dev/null 2>&1
[ $? -ne 0 ] && ok || bad "integrity_report must not accept a single argument — a defaulted wiring silently stops checking wiring"
case "$ONE_ARG_ERR" in
  *"unbound variable"*) ok ;;
  *) bad "a one-argument integrity_report must die on the UNBOUND \$2, not proceed with a defaulted wiring — got: $ONE_ARG_ERR" ;;
esac
case "$ONE_ARG_ERR" in
  *WIRING*) bad "a one-argument integrity_report reported a WIRING verdict — \$2 was defaulted rather than required, which is the state this assertion exists to forbid: it announces a wiring answer it never computed" ;;
  *) ok ;;
esac

# No environment override may enter this file, under ANY name. Naming prefixes is the same failure one
# step out: `${FK_TIER:-}` reinstates the hole while a HEKTOR|INTEGRITY pattern stays green. Match the
# SHAPE — any uppercase parameter read outside a comment. The `[^\\]` guard lets _wiring_resolve's
# escaped \$CLAUDE_PROJECT_DIR literals through, because those are text substituted into a registered
# command string, not a read of the caller's environment.
grep -v '^[[:space:]]*#' "$HERE/../_integrity.sh" | grep -qE '(^|[^\\])\$\{?[A-Z][A-Z0-9_]*' \
  && bad "no environment override may enter _integrity.sh — a caller who can set a variable silences the guard" || ok

# --- wiring_repair: the registration half ------------------------------------------------------
. "$HERE/../_wiring_repair.sh"
slots_of() { _wiring_slots "$1" | sed 's/\t.*//' | sort | tr '\n' ' '; }

# ADAPTED FROM THE BRIEF: wire_fixture (above) returns the KIT path
# ($dir/.claude/skills/hektor-flaky-triage), not the project root, so the settings file this block
# reads and mutates lives at "$R/.claude/settings.json" (R is the project root passed INTO
# wire_fixture), never at "$W/.claude/settings.json" (W is wire_fixture's return value, the kit
# path itself). The brief's snippet assumed the opposite convention; every R/W usage below is
# adjusted to the helper's real contract instead of introducing a second fixture.

# unregistered -> all three slots written, at every tier.
for T in hardened stale degraded unprotected unlocked; do
  R="$(mktemp -d)"; W="$(wire_fixture "$R")"; echo '{}' > "$R/.claude/settings.json"
  wiring_repair "$W" "$T" unregistered >/dev/null 2>&1
  case "$(slots_of "$R/.claude/settings.json")" in
    *PreToolUse:Bash*) ok ;; *) bad "$T: repair must register the Bash slot" ;;
  esac
  case "$(slots_of "$R/.claude/settings.json")" in
    *PreToolUse:Write*) ok ;; *) bad "$T: repair must register the Write slot" ;;
  esac
  case "$(slots_of "$R/.claude/settings.json")" in
    *PreToolUse:Edit*) ok ;; *) bad "$T: repair must register the Edit slot" ;;
  esac
  rm -rf "$R"
done

# partial -> only the missing slot is added, and the present one is not duplicated.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
jq 'del(.hooks.PreToolUse[] | select(.matcher=="Bash"))' "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
wiring_repair "$W" degraded partial >/dev/null 2>&1
[ "$(jq '[.hooks.PreToolUse[] | select(.matcher=="Write|Edit")] | length' "$R/.claude/settings.json")" = 1 ] \
  && ok || bad "repair must not duplicate a matcher that is already registered"
# The assertion above only pins the MATCHER BLOCK count, already guarded by
# `any(.hooks.PreToolUse[]?; .matcher==$m)`. It stays 1 even if the COMMAND-level guard
# (`any(.hooks[]?; .command==$c)`) is dropped, because that mutation adds a second entry
# INSIDE the existing block's .hooks array rather than a second block — confirmed by mutation:
# dropping the command-level guard left this file green. Pinned here instead, at the level the
# guard actually operates on.
[ "$(jq '[.hooks.PreToolUse[] | select(.matcher=="Write|Edit")][0].hooks | length' "$R/.claude/settings.json")" = 1 ] \
  && ok || bad "repair must not duplicate the command already registered inside an existing matcher block"
case "$(slots_of "$R/.claude/settings.json")" in *PreToolUse:Bash*) ok ;; *) bad "partial: the missing slot must be added" ;; esac
rm -rf "$R"

# foreign is NEVER written to. The file must come back byte-identical.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
cp "$R/.claude/settings.json" "$R/before.json"
wiring_repair "$W" hardened foreign >/dev/null 2>&1
cmp -s "$R/before.json" "$R/.claude/settings.json" && ok || bad "foreign must never be repaired — a stranger's gate is not ours to overwrite"
rm -rf "$R"

# wired and absent do nothing.
for V in wired absent; do
  R="$(mktemp -d)"; W="$(wire_fixture "$R")"; cp "$R/.claude/settings.json" "$R/before.json"
  wiring_repair "$W" degraded "$V" >/dev/null 2>&1
  cmp -s "$R/before.json" "$R/.claude/settings.json" && ok || bad "$V must not touch the settings file"
  rm -rf "$R"
done

# The repair is ADDITIVE: unrelated keys survive untouched.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
jq '.permissions = {allow:["Bash(ls:*)"]} | .env = {FOO:"bar"} | .model = "sonnet"' "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
jq 'del(.hooks.PreToolUse[] | select(.matcher=="Bash"))' "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
wiring_repair "$W" degraded partial >/dev/null 2>&1
[ "$(jq -r '.permissions.allow[0]' "$R/.claude/settings.json")" = "Bash(ls:*)" ] && ok || bad "repair must leave permissions untouched"
[ "$(jq -r '.env.FOO' "$R/.claude/settings.json")" = "bar" ] && ok || bad "repair must leave env untouched"
[ "$(jq -r '.model' "$R/.claude/settings.json")" = "sonnet" ] && ok || bad "repair must leave model untouched"
rm -rf "$R"

# Not an installed layout -> nothing is written anywhere. Running the suite from the source tree
# must never mutate a settings file.
R="$(mktemp -d)"; mkdir -p "$R/notakit/core"
wiring_repair "$R/notakit" degraded unregistered >/dev/null 2>&1
[ -z "$(find "$R" -name 'settings*.json' 2>/dev/null)" ] && ok || bad "a non-installed layout must never be written to"
rm -rf "$R"

# It narrates on stderr and nothing reaches stdout — four entrypoints emit a contract there.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; echo '{}' > "$R/.claude/settings.json"
[ -z "$(wiring_repair "$W" degraded unregistered 2>/dev/null)" ] \
  && ok || bad "wiring_repair must never write to stdout"
case "$(wiring_repair "$W" degraded unregistered 2>&1 >/dev/null)" in
  *REPAIRED*) ok ;; *) bad "a repair must say so on stderr" ;;
esac
rm -rf "$R"

# No environment override may enter the repair unit either — with ONE excluded name.
# CLAUDE_PROJECT_DIR appears in this file as a LITERAL inside single quotes: it is the text written
# into the settings file, which the harness expands when it later runs the gate. Bash never expands
# it here, so it is not a read and the property the constraint protects is untouched. grep cannot
# tell a read from a literal, so the exclusion is by name and the assertion below closes it by
# behaviour instead — which is stronger than the grep it replaces.
grep -v '^[[:space:]]*#' "$HERE/../_wiring_repair.sh" | grep -v 'CLAUDE_PROJECT_DIR' \
  | grep -qE '(^|[^\\])\$\{?[A-Z][A-Z0-9_]*' \
  && bad "no environment override may enter _wiring_repair.sh" || ok

# The excluded name is genuinely a literal: set it in the environment to something else and the
# written command must still carry the unexpanded text, never the hijacked path. If this ever fails,
# the exclusion above has stopped being safe and the grep is no longer the thing to fix.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; echo '{}' > "$R/.claude/settings.json"
CLAUDE_PROJECT_DIR=/tmp/hijack-me wiring_repair "$W" degraded unregistered >/dev/null 2>&1
grep -q 'CLAUDE_PROJECT_DIR' "$R/.claude/settings.json" && ok || bad "the registered command must keep \$CLAUDE_PROJECT_DIR unexpanded"
grep -q '/tmp/hijack-me' "$R/.claude/settings.json" && bad "the registered command must not expand CLAUDE_PROJECT_DIR from the caller's environment" || ok
rm -rf "$R"

echo "integrity-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
