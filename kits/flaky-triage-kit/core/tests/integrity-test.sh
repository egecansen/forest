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
LOCAL_NAMES="kit tier root f p t s slots cmd g gate got want out wc wu ws h c u ev tool line key k owner recorded actual expected wiring rc"
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
  # fix round 1, Minor 5: _wiring_slots_stop is reached by integrity_wiring only through $( ), the
  # same as every other helper in this list — its own direct call belongs here for the same reason,
  # regardless of it declaring no locals today (the rule is not conditioned on that).
  _wiring_slots_stop    "$W/a/.claude/settings.json"                   >/dev/null
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

# --- Task 3 REGRESSION: the capability-token record format. install.sh now writes "claude stop"
# (harness + capability tokens) once it also ships the delivery gate, not the bare "claude" every
# fixture above still uses. `_wiring_want` used to `case`-match the WHOLE file content, so
# "claude stop" matched no arm at all and fell through to the very file-existence inference this
# function exists to replace — reopening exactly the false-negative its own header names: a project
# carrying a .cursor/hooks.json from some UNRELATED tool (present, but registering nothing for the
# kit's own gate) got graded on that file again, on every FRESH claude-only install, not merely ones
# whose record predates this format.
K14="$(wire_fixture "$W/n")"
printf 'claude stop\n' > "$K14/core/.harness"
printf '{"version":1,"hooks":{}}\n' > "$W/n/.cursor/hooks.json"   # "unrelated tool": present, unregistered
# Task 4 ADDITION: this record's second token now names a REAL capability the wiring axis checks
# (the delivery gate, registered at Stop) — wire it the same way wire_fixture wires the
# self-protection gate, so this assertion keeps pinning only what it always pinned (first-token
# parsing; cursor never examined) instead of being dragged to `unregistered` by a capability this
# fixture predates, which would test Task 4's own feature by accident instead of Task 3's fix.
printf '#!/bin/sh\nexit 0\n' > "$W/n/.claude/hooks/flaky-kit-delivery-gate.sh"
chmod +x "$W/n/.claude/hooks/flaky-kit-delivery-gate.sh"
t="$(mktemp)"; jq '.hooks.Stop = [{hooks:[{type:"command",command:"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-delivery-gate.sh\""}]}]' \
  "$W/n/.claude/settings.json" > "$t" && mv "$t" "$W/n/.claude/settings.json"
[ "$(integrity_wiring "$K14" degraded)" = wired ] \
  && ok || bad "a 'claude stop' capability record must be parsed by its FIRST TOKEN — cursor must not be examined at all, and a stray foreign .cursor/hooks.json must not drag the verdict to unregistered (got $(integrity_wiring "$K14" degraded))"

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
#
# BASH_SOURCE is excluded by NAME (Task 4), the same way _wiring_repair.sh's own scan below excludes
# CLAUDE_PROJECT_DIR — and it is a STRONGER exclusion than that one: bash maintains the array itself
# and overwrites element 0 on every source and function entry, so no caller can preset it to a value
# this file would read back, and "a caller who can set a variable silences the guard" — the exact
# threat this assertion exists to catch — does not apply to it. Unlike CLAUDE_PROJECT_DIR's
# exclusion, which needed the hijack-attempt behavioural assertion further down to be trusted, no
# such backstop is possible or necessary FOR BASH_SOURCE ITSELF: there is no value for anything to
# hijack.
#
# The exclusion is nonetheless LINE-scoped, not name-scoped — `grep -v` drops the whole line — and
# that residual is stated here for the same reason the CLAUDE_PROJECT_DIR one is stated below rather
# than left implicit: a second, genuinely caller-controlled read placed on the SAME line as the
# BASH_SOURCE reference (`core/_integrity.sh:29`, the `_INTEGRITY_HERE=` assignment) would be dropped
# along with it and escape this check entirely. Only that one line is affected, and nothing on it
# today reads anything but BASH_SOURCE; a future edit that crowds another expansion onto it would.
grep -v '^[[:space:]]*#' "$HERE/../_integrity.sh" | grep -v 'BASH_SOURCE' \
  | grep -qE '(^|[^\\])\$\{?[A-Z][A-Z0-9_]*' \
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

# The settings file may be entirely ABSENT, not merely un-registered inside it — the exact worktree
# case cited in this file's own header comment. core/.harness must say the harness is required:
# deletion alone gives _wiring_want no signal to go on (the same reason integrity_wiring calls that
# combination `absent` rather than a defect), so the fixture forces the requirement explicitly.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
printf 'claude\n' > "$W/core/.harness"
rm -f "$R/.claude/settings.json"
wiring_repair "$W" degraded unregistered >/dev/null 2>&1
[ -f "$R/.claude/settings.json" ] && ok || bad "repair must create settings.json from scratch when the harness requires it and the file is gone entirely"
case "$(slots_of "$R/.claude/settings.json")" in
  *PreToolUse:Bash*) ok ;; *) bad "a from-scratch settings.json must still register the Bash slot" ;;
esac
rm -rf "$R"

# Symmetric case for Cursor: hooks.json entirely absent, core/.harness requires cursor. The WHOLE
# .cursor/ directory is removed here, not just the file — a plain `rm -f` on the file alone leaves
# wire_fixture's `.cursor/hooks/` directory behind, which masked a real bug found in review: the
# repair never `mkdir -p`'d the parent directory, so it silently failed to create hooks.json
# whenever .cursor/ itself did not already exist (measured: "hooks.json created: NO"). The
# equivalent stress for CLAUDE is structurally impossible to build: the kit itself lives under
# .claude/skills/hektor-flaky-triage, so a fixture where .claude/ is fully absent has no kit_root
# for integrity_project_root to resolve in the first place — .claude/ is guaranteed to exist in any
# fixture this function can even be called against. Checked via _wiring_cover rather than a
# `case`/glob match on the literal string "beforeShellExecution:*" — that asterisk is data here, not
# a wildcard, and a glob pattern is the wrong tool to compare it literally.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
printf 'cursor\n' > "$W/core/.harness"
rm -rf "$R/.cursor"
wiring_repair "$W" degraded unregistered >/dev/null 2>&1
[ -f "$R/.cursor/hooks.json" ] && ok || bad "repair must create hooks.json from scratch when Cursor is required and the file (and its directory) are gone entirely"
[ -n "$(_wiring_cover "$(_wiring_slots "$R/.cursor/hooks.json")" beforeShellExecution '*')" ] \
  && ok || bad "a from-scratch hooks.json must still register beforeShellExecution"
rm -rf "$R"

# unregistered -> all three slots written, but ONLY where the tree is not root-owned.
for T in degraded unprotected unlocked; do
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

# At EVERY REFUSING TIER nothing is written, registration included — not just the gate file. A
# registration written here would read as `wired` on the very next entrypoint call (integrity_guard
# recomputes from disk every time), so the tier would stop refusing while the session's harness still
# has no gate loaded. See the fuller two-call/byte-identical proof at the bottom of this file; this is
# the narrow "no slot lands" companion to it.
#
# `mismatch` is in this list because the rule is "the tier refuses", not "the tree is root-owned":
# the first phrasing shipped, and it reached hardened and stale while missing the one tier whose whole
# meaning is a recorded root ownership the tree does NOT have. Unlike the other two it needs no stat
# shim — recorded `hardened` on a user-owned tree IS `mismatch`, which is any fixture's default state.
for T in hardened stale mismatch; do
  R="$(mktemp -d)"; W="$(wire_fixture "$R")"; echo '{}' > "$R/.claude/settings.json"
  wiring_repair "$W" "$T" unregistered >/dev/null 2>&1
  case "$(slots_of "$R/.claude/settings.json")" in
    *PreToolUse:Bash*) bad "$T: the Bash slot must NOT be registered — nothing may be written at this tier" ;; *) ok ;;
  esac
  case "$(slots_of "$R/.claude/settings.json")" in
    *PreToolUse:Write*) bad "$T: the Write slot must NOT be registered — nothing may be written at this tier" ;; *) ok ;;
  esac
  [ "$(cat "$R/.claude/settings.json")" = '{}' ] \
    && ok || bad "$T: settings.json must be untouched (still '{}') when the tree is root-owned"
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

# dangling falls through the SAME case arm as unregistered/partial — deliberately: the gate-FILE
# restore (added in a later round of this same task) hangs off this state too, and this `case` must
# not block it. This block, unlike that one, is about the REGISTRATION half: in a dangling fixture
# the registration is already fully correct (it names the right command — the FILE that command
# points at is what's missing), so re-running the merge must be harmless and idempotent, changing
# nothing observable, and the function must still return 0.
#
# This fixture also has no `core/gate-src`, so — as a side effect, not what this block exists to pin
# — the gate-file restore below finds nothing to restore either. That specific case ("no restore
# source -> no restore, and it says so") gets its own dedicated assertion further down, driven by a
# fixture built to test exactly that. A prior version of this comment claimed restoring the gate file
# was "explicitly out of this task's scope" and asserted the file's non-existence as proof — true only
# because this fixture happens to carry no restore source, and stale the moment the restore was
# added. Removed rather than reworded to keep asserting non-existence: that would just be the same
# assertion under two names for two different reasons, one of which no longer holds.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
wiring_repair "$W" degraded dangling >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok || bad "dangling must still return 0, never wedge the caller"
case "$(slots_of "$R/.claude/settings.json")" in
  *PreToolUse:Bash*) ok ;; *) bad "dangling: the existing registration must still cover Bash after repair" ;;
