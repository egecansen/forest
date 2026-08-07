#!/bin/bash
# core/tests/self-protection-test.sh — Round-2 RE-REVIEW regression tests:
#
#   Fix 1 (CRITICAL): subshell/command-substitution cd-tracking bypass
#     — `(cd core && sed -i '' config.json)`, `x=$(cd core && sed -i '' config.json)`,
#       `cd core && (sed -i '' config.json)`, and a nested subshell all had to DENY.
#   Fix 2 (IMPORTANT): the gate scripts (+ vendored libs) didn't protect each other
#     — a Claude session could freely Edit the Cursor gate (and vice versa).
#   Fix 3 (MINOR): HEKTOR_FK_CWD absent degrades cd-tracking silently — now noted on stderr.
#
# LAST Bash-gate round (see "Fix 4/5" below + shell-guard.py's module docstring): two more
# bypasses the Round-2 REWRITE ITSELF introduced —
#   Fix 4 (CRITICAL): `scan()`'s MAX_SUBSHELL_DEPTH guard FAILED OPEN (`return False` = ALLOW)
#     once nesting exceeded the bound — a deeply-nested subshell wrapping a real surface write
#     sailed straight past detection. Now fails CLOSED (`return True` = deny) instead.
#   Fix 5 (IMPORTANT): `{ ...; }` brace groups were untracked — `split_segments()` had no
#     handling for them, so `{ cd core && sed -i '' config.json; }`'s `cd` (mangled to `"{ cd
#     core"` by the naive splitter) never matched `CD_RE` and the write sailed through.
# After this round, no further fixes chase shell constructs here — see the honest-framing note
# in shell-guard.py: this string-analysis gate is best-effort friction, not a hard wall; the real
# wall, at the hardened tier, is `core/lock-kit.sh lock` chown'ing core/** (dir-level) to root —
# below hardened it degrades to the same chmod-only friction this gate already is.
#
# Plain bash asserts, no framework (mirrors apply-test.sh's style). Runs entirely against /tmp
# fixtures that mimic install.sh's real on-disk layout for BOTH harnesses, sharing one core/ copy:
#   <proj>/.claude/skills/hektor-flaky-triage/{core,hooks}
#   <proj>/.claude/hooks/lib             (claude's vendored audit.sh)
#   <proj>/.cursor/hooks{,/lib}          (cursor gate + vendored libs)
# Fresh copies of the CURRENT kit source are placed there on every run, so re-running this file
# after editing the source re-derives RED vs GREEN. The live kit dir is NEVER touched; every gate
# invocation `cd`s into the fixture root first so any incidental audit-log write (docs/hektor/) or
# `git rev-parse` lands inside /tmp, never in this repo.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"        # core/tests
CORE="$HERE/.."                                              # core/
KITSRC="$(cd "$CORE/.." && pwd)"                              # kits/flaky-triage-kit
WORK="$(mktemp -d)"
cleanup() {  # undo lock-kit's chmod a-w AND audit.sh's append-only chflags/chattr before rm -rf
  chmod -R u+w "$WORK" 2>/dev/null
  chflags -R nouappend "$WORK" 2>/dev/null
  command -v chattr >/dev/null 2>&1 && chattr -R -a "$WORK" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

# --- fixture: mimic install.sh's on-disk layout, sharing one core/ copy between both harnesses ---
PROJ="$WORK/proj"
SKILL="$PROJ/.claude/skills/hektor-flaky-triage"
mkdir -p "$SKILL/core" "$PROJ/.claude/hooks/lib" "$PROJ/.cursor/hooks/lib" "$PROJ/.cursor/rules"
git -C "$PROJ" init -q
git -C "$PROJ" config user.email test@example.com
git -C "$PROJ" config user.name self-protection-test

cp "$CORE/shell-guard.py" "$SKILL/core/shell-guard.py"
cp "$CORE/lock-kit.sh"    "$SKILL/core/lock-kit.sh"
cp "$CORE/_integrity.sh"  "$SKILL/core/_integrity.sh"   # lock-kit.sh sources this; must ship alongside it
cp "$KITSRC/adapters/claude/flaky-kit-self-protection-gate.sh" "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh"
# install.sh puts the delivery gate in this same directory, so the fixture does too — the surface
# assertions below are about a path, but a fixture that omits the file would be describing a layout
# no install produces, and the audit assertion at the end of this file drives the real thing.
cp "$KITSRC/adapters/claude/flaky-kit-delivery-gate.sh"        "$PROJ/.claude/hooks/flaky-kit-delivery-gate.sh"
cp "$KITSRC/adapters/_lib/audit.sh"                             "$PROJ/.claude/hooks/lib/audit.sh"
cp "$KITSRC/adapters/cursor/flaky-kit-self-protection-gate.sh"  "$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh"
cp "$KITSRC/adapters/cursor/lib/cursor-compat.sh"               "$PROJ/.cursor/hooks/lib/cursor-compat.sh"
cp "$KITSRC/adapters/_lib/audit.sh"                             "$PROJ/.cursor/hooks/lib/audit.sh"
chmod +x "$SKILL/core/shell-guard.py" "$SKILL/core/lock-kit.sh" \
         "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" "$PROJ/.claude/hooks/flaky-kit-delivery-gate.sh" \
         "$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh"
printf '{"kit":"config"}\n'      > "$SKILL/core/config.json"
printf '# unrelated cursor rule\n' > "$PROJ/.cursor/rules/hektor-flaky-triage.mdc"
printf '{}\n'                    > "$PROJ/.claude/settings.json"
printf '{}\n'                    > "$PROJ/.claude/settings.local.json"
printf '{"version":1,"hooks":{}}\n' > "$PROJ/.cursor/hooks.json"
printf 'x\n'                     > "$PROJ/README.md"
git -C "$PROJ" add -A >/dev/null; git -C "$PROJ" commit -qm init >/dev/null

CLAUDE_GATE="$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh"
CURSOR_GATE="$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh"

run_claude() { (cd "$PROJ" && printf '%s' "$1" | CLAUDE_PROJECT_DIR="$PROJ" "$CLAUDE_GATE"); }
run_cursor() { (cd "$PROJ" && printf '%s' "$1" | "$CURSOR_GATE"); }
claude_denied() { run_claude "$1" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; }
cursor_denied() { run_cursor "$1" | jq -e '.permission == "deny"' >/dev/null 2>&1; }

bash_json()        { jq -n --arg c "$1" --arg cmd "$2" '{tool_name:"Bash", cwd:$c, tool_input:{command:$cmd}}'; }
cursor_bash_json() { jq -n --arg c "$1" --arg cmd "$2" '{command:$cmd, cwd:$c}'; }
edit_json()        { jq -n --arg c "$1" --arg f "$2" '{tool_name:"Edit", cwd:$c, tool_input:{file_path:$f}}'; }
# Task 4 payload builders. `edit_json` above carries a file_path and NOTHING else, which is exactly
# what makes it useless for the outcome check: an assertion built on it cannot tell "denies any edit of
# this path" from "denies an edit that drops the registration" — the single distinction Task 4 turns
# on. These two carry a REAL proposed payload (content for Write, old/new for Edit) so the assertions
# below name the outcome. One builder serves both harnesses: cursor-compat's cc_content /
# cc_old_string / cc_new_string read the same `.tool_input.*` keys.
write_json()       { jq -n --arg c "$1" --arg f "$2" --arg t "$3" '{tool_name:"Write", cwd:$c, tool_input:{file_path:$f, content:$t}}'; }
# $5 = replace_all (default false). It is a first-class Edit parameter, so a reconstruction that
# ignores it models a different edit than the one that will be written.
edit_str_json()    { jq -n --arg c "$1" --arg f "$2" --arg o "$3" --arg n "$4" --argjson a "${5:-false}" '{tool_name:"Edit", cwd:$c, tool_input:{file_path:$f, old_string:$o, new_string:$n, replace_all:$a}}'; }

assert_claude_bash_deny()  { claude_denied "$(bash_json "$SKILL" "$1")"        && ok || bad "claude DENY Bash: $1"; }
assert_claude_bash_allow() { claude_denied "$(bash_json "$SKILL" "$1")"        && bad "claude should ALLOW Bash: $1" || ok; }
assert_cursor_bash_deny()  { cursor_denied "$(cursor_bash_json "$SKILL" "$1")" && ok || bad "cursor DENY Bash: $1"; }
assert_cursor_bash_allow() { cursor_denied "$(cursor_bash_json "$SKILL" "$1")" && bad "cursor should ALLOW Bash: $1" || ok; }
assert_claude_edit_deny()  { claude_denied "$(edit_json "$PROJ" "$1")"  && ok || bad "claude DENY Edit: $2 ($1)"; }
assert_claude_edit_allow() { claude_denied "$(edit_json "$PROJ" "$1")"  && bad "claude should ALLOW Edit: $2 ($1)" || ok; }
assert_cursor_edit_deny()  { cursor_denied "$(edit_json "$PROJ" "$1")"  && ok || bad "cursor DENY Edit: $2 ($1)"; }
assert_cursor_edit_allow() { cursor_denied "$(edit_json "$PROJ" "$1")"  && bad "cursor should ALLOW Edit: $2 ($1)" || ok; }

# Task 4: same primitives (claude_denied / cursor_denied), payload-carrying builders. Every one is
# asserted on BOTH gates, per the hazard the Task 3 comment below records: updating one gate's logic
# and testing only that gate once left the other harness silently unprotected.
assert_claude_write_deny()     { claude_denied "$(write_json "$PROJ" "$1" "$2")"        && ok || bad "claude DENY Write: $3 ($1)"; }
assert_claude_write_allow()    { claude_denied "$(write_json "$PROJ" "$1" "$2")"        && bad "claude should ALLOW Write: $3 ($1)" || ok; }
assert_cursor_write_deny()     { cursor_denied "$(write_json "$PROJ" "$1" "$2")"        && ok || bad "cursor DENY Write: $3 ($1)"; }
assert_cursor_write_allow()    { cursor_denied "$(write_json "$PROJ" "$1" "$2")"        && bad "cursor should ALLOW Write: $3 ($1)" || ok; }
assert_claude_edit_str_deny()  { claude_denied "$(edit_str_json "$PROJ" "$1" "$2" "$3")" && ok || bad "claude DENY Edit: $4 ($1)"; }
assert_claude_edit_str_allow() { claude_denied "$(edit_str_json "$PROJ" "$1" "$2" "$3")" && bad "claude should ALLOW Edit: $4 ($1)" || ok; }
assert_cursor_edit_str_deny()  { cursor_denied "$(edit_str_json "$PROJ" "$1" "$2" "$3")" && ok || bad "cursor DENY Edit: $4 ($1)"; }
assert_cursor_edit_str_allow() { cursor_denied "$(edit_str_json "$PROJ" "$1" "$2" "$3")" && bad "cursor should ALLOW Edit: $4 ($1)" || ok; }
# ...and the same with an explicit replace_all ($4 = true|false), so the two spellings of one edit can
# be asserted against each other.
assert_claude_edit_all_deny()  { claude_denied "$(edit_str_json "$PROJ" "$1" "$2" "$3" "$4")" && ok || bad "claude DENY Edit(replace_all=$4): $5 ($1)"; }
assert_claude_edit_all_allow() { claude_denied "$(edit_str_json "$PROJ" "$1" "$2" "$3" "$4")" && bad "claude should ALLOW Edit(replace_all=$4): $5 ($1)" || ok; }
assert_cursor_edit_all_deny()  { cursor_denied "$(edit_str_json "$PROJ" "$1" "$2" "$3" "$4")" && ok || bad "cursor DENY Edit(replace_all=$4): $5 ($1)"; }
assert_cursor_edit_all_allow() { cursor_denied "$(edit_str_json "$PROJ" "$1" "$2" "$3" "$4")" && bad "cursor should ALLOW Edit(replace_all=$4): $5 ($1)" || ok; }

echo "== Fix 1: subshell / command-substitution cd-tracking (must DENY, both gates) ==" >&2
for cmd in \
  "(cd core && sed -i '' config.json)" \
  "x=\$(cd core && sed -i '' config.json)" \
  "cd core && (sed -i '' config.json)" \
  "(cd core && (sed -i '' config.json))"
do
  assert_claude_bash_deny "$cmd"
  assert_cursor_bash_deny "$cmd"
done

echo "== Fix 1 controls (must ALLOW, both gates) ==" >&2
for cmd in \
  "(cd /tmp && sed -i '' x)" \
  "(ls core)" \
  "(echo hi && ls /tmp)"
do
  assert_claude_bash_allow "$cmd"
  assert_cursor_bash_allow "$cmd"
done

echo "== Fix 1 regressions (Round2 behavior must hold) ==" >&2
assert_claude_bash_deny  "cd core && sed -i '' config.json"          # top-level cd+write, fixed in Round2
assert_cursor_bash_deny  "cd core && sed -i '' config.json"
assert_claude_bash_allow "cat core/config.json && echo hi > /tmp/x"  # surface ref + mutate in DIFFERENT segments
assert_cursor_bash_allow "cat core/config.json && echo hi > /tmp/x"

echo "== Fix 1: unlock still honoured + audited ==" >&2
UNLOCK_OUT=$(cd "$PROJ" && printf '%s' "$(bash_json "$SKILL" "(cd core && sed -i '' config.json)")" \
  | CLAUDE_PROJECT_DIR="$PROJ" HEKTOR_FLAKYKIT_UNLOCK=1 "$CLAUDE_GATE")
[ -z "$UNLOCK_OUT" ] && ok || bad "HEKTOR_FLAKYKIT_UNLOCK=1 still ALLOWs the subshell-bypass case (claude), got: $UNLOCK_OUT"
[ -f "$PROJ/docs/hektor/.hook-audit.log" ] && grep -q "unlocked for write" "$PROJ/docs/hektor/.hook-audit.log" \
  && ok || bad "unlock use audited to docs/hektor/.hook-audit.log"

echo "== Fix 2: gate scripts + vendored libs now protect each other (Edit) ==" >&2
assert_claude_edit_deny  "$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh" "cursor gate script"
assert_claude_edit_deny  "$PROJ/.cursor/hooks/lib/cursor-compat.sh"              "cursor lib"
assert_claude_edit_deny  "$PROJ/.claude/hooks/lib/audit.sh"                      "claude audit lib"
assert_claude_edit_allow "$PROJ/.cursor/rules/hektor-flaky-triage.mdc"           "unrelated cursor rule file"
assert_claude_edit_allow "$PROJ/.claude/settings.json"                          "unrelated claude settings"

echo "== Fix 2 (Task 5): relocated Claude gate lives at .claude/hooks/, out of the shadowable kit tree ==" >&2
assert_claude_edit_deny  "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" "the relocated Claude gate protects itself at its new path"
assert_claude_edit_deny  "$SKILL/core/apply.sh"                                  "kit core is still surface after the move"
assert_claude_edit_allow "$PROJ/.claude/hooks/observe.sh"                        "an unrelated pack hook is NOT surface"

assert_cursor_edit_deny  "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" "claude gate script (regression)"
assert_cursor_edit_deny  "$PROJ/.claude/hooks/lib/audit.sh"                      "claude audit lib (parity)"
assert_cursor_edit_deny  "$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh" "cursor gate self-protect"
assert_cursor_edit_deny  "$PROJ/.cursor/hooks/lib/cursor-compat.sh"              "cursor lib self-protect"
assert_cursor_edit_allow "$PROJ/.claude/settings.json"                          "unrelated claude settings"
assert_cursor_edit_allow "$PROJ/.cursor/rules/hektor-flaky-triage.mdc"           "unrelated cursor rule"

echo "== Fix 2 (Task 5 correction): Bash-vector mutation of the relocated gate's OWN file must DENY —" >&2
echo "   this exercises core/shell-guard.py's SURF regex (the real Bash-branch decision-maker; the" >&2
echo "   bash SURF_RE/MUT_RE above is only its degraded fallback), mirroring the existing core/ cases." >&2
GATE_MUT_CMD="sed -i '' .claude/hooks/flaky-kit-self-protection-gate.sh"
claude_denied "$(bash_json "$PROJ" "$GATE_MUT_CMD")" \
  && ok || bad "claude DENY Bash mutation of the relocated gate itself (shell-guard.py SURF): $GATE_MUT_CMD"
cursor_denied "$(cursor_bash_json "$PROJ" "$GATE_MUT_CMD")" \
  && ok || bad "cursor DENY Bash mutation of the relocated gate itself (shell-guard.py SURF): $GATE_MUT_CMD"

echo "== Directory OPERANDS: every surface pattern used to end in '/', so the directory itself never" >&2
echo "   matched — 'mv <kit> /tmp/x', 'rm -rf <kit>', 'mv <kit>/core /tmp/x' and 'rm -rf .claude/hooks'" >&2
echo "   were ALLOW and unaudited at every tier below hardened, i.e. every existing install. ==" >&2
# cwd is the PROJECT root here, not $SKILL: with cwd inside the kit tree a bare relative token would
# resolve under the kit and make these assertions pass for the wrong reason.
proj_bash_deny() {
  claude_denied "$(bash_json "$PROJ" "$1")"        && ok || bad "claude DENY Bash (cwd=proj): $1"
  cursor_denied "$(cursor_bash_json "$PROJ" "$1")" && ok || bad "cursor DENY Bash (cwd=proj): $1"
}
proj_bash_allow() {
  claude_denied "$(bash_json "$PROJ" "$1")"        && bad "claude should ALLOW Bash (cwd=proj): $1" || ok
  cursor_denied "$(cursor_bash_json "$PROJ" "$1")" && bad "cursor should ALLOW Bash (cwd=proj): $1" || ok
}
proj_bash_deny "mv $SKILL /tmp/shadow-aside"          # the whole kit tree as a single operand
proj_bash_deny "rm -rf $SKILL"
proj_bash_deny "mv $SKILL/core /tmp/core-aside"       # core/ as a DIRECTORY, not core/<file>
proj_bash_deny "rm -rf $PROJ/.claude/hooks"           # takes the gate, its lib AND the record with it
proj_bash_deny "rm -rf $PROJ/.cursor/hooks"
# The lock-tier record: the gate script and the lib beside it were surface while the record the gate's
# own shadow check depends on was not — editing the gate was DENY+audited, erasing its expectation was
# ALLOW+silent.
proj_bash_deny "printf 'degraded\\n' > $PROJ/.claude/hooks/.flaky-kit-expect"
proj_bash_deny "rm -f $PROJ/.claude/hooks/.flaky-kit-expect"
assert_claude_edit_deny "$PROJ/.claude/hooks/.flaky-kit-expect" "the out-of-tree lock-tier record"
assert_cursor_edit_deny "$PROJ/.claude/hooks/.flaky-kit-expect" "the out-of-tree lock-tier record (parity)"

echo "== THE DELIVERY GATE (Stop hook) is surface too. It shipped onto core/lock-kit.sh's" >&2
echo "   harden_targets and onto NOTHING else — and chown-list membership is not protection: below" >&2
echo "   the hardened tier it buys nothing, and the wiring axis that would notice the file gone only" >&2
echo "   runs when a kit ENTRYPOINT next runs, which a session whose whole goal is to stop never" >&2
echo "   does. Measured on a real install fixture before this block existed, 'rm -f" >&2
echo "   .claude/hooks/flaky-kit-delivery-gate.sh' was an ALLOW with no audit line while the same" >&2
echo "   command against the sibling gate DENIED. It also leaves wiring=dangling, which is rc 76 from" >&2
echo "   all thirteen entrypoints at the hardened tier with a password-priced remedy. ==" >&2
DG="$PROJ/.claude/hooks/flaky-kit-delivery-gate.sh"
assert_claude_edit_deny "$DG" "the delivery gate protects itself"
assert_cursor_edit_deny "$DG" "the delivery gate is surface in the other harness too"
proj_bash_deny "rm -f $DG"
proj_bash_deny "sed -i '' $DG"
proj_bash_deny "mv $DG /tmp/delivery-aside"
# The DIRECTORY operand already covered it, but only as a side effect of taking everything else with
# it — assert the file on its own, or a later narrowing of the directory arm silently reopens this.
# And the same precision the sibling arms keep: a file of the same NAME somewhere else is not surface.
proj_bash_allow "rm -f $PROJ/flaky-kit-delivery-gate.sh"
# shell-guard.py's SURF directly, not through a gate: both gates dispatch to it whenever python3 is
# present, so an assertion through a gate exercises whichever engine it chose, never this pattern in
# isolation. Same reasoning as the settings-file block further down.
printf '%s' "rm -f $DG" | HEKTOR_FK_CWD="$PROJ" python3 "$SKILL/core/shell-guard.py" >/dev/null 2>&1 \
  && ok || bad "shell-guard.py SURF must directly DENY a Bash mutation of the delivery gate: rm -f $DG"
printf '%s' "cat $DG" | HEKTOR_FK_CWD="$PROJ" python3 "$SKILL/core/shell-guard.py" >/dev/null 2>&1 \
  && bad "shell-guard.py SURF must directly ALLOW a read of the delivery gate: cat $DG" || ok
# ...and the bash-ERE fallback, which decides when python3 is unavailable. Extracted from the gate
# rather than re-spelled here, so this cannot pass against a pattern the gate does not carry.
SURF_RE_DG="$(sed -n "s/^SURF_RE='\(.*\)'\$/\1/p" "$CLAUDE_GATE")"
printf '%s' "rm -f $DG" | grep -qE "$SURF_RE_DG" \
  && ok || bad "the gates' bash SURF_RE fallback must also class the delivery gate as surface"
# Cursor has no stop event, so the delivery gate never lands under .cursor/hooks/ — a pattern for a
# file that cannot exist is a claim nothing can check, and this is the control that says so out loud.
proj_bash_allow "rm -f $PROJ/.cursor/hooks/flaky-kit-delivery-gate.sh"

echo "== Interpreter inline programs: the branch still bites on an absolute path, and a benign one-liner" >&2
echo "   run from INSIDE the kit tree is not flagged for its identifiers ==" >&2
# Widening the surface to the kit DIRECTORY made every bare identifier inside `-c`/`-e` code resolve to a
# path under the kit, so `python3 -c 'import sys; print(sys.argv)'` denied because of the word `import`.
# The inline program's text is excluded from path canonicalization; the literal match still applies.
assert_claude_bash_deny  "python3 -c 'open(\"$SKILL/core/config.json\",\"w\").write(\"x\")'"
assert_cursor_bash_deny  "python3 -c 'open(\"$SKILL/core/config.json\",\"w\").write(\"x\")'"
assert_claude_bash_allow "python3 -c 'import sys; print(sys.argv)'"
assert_cursor_bash_allow "python3 -c 'import sys; print(sys.argv)'"
assert_claude_bash_allow "python3 -c 'print(1.5)'"

echo "== Directory-operand SCOPE: deliberately bounded, so this is a control, not an omission ==" >&2
# An ordinary file INSIDE .claude/hooks/ stays editable: those are this pack's other hooks, they are
# legitimately edited, and the gates' own comments commit to that precision. Only the gate, its lib/,
# the record, and the DIRECTORY as an operand are surface.
proj_bash_allow "rm -f $PROJ/.claude/hooks/observe.sh"
proj_bash_allow "cat $SKILL/core/config.json"          # reads still pass: a mutation verb is required

echo "== Task 3: the settings files are surface for Bash MUTATIONS, reads still pass — deleting or" >&2
echo "   rewriting the registration is what turns every other protection off, and until now it cost" >&2
echo "   nothing: 'sed -i .../settings.json' was a verified ALLOW. cwd=PROJ (via proj_bash_deny/allow," >&2
echo "   not the assert_claude/cursor_bash_* helpers above): those hard-code cwd=\$SKILL, and a bare" >&2
echo "   relative operand joined onto a cwd INSIDE the kit tree already matches the pre-existing" >&2
echo "   kit-tree pattern regardless of these new ones, which would make this assertion pass for the" >&2
echo "   wrong reason — the same trap the 'Directory OPERANDS' comment above already calls out. Both" >&2
echo "   gates asserted per invocation, closing the hazard that updating the gates' patterns alone" >&2
echo "   once left the path the kit actually installs to unprotected on both harnesses. ==" >&2
for s in ".claude/settings.json" ".claude/settings.local.json" ".cursor/hooks.json"; do
  proj_bash_deny  "sed -i '' $s"
  proj_bash_deny  "rm -f $s"
  proj_bash_allow "cat $s"
  proj_bash_allow "jq . $s"
done
# The registration is what makes every other protection run; unregistering it must cost as much as
# editing the gate itself.
proj_bash_deny "printf '{}' > .claude/settings.json"

echo "== Task 3: shell-guard.py's SURF verified DIRECTLY, not only through the gate pipeline above —" >&2
echo "   both gates prefer shell-guard.py whenever python3 is present, so a deny/allow assertion" >&2
echo "   through a gate exercises whichever engine it actually dispatched to, never shell-guard.py's" >&2
echo "   SURF in isolation from that choice; a prior round shipped exactly that gap (gates' patterns" >&2
echo "   updated, primary engine blind, nothing ran the two independently). stdin piped directly here," >&2
echo "   no jq/gate wrapper in between, is what isolates shell-guard.py's own pattern — the gate's" >&2
echo "   separate bash-only SURF_RE fallback is checked on its own in the SURF DRIFT test below. ==" >&2
for s in ".claude/settings.json" ".claude/settings.local.json" ".cursor/hooks.json"; do
  printf '%s' "sed -i '' $s" | HEKTOR_FK_CWD="$PROJ" python3 "$SKILL/core/shell-guard.py" >/dev/null 2>&1 \
    && ok || bad "shell-guard.py SURF must directly DENY a Bash mutation of $s: sed -i '' $s"
  printf '%s' "cat $s" | HEKTOR_FK_CWD="$PROJ" python3 "$SKILL/core/shell-guard.py" >/dev/null 2>&1 \
    && bad "shell-guard.py SURF must directly ALLOW a read of $s: cat $s" || ok
done

echo "== Task 4: Write/Edit on a settings file is decided by OUTCOME, not by path. This branch HAS the" >&2
echo "   payload, so it answers the real question — with this change applied, is the kit's gate still" >&2
echo "   registered? Blanket-denying by path would make the kit block unrelated permission / env / model" >&2
echo "   edits in every project it installs into. The two 'unrelated claude settings' ALLOW assertions" >&2
echo "   in the Fix 2 sections above are the standing guard against that over-denial; they stay ALLOW" >&2
echo "   because that fixture settings.json carries no registration at all. ==" >&2
# --- Write/Edit on settings: deny only when the registration would not survive -------
SJ="$PROJ/.claude/settings.json"
REG='{"hooks":{"PreToolUse":[{"matcher":"Write|Edit","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]},{"matcher":"Bash","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]}]}}'
printf '%s\n' "$REG" > "$SJ"

# A Write that drops the registration -> DENY
assert_claude_write_deny "$SJ" '{"hooks":{"PreToolUse":[]}}' \
  "a Write that leaves the kit unregistered must be denied"
assert_cursor_write_deny "$SJ" '{"hooks":{"PreToolUse":[]}}' \
  "a Write that leaves the kit unregistered must be denied"
# A Write that keeps the registration and changes something unrelated -> ALLOW
KEEP="$(printf '%s' "$REG" | jq '.permissions = {"allow":["Bash(ls:*)"]}')"
assert_claude_write_allow "$SJ" "$KEEP" \
  "a Write that keeps the registration must be allowed even though it touches settings.json"
assert_cursor_write_allow "$SJ" "$KEEP" \
  "a Write that keeps the registration must be allowed even though it touches settings.json"
# Unparseable proposed JSON -> DENY (survival cannot be verified, and writing broken settings is
# itself a defect — the pack's run-status-write-gate sets this precedent)
assert_claude_write_deny "$SJ" '{"hooks":' \
  "a Write of unparseable JSON must be denied"
assert_cursor_write_deny "$SJ" '{"hooks":' \
  "a Write of unparseable JSON must be denied"
# An Edit whose old_string carries the registration away -> DENY. Note WHICH registration: only the
# Bash arm. `_reg_slots` (not "does the gate's filename still appear somewhere") is what makes this a
# DENY — the Write|Edit arm survives this edit untouched, so a "one mention is enough" test would call
# it a survival and ALLOW the Bash branch Task 3 just closed being unwired. core/_integrity.sh's
# wiring axis rules the same way, on the same slot model: it asks whether a registered slot covers
# Write, Edit AND Bash, and reports `partial` when the Bash coverage is gone. (The earlier wording
# here appealed to "both matchers are required" — but _integrity.sh ruled on the matcher STRING, not
# on the tool set, so the two halves cited each other while disagreeing; the slot-parity assertion
# below is what now makes the agreement checkable instead of asserted.)
assert_claude_edit_str_deny "$SJ" \
  '"matcher":"Bash","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]' '' \
  "an Edit that removes the Bash registration must be denied"
assert_cursor_edit_str_deny "$SJ" \
  '"matcher":"Bash","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]' '' \
  "an Edit that removes the Bash registration must be denied"
# An Edit that touches an unrelated key -> ALLOW
assert_claude_edit_str_allow "$SJ" '"hooks"' '"hooks"' \
  "a no-op Edit that preserves the registration must be allowed"
assert_cursor_edit_str_allow "$SJ" '"hooks"' '"hooks"' \
  "a no-op Edit that preserves the registration must be allowed"

echo "== The DELIVERY gate's Stop registration is a slot of its own. This branch decides by OUTCOME," >&2
echo "   and its outcome test used to read .hooks.PreToolUse and nothing else — so a Write applying" >&2
echo "   del(.hooks.Stop) with the PreToolUse arm left intact was a verified ALLOW on a real install" >&2
echo "   fixture: every key the check read was untouched, and it was blind to the one key the write" >&2
echo "   removed. Unregistering the Stop hook is the cheapest way to stop a session the Stop hook has" >&2
echo "   just refused to let stop. ==" >&2
DGC='"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-delivery-gate.sh"'
REGS="$(printf '%s' "$REG" | jq -c --arg d "$DGC" '.hooks.Stop = [{hooks:[{type:"command", command:$d, timeout:20}]}]')"
printf '%s\n' "$REGS" > "$SJ"
# The reviewer's row, as an assertion: PreToolUse intact, Stop dropped -> DENY.
assert_claude_write_deny "$SJ" "$(printf '%s' "$REGS" | jq -c 'del(.hooks.Stop)')" \
  "a Write that drops the Stop registration while leaving PreToolUse intact must be denied"
assert_cursor_write_deny "$SJ" "$(printf '%s' "$REGS" | jq -c 'del(.hooks.Stop)')" \
  "a Write that drops the Stop registration while leaving PreToolUse intact must be denied"
# The same loss spelled as an Edit, since that is the tool an agent reaches for first.
assert_claude_edit_str_deny "$SJ" \
  "\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"\\\"\$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-delivery-gate.sh\\\"\",\"timeout\":20}]}]" '"Stop":[]' \
  "an Edit that empties the Stop registration must be denied"
assert_cursor_edit_str_deny "$SJ" \
  "\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"\\\"\$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-delivery-gate.sh\\\"\",\"timeout\":20}]}]" '"Stop":[]' \
  "an Edit that empties the Stop registration must be denied"
# ...and the over-denial control this whole branch exists to keep: a Write that keeps BOTH
# registrations and changes something unrelated is still allowed.
assert_claude_write_allow "$SJ" "$(printf '%s' "$REGS" | jq -c '.permissions = {"allow":["Bash(ls:*)"]}')" \
  "a Write that keeps the Stop registration must be allowed even though it touches settings.json"
assert_cursor_write_allow "$SJ" "$(printf '%s' "$REGS" | jq -c '.permissions = {"allow":["Bash(ls:*)"]}')" \
  "a Write that keeps the Stop registration must be allowed even though it touches settings.json"
# The Stop slot must be keyed on the DELIVERY gate's filename and nothing else: retargeting the Stop
# command at the SELF-PROTECTION gate leaves a Stop entry naming a flaky-kit file, and a check that
# asked "does some flaky-kit command still appear under Stop" would read that as a survival while the
# I11 hook no longer runs. One predicate for both gates is how a different gate comes to satisfy a
# slot it does not guard.
assert_claude_write_deny "$SJ" "$(printf '%s' "$REGS" | jq -c '.hooks.Stop[0].hooks[0].command = "\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""')" \
  "retargeting the Stop registration at the self-protection gate must be denied"
assert_cursor_write_deny "$SJ" "$(printf '%s' "$REGS" | jq -c '.hooks.Stop[0].hooks[0].command = "\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""')" \
  "retargeting the Stop registration at the self-protection gate must be denied"
# ...and the mirror image, which is what keeps the two predicates genuinely separate: a document
# whose ONLY delivery-gate mention sits under PreToolUse must not have that mention counted as
# covering Write, Edit or Bash. Registering the delivery gate at PreToolUse and dropping the
# self-protection gate's Bash matcher is still a loss.
DGP="$(jq -nc --arg g '"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh"' --arg d "$DGC" '{hooks:{PreToolUse:[
  {matcher:"Write|Edit", hooks:[{type:"command", command:$g}]},
  {matcher:"Bash",       hooks:[{type:"command", command:$g}]},
  {matcher:"Bash",       hooks:[{type:"command", command:$d}]}]}}')"
