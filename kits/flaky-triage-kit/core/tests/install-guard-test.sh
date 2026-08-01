#!/bin/bash
# core/tests/install-guard-test.sh — install.sh must refuse to cp over a hardened kit instead of
# emitting a wall of EACCES, must tell the user how to harden a fresh install, and must clean up the
# pre-relocation in-tree gate when it upgrades an existing install.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KITSRC="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
# chflags -R nouappend FIRST: the audit-lib assertion below drives the installed delivery gate,
# whose hektor_audit() flags docs/hektor/.hook-audit.log append-only on Darwin — a flag `rm -rf`
# cannot remove through, so without this the fixture directory outlives the run.
trap 'chflags -R nouappend "$TMP" 2>/dev/null; chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

P="$TMP/proj"; mkdir -p "$P"; git -C "$P" init -q
SKILL_DIR="$P/.claude/skills/hektor-flaky-triage"
OUT="$("$KITSRC/install.sh" --harness claude --project "$P" 2>&1)"
# Anchored to the NEW hint's own wording. An earlier draft matched only "lock-kit.sh lock", which a
# pre-existing closing line already contained — so the assertion passed against an installer with no
# hint at all. Proven by mutation: with the guard and hint stripped, that version still reported 2/3.
case "$OUT" in *"WITHOUT that step nothing is protected"*) ok ;; *) bad "a fresh install must say plainly that nothing is protected yet, not just print a command" ;; esac
# The same output block used to call hardening "optional real wall" three lines above "WITHOUT that
# step nothing is protected" — one block calling the step optional and mandatory at once.
case "$OUT" in *"optional real wall"*) bad "the next-steps block must not call hardening optional while the line below it says nothing is protected without it" ;; *) ok ;; esac

# --- a FORGED record must not veto the upgrade ------------------------------------------------------
# The guard used to key off .lock-state, so an agent could block every future upgrade permanently by
# writing one line of JSON — a denial of service on the maintenance path from inside the scope this kit
# constrains. Ownership is the signal now; a record claiming hardened over a user-owned tree is a
# MISMATCH, reported loudly, and the install proceeds because reinstalling is the repair.
printf '{"tier":"hardened","at":"x"}\n' > "$SKILL_DIR/core/.lock-state"
OUT="$("$KITSRC/install.sh" --harness claude --project "$P" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok || bad "a forged hardened record over a user-owned tree must NOT block the install (rc=$RC)"
case "$OUT" in *MISMATCH*) ok ;; *) bad "a record claiming hardened over a tree that is not root-owned must be called out as a MISMATCH" ;; esac

# --- a GENUINELY hardened install must be refused --------------------------------------------------
# Real root ownership needs a password, so `stat`'s numeric-uid query is shimmed to report 0 for the
# installed core/ — exactly what a successful `sudo chown -R root` leaves behind — and install.sh's
# real, unmodified ownership check runs against it. Only `%u` is intercepted; everything else falls
# through to the real binary.
SHIM="$TMP/bin"; mkdir -p "$SHIM"
cat > "$SHIM/stat" <<'SH'
#!/bin/bash
case " $* " in *" %u "*) ;; *) exec /usr/bin/stat "$@" ;; esac
for a in "$@"; do [ "$a" = "$STAT_TARGET" ] && { echo 0; exit 0; }; done
exec /usr/bin/stat "$@"
SH
chmod +x "$SHIM/stat"
OUT="$(STAT_TARGET="$SKILL_DIR/core" PATH="$SHIM:$PATH" "$KITSRC/install.sh" --harness claude --project "$P" 2>&1)"; RC=$?
# Anchored to the refusal's own wording — the old boilerplate also contains "unlock", so matching that
# alone could not distinguish "guard refused" from "guard absent and the usual closing text printed".
case "$OUT" in *"refusing to overwrite"*) ok ;; *) bad "re-installing over a root-owned kit must print the refusal, not just any text containing 'unlock'" ;; esac
[ "$RC" -ne 0 ] && ok || bad "re-installing over a root-owned kit must exit non-zero"
rm -f "$SKILL_DIR/core/.lock-state"