esac
case "$(slots_of "$R/.claude/settings.json")" in
  *PreToolUse:Write*) ok ;; *) bad "dangling: the existing registration must still cover Write" ;;
esac
rm -rf "$R"

# Stale-lock recovery (review Critical): a `.lock.d` left behind by a killed holder (a Ctrl-C
# mid-`_wr_register`) must not wedge every future call. Two shapes, matching _wr_lock's own two
# recovery branches: a lock that never got as far as writing its pid (a holder that crashed between
# `mkdir` and the pid write) is reclaimed once it has sat past the pidless-stale threshold; a lock
# whose recorded holder is PROVABLY DEAD is reclaimed immediately. Pinned FUNCTIONALLY (the repair
# still completes) rather than by a tight wall-clock assertion, which would be its own source of CI
# flakiness — the measured numbers proving the fix (a stale lock cost every call the FULL 10s wait,
# forever, on the pre-fix code — reproduced directly at ~14s elapsed) are recorded in the task report
# instead of pinned here.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
jq 'del(.hooks.PreToolUse[] | select(.matcher=="Bash"))' "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
mkdir -p "$R/.claude/settings.json.lock.d"           # pidless: simulates a crash mid-acquire
wiring_repair "$W" degraded partial >/dev/null 2>&1
case "$(slots_of "$R/.claude/settings.json")" in
  *PreToolUse:Bash*) ok ;; *) bad "a pidless stale lock must eventually be reclaimed, not wedge the repair forever" ;;
esac
rm -rf "$R"

R="$(mktemp -d)"; W="$(wire_fixture "$R")"
jq 'del(.hooks.PreToolUse[] | select(.matcher=="Bash"))' "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
( exit 0 ) & DEADPID=$!; wait "$DEADPID" 2>/dev/null   # a pid guaranteed to be dead by the time we use it
mkdir -p "$R/.claude/settings.json.lock.d"; echo "$DEADPID" > "$R/.claude/settings.json.lock.d/pid"
wiring_repair "$W" degraded partial >/dev/null 2>&1
case "$(slots_of "$R/.claude/settings.json")" in
  *PreToolUse:Bash*) ok ;; *) bad "a lock held by a provably dead pid must be reclaimed immediately" ;;
esac
rm -rf "$R"

# foreign is NEVER written to. The file must come back byte-identical.
#
# Driven at `degraded`, NOT at `hardened`. This is the design's headline decision and it was
# unguarded: the tier is checked before the wiring value, so a `hardened` fixture short-circuits on
# the refusing-tier guard and never consults the `foreign` exclusion at all — the whole-branch review
# mutated `_wiring_repair.sh`'s wiring case to `unregistered|partial|dangling|foreign) : ;;` and the
# suite stayed 267/0. `degraded` is the weakest tier that reaches the exclusion, so the exclusion is
# the ONLY thing standing between this call and a write.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
cp "$R/.claude/settings.json" "$R/before.json"
wiring_repair "$W" degraded foreign >/dev/null 2>&1
cmp -s "$R/before.json" "$R/.claude/settings.json" && ok || bad "foreign must never be repaired — a stranger's gate is not ours to overwrite"
rm -rf "$R"

# wired and absent do nothing.
for V in wired absent; do
  R="$(mktemp -d)"; W="$(wire_fixture "$R")"; cp "$R/.claude/settings.json" "$R/before.json"
  wiring_repair "$W" degraded "$V" >/dev/null 2>&1
  cmp -s "$R/before.json" "$R/.claude/settings.json" && ok || bad "$V must not touch the settings file"
  rm -rf "$R"
done

# The repair is ADDITIVE: unrelated keys survive untouched, and so do SIBLING HOOK EVENTS. A merge
# that rebuilt `.hooks` as `{PreToolUse: (.hooks.PreToolUse // [])}` — discarding PostToolUse,
# SessionStart, Stop, UserPromptSubmit, every other real event a project's settings.json can carry —
# would satisfy the three top-level-key assertions below and still destroy real hook config.
# Confirmed by mutation during review: exactly that rewrite left this file green because nothing
# looked INSIDE `.hooks` for a sibling event.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
jq '.permissions = {allow:["Bash(ls:*)"]} | .env = {FOO:"bar"} | .model = "sonnet"
    | .hooks.PostToolUse = [{"matcher":"Write","hooks":[{"type":"command","command":"echo post"}]}]
    | .hooks.Stop = [{"hooks":[{"type":"command","command":"echo stop"}]}]' \
   "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
jq 'del(.hooks.PreToolUse[] | select(.matcher=="Bash"))' "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
wiring_repair "$W" degraded partial >/dev/null 2>&1
[ "$(jq -r '.permissions.allow[0]' "$R/.claude/settings.json")" = "Bash(ls:*)" ] && ok || bad "repair must leave permissions untouched"
[ "$(jq -r '.env.FOO' "$R/.claude/settings.json")" = "bar" ] && ok || bad "repair must leave env untouched"
[ "$(jq -r '.model' "$R/.claude/settings.json")" = "sonnet" ] && ok || bad "repair must leave model untouched"
[ "$(jq -r '.hooks.PostToolUse[0].hooks[0].command' "$R/.claude/settings.json")" = "echo post" ] \
  && ok || bad "repair must leave the sibling hook event PostToolUse untouched"
[ "$(jq -r '.hooks.Stop[0].hooks[0].command' "$R/.claude/settings.json")" = "echo stop" ] \
  && ok || bad "repair must leave the sibling hook event Stop untouched"
rm -rf "$R"

# The Cursor merge must be additive too: unrelated top-level keys survive, and re-adding a DELETED
# preToolUse array must not come at the cost of the beforeShellExecution array that was already
# there (or vice versa) — a merge that rebuilt the whole document around just one of the two slots
# would satisfy the from-scratch test above (which only checks beforeShellExecution) and still lose
# the other. Confirmed by mutation during review: replacing the Cursor merge with a
# beforeShellExecution-only document left the suite fully green, because the only prior Cursor
# coverage was that single from-scratch assertion.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
jq '.someOtherTool = {custom:true}' "$R/.cursor/hooks.json" > "$R/s" && mv "$R/s" "$R/.cursor/hooks.json"
jq 'del(.hooks.preToolUse)' "$R/.cursor/hooks.json" > "$R/s" && mv "$R/s" "$R/.cursor/hooks.json"
wiring_repair "$W" degraded partial >/dev/null 2>&1
[ "$(jq -r '.someOtherTool.custom' "$R/.cursor/hooks.json")" = "true" ] \
  && ok || bad "Cursor repair must leave unrelated top-level keys untouched"
[ "$(jq '.hooks.beforeShellExecution | length' "$R/.cursor/hooks.json")" -ge 1 ] \
  && ok || bad "Cursor repair must not drop beforeShellExecution while re-adding preToolUse"
[ "$(jq '.hooks.preToolUse | length' "$R/.cursor/hooks.json")" -ge 1 ] \
  && ok || bad "Cursor repair must re-add a deleted preToolUse array"
rm -rf "$R"

# Not an installed layout -> nothing is written anywhere, and the ATTEMPT is never even made.
# core/.harness is forced to `claude` here — review found that without it, "$R/notakit" has no
# .claude or .cursor at all, so _wiring_want's own fallback already returns "0 0" regardless of
# root, and the `[ -n "$root" ] || return 0` guard this assertion means to pin is never even
# reached: a mutation deleting that guard left the suite green, because there was nothing downstream
# for its absence to change. Forcing the harness record makes the guard the ONLY thing standing
# between this call and an attempted repair. SILENCE is what actually distinguishes "the guard
# fired" from "the guard was skipped and the write merely failed somewhere outside the sandbox": an
# empty root concatenates to the real filesystem's "/", which this test process cannot write to
# either way, so `find "$R"` stays empty regardless — but with the guard gone, the attempt still
# prints "cannot repair the registration" to stderr first. The guard prevents that line entirely.
R="$(mktemp -d)"; mkdir -p "$R/notakit/core"
printf 'claude\n' > "$R/notakit/core/.harness"
OUT="$(wiring_repair "$R/notakit" degraded unregistered 2>&1 >/dev/null)"
[ -z "$(find "$R" -name 'settings*.json' 2>/dev/null)" ] && ok || bad "a non-installed layout must never be written to"
[ -z "$OUT" ] && ok || bad "a non-installed layout must be silent, not attempt (and fail) a repair — got: $OUT"
rm -rf "$R"