printf '%s\n' "$DGP" > "$SJ"
assert_claude_write_deny "$SJ" "$(printf '%s' "$DGP" | jq -c '.hooks.PreToolUse |= [.[0], .[2]]')" \
  "a delivery-gate command under PreToolUse must not count as covering Bash for the self-protection gate"
assert_cursor_write_deny "$SJ" "$(printf '%s' "$DGP" | jq -c '.hooks.PreToolUse |= [.[0], .[2]]')" \
  "a delivery-gate command under PreToolUse must not count as covering Bash for the self-protection gate"
printf '%s\n' "$REG" > "$SJ"
# NO-BRICK CONTROL, the same rule `_wiring_want` encodes for the wiring axis: an install that
# predates the delivery gate carries no Stop registration at all, and a document with none before and
# none after has lost nothing. `_slots_kept` denies on a LOSS only, never on "must always end
# registered" — without this control the new arm could have been written as "a Stop slot is required"
# and every pre-delivery-gate project would be frozen out of its own settings file.
assert_claude_write_allow "$SJ" "$(printf '%s' "$REG" | jq -c '.permissions = {"allow":["Bash(ls:*)"]}')" \
  "a settings file that never had a Stop registration must not start needing one"
assert_cursor_write_allow "$SJ" "$(printf '%s' "$REG" | jq -c '.permissions = {"allow":["Bash(ls:*)"]}')" \
  "a settings file that never had a Stop registration must not start needing one"