# --- upgrade path: the pre-relocation in-tree gate must be removed AND deregistered ----------------
# install.sh's jq only ever appends, and nothing deleted the old in-tree copy — so upgrading an
# existing install left TWO registered gates: the new one plus a stale in-tree copy predating the
# shadow check and the relocated surface patterns, which also travels with the tree on a rename.
mkdir -p "$SKILL_DIR/hooks"
printf 'x\n' > "$SKILL_DIR/hooks/flaky-kit-self-protection-gate.sh"
OLDCMD='"$CLAUDE_PROJECT_DIR/.claude/skills/hektor-flaky-triage/hooks/flaky-kit-self-protection-gate.sh"'
t="$TMP/settings.tmp"
jq --arg c "$OLDCMD" '.hooks.PreToolUse |= map(if .matcher=="Bash" then .hooks += [{type:"command", command:$c, timeout:10}] else . end)' \
  "$P/.claude/settings.json" > "$t" && mv "$t" "$P/.claude/settings.json"
grep -qF 'skills/hektor-flaky-triage/hooks/flaky-kit-self-protection-gate.sh' "$P/.claude/settings.json" \
  && ok || bad "fixture precondition: the stale registration must be present before the upgrade run"
"$KITSRC/install.sh" --harness claude --project "$P" >/dev/null 2>&1
[ -e "$SKILL_DIR/hooks" ] && bad "the upgrade must delete the stale in-tree gate directory — it predates the shadow check and travels with the tree on a rename" || ok
grep -qF 'skills/hektor-flaky-triage/hooks/flaky-kit-self-protection-gate.sh' "$P/.claude/settings.json" \
  && bad "the upgrade must drop the stale in-tree gate registration — otherwise the project has two registered gates" || ok
# ...without dropping the CURRENT one.
grep -qF '.claude/hooks/flaky-kit-self-protection-gate.sh' "$P/.claude/settings.json" \
  && ok || bad "the stale-registration filter must not remove the relocated gate's own registration"
[ "$(jq '[.hooks.PreToolUse[].hooks[].command] | map(select(contains("flaky-kit"))) | length' "$P/.claude/settings.json")" = 2 ] \
  && ok || bad "exactly two flaky-kit registrations must remain (Write|Edit + Bash), one per matcher"

# --- the restore source ships with the engine ------------------------------------------------
# Task 3 restores a deleted gate from here. It lives under core/ deliberately: harden_targets
# chowns that directory, so at a root-owned tier the restore source is root-owned and an agent
# cannot poison what would be restored.
GS="$SKILL_DIR/core/gate-src/claude"
[ -f "$GS/flaky-kit-self-protection-gate.sh" ] && ok || bad "install must ship the claude gate restore source"
[ -x "$GS/flaky-kit-self-protection-gate.sh" ] && ok || bad "the restore source must stay executable"
[ -f "$GS/lib/audit.sh" ] && ok || bad "install must ship the audit lib beside the restore source"
# It must be the SAME file the gate was installed from, or a restore would install a different
# gate than the one the install registered.
cmp -s "$GS/flaky-kit-self-protection-gate.sh" "$P/.claude/hooks/flaky-kit-self-protection-gate.sh" \
  && ok || bad "the restore source must be byte-identical to the installed gate"

# --- the same, for Cursor -----------------------------------------------------------------------
# install.sh writes gate-src/cursor/ symmetrically to gate-src/claude/ above, but nothing had ever
# installed --harness cursor in this file, so that half rested on by-eye symmetry alone. Task 3
# restores the Cursor gate from this path too.
P2="$TMP/proj-cursor"; mkdir -p "$P2"; git -C "$P2" init -q
SKILL_DIR2="$P2/.claude/skills/hektor-flaky-triage"
"$KITSRC/install.sh" --harness cursor --project "$P2" >/dev/null 2>&1
GSC="$SKILL_DIR2/core/gate-src/cursor"
[ -f "$GSC/flaky-kit-self-protection-gate.sh" ] && ok || bad "install must ship the cursor gate restore source"
[ -x "$GSC/flaky-kit-self-protection-gate.sh" ] && ok || bad "the cursor restore source must stay executable"
[ -f "$GSC/lib/audit.sh" ] && ok || bad "install must ship the audit lib beside the cursor restore source"
cmp -s "$GSC/flaky-kit-self-protection-gate.sh" "$P2/.cursor/hooks/flaky-kit-self-protection-gate.sh" \
  && ok || bad "the cursor restore source must be byte-identical to the installed gate"

# --- the delivery gate ships, registers, and records its capability ---------------------------
[ -x "$P/.claude/hooks/flaky-kit-delivery-gate.sh" ] && ok || bad "install must ship the delivery gate"
[ -f "$SKILL_DIR/core/gate-src/claude/flaky-kit-delivery-gate.sh" ] && ok || bad "the delivery gate needs a restore source like its sibling"
[ "$(jq -r '[.hooks.Stop[]?|(.hooks//[])[]?|.command|select(test("flaky-kit-delivery-gate"))]|length' "$P/.claude/settings.json")" = 1 ] \
  && ok || bad "install must register the delivery gate at Stop, exactly once"