# It narrates on stderr and nothing reaches stdout — four entrypoints emit a contract there.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; echo '{}' > "$R/.claude/settings.json"
[ -z "$(wiring_repair "$W" degraded unregistered 2>/dev/null)" ] \
  && ok || bad "wiring_repair must never write to stdout"
case "$(wiring_repair "$W" degraded unregistered 2>&1 >/dev/null)" in
  *REPAIRED*) ok ;; *) bad "a repair must say so on stderr" ;;
esac
rm -rf "$R"

# REPAIRED must be gated on an ACTUAL write, not merely on acquiring the lock (review Important 2).
# `.hooks.PreToolUse` is set to a STRING here, not an array: the file still parses as valid JSON (so
# the pre-check passes and the lock is acquired), but the merge jq errors internally
# (`string and array cannot be added`, confirmed separately), so `_wr_register` returns 1 and no
# write lands. core/.harness pins this to Claude only, so a Cursor-side success elsewhere in the
# same call cannot mask the assertion.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
printf 'claude\n' > "$W/core/.harness"
jq '.hooks.PreToolUse = "not-an-array"' "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
cp "$R/.claude/settings.json" "$R/before.json"
OUT="$(wiring_repair "$W" degraded unregistered 2>&1 >/dev/null)"
case "$OUT" in *REPAIRED*) bad "a merge that fails internally must not announce REPAIRED — got: $OUT" ;; *) ok ;; esac
cmp -s "$R/before.json" "$R/.claude/settings.json" && ok || bad "a failed merge must not leave the settings file half-written"
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

# Residual blind spot, noted rather than closed (review round 2): the exclusion above is by NAME, so
# it also hides a hypothetical `if [ "$CLAUDE_PROJECT_DIR" = ... ]`-style READ of the variable's
# VALUE, not just the literal-command use this file actually makes of the name. The behavioural
# assertion below only checks what ends up WRITTEN to the settings file — it would not catch a
# branch that reads the variable's value and does something else with it entirely. No such read
# exists in _wiring_repair.sh today; if one is ever added, neither check here would catch it.

# The excluded name is genuinely a literal: set it in the environment to something else and the
# written command must still carry the unexpanded text, never the hijacked path. If this ever fails,
# the exclusion above has stopped being safe and the grep is no longer the thing to fix.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; echo '{}' > "$R/.claude/settings.json"
CLAUDE_PROJECT_DIR=/tmp/hijack-me wiring_repair "$W" degraded unregistered >/dev/null 2>&1
grep -q 'CLAUDE_PROJECT_DIR' "$R/.claude/settings.json" && ok || bad "the registered command must keep \$CLAUDE_PROJECT_DIR unexpanded"
grep -q '/tmp/hijack-me' "$R/.claude/settings.json" && bad "the registered command must not expand CLAUDE_PROJECT_DIR from the caller's environment" || ok
rm -rf "$R"

# --- wiring_repair: the gate file --------------------------------------------------------------
# ADAPTED FROM THE BRIEF, same reason as the earlier "ADAPTED FROM THE BRIEF" note in this file:
# wire_fixture returns the KIT path directly ($dir/.claude/skills/hektor-flaky-triage), not a
# project root one level up from it. The brief's snippet computed K as "$W/.claude/skills/hektor-
# flaky-triage" (assuming W was the project root), which under the helper's real contract double-
# appends the suffix onto a path that is already the kit path. K is therefore just wire_fixture's
# return value here, and the restored file's location is checked under R (the actual project root
# passed INTO wire_fixture), never under K.
#
# Below root ownership the file comes back.
for T in degraded unprotected unlocked; do
  R="$(mktemp -d)"; K="$(wire_fixture "$R")"
  mkdir -p "$K/core/gate-src/claude/lib"
  printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
  chmod +x "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
  printf 'audit\n' > "$K/core/gate-src/claude/lib/audit.sh"
  rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
  wiring_repair "$K" "$T" dangling >/dev/null 2>&1
  [ -x "$R/.claude/hooks/flaky-kit-self-protection-gate.sh" ] && ok || bad "$T: a dangling gate must be restored, executable"
  [ -f "$R/.claude/hooks/lib/audit.sh" ] && ok || bad "$T: the audit lib must be restored beside it"
  rm -rf "$R"
done

# At a REFUSING tier the gate file is not restored either — `wiring_repair`'s own guard returns before
# `_wr_restore_gate` is ever called. Asserted at all three: hardened and stale (the tree IS root-owned,
# so a file written as this user would read `foreign` and break the kit differently while claiming to
# heal it) and mismatch (the tree is NOT root-owned, and a gate copied out of a tree the same run
# declares untrustworthy is planted exactly where a later re-lock would chown it to root and bless it).
#
# WHAT THESE ASSERT WAS WRONG BEFORE. `_wr_restore_gate` used to carry its own `hardened|stale` arm,
# and these two assertions were labelled for ITS message — but the outer guard short-circuits first,
# so the `*root-owned*` glob was matching the OUTER message and the inner arm had zero coverage
# (deleting it outright left the suite 267/0). The arm is now gone, the rule lives in `wiring_repair`
# alone, and the glob below names text that only the outer guard emits. The third assertion is the one
# that makes the misattribution impossible to repeat: `_wr_restore_gate` announces every restore it
# performs, so the ABSENCE of any "restore" line is direct evidence it was never reached.
for T in hardened stale mismatch; do
  R="$(mktemp -d)"; K="$(wire_fixture "$R")"
  mkdir -p "$K/core/gate-src/claude/lib"
  printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
  rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
  OUT="$(wiring_repair "$K" "$T" dangling 2>&1 >/dev/null)"
  [ ! -e "$R/.claude/hooks/flaky-kit-self-protection-gate.sh" ] && ok || bad "$T: a refusing tier must not get a user-owned gate — the outer guard writes nothing"
  case "$OUT" in
    *"not repairing"*) ok ;; *) bad "$T: refusing to repair must say why, in the OUTER guard's own words — got: $OUT" ;;
  esac
  case "$OUT" in
    *restor*) bad "$T: _wr_restore_gate must never be reached at a refusing tier — it said something about restoring: $OUT" ;; *) ok ;;
  esac
  rm -rf "$R"
done

# `_wr_restore_gate` is TIER-BLIND, and that is the design, not an oversight. Driven directly, with
# the tier the outer guard would have refused at, it restores — because the tier is not its business
# and is no longer one of its parameters. Two things are pinned here: that the rule has exactly ONE
# implementation (the block above proves the outer guard enforces it; this proves the inner function
# does not, so neither can drift from the other), and the three-argument signature itself — the
# five-parameter version carried two never-read slots (`$root` at all, `$tier` only in the dead arm),
# which is how a mis-ordered call gets written and never noticed.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
mkdir -p "$K/core/gate-src/claude/lib"
printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
chmod +x "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
OUT="$(_wr_restore_gate "$K" claude "$R/.claude/hooks" 2>&1 >/dev/null)"
[ -x "$R/.claude/hooks/flaky-kit-self-protection-gate.sh" ] \
  && ok || bad "_wr_restore_gate called directly must restore — it takes <kit> <harness> <dest> and knows nothing about tiers"
case "$OUT" in
  *"restored the claude gate"*) ok ;; *) bad "_wr_restore_gate must announce the restore it performed — got: $OUT" ;;
esac
rm -rf "$R"

# The dead parameters are gone for real, not merely unused: a call written to the OLD five-argument
# shape must not silently half-work. With `$root` and `$tier` still leading, `$2` (a project root) is
# read as the harness name and `$3` (a tier string) as the destination directory, so the restore lands
# nowhere near the gate path — the failure a five-slot signature with two dead slots invites.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
mkdir -p "$K/core/gate-src/claude/lib"
printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
_wr_restore_gate "$K" "$R" hardened claude "$R/.claude/hooks" >/dev/null 2>&1
[ ! -e "$R/.claude/hooks/flaky-kit-self-protection-gate.sh" ] \
  && ok || bad "an old-shape five-argument call must not land a gate at the real path — the signature is three arguments"
rm -rf "$R"

# No restore source -> no restore, and it says so rather than failing silently.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
rm -rf "$K/core/gate-src"
rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
wiring_repair "$K" degraded dangling >/dev/null 2>&1
[ ! -e "$R/.claude/hooks/flaky-kit-self-protection-gate.sh" ] && ok || bad "no restore source must mean no restore"
case "$(wiring_repair "$K" degraded dangling 2>&1 >/dev/null)" in
  *restore\ source*) ok ;; *) bad "a missing restore source must be named" ;;
esac
rm -rf "$R"