echo "== Task 4: slot identity is the TOOLS a matcher covers, not the matcher's spelling ==" >&2
# Keying on the string would deny a user who HARDENS their registration by widening the matcher — a
# false deny on a change that leaves the registration strictly better than it found it, i.e. the same
# over-denial this branch forbids, arriving through string identity instead of a path match.
assert_claude_write_allow "$SJ" "$(printf '%s' "$REG" | jq -c '.hooks.PreToolUse[0].matcher = "Write|Edit|MultiEdit"')" \
  "widening Write|Edit to Write|Edit|MultiEdit must be allowed"
assert_cursor_write_allow "$SJ" "$(printf '%s' "$REG" | jq -c '.hooks.PreToolUse[0].matcher = "Write|Edit|MultiEdit"')" \
  "widening Write|Edit to Write|Edit|MultiEdit must be allowed"
# `*` covers everything, so collapsing both matchers into one wildcard slot loses no coverage.
assert_claude_write_allow "$SJ" "$(printf '%s' "$REG" | jq -c '.hooks.PreToolUse[0].matcher = "*" | del(.hooks.PreToolUse[1])')" \
  "a single \"*\" matcher covers every tool the two matchers covered, so it must be allowed"
assert_cursor_write_allow "$SJ" "$(printf '%s' "$REG" | jq -c '.hooks.PreToolUse[0].matcher = "*" | del(.hooks.PreToolUse[1])')" \
  "a single \"*\" matcher covers every tool the two matchers covered, so it must be allowed"