# The capability record: first token the harness, remaining tokens capabilities.
[ "$(cat "$SKILL_DIR/core/.harness")" = "claude stop" ] && ok || bad "install must record the stop capability"
# Idempotent: a second install must not duplicate the registration or the token.
"$KITSRC/install.sh" --harness claude --project "$P" >/dev/null 2>&1
[ "$(jq -r '[.hooks.Stop[]?|(.hooks//[])[]?|.command|select(test("flaky-kit-delivery-gate"))]|length' "$P/.claude/settings.json")" = 1 ] \
  && ok || bad "a second install must not duplicate the Stop registration"
[ "$(cat "$SKILL_DIR/core/.harness")" = "claude stop" ] && ok || bad "a second install must not duplicate the capability token"

# --- whole-branch review, Minor 3: the Stop merge must not report a success it did not have -------
# `core/_wiring_repair.sh`'s `_wr_register_stop` carries `[ -s "$t" ]` and an `rm -f "$t"`, and its
# comment claims an install and a repair "cannot disagree about" this merge. They did: this merge had
# neither guard and printed its success line unconditionally. Driven against a project whose
# `.hooks.Stop` is a non-array — valid JSON, so nothing upstream rejects it — jq errors, `mv` never
# runs, and the pre-fix installer printed "Claude Code wired (… Stop)" with nothing registered, while
# `core/.harness` still recorded the `stop` capability: the axis then reads `unregistered`, which is
# rc 76 from every entrypoint at the hardened and stale tiers.
P3="$TMP/proj-stopfail"; mkdir -p "$P3"; git -C "$P3" init -q
"$KITSRC/install.sh" --harness claude --project "$P3" >/dev/null 2>&1
S3="$P3/.claude/settings.json"
t="$TMP/s3.tmp"; jq '.hooks.Stop = "not-an-array"' "$S3" > "$t" && mv "$t" "$S3"
cp "$S3" "$P3/before.json"
# A `mktemp` SHIM, not `TMPDIR`: BSD `mktemp` (macOS, the system shell this kit targets) ignores
# TMPDIR entirely when called with no template — verified — so a TMPDIR-based version of the leak
# assertion below is vacuous and passes against an installer that leaks every temp file it makes.
# Same seam as the `stat` shim above: only the no-argument form is intercepted, everything else falls
# through to the real binary. install.sh calls `mktemp` with no arguments in all six places.
TD="$TMP/tmpdir"; mkdir -p "$TD" "$SHIM"
cat > "$SHIM/mktemp" <<'SH'
#!/bin/bash
case "$#" in 0) exec /usr/bin/mktemp "$MKTEMP_DIR/tmp.XXXXXXXX" ;; *) exec /usr/bin/mktemp "$@" ;; esac
SH
chmod +x "$SHIM/mktemp"
OUT="$(MKTEMP_DIR="$TD" PATH="$SHIM:$PATH" "$KITSRC/install.sh" --harness claude --project "$P3" 2>&1)"; RC3=$?
case "$OUT" in *"Stop)"*) bad "the installer must not claim the Stop registration landed when the merge failed — got: $OUT" ;; *) ok ;; esac
case "$OUT" in *"Stop registration did NOT land"*) ok ;; *) bad "a failed Stop merge must say so — got: $OUT" ;; esac
cmp -s "$P3/before.json" "$S3" && ok || bad "a failed Stop merge must leave the settings file exactly as it found it"
[ "$(jq -r '[.hooks.Stop?] | length' "$S3")" = 1 ] && [ "$(jq -r '.hooks.Stop | type' "$S3")" = string ] \
  && ok || bad "CONTROL: .hooks.Stop must still be the non-array this fixture set, or the merge did not actually fail"
[ "$(find "$TD" -type f 2>/dev/null | wc -l | tr -d ' ')" = 0 ] \
  && ok || bad "a failed merge must remove its temp file — $(find "$TD" -type f 2>/dev/null | wc -l | tr -d ' ') left behind"
# The record still says `stop`, deliberately: it states what the install was asked for, and dropping
# the token would turn a loud, repairable failure into a silent downgrade — the axis would simply
# stop checking the Stop slot and nothing would ever say the delivery gate is not running.
[ "$(cat "$P3/.claude/skills/hektor-flaky-triage/core/.harness")" = "claude stop" ] \
  && ok || bad "a failed Stop merge must not quietly drop the capability the install was asked for"

