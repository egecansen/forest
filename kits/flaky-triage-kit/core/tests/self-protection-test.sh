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
# in shell-guard.py: this string-analysis gate is best-effort friction, not a hard wall; the
# real wall is `core/lock-kit.sh lock` (OS read-only, dir-level).
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
cp "$KITSRC/adapters/_lib/audit.sh"                             "$PROJ/.claude/hooks/lib/audit.sh"
cp "$KITSRC/adapters/cursor/flaky-kit-self-protection-gate.sh"  "$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh"
cp "$KITSRC/adapters/cursor/lib/cursor-compat.sh"               "$PROJ/.cursor/hooks/lib/cursor-compat.sh"
cp "$KITSRC/adapters/_lib/audit.sh"                             "$PROJ/.cursor/hooks/lib/audit.sh"
chmod +x "$SKILL/core/shell-guard.py" "$SKILL/core/lock-kit.sh" \
         "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" "$PROJ/.cursor/hooks/flaky-kit-self-protection-gate.sh"
printf '{"kit":"config"}\n'      > "$SKILL/core/config.json"
printf '# unrelated cursor rule\n' > "$PROJ/.cursor/rules/hektor-flaky-triage.mdc"
printf '{}\n'                    > "$PROJ/.claude/settings.json"
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

assert_claude_bash_deny()  { claude_denied "$(bash_json "$SKILL" "$1")"        && ok || bad "claude DENY Bash: $1"; }
assert_claude_bash_allow() { claude_denied "$(bash_json "$SKILL" "$1")"        && bad "claude should ALLOW Bash: $1" || ok; }
assert_cursor_bash_deny()  { cursor_denied "$(cursor_bash_json "$SKILL" "$1")" && ok || bad "cursor DENY Bash: $1"; }
assert_cursor_bash_allow() { cursor_denied "$(cursor_bash_json "$SKILL" "$1")" && bad "cursor should ALLOW Bash: $1" || ok; }
assert_claude_edit_deny()  { claude_denied "$(edit_json "$PROJ" "$1")"  && ok || bad "claude DENY Edit: $2 ($1)"; }
assert_claude_edit_allow() { claude_denied "$(edit_json "$PROJ" "$1")"  && bad "claude should ALLOW Edit: $2 ($1)" || ok; }
assert_cursor_edit_deny()  { cursor_denied "$(edit_json "$PROJ" "$1")"  && ok || bad "cursor DENY Edit: $2 ($1)"; }
assert_cursor_edit_allow() { cursor_denied "$(edit_json "$PROJ" "$1")"  && bad "cursor should ALLOW Edit: $2 ($1)" || ok; }

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

echo "== Fix 2: SURF_RE stays byte-identical between the two gate scripts (parity) ==" >&2
CLAUDE_SURF="$(grep -m1 '^SURF_RE=' "$CLAUDE_GATE")"
CURSOR_SURF="$(grep -m1 '^SURF_RE=' "$CURSOR_GATE")"
[ -n "$CLAUDE_SURF" ] && [ "$CLAUDE_SURF" = "$CURSOR_SURF" ] && ok || bad "SURF_RE identical across both gate scripts"

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
rm -rf "$SKILL"                                   # simulate the kit dir being renamed away
OUT="$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo hi"}}' "$PROJ" \
       | "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" 2>&1)"
case "$OUT" in *SHADOW*|*"no longer present"*) ok ;; *) bad "claude gate must notice the kit tree vanished while the expectation says hardened" ;; esac

CURSOR_OUT="$(printf '{"command":"echo hi","cwd":"%s"}' "$PROJ" \
       | "$CURSOR_GATE" 2>&1)"
case "$CURSOR_OUT" in *SHADOW*|*"no longer present"*) ok ;; *) bad "cursor gate must notice the kit tree vanished while the expectation says hardened" ;; esac

echo "self-protection-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