# NARROWING is a real loss and must still be caught — this is what stops "tools, not strings" from
# collapsing into "any matcher will do".
assert_claude_write_deny "$SJ" "$(printf '%s' "$REG" | jq -c '.hooks.PreToolUse[0].matcher = "Write"')" \
  "narrowing Write|Edit to Write drops Edit coverage and must be denied"
assert_cursor_write_deny "$SJ" "$(printf '%s' "$REG" | jq -c '.hooks.PreToolUse[0].matcher = "Write"')" \
  "narrowing Write|Edit to Write drops Edit coverage and must be denied"

echo "== Task 4: replace_all is a first-class Edit parameter — reconstructing with ONE replacement" >&2
echo "   while the tool replaces EVERY occurrence judges a document that is not the one being written ==" >&2
# The decoy is the case that separates a real fix from a cosmetic one: a mention of the gate filename
# that is NOT a registration, planted AHEAD of the two real ones by a prior Write this gate allows.
# With replace_all the write unregisters both; a single-replacement reconstruction only rewrites the
# decoy, still sees two registrations, and reads the change as a survival.
DECOY="$(jq -nc --arg c '"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh"' '{
  env:{HEKTOR_NOTE:"flaky-kit-self-protection-gate.sh"},
  hooks:{PreToolUse:[
    {matcher:"Write|Edit", hooks:[{type:"command", command:$c}]},
    {matcher:"Bash",       hooks:[{type:"command", command:$c}]}]}}')"