# --- review round 2, Important 1: a ZERO-BYTE restore source must not be restored -----------------
# `[ -r ]` passes on an empty file. Installing one would create a gate that PASSES its own existence
# check (`_wiring_one` below the root-owned tiers tests only `[ -f ]`) while enforcing nothing at
# all — a loud, repairable `dangling` silently flipping to `wired`, worse than the missing file it
# replaced. Asserted three ways: the file must not land, the ENGINE'S OWN wiring verdict must stay
# `dangling` rather than flip to `wired` (the actual exploit, not just a proxy for it), and the
# refusal must say why.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
mkdir -p "$K/core/gate-src/claude/lib"
: > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"   # zero bytes: readable, unusable
rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
wiring_repair "$K" degraded dangling >/dev/null 2>&1
[ ! -e "$R/.claude/hooks/flaky-kit-self-protection-gate.sh" ] && ok || bad "a zero-byte restore source must not be installed"
[ "$(integrity_wiring "$K" degraded)" = dangling ] \
  && ok || bad "a zero-byte restore source must leave the verdict dangling, not flip it to wired (got $(integrity_wiring "$K" degraded))"
case "$(wiring_repair "$K" degraded dangling 2>&1 >/dev/null)" in
  *"no usable restore source"*) ok ;; *) bad "a zero-byte restore source must say why it was refused" ;;
esac
rm -rf "$R"

# --- review round 2, Important 2: mkdir/cp failures inside the restore must say why ----------------
# Same shape as the carried Task-2 finding this task already fixed in the REGISTRATION path, one
# function below — a failure here must not be silent either.
#
# mkdir failure: a plain FILE sits where the destination directory must go, so `mkdir -p "$dest/lib"`
# cannot create it (verified directly above: `mkdir -p` on a path whose parent is a regular file
# returns 1 with "Not a directory").
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
mkdir -p "$K/core/gate-src/claude/lib"
printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
rm -rf "$R/.claude/hooks"
: > "$R/.claude/hooks"                       # a FILE where the dest directory must go
OUT="$(wiring_repair "$K" degraded dangling 2>&1 >/dev/null)"
case "$OUT" in *"not creatable"*) ok ;; *) bad "an mkdir failure inside the restore must say why — got: $OUT" ;; esac
rm -rf "$R"

# cp failure: `dest/lib` is pre-created (so `mkdir -p` is a mere existence check, not a write — see
# the mkdir-existing probe above) but `dest` itself is not writable, so the gate script — which lands
# directly in `dest`, not `dest/lib` — cannot be written (verified directly above: `cp` into a 555
# directory returns 1, "Permission denied").
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
mkdir -p "$K/core/gate-src/claude/lib"
printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
mkdir -p "$R/.claude/hooks/lib"               # pre-created while still writable
chmod 555 "$R/.claude/hooks"
OUT="$(wiring_repair "$K" degraded dangling 2>&1 >/dev/null)"
chmod 755 "$R/.claude/hooks"                 # restore perms so cleanup below can actually remove it
case "$OUT" in *"writing"*"failed"*) ok ;; *) bad "a cp failure inside the restore must say why — got: $OUT" ;; esac
rm -rf "$R"

# audit-lib copy failure: the gate script itself lands fine (dest dir writable), but `dest/lib` is
# not, so only the audit lib fails to copy. This is a DEGRADED outcome, not a broken one — the
# adapter's gate stubs `hektor_audit(){ :; }` when the lib is absent — so the message says exactly
# that instead of treating it as a full restore failure, and the gate script must still land.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
mkdir -p "$K/core/gate-src/claude/lib"
printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
chmod +x "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
printf 'audit\n' > "$K/core/gate-src/claude/lib/audit.sh"
rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
mkdir -p "$R/.claude/hooks/lib"
chmod 555 "$R/.claude/hooks/lib"             # lib itself unwritable; hooks/ stays writable
OUT="$(wiring_repair "$K" degraded dangling 2>&1 >/dev/null)"
chmod 755 "$R/.claude/hooks/lib"             # restore perms so cleanup below can actually remove it
case "$OUT" in *"still runs, unaudited"*) ok ;; *) bad "a failed audit-lib copy must say the gate still runs unaudited — got: $OUT" ;; esac
[ -x "$R/.claude/hooks/flaky-kit-self-protection-gate.sh" ] \
  && ok || bad "the gate script itself must still land even when the audit lib copy fails"
rm -rf "$R"

# A ZERO-BYTE audit-lib SOURCE is the third outcome the `[ -s ]` test used to collapse into the
# second. `[ -s ]` is false for an empty file exactly as it is for a missing one, so the branch took
# neither the copy nor the warning and the clean "restored the … gate" line then announced a full
# restore for a degraded one — the same `-r`-vs-`-s` confusion already fixed one line up for the gate
# script itself. Three assertions, because "it warned" alone would not distinguish the fix from a
# version that warned AND installed the empty lib: the empty file must NOT be copied (the adapter's
# gate stubs `hektor_audit(){ :; }` only when the lib is MISSING — a present-but-empty one gets
# sourced and defines nothing, which is worse than absent), the warning must be there, and the gate
# script itself must still land, because this is a degradation and not a failure.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
mkdir -p "$K/core/gate-src/claude/lib"
printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
chmod +x "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
: > "$K/core/gate-src/claude/lib/audit.sh"          # zero bytes: present, readable, useless
rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
OUT="$(wiring_repair "$K" degraded dangling 2>&1 >/dev/null)"
[ ! -e "$R/.claude/hooks/lib/audit.sh" ] \
  && ok || bad "a zero-byte audit-lib source must not be copied — an empty lib is worse than an absent one"
case "$OUT" in *"still runs, unaudited"*) ok ;; *) bad "a zero-byte audit-lib source must say the gate still runs unaudited — got: $OUT" ;; esac
[ -x "$R/.claude/hooks/flaky-kit-self-protection-gate.sh" ] \
  && ok || bad "the gate script itself must still land when only the audit lib source is unusable"
rm -rf "$R"

# --- review round 2, Important 3: a HEALTHY harness must not be overwritten just because the OTHER
# --- one is dangling -------------------------------------------------------------------------------
# `dangling` is a verdict over the WHOLE project (the worse of the two harnesses), so a project whose
# Claude gate is missing and whose Cursor gate is fine reaches `_wr_restore_gate` for BOTH harnesses.
# Without the "already there" guard, the healthy Cursor gate gets silently overwritten and announced
# as restored — a repair claimed for a harness that was never broken, the same misattribution class
# the per-harness `did_c`/`did_u` split fixed in the registration path. Proven with deliberately
# DIFFERENT content at the two restore sources, so an overwrite is observable by content, not just by
# an announcement.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
mkdir -p "$K/core/gate-src/claude/lib" "$K/core/gate-src/cursor/lib"
printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
printf '#!/bin/sh\nexit 1\n' > "$K/core/gate-src/cursor/flaky-kit-self-protection-gate.sh"
rm -f "$R/.claude/hooks/flaky-kit-self-protection-gate.sh"          # Claude: dangling
cp "$R/.cursor/hooks/flaky-kit-self-protection-gate.sh" "$R/before-cursor-gate.sh"  # Cursor: healthy
OUT="$(wiring_repair "$K" degraded dangling 2>&1 >/dev/null)"
cmp -s "$R/before-cursor-gate.sh" "$R/.cursor/hooks/flaky-kit-self-protection-gate.sh" \
  && ok || bad "a healthy Cursor gate must not be overwritten just because Claude's is dangling"
case "$OUT" in *"restored the cursor gate"*) bad "a healthy Cursor gate must not be announced as restored — got: $OUT" ;; *) ok ;; esac
case "$OUT" in *"restored the claude gate"*) ok ;; *) bad "the actually-broken Claude gate must still be restored and announced — got: $OUT" ;; esac
rm -rf "$R"

# --- carried forward from Task 2 review, Finding 1: a failed merge must not be completely silent -
# Task 2 correctly stopped announcing REPAIRED when the merge fails, but added no diagnostic in its
# place — measured, the failing-merge fixture below printed nothing at all, contradicting this
# file's own header ("every failure mode here resolves to doing nothing and saying why"). Same
# fixture as the REPAIRED-gating test above (a PreToolUse STRING forces _wr_register to error
# internally); the new assertion is the flip side that test never checked: something must be SAID.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
printf 'claude\n' > "$W/core/.harness"
jq '.hooks.PreToolUse = "not-an-array"' "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
OUT="$(wiring_repair "$W" degraded unregistered 2>&1 >/dev/null)"
[ -n "$OUT" ] && ok || bad "a merge that fails internally must say why instead of printing nothing at all"
case "$OUT" in *"Claude gate registration merge failed"*) ok ;; *) bad "the diagnostic must actually name the failed merge, not just make some noise — got: $OUT" ;; esac
rm -rf "$R"

