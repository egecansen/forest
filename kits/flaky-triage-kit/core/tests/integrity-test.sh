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
rep_out() { integrity_report "$1" 2>&1; }
rep_rc()  { integrity_report "$1" >/dev/null 2>&1; echo $?; }

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
  [ -z "$(integrity_report "$t" 2>/dev/null)" ] || bad "integrity_report must never write to stdout (tier: $t)"
done; ok
# The production path must carry no environment override.
grep -q 'INTEGRITY_FAKE_UID' "$HERE/../_integrity.sh" && bad "no environment override may remain in _integrity.sh — it silences the guard for anyone who can set a variable" || ok

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
# the three sourced helpers (never run standalone) or one of the two functional exclusions named
# above. A new file lands in neither carve-out by default, so it is guilty (must carry the guard)
# until someone deliberately, reviewably adds it to NON_ENTRYPOINTS with a stated reason — which
# $ENTRYPOINTS along could never enforce, since nothing added a new file to it automatically either.
NON_ENTRYPOINTS="_integrity.sh _lock.sh _strict.sh lock-kit.sh hedge-scan.sh"
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

# worse-value-wins across harnesses: a working half must not hide a broken half
K7="$(wire_fixture "$W/g")"; rm -f "$W/g/.cursor/hooks/flaky-kit-self-protection-gate.sh"
[ "$(integrity_wiring "$K7" degraded)" = dangling ] && ok || bad "a dangling Cursor gate must not be masked by a wired Claude gate"

# not an installed layout -> absent, silent. Running the suite from the source tree must not warn.
[ "$(integrity_wiring "$W" degraded)" = absent ] && ok || bad "a non-installed layout must be absent"

# --- review round 2, Finding 2: loop variables must not leak into the sourcing shell ------------
# core/_integrity.sh is sourced by ten entrypoints, and `m`/`e` are already globals in core/rerun.sh
# (rerun.sh:58 `m="${t##*.}"`, rerun.sh:147 `for e in "${ENT[@]}"`). Nothing broke before this round
# only because the guard call happened to sit above those lines — ordering luck, not isolation, in a
# file whose header promises never to wedge a caller. The probe runs in a SUBSHELL so a leak there
# cannot contaminate this test file's own variables; only the subshell's pass/fail exit status
# crosses back out, and `ok`/`bad` (which touch this file's pass/fail counters) are called out here
# in the main shell, not inside the subshell where their effect would be lost when it exits.
( unset m e
  . "$HERE/../_integrity.sh"
  integrity_wiring "$K1" degraded >/dev/null
  [ -z "${m:-}" ] && [ -z "${e:-}" ]
) 2>/dev/null && ok || bad "integrity_wiring must not leak its loop variables (m/e) into the sourcing shell"

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

rm -rf "$PR" "$W"

echo "integrity-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