printf '%s\n' "$DECOY" > "$SJ"
assert_claude_edit_all_deny "$SJ" 'flaky-kit-self-protection-gate.sh' 'x.sh' true \
  "an Edit whose replace_all rewrites every mention of the gate must be denied"
assert_cursor_edit_all_deny "$SJ" 'flaky-kit-self-protection-gate.sh' 'x.sh' true \
  "an Edit whose replace_all rewrites every mention of the gate must be denied"
# The SAME old/new with replace_all FALSE rewrites only the decoy and must be ALLOWED. This pair is
# the whole evidence that the branch reads the parameter rather than ignoring it: a gate that always
# replaced once, or always replaced all, gets one of these two wrong.
assert_claude_edit_all_allow "$SJ" 'flaky-kit-self-protection-gate.sh' 'x.sh' false \
  "the same edit without replace_all rewrites only the decoy, so both registrations survive"
assert_cursor_edit_all_allow "$SJ" 'flaky-kit-self-protection-gate.sh' 'x.sh' false \
  "the same edit without replace_all rewrites only the decoy, so both registrations survive"
printf '%s\n' "$REG" > "$SJ"
# A legitimate replace_all that touches every registration without unregistering anything -> ALLOW,
# so replace_all is not simply treated as hostile.
assert_claude_edit_all_allow "$SJ" '"type":"command"' '"type":"command"' true \
  "a replace_all edit that preserves every registration must be allowed"
assert_cursor_edit_all_allow "$SJ" '"type":"command"' '"type":"command"' true \
  "a replace_all edit that preserves every registration must be allowed"

# When the file is NOT currently registered, the gate has nothing to protect -> ALLOW
printf '{"hooks":{"PreToolUse":[]}}\n' > "$SJ"
assert_claude_write_allow "$SJ" '{"hooks":{"PreToolUse":[]}}' \
  "with no registration present there is nothing to lose, so the write must be allowed"
assert_cursor_write_allow "$SJ" '{"hooks":{"PreToolUse":[]}}' \
  "with no registration present there is nothing to lose, so the write must be allowed"
# ...and that "nothing to lose" exit is what keeps the unparseable-JSON deny from freezing a project
# that never installed this kit out of its own settings file. Without this control the early
# not-currently-registered guard has no assertion on it at all: every OTHER unregistered-file case is
# allowed by the survival comparison anyway (losing none of zero slots), so only the malformed-content
# path distinguishes "nothing to lose" from "must always end registered".
assert_claude_write_allow "$SJ" '{"hooks":' \
  "unparseable JSON in a file this kit is not registered in is not this kit's business"
assert_cursor_write_allow "$SJ" '{"hooks":' \
  "unparseable JSON in a file this kit is not registered in is not this kit's business"
printf '%s\n' "$REG" > "$SJ"

echo "== Task 4: the same rule on CURSOR's registration file, whose shape is different — two EVENTS," >&2
echo "   not two PreToolUse matchers. Everything above reads a Claude-shaped document, so the two" >&2
echo "   cursor arms of the gates' _reg_slots() were reachable by no assertion at all: deleting either" >&2
echo "   one left the whole suite green. One assertion per arm, plus the over-denial control. ==" >&2
CH="$PROJ/.cursor/hooks.json"
CGATE_CMD=".cursor/hooks/flaky-kit-self-protection-gate.sh"
CREG="$(jq -nc --arg c "$CGATE_CMD" '{version:1, hooks:{
  beforeShellExecution:[{command:$c, timeout:10}],
  preToolUse:[{command:$c, matcher:"Write|Edit", timeout:10}]}}')"
printf '%s\n' "$CREG" > "$CH"
# Unrelated change (the file's own version key) -> ALLOW
assert_claude_write_allow "$CH" "$(printf '%s' "$CREG" | jq -c '.version = 2')" \
  "a Write that keeps both Cursor events registered must be allowed"
assert_cursor_write_allow "$CH" "$(printf '%s' "$CREG" | jq -c '.version = 2')" \
  "a Write that keeps both Cursor events registered must be allowed"
# Each event dropped on its own -> DENY. Losing one of the two is a loss: the Bash vector and the
# file-edit vector are registered separately here, exactly as Claude's two matchers are.
assert_claude_write_deny "$CH" "$(printf '%s' "$CREG" | jq -c 'del(.hooks.beforeShellExecution)')" \
  "a Write that drops the Cursor beforeShellExecution registration must be denied"
assert_cursor_write_deny "$CH" "$(printf '%s' "$CREG" | jq -c 'del(.hooks.beforeShellExecution)')" \
  "a Write that drops the Cursor beforeShellExecution registration must be denied"
assert_claude_write_deny "$CH" "$(printf '%s' "$CREG" | jq -c 'del(.hooks.preToolUse)')" \
  "a Write that drops the Cursor preToolUse registration must be denied"
assert_cursor_write_deny "$CH" "$(printf '%s' "$CREG" | jq -c 'del(.hooks.preToolUse)')" \
  "a Write that drops the Cursor preToolUse registration must be denied"
# Cursor's preToolUse entries carry a `matcher` exactly as Claude's do, so neutering one has to cost
# the same. Keying Cursor slots by event ALONE would read this as a survival while the identical
# mutation on the Claude side is caught — an asymmetry with nothing behind it but the shape of the
# first draft's jq.
assert_claude_write_deny "$CH" "$(printf '%s' "$CREG" | jq -c '.hooks.preToolUse[0].matcher = "Task"')" \
  "retargeting the Cursor preToolUse matcher to an inert tool must be denied"
assert_cursor_write_deny "$CH" "$(printf '%s' "$CREG" | jq -c '.hooks.preToolUse[0].matcher = "Task"')" \
  "retargeting the Cursor preToolUse matcher to an inert tool must be denied"
# The Stop slot the Claude block above added to `_reg_slots` must be inert here, and that is what
# lets the function stay BYTE-IDENTICAL across the two harnesses while naming a Claude-only control:
# `.cursor/hooks.json` has no `Stop` key, so the arm emits nothing BEFORE the edit and nothing AFTER,
# and `_slots_kept` denies on a LOSS only. Absent/absent must read as no change, never as a dropped
# registration — if it did, the shared shape would have to fork and the parity assertion below would
# be the thing that has to give.
assert_claude_write_allow "$CH" "$(printf '%s' "$CREG" | jq -c '.hooks.afterShellExecution = []')" \
  "a Cursor hooks.json has no Stop key at all — absent before and absent after is not a loss"
assert_cursor_write_allow "$CH" "$(printf '%s' "$CREG" | jq -c '.hooks.afterShellExecution = []')" \
  "a Cursor hooks.json has no Stop key at all — absent before and absent after is not a loss"
printf '{"version":1,"hooks":{}}\n' > "$CH"   # restore the fixture's original shape

echo "== Fix 2: SURF_RE stays byte-identical between the two gate scripts (parity) ==" >&2
CLAUDE_SURF="$(grep -m1 '^SURF_RE=' "$CLAUDE_GATE")"
CURSOR_SURF="$(grep -m1 '^SURF_RE=' "$CURSOR_GATE")"
[ -n "$CLAUDE_SURF" ] && [ "$CLAUDE_SURF" = "$CURSOR_SURF" ] && ok || bad "SURF_RE identical across both gate scripts"
# Same reasoning for Task 4's registration reader: the gates are two files by necessity, not by design,
# and a divergence here is something a later reader "fixes" in the wrong direction. Only the I/O
# boundary (which accessor produces the payload) may differ between them.
for fn in _reg_slots _slots_kept; do
  CLAUDE_FN="$(sed -n "/^$fn() {/,/^}/p" "$CLAUDE_GATE")"
  CURSOR_FN="$(sed -n "/^$fn() {/,/^}/p" "$CURSOR_GATE")"
  [ -n "$CLAUDE_FN" ] && [ "$CLAUDE_FN" = "$CURSOR_FN" ] && ok || bad "$fn() identical across both gate scripts"