# --- carried forward from Task 2 review, Finding 2: `did` is an OR across the two harnesses -------
# A single OR'd `did` prints one shared REPAIRED even when only one harness actually succeeded,
# leaving a failing Claude merge unregistered AND unmentioned beside a healthy Cursor one.
# core/.harness=all forces both branches to run; Claude's settings are corrupted the same way as
# above (merge fails), Cursor's are left exactly as wire_fixture built them (already fully
# registered, so its merge is a trivial, successful no-op) — the asymmetry the OR was hiding.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
printf 'all\n' > "$W/core/.harness"
jq '.hooks.PreToolUse = "not-an-array"' "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
OUT="$(wiring_repair "$W" degraded unregistered 2>&1 >/dev/null)"
case "$OUT" in *"Claude gate registration merge failed"*) ok ;; *) bad "a failing Claude merge alongside a healthy Cursor one must still name Claude's failure — got: $OUT" ;; esac
case "$OUT" in *"REPAIRED — the Cursor gate registration has been rewritten."*) ok ;; *) bad "a healthy Cursor merge must still be announced BY NAME, not folded into one shared REPAIRED — got: $OUT" ;; esac
case "$OUT" in *"REPAIRED — the Claude gate registration has been rewritten."*) bad "Claude must not be reported REPAIRED when its own merge failed — got: $OUT" ;; *) ok ;; esac
rm -rf "$R"

# --- Task 4: integrity_guard calls wiring_repair between detection and reporting ------------------
# Three prior tasks built _wiring_repair.sh; nothing in production sourced it and integrity_guard
# never called it, so the whole repair was dead code reachable from no entrypoint (confirmed at the
# time: grep -rn "wiring_repair" outside core/tests/ matched only comments). This section pins that
# it is now wired in, AND that the ordering is the deliberate one: repair happens, but the verdict
# handed to integrity_report is the PRE-repair one — a written registration does not arm a running
# session, because the harness reads hook config at startup, so a root-owned tree must still refuse
# on the very call that finds and fixes it.

# integrity_guard repairs and proceeds at a tier that was never going to refuse anyway (no root
# ownership involved) — a genuinely unprotected fixture whose settings.json has been wiped of its
# registration entirely.
#
# ADAPTED FROM THE BRIEF, same convention as every other "ADAPTED FROM THE BRIEF" note in this file:
# wire_fixture(R) returns the KIT path directly, not a project root one level above it, so K is just
# that return value and the settings file lives under R (wire_fixture's own argument), never under K.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
echo '{}' > "$R/.claude/settings.json"
integrity_guard "$K" >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok || bad "an unprotected tree must proceed after repairing"
case "$(slots_of "$R/.claude/settings.json")" in
  *PreToolUse:Bash*) ok ;; *) bad "the guard must have repaired the registration" ;;
esac
# Second call: now wired, and silent about wiring.
case "$(integrity_guard "$K" 2>&1 >/dev/null)" in
  *WIRING*) bad "a repaired registration must read as wired on the next call" ;; *) ok ;;
esac
rm -rf "$R"

# The guard's signature is unchanged, so no call site moved.
#
# ADAPTED FROM THE BRIEF: the brief's own snippet here — `[ "$(grep -c '...' "$HERE"/../*.sh)" -ge 1 ]`
# — hands `[ ]` a MULTI-LINE "path:count" blob the instant more than one file matches (grep -c prints
# one "path:count" line PER FILE when given multiple files, not a single combined total), and `[ -ge ]`
# against a multi-line string is not a comparison, it is a guaranteed "integer expression expected"
# error — verified directly against this unmodified tree, before this task changed anything: that
# exact line evaluates to `bad` unconditionally, every time, regardless of how many call sites exist.
# `grep -o` + `wc -l` collapses the matches across every file to the single total the assertion needs.
[ "$(grep -o 'integrity_guard "' "$HERE"/../*.sh | wc -l | tr -d '[:space:]')" -eq 13 ] \
  && ok || bad "integrity_guard call sites must not have moved (expected 13)"

# --- review Critical 1: pin that the two production lines (the sourcing line and its no-op
# --- fallback) actually MATTER, not just that integrity_guard calls wiring_repair -----------------
# Every fixture above reaches integrity_guard with `wiring_repair` ALREADY defined for real, because
# THIS test file sources _integrity.sh — and therefore, at load time, _wiring_repair.sh from THIS
# repo's own core/ — once at the top. wire_fixture() never places a copy of _wiring_repair.sh under
# its own core/, so nothing above ever exercises _integrity.sh's own lookup or its no-op fallback
# when that lookup fails. Confirmed by mutation (recorded in the task report): deleting either the
# sourcing line or the fallback line in _integrity.sh left the WHOLE suite green, all 11 files,
# 722/0 — the exact inert state this task exists to end.
#
# Driven in a genuinely FRESH bash PROCESS, which starts with no functions defined at all (functions
# do not cross a process boundary the way they cross a subshell), against a fixture whose OWN core/
# carries a copy of _integrity.sh (and, for the first case, _wiring_repair.sh too) — so
# `${BASH_SOURCE[0]}` inside THAT copy of _integrity.sh resolves to the FIXTURE's own core/, not this
# repository's, and it is the lookup this task added that has to find it, not a load that already
# happened somewhere else.
DRIVER="$(mktemp)"
cat > "$DRIVER" <<'DRV'
. "$1/core/_integrity.sh"
integrity_guard "$1"
DRV

R="$(mktemp -d)"; K="$(wire_fixture "$R")"
cp "$CORE/_integrity.sh" "$CORE/_wiring_repair.sh" "$K/core/"
echo '{}' > "$R/.claude/settings.json"          # registration gone: unregistered
bash "$DRIVER" "$K" >/dev/null 2>&1
case "$(slots_of "$R/.claude/settings.json")" in
  *PreToolUse:Bash*) ok ;; *) bad "a FRESH process, with wiring_repair defined nowhere yet, must still find and run the repair via _integrity.sh's own lookup — the registration was not repaired" ;;
esac
rm -rf "$R"

# Now the SAME shape with _wiring_repair.sh deliberately absent: the no-op fallback must hold. The
# guard must still return a SANE rc (0 or 76, never a crash or a hang) and keep stdout clean, even
# when the repair unit this task wires in is itself missing — the "never wedge a caller" contract
# thirteen entrypoints depend on, exercised here instead of only asserted in a comment.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
cp "$CORE/_integrity.sh" "$K/core/"                     # _wiring_repair.sh deliberately NOT copied
echo '{}' > "$R/.claude/settings.json"
OUT="$(bash "$DRIVER" "$K" 2>/dev/null)"; RC=$?
[ -z "$OUT" ] && ok || bad "a missing _wiring_repair.sh must not leak anything to stdout — got: $OUT"
case "$RC" in 0|76) ok ;; *) bad "a missing _wiring_repair.sh must still return a sane rc (0 or 76), not wedge the caller (got $RC)" ;; esac

# The rc/stdout pair above does NOT, by itself, distinguish "the fallback defined a no-op" from "the
# fallback is gone and wiring_repair is simply undefined": integrity_guard's LAST command is always
# integrity_report, so ITS rc is what the function returns regardless of whether the earlier call to
# `wiring_repair` inside it succeeded, silently no-op'd, or hit bash's own "command not found" (127)
# on an undefined name — verified directly: deleting the `|| wiring_repair() { return 0; }` clause
# and keeping only the sourcing half left the two assertions above (and every other assertion in
# this file) green. So the fallback's existence has to be probed DIRECTLY: source the same
# fixture and call `wiring_repair` itself, not just integrity_guard, and check both that it returns 0
# and that bash never reports it as an unknown command.
DRIVER2="$(mktemp)"
cat > "$DRIVER2" <<'DRV'
. "$1/core/_integrity.sh"
wiring_repair a b c
printf 'wr_rc=%s\n' "$?"
DRV
OUT2="$(bash "$DRIVER2" "$K" 2>&1)"
case "$OUT2" in
  *wr_rc=0*) ok ;; *) bad "with _wiring_repair.sh missing, wiring_repair must still be callable and return 0 via the no-op fallback — got: $OUT2" ;;
esac
case "$OUT2" in
  *"not found"*) bad "with _wiring_repair.sh missing and no fallback, wiring_repair is an UNDEFINED command — got: $OUT2" ;; *) ok ;;
esac
rm -rf "$R"

# --- whole-branch review, Important 4: SOURCED-BUT-NONZERO is the third state, and the one that
# --- silently disabled the entire repair ----------------------------------------------------------
# The two cases above pin PRESENT and ABSENT. The line that used to join them —
#   [ -r X ] && . X || wiring_repair() { return 0; }
# — branches on the STATUS OF THE SOURCE, not on whether the source worked: `. X` returning non-zero
# makes the `||` fire and REDEFINE the just-loaded `wiring_repair` as a no-op. Every function in the
# file loads correctly and then the one that matters is thrown away, with nothing printed and nothing
# failed. It held only because _wiring_repair.sh happens to end on a function definition — a property
# of that file on that day, not of this line, and this is the single line the whole branch's
# reachability rests on.
#
# The fixture appends one `false` to the fixture's OWN copy, which is exactly the mutation that proved
# the defect. The assertion is the repair LANDING, not merely an rc: an rc says nothing here, because
# integrity_guard returns integrity_report's status either way (that is the trap the DRIVER2 probe
# above already documents). What separates a loaded repair from a discarded one is whether the
# registration is on disk afterwards.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
cp "$CORE/_integrity.sh" "$CORE/_wiring_repair.sh" "$K/core/"
printf 'false\n' >> "$K/core/_wiring_repair.sh"      # the sourced file now returns non-zero
echo '{}' > "$R/.claude/settings.json"               # registration gone: unregistered
# CONTROL, required: prove the mutation actually took — a `printf` that silently failed, or a file
# that already returned non-zero, would leave every assertion below passing for the wrong reason.
( . "$K/core/_wiring_repair.sh" ) >/dev/null 2>&1 \
  && bad "CONTROL: the fixture's _wiring_repair.sh must actually return NON-ZERO when sourced, or this block tests nothing" || ok