# --- residual R3: the WARN was the whole of the loudness, and the script still exited 0 -----------
# It went on to print "install: done" and to name "run core/lock-kit.sh lock" as step 2. A scripted
# or CI install could not tell this state from a clean one; a reader who follows step 2 converts a
# warning into rc 76 on all thirteen entrypoints, at which point the remedy printed there (re-run the
# installer) is itself refused with 75 on the now-root-owned tree, and the real repair becomes
# unlock (password) -> fix -> reinstall -> relock. Three separate properties, because "it exits
# non-zero" alone would pass against a version that exits 74 AFTER telling the reader to lock.
[ "$RC3" = 74 ] && ok || bad "a failed Stop merge must exit non-zero (74) so a scripted install can see it — got rc $RC3"
case "$OUT" in *"install: done"*) bad "a failed Stop merge must not print 'install: done' as if the install were clean — got: $OUT" ;; *) ok ;; esac
case "$OUT" in *"HARDEN (do not skip"*) bad "a failed Stop merge must not print the HARDEN step — following it is what converts this into the rc-76 state — got: $OUT" ;; *) ok ;; esac
case "$OUT" in *"INCOMPLETE"*) ok ;; *) bad "a failed Stop merge must SAY the install is incomplete, not merely return a number — got: $OUT" ;; esac
case "$OUT" in *"DO NOT run"*) ok ;; *) bad "the incomplete ending must tell the reader not to lock yet — that is the step that makes it expensive — got: $OUT" ;; esac
# ...and it must FINISH the install before saying so. A partial install that aborts mid-way is worse
# than one that completes and reports: these four are all written AFTER the Stop merge in the script,
# or are the things a reader would lose if it bailed at the merge.
[ -x "$P3/.claude/hooks/flaky-kit-self-protection-gate.sh" ] \
  && ok || bad "the failing path must still install the self-protection gate — the merge that failed is a different control"
[ -x "$P3/.claude/hooks/flaky-kit-delivery-gate.sh" ] \
  && ok || bad "the failing path must still install the delivery gate FILE — only its registration failed"
[ "$(jq '[.hooks.PreToolUse[]?.hooks[]?.command] | map(select(contains("flaky-kit"))) | length' "$S3")" = 2 ] \
  && ok || bad "the failing path must still land the PreToolUse registrations — they are a separate merge on a separate key"
[ -f "$P3/.claude/skills/hektor-flaky-triage/core/gate-src/claude/flaky-kit-delivery-gate.sh" ] \
  && ok || bad "the failing path must still vendor the restore source — the repair path depends on it"

# ...and the control that keeps all of the above from passing against an installer that never claims
# Stop at all, or that exits 74 on every install: the healthy path still says it, and still exits 0.
OUTH="$("$KITSRC/install.sh" --harness claude --project "$P" 2>&1)"; RCH=$?
case "$OUTH" in
  *"PreToolUse Write|Edit + Bash, Stop)"*) ok ;;
  *) bad "CONTROL: a healthy install must still report the Stop registration" ;;
esac
[ "$RCH" = 0 ] && ok || bad "CONTROL: a healthy install must still exit 0 — got rc $RCH"
case "$OUTH" in *"install: done"*) ok ;; *) bad "CONTROL: a healthy install must still print 'install: done'" ;; esac
case "$OUTH" in *"INCOMPLETE"*) bad "CONTROL: a healthy install must not call itself incomplete" ;; *) ok ;; esac

# --- carried forward from the gate's own task: the audit-lib fallback is a SILENT no-op ------------
# (`hektor_audit() { :; }`) whenever lib/audit.sh is not beside the installed gate, which would turn
# every one of the delivery gate's "fail open and SAY so" paths quiet. install.sh vendors the lib
# beside the deployed gate the same way it does for the self-protection gate — but a bare file-exists
# check would pass even if the gate's own relative-path lookup were wrong (wrong dirname, wrong
# nesting, ...). Run the INSTALLED gate for real and prove it actually FOUND the lib: empty stdin is
# the very first fail-open branch in the gate (`command -v jq` first, then this), needs nothing but
# jq, and hektor_audit only ever reaches docs/hektor/.hook-audit.log if lib/audit.sh was sourced —
# the `{ :; }` fallback writes nothing at all.
rm -rf "$P/docs/hektor"
( cd "$P" && printf '' | "$P/.claude/hooks/flaky-kit-delivery-gate.sh" >/dev/null 2>&1 )
case "$(cat "$P/docs/hektor/.hook-audit.log" 2>/dev/null)" in
  *"empty stdin, failing open"*) ok ;;
  *) bad "the installed delivery gate must find its vendored audit lib and log its fail-open path, not silently no-op" ;;
esac

echo "install-guard-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