done

echo "== CROSS-AXIS SLOT PARITY: the gate (does this edit keep the registration?) and core/_integrity.sh" >&2
echo "   (will the gate actually run?) must derive the SAME slots from the same document ==" >&2
# The two axes disagreeing is not a cosmetic split: the gate deliberately ALLOWs a widened matcher and
# a collapse of both matchers into one `*`, while _integrity.sh's matcher-STRING comparison read those
# same documents as `partial` and `unregistered` -> 76 at hardened/stale -> all thirteen entrypoints
# refuse, with a printed repair the installer itself rejects on a root-owned tree. A kit wedged by a
# change its own gate had just approved.
#
# Byte-identity is the wrong instrument here (the wiring side must also return the COMMAND per slot,
# so the two functions cannot be the same text), and a comment saying "kept in sync" is what the SURF
# DRIFT test above already exists to distrust. Compare DECISIONS: for each document, the set of
# "<event>:<tool>" keys must match exactly. Any divergence is drift between the two axes.
#
# The wiring side spells the same model across TWO functions — `_wiring_slots` for the
# self-protection gate's PreToolUse/preToolUse/beforeShellExecution slots and `_wiring_slots_stop`
# for the delivery gate's Stop slot, split so that one gate's registration can never satisfy the
# other's slot. The gate's `_reg_slots` keeps both in one function with two predicates for the same
# reason, so the comparison is against the UNION. Documents carrying a Stop registration are in the
# list below precisely so that half is not compared vacuously.
JQ="$(command -v jq)"
eval "$(sed -n '/^_reg_slots() {/,/^}/p' "$CLAUDE_GATE")"
. "$CORE/_integrity.sh"
PARITY_DOC_DIR="$WORK/slot-parity"; mkdir -p "$PARITY_DOC_DIR"
SLOT_DRIFT=0; n=0
gate_c='"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh"'
dlv_c='"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-delivery-gate.sh"'
for doc in \
  "$(jq -nc --arg c "$gate_c" --arg d "$dlv_c" '{hooks:{PreToolUse:[{matcher:"Write|Edit",hooks:[{type:"command",command:$c}]},{matcher:"Bash",hooks:[{type:"command",command:$c}]}],Stop:[{hooks:[{type:"command",command:$d}]}]}}')" \
  "$(jq -nc --arg d "$dlv_c" '{hooks:{Stop:[{hooks:[{type:"command",command:$d}]}]}}')" \
  "$(jq -nc --arg c "$gate_c" '{hooks:{Stop:[{hooks:[{type:"command",command:$c}]}]}}')" \
  "$(jq -nc --arg d "$dlv_c" '{hooks:{PreToolUse:[{matcher:"Bash",hooks:[{type:"command",command:$d}]}]}}')" \
  '{"hooks":{"Stop":[]}}' \
  "$(jq -nc --arg c "$gate_c" '{hooks:{PreToolUse:[{matcher:"Write|Edit",hooks:[{type:"command",command:$c}]},{matcher:"Bash",hooks:[{type:"command",command:$c}]}]}}')" \
  "$(jq -nc --arg c "$gate_c" '{hooks:{PreToolUse:[{matcher:"Write|Edit|MultiEdit",hooks:[{type:"command",command:$c}]},{matcher:"Bash",hooks:[{type:"command",command:$c}]}]}}')" \
  "$(jq -nc --arg c "$gate_c" '{hooks:{PreToolUse:[{matcher:"*",hooks:[{type:"command",command:$c}]}]}}')" \
  "$(jq -nc --arg c "$gate_c" '{hooks:{PreToolUse:[{hooks:[{type:"command",command:$c}]}]}}')" \
  "$(jq -nc --arg c "$gate_c" '{hooks:{PreToolUse:[{matcher:"Write",hooks:[{type:"command",command:$c}]}]}}')" \
  "$(jq -nc --arg c "$CGATE_CMD" '{version:1,hooks:{beforeShellExecution:[{command:$c}],preToolUse:[{command:$c,matcher:"Write|Edit"}]}}')" \
  "$(jq -nc --arg c "$CGATE_CMD" '{version:1,hooks:{preToolUse:[{command:$c,matcher:"Task"}]}}')" \
  "$(jq -nc --arg c "$CGATE_CMD" '{version:1,hooks:{preToolUse:[{command:$c,matcher:"*"}]}}')" \
  '{"hooks":{"PreToolUse":[]}}' \
  '{"hooks":{"PreToolUse":[{"matcher":"Write|Edit","hooks":[{"type":"command","command":"/some/other/hook.sh"}]}]}}'
do
  n=$((n+1)); PD="$PARITY_DOC_DIR/doc$n.json"; printf '%s\n' "$doc" > "$PD"
  GATE_SLOTS="$(_reg_slots "$PD" | sort)"
  WIRE_SLOTS="$({ _wiring_slots "$PD"; _wiring_slots_stop "$PD"; } | sed 's/	.*//' | sort -u)"
  [ "$GATE_SLOTS" = "$WIRE_SLOTS" ] || { SLOT_DRIFT=1; echo "   SLOT DRIFT on doc$n: gate=[$GATE_SLOTS] wiring=[$WIRE_SLOTS]" >&2; }
done
[ "$SLOT_DRIFT" -eq 0 ] && ok || bad "the gate's _reg_slots and core/_integrity.sh's _wiring_slots/_wiring_slots_stop disagree about at least one document — the two integrity axes have drifted apart again"
# ...and the control that keeps the comparison from being vacuous: the documents above must actually
# produce slots, or two empty sets would match for every one of them. doc1 carries BOTH a PreToolUse
# and a Stop registration, so it is non-empty on `_wiring_slots` and on `_wiring_slots_stop` — the
# Stop half needs its own control for exactly the reason the whole comparison does.
[ -n "$(_reg_slots "$PARITY_DOC_DIR/doc1.json")" ] && [ -n "$(_wiring_slots "$PARITY_DOC_DIR/doc1.json")" ] \
  && [ -n "$(_wiring_slots_stop "$PARITY_DOC_DIR/doc1.json")" ] \
  && ok || bad "CONTROL: the slot-parity documents must produce non-empty slot sets on both axes, Stop included, or the comparison above is vacuous"
# ...and that the gate's own reader emits the Stop slot at all — the parity loop compares two sets and
# would stay green if BOTH sides went blind to Stop at once (a shared jq typo in the filename, say).
[ "$(_reg_slots "$PARITY_DOC_DIR/doc2.json")" = 'Stop:*' ] \
  && ok || bad "CONTROL: _reg_slots must emit Stop:* for a document whose only registration is the delivery gate at Stop"

echo "== SURF DRIFT: the bash-ERE fallback and shell-guard.py's SURF must classify the same paths ==" >&2
# There are two surface patterns in two languages, "kept in sync" by comment only — and the review that
# produced this round found the directory-operand gap present in BOTH plus match_surface, which is how a
# three-way hand-sync fails. Compare decisions instead of trusting the comment: for an absolute path,
# `rm -f <path>` always satisfies MUT_RE, so the bash fallback's verdict reduces to its SURF_RE, and
# shell-guard.py's verdict to its SURF. Any disagreement is drift.
SURF_RE_VAL="$(sed -n "s/^SURF_RE='\(.*\)'\$/\1/p" "$CLAUDE_GATE")"
[ -n "$SURF_RE_VAL" ] && ok || bad "could not extract SURF_RE from the gate for the drift check"
DRIFT=0
for p in "$SKILL/core/config.json" "$SKILL/SKILL.md" "$SKILL" "$SKILL/core" \
         "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" "$PROJ/.claude/hooks/.flaky-kit-expect" \
         "$PROJ/.claude/hooks/flaky-kit-delivery-gate.sh" "$PROJ/.cursor/hooks/flaky-kit-delivery-gate.sh" \
         "$PROJ/.claude/hooks/lib/audit.sh" "$PROJ/.cursor/hooks/lib/audit.sh" \
         "$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh" \
         "$PROJ/.claude/hooks" "$PROJ/.cursor/hooks" \
         "$PROJ/.claude/hooks/observe.sh" "$PROJ/.claude/settings.json" "$PROJ/README.md" "/tmp/elsewhere" \
         "$PROJ/.claude/settings.local.json" "$PROJ/.cursor/hooks.json"
do
  if printf '%s' "rm -f $p" | grep -qE "$SURF_RE_VAL"; then B=surface; else B=other; fi
  if printf '%s' "rm -f $p" | HEKTOR_FK_CWD="$PROJ" python3 "$SKILL/core/shell-guard.py" >/dev/null 2>&1; then G=surface; else G=other; fi
  [ "$B" = "$G" ] || { DRIFT=1; echo "   DRIFT: $p -> bash=$B python=$G" >&2; }
done
[ "$DRIFT" -eq 0 ] && ok || bad "the gates' bash SURF_RE and core/shell-guard.py's SURF disagree about at least one path — the two hand-synced patterns have drifted"