bash "$DRIVER" "$K" >/dev/null 2>&1
case "$(slots_of "$R/.claude/settings.json")" in
  *PreToolUse:Bash*) ok ;; *) bad "a _wiring_repair.sh whose last statement returns non-zero must still be USED — the fallback may only fire when wiring_repair is genuinely undefined, never on the source's exit status" ;;
esac
rm -rf "$R"

# PRESENT-BUT-UNREADABLE was previously indistinguishable from "not installed": both took the silent
# no-op path, though only one of them is a defect. It must still not wedge the caller (rc sane, stdout
# clean, wiring_repair callable) AND it must now say which of the two states it is in.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
cp "$CORE/_integrity.sh" "$CORE/_wiring_repair.sh" "$K/core/"
chmod 000 "$K/core/_wiring_repair.sh"
echo '{}' > "$R/.claude/settings.json"
# CONTROL: a test process that can read the file anyway (running as root, or a permissive filesystem)
# would make the assertions below vacuous.
[ ! -r "$K/core/_wiring_repair.sh" ] \
  && ok || bad "CONTROL: the fixture's _wiring_repair.sh must actually be unreadable to this process, or the block below tests nothing"
OUT="$(bash "$DRIVER" "$K" 2>/dev/null)"; RC=$?
ERR="$(bash "$DRIVER" "$K" 2>&1 >/dev/null)"
[ -z "$OUT" ] && ok || bad "an unreadable _wiring_repair.sh must not leak anything to stdout — got: $OUT"
case "$RC" in 0|76) ok ;; *) bad "an unreadable _wiring_repair.sh must still return a sane rc (0 or 76), not wedge the caller (got $RC)" ;; esac
case "$ERR" in
  *"present but unreadable"*) ok ;; *) bad "an unreadable _wiring_repair.sh must SAY so rather than degrade silently into the not-installed case — got: $ERR" ;;
esac
OUT3="$(bash "$DRIVER2" "$K" 2>&1)"
case "$OUT3" in *wr_rc=0*) ok ;; *) bad "with _wiring_repair.sh unreadable, wiring_repair must still be callable and return 0 — got: $OUT3" ;; esac
chmod 644 "$K/core/_wiring_repair.sh"                # so the cleanup below can remove it
rm -rf "$R"
rm -f "$DRIVER" "$DRIVER2"

# Task 5 review, Important: a hardened tree that lost its registration refusing (76) on the VERY CALL
# that repairs it is not the property that matters — `integrity_guard` recomputes both axes from the
# filesystem on EVERY call, so if that repair had written the registration to disk, the very NEXT call
# would read `wired` and return 0 while the session's harness still has no gate loaded. One call
# refusing and every call after it proceeding unprotected is the silent loss of protection this whole
# axis exists to catch — measured directly (`integrity_report hardened unregistered` -> 76,
# `integrity_report hardened wired` -> 0) before the fix. The correction: `wiring_repair` writes
# NOTHING where the tree is root-owned, so nothing on disk ever changes and the SECOND consecutive
# call must refuse exactly like the first. That is the assertion the old version of this test did not
# make, and it is the one that would have caught the defect. Asserted at BOTH hardened and stale, the
# same "a rule that read the recorded tier instead of ownership would pass the first and fail the
# second" concern this file already applies to the gate-file restore above.
#
# Real root ownership needs a password this suite cannot supply, so a PATH-shimmed `stat` reports uid
# 0 for exactly this fixture's core/ dir AND its (still user-owned) gate file — the same technique
# core/tests/lock-tier-test.sh already uses to drive its own hardened branch without sudo, extended to
# a colon-separated STAT_TARGETS the same way that file's own STAT_TARGETS does, so BOTH root-ownership
# checks integrity_guard can reach (the tier's own integrity_owner_uid call, and integrity_wiring's
# identity check on the resolved gate path) see a root-owned tree, not just the first one a narrower
# fixture happened to need. Only the numeric `%u` query is intercepted, matching that file's own rule;
# anything else, or a `%u` query against any other path, falls straight through to the real stat.
REAL_STAT="$(command -v stat)"
export REAL_STAT
for T in hardened stale; do
  SHIM="$(mktemp -d)"
  cat > "$SHIM/stat" <<'STATSH'
#!/bin/bash
case " $* " in *" %u "*) ;; *) exec "$REAL_STAT" "$@" ;; esac
IFS=:
for t in ${STAT_TARGETS:-}; do
  for a in "$@"; do [ "$a" = "$t" ] && { echo 0; exit 0; }; done
done
unset IFS
exec "$REAL_STAT" "$@"
STATSH
  chmod +x "$SHIM/stat"

  # `pwd -P` immediately after mktemp, same reason as the PR fixture above and lock-tier-test.sh /
  # install-guard-test.sh: on macOS mktemp -d hands back a /var/folders/... path whose /var is a
  # symlink to /private/var, and integrity_project_root resolves the PHYSICAL path via `cd ... && pwd
  # -P`. Comparing the shim's target against the un-resolved $R silently misses every match: the gate
  # path integrity_wiring actually stats is the /private/var/... form, so a naive STAT_TARGETS built
  # from the raw mktemp path never fires there and the checks below would stay green for the wrong
  # reason (a resolution miss, not the fix being right) — caught by the CONTROL below.
  R="$(mktemp -d)"; R="$(cd "$R" && pwd -P)"; K="$(wire_fixture "$R")"
  printf 'claude\n' > "$K/core/.harness"
  printf '{"tier":"%s","at":"x"}\n' "$T" > "$K/core/.lock-state"
  echo '{}' > "$R/.claude/settings.json"          # the registration is gone: unregistered
  GATE="$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
  # A literal byte copy, not `$(cat …)` captured into a variable: command substitution strips
  # trailing newlines, so a variable-based comparison would only prove "identical up to trailing
  # newlines" rather than the byte-identical claim this assertion makes.
  cp "$R/.claude/settings.json" "$R/.claude/settings.json.before"

  # CONTROL, required (review Critical 2 in Task 4's cycle, same reasoning applies here): prove the
  # shim actually lands this fixture on $T BEFORE trusting anything below — this file's own rule,
  # stated at the K1 CONTROL earlier in this file ("the fixture must reach a non-absent wiring state,
  # or every assertion below is vacuous"), applies here too. Without this, a shim that silently fails
  # to fire (STAT_TARGETS mistyped, PATH not actually picked up, the shim script itself broken) leaves
  # integrity_owner_uid reporting the REAL uid, and the tier becomes `mismatch` instead (recorded
  # hardened/stale, not actually root-owned) — which ALSO refuses with 76 on every call regardless of
  # wiring, so every assertion below would stay green against a tier it does not name.
  CONTROL_TIER="$(export STAT_TARGETS="$K/core:$GATE" PATH="$SHIM:$PATH"
    integrity_tier "$(integrity_owner_uid "$K/core")" "$(integrity_state "$K")")"
  [ "$CONTROL_TIER" = "$T" ] \
    && ok || bad "CONTROL ($T): the shim must make this fixture read as $T, or every check below is vacuous (got $CONTROL_TIER)"

  RC1="$(STAT_TARGETS="$K/core:$GATE" PATH="$SHIM:$PATH" integrity_guard "$K" >/dev/null 2>&1; echo $?)"
  [ "$RC1" = 76 ] && ok \
    || bad "$T: a tree that lost its registration must refuse (76) on the FIRST call (got $RC1)"

  cmp -s "$R/.claude/settings.json" "$R/.claude/settings.json.before" && ok \
    || bad "$T: the settings file must be BYTE-IDENTICAL after a root-owned repair call — nothing may be written here at all"
  case "$(slots_of "$R/.claude/settings.json")" in
    *PreToolUse:Bash*) bad "$T: the registration must NOT have been repaired — a write here is exactly what let the second call read wired" ;; *) ok ;;
  esac

  MSG="$(STAT_TARGETS="$K/core:$GATE" PATH="$SHIM:$PATH" wiring_repair "$K" "$T" unregistered 2>&1 >/dev/null)"
  case "$MSG" in
    *root-owned*) ok ;; *) bad "$T: refusing to repair must say why — got: $MSG" ;;
  esac

  RC2="$(STAT_TARGETS="$K/core:$GATE" PATH="$SHIM:$PATH" integrity_guard "$K" >/dev/null 2>&1; echo $?)"
  [ "$RC2" = 76 ] && ok \
    || bad "$T: must ALSO refuse (76) on the SECOND consecutive call — this is exactly the property the old write-then-recompute behaviour failed (got $RC2)"

  rm -rf "$R" "$SHIM"
done

# --- whole-branch review, Important 1: `mismatch` is the THIRD refusing tier -----------------------
# The ruling the loop above encodes was first phrased "where the tree is root-owned", which reaches
# `hardened` and `stale` and misses the one tier whose entire meaning is that the record CLAIMS a root
# ownership the tree does not have. Driven against the real thing — recorded `hardened`, `core/` left
# user-owned (so no stat shim is needed, or wanted: the whole point is that the tree is genuinely NOT
# root-owned), the relocated gate file deleted, and `core/gate-src` PRESENT so a restore is actually
# possible — the repair copied the gate script out of a tree the very same run calls untrustworthy,
# into the path that is the kit's own protection hook, and flipped the axis from `dangling` to `wired`.
#
# The gate-src half is what makes this fixture different from a naive one: without a restore source
# there is nothing to copy and the whole finding is invisible. That is precisely the failure mode this
# branch has repeated — an assertion passing against a state its fixture never produced — so the
# CONTROLs below prove the fixture reaches `mismatch`/`dangling` BEFORE anything is asserted about it.
R="$(mktemp -d)"; R="$(cd "$R" && pwd -P)"; K="$(wire_fixture "$R")"
printf 'claude\n' > "$K/core/.harness"
printf '{"tier":"hardened","at":"x"}\n' > "$K/core/.lock-state"   # recorded hardened, tree user-owned
mkdir -p "$K/core/gate-src/claude/lib"
printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
chmod +x "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
printf 'audit\n' > "$K/core/gate-src/claude/lib/audit.sh"
GATE="$R/.claude/hooks/flaky-kit-self-protection-gate.sh"
rm -f "$GATE"                                                     # registration stands, file gone
cp "$R/.claude/settings.json" "$R/.claude/settings.json.before"

M_TIER="$(integrity_tier "$(integrity_owner_uid "$K/core")" "$(integrity_state "$K")")"
[ "$M_TIER" = mismatch ] \
  && ok || bad "CONTROL: this fixture must read as mismatch, or every check below is vacuous (got $M_TIER)"
[ "$(integrity_wiring "$K" "$M_TIER")" = dangling ] \
  && ok || bad "CONTROL: this fixture must read as dangling BEFORE the repair, or the restore it would perform is not even reachable (got $(integrity_wiring "$K" "$M_TIER"))"
[ -s "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh" ] \
  && ok || bad "CONTROL: a usable restore source must be present, or 'nothing was restored' proves nothing"

RC1="$(integrity_guard "$K" >/dev/null 2>&1; echo $?)"
[ "$RC1" = 76 ] && ok || bad "mismatch: the guard must refuse (76) on the FIRST call (got $RC1)"
[ ! -e "$GATE" ] && ok \
  || bad "mismatch: the gate must NOT be restored from a tree this same run declares untrustworthy — and planting it there is what a later re-lock would chown to root and bless"
cmp -s "$R/.claude/settings.json" "$R/.claude/settings.json.before" && ok \
  || bad "mismatch: the settings file must be BYTE-IDENTICAL — every tier that refuses writes nothing at all"
[ "$(integrity_wiring "$K" mismatch)" = dangling ] && ok \
  || bad "mismatch: the wiring axis must still read dangling — flipping it to wired is the exact loss this assertion names (got $(integrity_wiring "$K" mismatch))"
MSG="$(wiring_repair "$K" mismatch dangling 2>&1 >/dev/null)"
case "$MSG" in *"not repairing"*) ok ;; *) bad "mismatch: refusing to repair must say why — got: $MSG" ;; esac
RC2="$(integrity_guard "$K" >/dev/null 2>&1; echo $?)"
[ "$RC2" = 76 ] && ok \
  || bad "mismatch: must ALSO refuse (76) on the SECOND consecutive call — nothing on disk changed, so nothing may have converged (got $RC2)"
rm -rf "$R"

# --- the repair fallback keys on a FUNCTION, not on anything PATH can answer -------------------
# `command -v` resolves executables too, so a `wiring_repair` on PATH satisfied it and the no-op
# fallback never fired — the integrity path then exec'd that binary. `declare -F` asks the property.
#
# ADAPTED FROM THE BRIEF: the snippet as written sources "$K/core/_integrity.sh" without ever
# putting a copy of that file under the fixture's own core/ — wire_fixture (above) only creates
# $k/core as an empty directory, it never populates it with this repo's *.sh files. Verified
# directly: run unmodified, the inner `bash -c` prints "No such file or directory" for the source
# and "integrity_guard: command not found" for the call, so OUT never contains PATH-BINARY-RAN and
# the case's `*) ok` arm fires — passing, but for a reason that has nothing to do with the fix this
# task makes. The DRIVER fixtures earlier in this file (search "cp \"$CORE/_integrity.sh\"") already
# establish the right shape for a fresh-process probe: copy this repo's own _integrity.sh into the
# fixture's core/ first, so the inner bash -c sources a real file whose ${BASH_SOURCE[0]} resolves
# inside the fixture. Added below; nothing else about the brief's snippet changed.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
cp "$CORE/_integrity.sh" "$K/core/"                     # _wiring_repair.sh deliberately NOT copied
rm -f "$K/core/_wiring_repair.sh"
mkdir -p "$R/fakebin"
printf '#!/bin/sh\necho PATH-BINARY-RAN >&2\nexit 0\n' > "$R/fakebin/wiring_repair"
chmod +x "$R/fakebin/wiring_repair"
OUT="$(PATH="$R/fakebin:$PATH" bash -c ". \"$K/core/_integrity.sh\"; integrity_guard \"$K\"" 2>&1 >/dev/null)"
case "$OUT" in
  *PATH-BINARY-RAN*) bad "a wiring_repair on PATH must not satisfy the repair-unit check" ;;
  *) ok ;;
esac
rm -rf "$R"

# --- Task 4: the delivery gate (Stop) joins the wiring axis -------------------------------------
# A control that can be silently unregistered is not a control -- the same rule that put the
# self-protection gate on this axis. The Stop slot is a SEPARATE block from the Claude PreToolUse
# one -- its own file (flaky-kit-delivery-gate.sh), its own event (Stop, not PreToolUse) -- merged
# into the overall verdict by the same worse-wins rule, so _wiring_one never has to arbitrate
# between two different gate files inside one call.
#
# The record's THIRD field decides whether the Stop slot is required at all, exactly as the first
# two fields decide Claude/Cursor. An install predating the delivery gate (a bare "claude" record,
# no `stop` token) must require exactly what it required before -- that is the whole no-brick
# guarantee this task exists to prove holds (the task report's decisive mutation forces the third
# field to 1 unconditionally and reddens the very next assertion).
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
printf 'claude\n' > "$W/core/.harness"          # a record predating the delivery gate
[ "$(integrity_wiring "$W" degraded)" = wired ] && ok || bad "an install without the stop capability must not require the Stop slot"
printf 'claude stop\n' > "$W/core/.harness"     # this install shipped it, and it is not registered
# CORRECTED FROM THE BRIEF: the brief's own Step-1 snippet expected `partial` here. `_wiring_one`'s
# own contract (unchanged by this task, verified directly before writing this assertion) returns
# `unregistered` whenever NO slot is registered -- that arm fires on `got -eq 0` alone, before want
# is ever consulted -- and `partial` is reachable only for 0 < got < want, which no want=1 axis can
# ever produce (there is no integer strictly between 0 and 1). Running the brief's own Step-3 code
# against this exact fixture (got=0, want=1) computes `unregistered`, not `partial`. `unregistered`
# is also the established meaning, one axis over, for "settings present, no registration for the
# kit's gate at all" (K3, above): a totally-missing Stop registration is that same fact about a
# different gate, not a new one `partial` was ever meant to describe.
[ "$(integrity_wiring "$W" degraded)" = unregistered ] \
  && ok || bad "a stop-capable install with no Stop registration must read unregistered, not partial -- partial is unreachable for a single-slot axis (got=0 always takes _wiring_one's unregistered arm before want is consulted)"
rm -rf "$R"

# --- registering it satisfies the axis ------------------------------------------------------------
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; P="$(dirname "$(dirname "$(dirname "$W")")")"
printf 'claude stop\n' > "$W/core/.harness"
mkdir -p "$P/.claude/hooks"; printf '#!/bin/sh\nexit 0\n' > "$P/.claude/hooks/flaky-kit-delivery-gate.sh"
chmod +x "$P/.claude/hooks/flaky-kit-delivery-gate.sh"
t="$(mktemp)"; jq '.hooks.Stop = [{hooks:[{type:"command",command:"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-delivery-gate.sh\""}]}]' \
  "$P/.claude/settings.json" > "$t" && mv "$t" "$P/.claude/settings.json"