echo "== Claim sweep: the retracted overclaims must not come back in new wording ==" >&2
# The branch's governing rule is that a claim the mechanism does not deliver is a defect equal to a
# broken mechanism — and these four claims came back, reworded, in four consecutive rounds. Guard the
# exact phrases the way integrity-test.sh guards the retired INTEGRITY_FAKE_UID identifier. A hit is
# tolerated only on a line that marks itself as a retraction, a historical quote, or an assertion ABOUT
# the phrase; anything else is the claim being made again. `claim_free` is in the exclusion set because
# the argument list below would otherwise match itself.
#
# Two honest limits: the sweep covers the KIT tree only, not docs/superpowers/{plans,specs} (those are
# swept by hand at review time), and a phrase re-introduced with different line wrapping would slip past
# a per-line fixed-string grep. It is a regression tripwire for the recurrence pattern actually
# observed — the same sentence reappearing verbatim in a new file — not a proof of absence.
claim_free() {
  local hits n
  hits="$(grep -rn -F "$1" --include='*.md' --include='*.mdc' --include='*.sh' --include='*.py' "$KITSRC" 2>/dev/null \
          | grep -v -E 'retract|AMENDED|withdrawn|corrected|must not|bad "|claim_free|earlier|stale|no longer|used to')"
  n="$(printf '%s' "$hits" | grep -c '[^[:space:]]')"
  [ "$n" -eq 0 ] && ok \
    || bad "a retracted claim is being asserted again: \"$1\" — $n line(s): $(printf '%s' "$hits" | head -1)"
}
claim_free 'the gate is a real wall'
claim_free 'gates are real walls'
claim_free 'gate itself walls'
claim_free 'optional real wall'
claim_free 'keyed to human consent'
claim_free 'THIS is human consent'
claim_free 'the privileged path cannot be automated'

echo "== Fix 3: HEKTOR_FK_CWD-absent degrades observably, not silently ==" >&2
SG="$SKILL/core/shell-guard.py"
ABS_CMD="sed -i '' \"$SKILL/core/config.json\""   # absolute reference: cwd-independent, isolates the floor check
ERR_NOCWD="$WORK/err-nocwd.txt"; ERR_CWD="$WORK/err-cwd.txt"
printf '%s' "$ABS_CMD" | HEKTOR_FK_SURFACE="$SKILL/core" python3 "$SG" 2>"$ERR_NOCWD" >/dev/null; RC_NOCWD=$?
printf '%s' "$ABS_CMD" | HEKTOR_FK_SURFACE="$SKILL/core" HEKTOR_FK_CWD="$SKILL" python3 "$SG" 2>"$ERR_CWD" >/dev/null; RC_CWD=$?
[ "$RC_NOCWD" -eq 0 ] && ok || bad "deny floor unaffected: absolute surface ref still DENYs with HEKTOR_FK_CWD absent (rc=$RC_NOCWD)"
[ "$RC_CWD" -eq 0 ]   && ok || bad "deny floor unaffected: absolute surface ref still DENYs with HEKTOR_FK_CWD present (rc=$RC_CWD)"
grep -q "cwd unavailable" "$ERR_NOCWD" && ok || bad "stderr note printed when HEKTOR_FK_CWD is absent"
grep -q "cwd unavailable" "$ERR_CWD"   && bad "no stderr note expected when HEKTOR_FK_CWD IS set" || ok

echo "== HEKTOR_FK_SURFACE must be ADDITIVE: it used to REPLACE the surface pattern wholesale, so one" >&2
echo "   environment variable disabled the primary Bash decision path outright ==" >&2
printf '%s' "$ABS_CMD" | HEKTOR_FK_SURFACE=/definitely/nowhere python3 "$SG" >/dev/null 2>&1
[ "$?" -eq 0 ] && ok || bad "a bogus HEKTOR_FK_SURFACE must not turn a verified DENY into an ALLOW — same class as the INTEGRITY_FAKE_UID back door, whose ruling was remove, not fence"
# ...and it must still ADD a root, which is the seam's legitimate purpose (a kit installed anywhere
# protects itself). The unset case below proves the added-root assertion is not vacuous.
OUTSIDE_CMD="sed -i '' $WORK/elsewhere/kit/core/config.json"
printf '%s' "$OUTSIDE_CMD" | HEKTOR_FK_SURFACE="$WORK/elsewhere/kit" python3 "$SG" >/dev/null 2>&1
[ "$?" -eq 0 ] && ok || bad "HEKTOR_FK_SURFACE must still ADD a root — a kit installed outside .claude/skills/ has to be able to protect itself"
printf '%s' "$OUTSIDE_CMD" | python3 "$SG" >/dev/null 2>&1
[ "$?" -eq 1 ] && ok || bad "without the override that out-of-tree path must NOT be surface (otherwise the additive assertion above proves nothing)"

echo "== Locked-kit operation intact (Round2 lock-kit.sh, unaffected by this round) ==" >&2
# HEKTOR_FK_NO_SUDO=1 forces the degraded (chmod-only) tier: this fixture is a /tmp throwaway that
# lock-kit.sh's tier logic (Task 3) would otherwise try to `chown -R root` if sudo has a cached
# credential on the developer's machine — this test must never attempt a privileged operation.
HEKTOR_FK_NO_SUDO=1 "$SKILL/core/lock-kit.sh" lock >/dev/null 2>&1
assert_claude_bash_deny "(cd core && sed -i '' config.json)"   # gate still reads/decides fine while locked
LOCK_STATUS="$("$SKILL/core/lock-kit.sh" status 2>/dev/null)"  # captured first: `status | grep -q` on the
printf '%s\n' "$LOCK_STATUS" | grep -q 'r-  core/config.json' \
  && ok || bad "locked kit: status shows core/config.json read-only"
HEKTOR_FLAKYKIT_UNLOCK=1 HEKTOR_FK_NO_SUDO=1 "$SKILL/core/lock-kit.sh" unlock >/dev/null 2>&1

# --- helpers: build N-deep nested parens / mixed $(...)/(...) around an inner command ---
nest_parens() {  # $1=depth $2=inner -> ((...(inner)...))
  local n="$1" out="$2" i
  for ((i = 0; i < n; i++)); do out="($out)"; done
  printf '%s' "$out"
}
nest_mixed() {    # $1=depth $2=inner -> alternating $(...) / (...), N layers deep
  local n="$1" out="$2" i
  for ((i = 0; i < n; i++)); do
    if (( i % 2 == 0 )); then out="\$($out)"; else out="($out)"; fi
  done
  printf '%s' "$out"
}

echo "== Fix 4 (CRITICAL): MAX_SUBSHELL_DEPTH must fail CLOSED, not open (must DENY, both gates) ==" >&2
SURFACE_CMD="cd core && sed -i '' config.json"
assert_claude_bash_deny "$(nest_parens 9  "$SURFACE_CMD")"    # depth 9  (bound is 8) — all parens
assert_cursor_bash_deny "$(nest_parens 9  "$SURFACE_CMD")"
assert_claude_bash_deny "$(nest_parens 12 "$SURFACE_CMD")"    # depth 12
assert_cursor_bash_deny "$(nest_parens 12 "$SURFACE_CMD")"
assert_claude_bash_deny "$(nest_parens 20 "$SURFACE_CMD")"    # depth 20
assert_cursor_bash_deny "$(nest_parens 20 "$SURFACE_CMD")"
assert_claude_bash_deny "$(nest_mixed  9  "$SURFACE_CMD")"    # depth 9, mixed $(...)/(...)
assert_cursor_bash_deny "$(nest_mixed  9  "$SURFACE_CMD")"

echo "== Fix 4: deny-on-excess-depth is intentional even for a BENIGN 9-deep nest (documented fail-closed, not a bug) ==" >&2
assert_claude_bash_deny "$(nest_parens 9 "echo hi")"
assert_cursor_bash_deny "$(nest_parens 9 "echo hi")"

echo "== Fix 4 controls: a NORMAL shallow (depth <= 2) triage command still ALLOWs ==" >&2
assert_claude_bash_allow "bash core/rerun.sh --suite nightly"                 # depth 0, real kit usage shape
assert_cursor_bash_allow "bash core/rerun.sh --suite nightly"
assert_claude_bash_allow "$(nest_parens 1 "echo hi && ls /tmp")"              # depth 1, benign
assert_cursor_bash_allow "$(nest_parens 1 "echo hi && ls /tmp")"
assert_claude_bash_allow "$(nest_parens 2 "echo hi")"                         # depth 2, benign
assert_cursor_bash_allow "$(nest_parens 2 "echo hi")"

echo "== Fix 5 (IMPORTANT): brace groups '{ ...; }' must be cd-tracked (must DENY, both gates) ==" >&2
assert_claude_bash_deny "{ cd core && sed -i '' config.json; }"
assert_cursor_bash_deny "{ cd core && sed -i '' config.json; }"
assert_claude_bash_deny "{ cd core; }; sed -i '' config.json"   # cd PERSISTS past the closing brace
assert_cursor_bash_deny "{ cd core; }; sed -i '' config.json"

echo "== Fix 5 controls: a brace group with no surface write still ALLOWs, both gates ==" >&2
assert_claude_bash_allow "{ echo hi; ls /tmp; }"
assert_cursor_bash_allow "{ echo hi; ls /tmp; }"
assert_claude_bash_allow "{ cd /tmp; sed -i '' x; }"            # cd is OUT of the surface entirely
assert_cursor_bash_allow "{ cd /tmp; sed -i '' x; }"