[ "$(integrity_wiring "$W" degraded)" = wired ] && ok || bad "a registered, present delivery gate must read wired"
# and a registration whose file is gone is dangling, exactly as for the sibling gate
rm -f "$P/.claude/hooks/flaky-kit-delivery-gate.sh"
[ "$(integrity_wiring "$W" degraded)" = dangling ] && ok || bad "a Stop registration pointing at a missing file must read dangling"
rm -rf "$R"

# --- the repair writes the Stop slot below root ownership, and nothing at a refusing tier -------
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; P="$(dirname "$(dirname "$(dirname "$W")")")"
printf 'claude stop\n' > "$W/core/.harness"
wiring_repair "$W" degraded partial >/dev/null 2>&1
[ "$(jq -r '[.hooks.Stop[]?|(.hooks//[])[]?|.command|select(test("flaky-kit-delivery-gate"))]|length' "$P/.claude/settings.json")" = 1 ] \
  && ok || bad "below root ownership the repair must register the Stop slot"
rm -rf "$R"
for T in hardened stale mismatch; do
  R="$(mktemp -d)"; W="$(wire_fixture "$R")"; P="$(dirname "$(dirname "$(dirname "$W")")")"
  printf 'claude stop\n' > "$W/core/.harness"
  cp "$P/.claude/settings.json" "$R/before.json"
  wiring_repair "$W" "$T" partial >/dev/null 2>&1
  cmp -s "$R/before.json" "$P/.claude/settings.json" && ok || bad "$T: a refusing tier must not write the Stop slot either"
  rm -rf "$R"
done

# --- Fix round 1 -----------------------------------------------------------------------------

# Important 1: did_c must not be shared between the self-protection registration and the delivery
# gate registration. They are two independent controls on the same file; a failure in one and a
# success in the other must be reported by name, not folded into one shared flag — the exact defect
# Task 2's review split the original OR'd `did` into `did_c`/`did_u` to close, now reopened one
# control over. `.hooks.PreToolUse = "not-an-array"` breaks ONLY the self-protection merge (jq
# errors on `string and array cannot be added`); `_wr_register_stop` never touches `.hooks.PreToolUse`
# at all, so it succeeds independently in the SAME call. Reproduced against the pre-fix code before
# writing this: the shared-`did_c` version printed "REPAIRED — the Claude gate registration has been
# rewritten." over a settings file whose PreToolUse was still the broken string.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
printf 'claude stop\n' > "$W/core/.harness"
jq '.hooks.PreToolUse = "not-an-array"' "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
OUT="$(wiring_repair "$W" degraded unregistered 2>&1 >/dev/null)"
case "$OUT" in *"Claude gate registration merge failed"*) ok ;; *) bad "the self-protection merge failure must still be named — got: $OUT" ;; esac
case "$OUT" in
  *"REPAIRED — the Claude gate registration has been rewritten."*)
    bad "the self-protection gate must NOT be announced REPAIRED when its own merge failed, even though the Stop merge succeeded in the same call — got: $OUT" ;;
  *) ok ;;
esac
case "$OUT" in *"REPAIRED — the Claude delivery gate registration has been rewritten."*) ok ;; *) bad "a succeeding Stop merge alongside a failing self-protection merge must still be announced BY ITS OWN NAME — got: $OUT" ;; esac
[ "$(jq -r '.hooks.PreToolUse | type' "$R/.claude/settings.json")" = string ] \
  && ok || bad "the self-protection gate's PreToolUse merge must genuinely still be broken (control for this fixture)"
[ "$(jq -r '[.hooks.Stop[]?|(.hooks//[])[]?|.command|select(test("flaky-kit-delivery-gate"))]|length' "$R/.claude/settings.json")" = 1 ] \
  && ok || bad "the Stop registration must have landed despite the self-protection merge failing in the same call"
rm -rf "$R"

# Important 2: the third field on 'all'/'both' (install.sh's --harness DEFAULT — the record a real
# install actually writes most often) and the deliberately-hardcoded 'agents' zero. Both untested
# before this round: mutating the `all|both` arm to a hardcoded "1 1 0" and the `agents` arm to
# "0 0 $s" left the whole suite green, because no fixture ever wrote a two-token record on either
# arm. Driven directly through `_wiring_want`, the same way the K12/K13/K14 arm-pinning fixtures
# above already are.
R="$(mktemp -d)"; K="$(wire_fixture "$R/all-stop")"
printf 'all stop\n' > "$K/core/.harness"
[ "$(_wiring_want "$K" "$R/all-stop")" = "1 1 1" ] \
  && ok || bad "an 'all stop' record — install.sh's DEFAULT once it ships the delivery gate — must require claude+cursor+stop (got $(_wiring_want "$K" "$R/all-stop"))"
K2="$(wire_fixture "$R/agents-stop")"
printf 'agents stop\n' > "$K2/core/.harness"
[ "$(_wiring_want "$K2" "$R/agents-stop")" = "0 0 0" ] \
  && ok || bad "an 'agents stop' record must still force the third field to 0 — an AGENTS.md-only install has no Claude Stop hook to register regardless of what a stray token claims (got $(_wiring_want "$K2" "$R/agents-stop"))"
rm -rf "$R"

# Minor 1: the capability token must be matched EXACTLY, not as a substring. `case "$h" in *" stop"*)`
# read `claude stopwatch` as carrying the `stop` capability too — the same proxy-standing-in-for-a-
# property shape this kit has retracted repeatedly. Fixed by iterating $h's word-split tokens and
# comparing each one for exact equality.
R="$(mktemp -d)"; K="$(wire_fixture "$R/sw")"
printf 'claude stopwatch\n' > "$K/core/.harness"
[ "$(_wiring_want "$K" "$R/sw")" = "1 0 0" ] \
  && ok || bad "a trailing token that merely CONTAINS 'stop' ('stopwatch') must not satisfy the capability check — exact token match only (got $(_wiring_want "$K" "$R/sw"))"
rm -rf "$R"

# Minor 2: 'cursor stop' must not become an unrepairable wedge. The delivery gate is a CLAUDE
# control (Claude Code's Stop event; Cursor has no equivalent), so a 'cursor stop' record names a
# capability that harness can never satisfy — before this fix it required the Stop slot anyway (the
# Claude settings files are examined regardless of which harness the record selects) with no code
# path that could ever register it, refusing every entrypoint at the hardened tier forever. The
# 'cursor' arm now forces the third field to 0, the same way 'agents' already did.
R="$(mktemp -d)"; K="$(wire_fixture "$R/cs")"
printf 'cursor stop\n' > "$K/core/.harness"
[ "$(_wiring_want "$K" "$R/cs")" = "0 1 0" ] \
  && ok || bad "a 'cursor stop' record must force the third field to 0 — Cursor has no Stop event, so the capability can never be satisfied there (got $(_wiring_want "$K" "$R/cs"))"
rm -rf "$R"

# Important 3: _wiring_slots must never be taught the delivery gate's filename. Enforced only by
# construction today (a separate emitter, `_wiring_slots_stop`, with its own regex) — this pins the
# BEHAVIOUR that construction is meant to guarantee, so folding the filename into `_wiring_slots`'s
# `gate` predicate (a one-token edit a future maintainer could plausibly make as "deduplication")
# reddens this assertion instead of shipping silently. A PreToolUse registration of the DELIVERY gate
# must not satisfy the self-protection gate's Write/Edit/Bash slots — if it did, a project could
# register the wrong script under PreToolUse and still read `wired` for the self-protection axis.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
jq --arg c '"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-delivery-gate.sh"' \
   '.hooks.PreToolUse |= map(.hooks |= map(.command = $c))' \
   "$R/.claude/settings.json" > "$R/s" && mv "$R/s" "$R/.claude/settings.json"
[ "$(integrity_wiring "$W" degraded)" = unregistered ] \
  && ok || bad "a PreToolUse registration of the DELIVERY gate must not satisfy the self-protection gate's slots — _wiring_slots must not have learned its filename (got $(integrity_wiring "$W" degraded))"
rm -rf "$R"

# Minor 4: the Stop merge must not duplicate across repeated repairs. wiring_repair runs on every
# entrypoint, so a non-idempotent merge would grow settings.json without bound and fire the delivery
# gate N times per session. Mirrors the sibling PreToolUse duplicate-guard assertion above (search
# "must not duplicate a matcher"), which exists for the identical reason on the other gate.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; P="$(dirname "$(dirname "$(dirname "$W")")")"
printf 'claude stop\n' > "$W/core/.harness"
wiring_repair "$W" degraded partial >/dev/null 2>&1
wiring_repair "$W" degraded partial >/dev/null 2>&1
wiring_repair "$W" degraded partial >/dev/null 2>&1
[ "$(jq -r '[.hooks.Stop[]?|(.hooks//[])[]?|.command|select(test("flaky-kit-delivery-gate"))]|length' "$P/.claude/settings.json")" = 1 ] \
  && ok || bad "three repeated repairs must not duplicate the Stop registration"
rm -rf "$R"

echo "integrity-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