echo "== Fix 5 regression: unquoted \${VAR}-style expansion / brace-expansion tokens are NOT mistaken for a group ==" >&2
assert_claude_bash_allow 'echo ${HOME} && ls /tmp'
assert_cursor_bash_allow 'echo ${HOME} && ls /tmp'
assert_claude_bash_allow 'ls /tmp/{a,b}'
assert_cursor_bash_allow 'ls /tmp/{a,b}'

echo "== Task 6: out-of-tree shadow detection (the expectation lives OUTSIDE the kit tree, BOTH gates) ==" >&2
# --- shadow detection: the expectation lives OUTSIDE the kit tree. lock() writes exactly ONE
# record (.claude/hooks/.flaky-kit-expect) regardless of which harness reads it, so a dual-harness
# install must have BOTH gates notice the same shadowed tree, not just the Claude one. ---
printf 'hardened\n' > "$PROJ/.claude/hooks/.flaky-kit-expect"

echo "== Shadow case A: rename-and-REPLACE — the case the warning's own text describes ==" >&2
# The detector's first version fired only when core/ was ABSENT, so this — move the tree aside and drop
# a tree this account controls in its place — was completely silent, while FIVE places (spec §4,
# core/lock-kit.sh, kernel.md's P4 row, and both gates' comments) asserted the detection as fact.
# Ownership is the signal that cannot be forged without the password the hardened tier is built on: a
# replacement cannot be root-owned. Also remove the replacement's .lock-state, so nothing in-tree hints
# at what happened — an in-tree check cannot tell this from a fresh install, which is the whole reason
# the record and this detector live outside the tree.
mv "$SKILL" "$WORK/shadowed-kit"
cp -R "$WORK/shadowed-kit" "$SKILL"
rm -f "$SKILL/core/.lock-state"
REPL_JSON='{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo hi"}}'
OUT="$(printf "$REPL_JSON" "$PROJ" | "$CLAUDE_GATE" 2>&1)"
case "$OUT" in *SHADOW*) ok ;; *) bad "claude gate must warn when the recorded tier is hardened but the tree at the expected path is NOT root-owned — a rename-and-replace, got: $OUT" ;; esac
CURSOR_OUT="$(printf '{"command":"echo hi","cwd":"%s"}' "$PROJ" | "$CURSOR_GATE" 2>&1)"
case "$CURSOR_OUT" in *SHADOW*) ok ;; *) bad "cursor gate must warn on the same rename-and-replace, got: $CURSOR_OUT" ;; esac

echo "== Shadow control: a legitimate maintenance window must NOT trip it (unlock refreshes the record) ==" >&2
# Testing PROTECTION rather than PRESENCE only works because `unlock` writes `unlocked` to the record
# (core/lock-kit.sh's write_expect). Without that, every open maintenance window would look exactly
# like a shadowed kit and the warning would cry wolf on the normal path.
printf 'unlocked\n' > "$PROJ/.claude/hooks/.flaky-kit-expect"
OUT="$(printf "$REPL_JSON" "$PROJ" | "$CLAUDE_GATE" 2>&1)"
case "$OUT" in *SHADOW*) bad "claude gate must stay silent while the record says 'unlocked' — a maintenance window is not a shadow" ;; *) ok ;; esac
CURSOR_OUT="$(printf '{"command":"echo hi","cwd":"%s"}' "$PROJ" | "$CURSOR_GATE" 2>&1)"
case "$CURSOR_OUT" in *SHADOW*) bad "cursor gate must stay silent while the record says 'unlocked'" ;; *) ok ;; esac
printf 'hardened\n' > "$PROJ/.claude/hooks/.flaky-kit-expect"

echo "== R1 Shadow SILENCE control: core/ genuinely root-owned must produce NO warning ==" >&2
# The suite above proves the gate WARNS on a rename-and-replace and on a vanished tree — testing
# PROTECTION, not merely PRESENCE. But nothing yet proves the gate STAYS SILENT when the recorded
# tier is hardened AND core/ genuinely IS root-owned — the one state a correctly hardened, normally
# operating kit is in essentially all the time. The only existing silence control (the maintenance-
# window one just above) pins the RECORD comparison (record=unlocked), not the ownership branch —
# it never exercises the `_owner_uid "$_CORE" != "0"` line at all. Mutation-verified below: replacing
# that comparison with `true` in BOTH gates left the whole suite green before this control existed.
#
# No privilege needed: a PATH-shimmed `stat` (same technique as core/tests/lock-tier-test.sh's
# STAT_TARGETS and core/tests/install-guard-test.sh) reports uid 0 for exactly $SKILL/core when
# asked for the numeric owner (`%u`), and falls through to the real `stat` for every other query
# (including `status`'s `%Su` name lookup, and anything unrelated to this one path) so it cannot
# accidentally widen into a general "everything is root" stub.
#
# Two spellings are matched, not one: the Cursor gate resolves its root via `git rev-parse
# --show-toplevel` (cc_repo_root), which on macOS answers with the PHYSICAL path, while $SKILL
# itself is spelled through mktemp's un-resolved /var/folders/... symlink form (same /var ->
# /private/var wrinkle noted in core/tests/lock-tier-test.sh) — so the Cursor gate's `_CORE` and
# this fixture's `$SKILL/core` are two different strings for the same directory. Resolving
# $SKILL/core's own physical form with `pwd -P` and matching either spelling closes that gap; the
# Claude gate is unaffected (it takes CLAUDE_PROJECT_DIR directly, no git resolution) but is matched
# the same way for uniformity.
PHYS_CORE="$(cd "$SKILL/core" && pwd -P)"
OWNSHIM="$WORK/ownshim"; mkdir -p "$OWNSHIM"
cat > "$OWNSHIM/stat" <<STATSH
#!/bin/bash
case " \$* " in *" %u "*) ;; *) exec /usr/bin/stat "\$@" ;; esac
for a in "\$@"; do
  case "\$a" in "$SKILL/core"|"$PHYS_CORE") echo 0; exit 0 ;; esac
done
exec /usr/bin/stat "\$@"
STATSH
chmod +x "$OWNSHIM/stat"
SILENT_OUT="$(cd "$PROJ" && printf "$REPL_JSON" "$PROJ" | PATH="$OWNSHIM:$PATH" CLAUDE_PROJECT_DIR="$PROJ" "$CLAUDE_GATE" 2>&1)"
case "$SILENT_OUT" in *SHADOW*) bad "claude gate must stay SILENT when core/ genuinely reports root-owned (record says hardened, ownership agrees) — got: $SILENT_OUT" ;; *) ok ;; esac
SILENT_CURSOR="$(cd "$PROJ" && printf '{"command":"echo hi","cwd":"%s"}' "$PROJ" | PATH="$OWNSHIM:$PATH" "$CURSOR_GATE" 2>&1)"
case "$SILENT_CURSOR" in *SHADOW*) bad "cursor gate must stay SILENT when core/ genuinely reports root-owned (record says hardened, ownership agrees) — got: $SILENT_CURSOR" ;; *) ok ;; esac

echo "== Shadow case B: renamed aside with NOTHING in its place ==" >&2
rm -rf "$SKILL"                                   # simulate the kit dir being renamed away
OUT="$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo hi"}}' "$PROJ" \
       | "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" 2>&1)"
case "$OUT" in *SHADOW*|*"no longer present"*) ok ;; *) bad "claude gate must notice the kit tree vanished while the expectation says hardened" ;; esac

CURSOR_OUT="$(printf '{"command":"echo hi","cwd":"%s"}' "$PROJ" \
       | "$CURSOR_GATE" 2>&1)"
case "$CURSOR_OUT" in *SHADOW*|*"no longer present"*) ok ;; *) bad "cursor gate must notice the kit tree vanished while the expectation says hardened" ;; esac

echo "== Task 8: _ROOT git-toplevel fallback (CLAUDE_PROJECT_DIR unset, cwd a SUBDIRECTORY) ==" >&2
# Regression for a silent-failure bug: _ROOT used to fall back to $CWD (the tool call's reported
# cwd), which is wrong whenever that cwd is a subdirectory of the project — .flaky-kit-expect then
# gets looked up under the WRONG path and the shadow check silently never fires. Reuses the
# already-shadowed fixture above ($SKILL still removed, .flaky-kit-expect still says hardened);
# invokes the gate with the process's REAL cwd inside a nested subdirectory and CLAUDE_PROJECT_DIR
# unset, so only the git-toplevel fallback (not $CWD) can find the project root.
NESTED="$PROJ/some/nested/dir"
mkdir -p "$NESTED"
NESTED_OUT="$(cd "$NESTED" && printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo hi"}}' "$NESTED" \
       | "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" 2>&1)"
case "$NESTED_OUT" in *SHADOW*|*"no longer present"*) ok ;; *) bad "claude gate must resolve the project root via the git-toplevel fallback when CLAUDE_PROJECT_DIR is unset and cwd is a subdirectory — got: $NESTED_OUT" ;; esac

echo "self-protection-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
