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
# ...and the failed merge must take nothing else down with it. These four are written BEFORE it — so
# they say the failure did not roll anything back, which is NOT the same claim as "the install ran to
# the end". That claim needs work scheduled AFTER the Stop merge, and with --harness claude there is
# none; it is asserted on its own fixture below.
[ -x "$P3/.claude/hooks/flaky-kit-self-protection-gate.sh" ] \
  && ok || bad "the failing path must still install the self-protection gate — the merge that failed is a different control"
[ -x "$P3/.claude/hooks/flaky-kit-delivery-gate.sh" ] \
  && ok || bad "the failing path must still install the delivery gate FILE — only its registration failed"
[ "$(jq '[.hooks.PreToolUse[]?.hooks[]?.command] | map(select(contains("flaky-kit"))) | length' "$S3")" = 2 ] \
  && ok || bad "the failing path must still land the PreToolUse registrations — they are a separate merge on a separate key"
[ -f "$P3/.claude/skills/hektor-flaky-triage/core/gate-src/claude/flaky-kit-delivery-gate.sh" ] \
  && ok || bad "the failing path must still vendor the restore source — the repair path depends on it"

# THE INSTALL MUST RUN TO COMPLETION and only then report — a partial install that aborts in the
# middle is worse than one that finishes and says what it could not do. The Cursor block and the
# AGENTS.md block are the only work scheduled AFTER the Claude Stop merge, so `--harness all` is the
# only fixture that can tell "finished, then exited 74" from "bailed at the merge". An early `exit`
# at the WARN would leave both absent and both assertions red.
P4="$TMP/proj-stopfail-all"; mkdir -p "$P4"; git -C "$P4" init -q
mkdir -p "$P4/.claude"
printf '{"hooks":{"Stop":"not-an-array"}}\n' > "$P4/.claude/settings.json"
OUT4="$("$KITSRC/install.sh" --harness all --project "$P4" 2>&1)"; RC4=$?
[ "$RC4" = 74 ] && ok || bad "CONTROL: the --harness all fixture must also hit the failing Stop merge — got rc $RC4"
[ -n "$(jq -r '[.hooks.beforeShellExecution[]?.command|select(test("flaky-kit"))]|length|select(.>0)' "$P4/.cursor/hooks.json" 2>/dev/null)" ] \
  && ok || bad "the Cursor registration is written AFTER the failing Claude Stop merge and must still land — the install completes, then reports"
grep -qF 'hektor-flaky-triage:begin' "$P4/AGENTS.md" 2>/dev/null \
  && ok || bad "the AGENTS.md pointer is the LAST thing the installer writes and must still land before it exits 74"

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

# --- final minors, Fix 2: the Cursor merge had the exact defect Minor 3 / residual R3 fixed for the
# Stop merge above — no `[ -s "$t" ]` guard, no `rm -f "$t"` on failure, and an unconditional "install:
# Cursor wired". Same fixture shape as the Stop-merge block above, mirrored onto `.cursor/hooks.json`:
# `.hooks.beforeShellExecution` set to a non-array (valid JSON, so nothing upstream rejects it) makes
# the `+=` inside the jq filter error, `mv` never runs, and the pre-fix installer printed "Cursor
# wired (… beforeShellExecution + preToolUse …)" over a hooks.json with nothing registered — while
# `core/.harness` recorded cursor as a required harness, so the wiring axis reads `unregistered` for
# the Cursor self-protection gate at the very next entrypoint, rc 76 at the hardened and stale tiers.
P5="$TMP/proj-cursorfail"; mkdir -p "$P5/.cursor"; git -C "$P5" init -q
printf '{"version":1,"hooks":{"beforeShellExecution":"not-an-array"}}\n' > "$P5/.cursor/hooks.json"
H5="$P5/.cursor/hooks.json"
cp "$H5" "$TMP/before-cursor.json"
TD2="$TMP/tmpdir2"; mkdir -p "$TD2"
OUT5="$(MKTEMP_DIR="$TD2" PATH="$SHIM:$PATH" "$KITSRC/install.sh" --harness cursor --project "$P5" 2>&1)"; RC5=$?
case "$OUT5" in *"beforeShellExecution + preToolUse"*) bad "the installer must not claim the Cursor registration landed when the merge failed — got: $OUT5" ;; *) ok ;; esac
case "$OUT5" in *"hooks.json registration did NOT land"*) ok ;; *) bad "a failed Cursor merge must say so — got: $OUT5" ;; esac
cmp -s "$TMP/before-cursor.json" "$H5" && ok || bad "a failed Cursor merge must leave hooks.json exactly as it found it"
[ "$(jq -r '.hooks.beforeShellExecution' "$H5")" = "not-an-array" ] \
  && ok || bad "CONTROL: .hooks.beforeShellExecution must still be the non-array this fixture set, or the merge did not actually fail"
[ "$(find "$TD2" -type f 2>/dev/null | wc -l | tr -d ' ')" = 0 ] \
  && ok || bad "a failed Cursor merge must remove its temp file — $(find "$TD2" -type f 2>/dev/null | wc -l | tr -d ' ') left behind"
# The record still says `cursor`, deliberately, for the same reason the Stop capability survives its
# own merge's failure above: it states what the install was ASKED for, and dropping it would turn a
# loud, repairable failure into a silent downgrade — the wiring axis would simply stop checking the
# Cursor self-protection slot.
[ "$(cat "$P5/.claude/skills/hektor-flaky-triage/core/.harness")" = "cursor" ] \
  && ok || bad "a failed Cursor merge must not quietly drop the harness the install was asked for"
[ "$RC5" = 74 ] && ok || bad "a failed Cursor merge must exit non-zero (74), the same contract the Stop merge failure uses — got rc $RC5"
case "$OUT5" in *"install: done"*) bad "a failed Cursor merge must not print 'install: done' as if the install were clean — got: $OUT5" ;; *) ok ;; esac
case "$OUT5" in *"HARDEN (do not skip"*) bad "a failed Cursor merge must not print the HARDEN step — got: $OUT5" ;; *) ok ;; esac
case "$OUT5" in *"INCOMPLETE"*) ok ;; *) bad "a failed Cursor merge must SAY the install is incomplete — got: $OUT5" ;; esac
case "$OUT5" in *"DO NOT run"*) ok ;; *) bad "the incomplete ending must tell the reader not to lock yet — got: $OUT5" ;; esac
# The closing paragraph must not overclaim: it used to say "every other registration ARE in place",
# which is exactly the assertion the branch's own INCOMPLETE ending would be making falsely here, since
# the Cursor merge — not the Stop merge — is the one that failed.
case "$OUT5" in *"every other registration ARE in place"*) bad "the INCOMPLETE ending must not claim every OTHER registration is in place when the Cursor merge itself is the one that failed — got: $OUT5" ;; *) ok ;; esac
# ...and the failed merge must take nothing else down with it: the gate FILE and rule are a different
# control from the hooks.json REGISTRATION, mirroring the Stop-failure assertions above.
[ -x "$P5/.cursor/hooks/flaky-kit-self-protection-gate.sh" ] \
  && ok || bad "the failing Cursor path must still install the self-protection gate file — only its registration failed"
[ -f "$P5/.cursor/rules/hektor-flaky-triage.mdc" ] \
  && ok || bad "the failing Cursor path must still install the rule file"
[ -f "$P5/.claude/skills/hektor-flaky-triage/core/gate-src/cursor/flaky-kit-self-protection-gate.sh" ] \
  && ok || bad "the failing Cursor path must still vendor the cursor restore source"

# THE INSTALL MUST RUN TO COMPLETION here too — the AGENTS.md block is the only work scheduled AFTER
# the Cursor merge, so a pre-broken `.cursor/hooks.json` under `--harness all` is what tells "finished,
# then exited 74" from "bailed at the merge", mirroring the Stop-side P4 fixture above but with the
# failure on the OTHER merge, and the Claude side left healthy to prove the two merges are independent.
P6="$TMP/proj-cursorfail-all"; mkdir -p "$P6/.cursor"; git -C "$P6" init -q
printf '{"version":1,"hooks":{"beforeShellExecution":"not-an-array"}}\n' > "$P6/.cursor/hooks.json"
OUT6="$("$KITSRC/install.sh" --harness all --project "$P6" 2>&1)"; RC6=$?
[ "$RC6" = 74 ] && ok || bad "CONTROL: the --harness all fixture must also hit the failing Cursor merge — got rc $RC6"
[ "$(jq -r '[.hooks.Stop[]?|(.hooks//[])[]?|.command|select(test("flaky-kit-delivery-gate"))]|length' "$P6/.claude/settings.json")" = 1 ] \
  && ok || bad "the Claude Stop registration is written BEFORE the failing Cursor merge and must still land — the two merges are independent"
grep -qF 'hektor-flaky-triage:begin' "$P6/AGENTS.md" 2>/dev/null \
  && ok || bad "the AGENTS.md pointer is the LAST thing the installer writes and must still land before it exits 74, even when the Cursor merge is what failed"

# ...and the control that keeps the above from passing against an installer that never claims Cursor
# at all, or that exits 74 on every install: the healthy Cursor path still says it, and still exits 0.
P7="$TMP/proj-cursor-healthy"; mkdir -p "$P7"; git -C "$P7" init -q
OUT7="$("$KITSRC/install.sh" --harness cursor --project "$P7" 2>&1)"; RC7=$?
case "$OUT7" in
  *"Cursor wired (.cursor/: rule + beforeShellExecution + preToolUse Write|Edit)"*) ok ;;
  *) bad "CONTROL: a healthy Cursor install must still report the registration — got: $OUT7" ;;
esac
[ "$RC7" = 0 ] && ok || bad "CONTROL: a healthy Cursor install must still exit 0 — got rc $RC7"
case "$OUT7" in *"install: done"*) ok ;; *) bad "CONTROL: a healthy Cursor install must still print 'install: done'" ;; esac
case "$OUT7" in *"INCOMPLETE"*) bad "CONTROL: a healthy Cursor install must not call itself incomplete" ;; *) ok ;; esac

# --- the COPIES: an install must not report a success it never achieved ---------------------------
# Everything above is about a registration MERGE failing over an install that otherwise landed.
# Nothing had ever asked whether the install landed at all. install.sh has no `set -e`, no
# `cp || exit`, and none of its six non-zero exits observes a copy result — the first copy happens
# after all of them, and the sixth is about `.hooks.Stop`. So a copy that failed was invisible:
# measured, an unwritable target directory left the project with no engine, no core/.harness
# and no core/.version, while the installer registered three hooks, printed "install: Claude Code
# wired (.claude/settings.json: PreToolUse Write|Edit + Bash, Stop)" and "install: done", named
# `lock-kit.sh lock` as step 2, and exited 0. The registrations named paths that did not exist. A
# user was told they were wired and protected with nothing installed, and enforcement is the only
# thing this kit is for.
#
# Not scoped to any one route in. Invoking install.sh through a symlink produces the whole-tree
# version of the same thing — install.sh does not walk the chain, so every `cp` SOURCE is missing —
# and that route is unreachable through the CLI today (which execs install.sh by resolved absolute
# path). The defect is that ANY copy failure, from a full disk to a permission error to a partial
# `cp`, produced a confident success; the fixtures below drive two different causes for that reason.
#
# NO real `chown`, ever: a directory the invoking user cannot write into raises the same EACCES on
# `cp` that a read-only mount does, and one `chmod` reverses it. It is restored immediately after the
# run (and again by the EXIT trap's `chmod -R u+w`) so the fixture can be removed.
P8="$TMP/proj-copyfail"; mkdir -p "$P8/.claude/skills/hektor-flaky-triage"; git -C "$P8" init -q
chmod 500 "$P8/.claude/skills/hektor-flaky-triage"
OUT8="$("$KITSRC/install.sh" --harness claude --project "$P8" 2>&1)"; RC8=$?
chmod 700 "$P8/.claude/skills/hektor-flaky-triage"
# CONTROL first: without this the whole block could pass against a fixture that installed fine and an
# installer that simply prints "FAILED" at random.
[ ! -f "$P8/.claude/skills/hektor-flaky-triage/core/gate.sh" ] \
  && ok || bad "CONTROL: the fixture must actually have stopped the engine copy, or nothing below proves anything"
[ "$RC8" -ne 0 ] && ok || bad "an install whose engine copy failed must exit non-zero — got rc $RC8"
[ "$RC8" = 73 ] \
  && ok || bad "a failed copy must exit 73, kept distinct from 74 (everything landed, a registration merge did not) — got rc $RC8"
case "$OUT8" in *"install: done"*) bad "an install whose engine copy failed must not print 'install: done' — got: $OUT8" ;; *) ok ;; esac
case "$OUT8" in *wired*) bad "an install whose engine copy failed must not claim any harness is wired — got: $OUT8" ;; *) ok ;; esac
case "$OUT8" in *"HARDEN (do not skip"*) bad "an install whose engine copy failed must not print the HARDEN step — there is nothing there to lock — got: $OUT8" ;; *) ok ;; esac
case "$OUT8" in *"install: FAILED"*) ok ;; *) bad "a failed copy must SAY the install failed, not merely return a number — got: $OUT8" ;; esac
# Naming the artefact is the requirement, not a generic failure: these are what the closing
# next-steps block tells the reader to open, so they are exactly what it may not claim falsely.
#
# Anchored to "MISSING: <exact path>", the report's own shape, NOT to the bare path. Proven
# necessary by mutation: with the artefact list deleted from the report, a bare `*"SKILL.md"*` still
# matched — `cp`'s own "Permission denied" for that copy is in the captured output — and a bare
# `*"core/lock-kit.sh"*` matched the "Do NOT run …" remedy line that the report prints regardless.
# Both would have been assertions that could not fail.
S8="$P8/.claude/skills/hektor-flaky-triage"
case "$OUT8" in *"MISSING: $S8/core/config.json"*) ok ;; *) bad "the failure must NAME the missing artefact — core/config.json is what next-step 1 sends the reader to — got: $OUT8" ;; esac
case "$OUT8" in *"MISSING: $S8/core/lock-kit.sh"*) ok ;; *) bad "the failure must name the missing hardening script next-step 2 sends the reader to run — got: $OUT8" ;; esac
case "$OUT8" in *"MISSING: $S8/SKILL.md"*) ok ;; *) bad "the failure must name the missing SKILL.md — got: $OUT8" ;; esac
case "$OUT8" in *"MISSING: $S8/core/README.md"*) ok ;; *) bad "the failure must name the missing core/README.md — got: $OUT8" ;; esac
# A failed install must not leave the project half-wired either: the check runs BEFORE the merge.
[ ! -f "$P8/.claude/settings.json" ] \
  && ok || bad "an install that failed before the engine landed must not have registered anything — settings.json was written"
# CONTROL, on the SAME fixture: restore the one permission and it installs cleanly. This is what says
# the refusal was caused by the copy failure rather than by anything else about this project.
OUT8B="$("$KITSRC/install.sh" --harness claude --project "$P8" 2>&1)"; RC8B=$?
[ "$RC8B" = 0 ] && ok || bad "CONTROL: the same fixture with the permission restored must install cleanly — got rc $RC8B: $OUT8B"
case "$OUT8B" in *"install: done"*) ok ;; *) bad "CONTROL: the repaired fixture must print 'install: done'" ;; esac
case "$OUT8B" in *"install: FAILED"*) bad "CONTROL: the repaired fixture must not still report FAILED" ;; *) ok ;; esac

# A directory that EXISTS with nothing in it is the other shape a failed copy leaves behind, and it
# is the one "the engine directory is non-empty" was written for: here `mkdir -p core` succeeds, the
# `cp -R` into it does not, and the `.harness`/`.version` writes that would otherwise have made the
# directory non-empty without an engine in it fail for the same reason.
P8C="$TMP/proj-copyfail-empty"; mkdir -p "$P8C/.claude/skills/hektor-flaky-triage/core"; git -C "$P8C" init -q
chmod 500 "$P8C/.claude/skills/hektor-flaky-triage/core"
OUT8C="$("$KITSRC/install.sh" --harness claude --project "$P8C" 2>&1)"; RC8C=$?
chmod 700 "$P8C/.claude/skills/hektor-flaky-triage/core"
[ "$RC8C" = 73 ] && ok || bad "an engine directory left EMPTY by a failed copy must fail the install with 73 — got rc $RC8C"
case "$OUT8C" in *"EMPTY:"*) ok ;; *) bad "an engine directory that exists but is empty must be reported as empty, not merely missing — got: $OUT8C" ;; esac
case "$OUT8C" in *"install: done"*) bad "an empty engine directory must not print 'install: done' — got: $OUT8C" ;; *) ok ;; esac

# The other half of the requirement: the GATE SCRIPTS. A gate whose file did not land is a
# registration naming a path that does not exist, and the pre-fix installer reported it as wired.
# Driven from a staged source with the delivery gate removed — a missing `cp` SOURCE, a different
# cause from the unwritable destination above, reaching the copy that happens after the engine's.
GSRC="$TMP/src-nogate"; mkdir -p "$GSRC"; cp -R "$KITSRC/." "$GSRC/"
rm -f "$GSRC/adapters/claude/flaky-kit-delivery-gate.sh"
P9="$TMP/proj-gatefail"; mkdir -p "$P9"; git -C "$P9" init -q
OUT9="$("$GSRC/install.sh" --harness claude --project "$P9" 2>&1)"; RC9=$?
[ "$RC9" = 73 ] && ok || bad "an install whose gate copy failed must exit 73 — got rc $RC9"
case "$OUT9" in *"Claude Code wired"*) bad "a gate whose file never landed must not be reported as wired — got: $OUT9" ;; *) ok ;; esac
case "$OUT9" in *"install: done"*) bad "an install whose gate copy failed must not print 'install: done' — got: $OUT9" ;; *) ok ;; esac
# Anchored for the same reason as the engine artefacts above: the bare filename also appears in
# `cp`'s own "No such file or directory" for the SOURCE this fixture removed.
case "$OUT9" in *"MISSING: $P9/.claude/hooks/flaky-kit-delivery-gate.sh"*) ok ;; *) bad "the failure must name the gate that is missing — got: $OUT9" ;; esac
# The engine DID land here, so this fixture also proves the gate check is its own check and not the
# engine one firing again.
[ -f "$P9/.claude/skills/hektor-flaky-triage/core/gate.sh" ] \
  && ok || bad "CONTROL: the engine must have landed in this fixture, or this is the engine check firing, not the gate one"
[ ! -f "$P9/.claude/settings.json" ] \
  && ok || bad "the installer must not register a gate whose file never landed — settings.json was written"

# ...and PRESENT is not the same claim as EXECUTABLE. A gate that is registered but not executable is
# a hook Claude Code cannot run, which is the same silence as a missing one. Reached with a `chmod`
# SHIM — the same seam as the `stat` and `mktemp` shims above — because install.sh chmod +x's every
# gate it copies, so a non-executable SOURCE alone cannot produce a non-executable install. Only the
# one destination path is intercepted; every other chmod falls through to the real binary.
cat > "$SHIM/chmod" <<'SH'
#!/bin/bash
for a in "$@"; do [ "$a" = "${CHMOD_SKIP:-}" ] && exit 0; done
exec /bin/chmod "$@"
SH
/bin/chmod +x "$SHIM/chmod"
GSRC2="$TMP/src-noexec"; mkdir -p "$GSRC2"; cp -R "$KITSRC/." "$GSRC2/"
SPG="flaky-kit-self-protection-gate.sh"
/bin/chmod -x "$GSRC2/adapters/claude/$SPG"
P10="$TMP/proj-gatenoexec"; mkdir -p "$P10"; git -C "$P10" init -q
OUT10="$(CHMOD_SKIP="$P10/.claude/hooks/$SPG" PATH="$SHIM:$PATH" "$GSRC2/install.sh" --harness claude --project "$P10" 2>&1)"; RC10=$?
[ -f "$P10/.claude/hooks/$SPG" ] && [ ! -x "$P10/.claude/hooks/$SPG" ] \
  && ok || bad "CONTROL: the shim must have left the gate present-but-not-executable, or this asserts nothing"
[ "$RC10" = 73 ] && ok || bad "a gate that landed but is not executable must fail the install with 73 — got rc $RC10"
case "$OUT10" in *"NOT EXECUTABLE: $P10/.claude/hooks/$SPG"*) ok ;; *) bad "the failure must distinguish a non-executable gate from a missing one — got: $OUT10" ;; esac
case "$OUT10" in *"Claude Code wired"*) bad "a gate that cannot be executed must not be reported as wired — got: $OUT10" ;; *) ok ;; esac
rm -f "$SHIM/chmod"

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

# --- REGRESSION: .lock-state must not travel from the SOURCE tree into a fresh install -------------
# lock-kit.sh writes core/.lock-state INSIDE the tree it describes. install.sh's `cp -R "$HERE/core/."
# "$SKILL_DIR/core/"` copied that file right along with everything else, so a fresh install made from
# an already-locked (or already-unlocked) SOURCE kit landed carrying a record about a tree it never
# was. At `hardened` that record over a user-owned (freshly installed) destination reads back as
# `mismatch` — see _integrity.sh's integrity_tier — and `mismatch` REFUSES every entrypoint: the moment
# anyone locks the source kit, every project installed from it afterward is born refusing all thirteen
# entrypoints, with install.sh:83-87's own printed remedy ("reinstalling is the repair") being exactly
# what recreates the disease. Every prior assertion in this suite drives the tier as a string
# parameter; none exercises a real .lock-state file traveling through an actual install — this closes
# that gap.
#
# No sudo, no chown: ownership never enters into this. `cp -R` happily copies a plain file regardless
# of who owns the source tree, so a user-owned fixture reproduces the defect exactly. Stage a FULL copy
# of KITSRC as the fake source (not just core/) so install.sh's own $HERE-relative adapter lookups
# — adapters/claude/SKILL.md, adapters/_lib/audit.sh, etc. — still resolve when it runs from the copy.
stage_locked_source() { # $1 = fake-source dir to create, $2 = the tier to forge into its .lock-state
  mkdir -p "$1"
  cp -R "$KITSRC/." "$1/"
  printf '{"tier":"%s","at":"2026-08-04T07:25:06Z"}\n' "$2" > "$1/core/.lock-state"
}
read_tier() { "$1/core/lock-kit.sh" status 2>&1 | sed -n 's/^  tier: //p'; } # $1 = installed SKILL_DIR

# hardened source -> fresh destination: must install cleanly, must carry NO .lock-state, and the
# destination — which has never been locked — must read back as `unprotected`, not `mismatch`.
SRCH="$TMP/src-hardened"
stage_locked_source "$SRCH" hardened
PH="$TMP/proj-lockstate-hardened"; mkdir -p "$PH"; git -C "$PH" init -q
OUTLH="$("$SRCH/install.sh" --harness claude --project "$PH" 2>&1)"; RCLH=$?
SKILL_H="$PH/.claude/skills/hektor-flaky-triage"
[ "$RCLH" -eq 0 ] && ok || bad "installing from a hardened-recording source into a fresh project must succeed — got rc=$RCLH: $OUTLH"
[ -f "$SKILL_H/core/.lock-state" ] \
  && bad "a fresh install must not carry the SOURCE's .lock-state — found: $(cat "$SKILL_H/core/.lock-state" 2>/dev/null)" \
  || ok
TIER_H="$(read_tier "$SKILL_H")"
[ "$TIER_H" = "unprotected" ] && ok || bad "a fresh install (never locked) must report tier 'unprotected' — got '$TIER_H'"

# unlocked source -> fresh destination: the case that is wrong even without root. `unlock` does not
# delete .lock-state, it rewrites it to {"tier":"unlocked"} — so copying it claims the destination was
# once locked and then deliberately reopened, which never happened to it. `unprotected` ("lock has
# never run here") and `unlocked` (locked, then explicitly reopened) are different claims.
SRCU="$TMP/src-unlocked"
stage_locked_source "$SRCU" unlocked
PU="$TMP/proj-lockstate-unlocked"; mkdir -p "$PU"; git -C "$PU" init -q
OUTLU="$("$SRCU/install.sh" --harness claude --project "$PU" 2>&1)"; RCLU=$?
SKILL_U="$PU/.claude/skills/hektor-flaky-triage"
[ "$RCLU" -eq 0 ] && ok || bad "installing from an unlocked-recording source into a fresh project must succeed — got rc=$RCLU: $OUTLU"
[ -f "$SKILL_U/core/.lock-state" ] \
  && bad "a fresh install must not carry the SOURCE's .lock-state — found: $(cat "$SKILL_U/core/.lock-state" 2>/dev/null)" \
  || ok
TIER_U="$(read_tier "$SKILL_U")"
[ "$TIER_U" = "unprotected" ] \
  && ok || bad "a fresh install must report 'unprotected', not '$TIER_U' — carrying the source's 'unlocked' record falsely claims this tree was locked and then reopened"

# --- the CLI must resolve itself through a symlink -----------------------------
# npm's `bin` mechanism is ALWAYS a symlink: `<prefix>/bin/hektor-triage-kit ->
# ../lib/node_modules/hektor-flaky-triage/hektor-triage-kit` for `npm i -g`,
# `node_modules/.bin/hektor-triage-kit` for `npx`. bash puts the SYMLINK's path in
# BASH_SOURCE, so a HERE that takes dirname without walking the chain lands in npm's
# bin directory and `exec "$HERE/install.sh"` dies with rc 126 — that is EVERY npm
# consumption path, i.e. the whole reason this package exists.
#
# It survived 1061 green assertions because no test had ever invoked the CLI through
# a symlink: `grep -rn 'ln -s' core/tests/` returned nothing before this block.
#
# The fixture is TWO hops and the outer one is RELATIVE, exactly as npm writes it —
# an implementation that resolves only absolute targets passes a one-hop absolute
# fixture and still cannot install from npm.
SYM="$(mktemp -d)"; SYM="$(cd "$SYM" && pwd -P)"
mkdir -p "$SYM/lib" "$SYM/bin" "$SYM/proj"
ln -s "$KITSRC/hektor-triage-kit" "$SYM/lib/hektor-triage-kit"   # absolute hop
ln -s "../lib/hektor-triage-kit"  "$SYM/bin/hektor-triage-kit"   # relative hop, as npm writes it
( cd "$SYM/proj" && git init -q . )
SYMOUT="$("$SYM/bin/hektor-triage-kit" install --harness claude --project "$SYM/proj" 2>&1)"; SYMRC=$?
[ "$SYMRC" -eq 0 ] \
  && ok || bad "install through a symlinked CLI must succeed (rc=$SYMRC): $(printf '%s' "$SYMOUT" | tail -1)"
[ -f "$SYM/proj/.claude/skills/hektor-flaky-triage/core/apply.sh" ] \
  && ok || bad "install through a symlinked CLI must lay down the engine under .claude/"
[ -f "$SYM/proj/.claude/skills/hektor-flaky-triage/SKILL.md" ] \
  && ok || bad "install through a symlinked CLI must lay down SKILL.md"
# `link` reads the same HERE and carries the identical latent bug: called through a
# symlink it used to write a link pointing back at the calling symlink's directory
# instead of at the kit. Asserted structurally — the target's directory must be the
# one holding install.sh — so it cannot pass on a path that merely looks plausible.
"$SYM/bin/hektor-triage-kit" link "$SYM/dest" >/dev/null 2>&1
SYMLNK="$(readlink "$SYM/dest/hektor-triage-kit" 2>/dev/null)"
[ -n "$SYMLNK" ] && [ -f "$(dirname "$SYMLNK")/install.sh" ] \
  && ok || bad "link through a symlinked CLI must point into the kit, not back at the calling bin dir — got: ${SYMLNK:-<none>}"
rm -rf "$SYM"

# --- packaging: the files whitelist decides what ships ------------------------
# npm's `files` is a WHITELIST: a new kind of dev cruft is excluded by default
# rather than needing a new rule after it escapes. That is why this replaced the
# packager's blacklist. Driven through `npm pack --dry-run --json`, which is npm's
# own resolution rather than our reading of it.
pack_list() {  # $1 = kit dir -> newline-separated paths npm would ship
  # `npm pack --dry-run` genuinely runs `prepack` (verified: it executes the
  # hostname scan for real). On a scan failure npm's --json output is an
  # {"error": {...}} OBJECT, not the [{"files": [...]}] LIST this expects --
  # so name that cause up front instead of letting every caller hit a bare
  # KeyError/TypeError and a page of mechanically-cascading "files must ship"
  # failures with no pointer back to the actual refusal.
  ( cd "$1" && npm pack --dry-run --json 2>/dev/null \
      | python3 -c '
import sys, json
d = json.load(sys.stdin)
if isinstance(d, dict) and "error" in d:
    e = d["error"]
    sys.exit("pack_list: npm pack refused -- " + e.get("detail", e.get("summary", "?")) +
             "  (prepack runs the hostname scan: a dirty tree cannot be packed, so every "
             "files-must-ship / top-level-entries failure below is a SYMPTOM of this, not "
             "the cause)")
print("\n".join(f["path"] for f in d[0]["files"]))
' )
}

PKG_SRC="$(mktemp -d)"
cp -R "$KITSRC/." "$PKG_SRC/kit/" 2>/dev/null || { mkdir -p "$PKG_SRC/kit"; cp -R "$KITSRC/." "$PKG_SRC/kit/"; }
# plant every kind of thing that must NOT ship
mkdir -p "$PKG_SRC/kit/.achilles" "$PKG_SRC/kit/.playwright-mcp"
echo x > "$PKG_SRC/kit/.achilles/note.md"
echo x > "$PKG_SRC/kit/.playwright-mcp/capture.txt"
echo x > "$PKG_SRC/kit/.DS_Store"
echo x > "$PKG_SRC/kit/shot.png"
printf '{"tier":"hardened","at":"2020-01-01T00:00:00Z"}\n' > "$PKG_SRC/kit/core/.lock-state"
LIST="$(pack_list "$PKG_SRC/kit")"

for want in core/ adapters/ install.sh hektor-triage-kit README.md kernel.md cross-harness.md enforcement-codeowners.md; do
  case "$want" in
    */) printf '%s\n' "$LIST" | grep -q "^${want}" && ok || bad "files must ship $want" ;;
    *)  printf '%s\n' "$LIST" | grep -qx "$want" && ok || bad "files must ship $want" ;;
  esac
done

# whitelist excludes these without help from gitignore or npm's hardcoded defaults
for junk in .achilles/note.md .playwright-mcp/capture.txt shot.png scripts/scan-kit.sh; do
  printf '%s\n' "$LIST" | grep -q "$junk" && bad "whitelist must exclude $junk" || ok
done

# these are excluded by other layers (defence in depth), independent of files
# .DS_Store: npm's hardcoded ignore list. core/.lock-state: core/.gitignore.
for excluded in .DS_Store core/.lock-state; do
  printf '%s\n' "$LIST" | grep -q "$excluded" && bad "must not ship $excluded (excluded by layer outside whitelist)" || ok
done

# the set of top-level entries is exactly what files names: adding anything new
# to the top level reddens this, even if every item is already excluded by other means
TOP_LEVEL="$(printf '%s\n' "$LIST" | sed -n 's|^\([^/]*\).*|\1|p' | sort -u)"
WANT_TOP="README.md
adapters
core
cross-harness.md
enforcement-codeowners.md
hektor-triage-kit
install.sh
kernel.md
package.json"
[ "$TOP_LEVEL" = "$WANT_TOP" ] && ok || bad "top-level entries must be exactly $(printf '%s' "$WANT_TOP" | tr '\n' ' ') — got: $(printf '%s' "$TOP_LEVEL" | tr '\n' ' ')"

rm -rf "$PKG_SRC"

# --- packaging: the hostname guard --------------------------------------------
# The scan is the half of the retired packager that had to survive. A dirty tree
# must not become a tarball, so it runs as prepack.
SCAN_SRC="$(mktemp -d)"
cp -R "$KITSRC/." "$SCAN_SRC/kit/" 2>/dev/null || { mkdir -p "$SCAN_SRC/kit"; cp -R "$KITSRC/." "$SCAN_SRC/kit/"; }

bash "$SCAN_SRC/kit/scripts/scan-kit.sh" "$SCAN_SRC/kit" >/dev/null 2>&1 \
  && ok || bad "a clean kit must pass the hostname scan"

# Assembled rather than written literally: this file SHIPS (core/ is whitelisted),
# so a literal here would be a real hostname in a released artifact — and exempting
# the file instead would blind the guard to everything else in it.
_h="$(printf 'chroma-s-test-applications.apps.%s%s.%stzla.%s%s' 'ocpt' 'box' '' 'sahibinden' 'local.net')"
printf 'see %s\n' "$_h" >> "$SCAN_SRC/kit/README.md"
bash "$SCAN_SRC/kit/scripts/scan-kit.sh" "$SCAN_SRC/kit" >/dev/null 2>&1 \
  && bad "a hostname in a non-exempt file must be refused" || ok

git -C "$SCAN_SRC/kit" checkout README.md 2>/dev/null || cp "$KITSRC/README.md" "$SCAN_SRC/kit/README.md"
_h="$(printf '%s%s.%stzla.%s%s' 'ocpt' 'box' '' 'sahibinden' 'local.net')"
printf '\n%s\n' "$_h" >> "$SCAN_SRC/kit/kernel.md"
bash "$SCAN_SRC/kit/scripts/scan-kit.sh" "$SCAN_SRC/kit" >/dev/null 2>&1 \
  && ok || bad "kernel.md documents those endpoints deliberately and must stay exempt"

bash "$SCAN_SRC/kit/scripts/scan-kit.sh" --self-test >/dev/null 2>&1 \
  && ok || bad "the guard's own self-test must pass"
rm -rf "$SCAN_SRC"

# --- the install records its version ------------------------------------------
# "what version is this install?" was unanswerable twice: a broken worktree's age
# had to be inferred from file presence. Written at install time like
# core/.harness, and deliberately ABSENT from the source tree — see install.sh.
VER_SRC="$(mktemp -d)"; VER_P1="$(mktemp -d)"; VER_P2="$(mktemp -d)"
cp -R "$KITSRC/." "$VER_SRC/kit/" 2>/dev/null || { mkdir -p "$VER_SRC/kit"; cp -R "$KITSRC/." "$VER_SRC/kit/"; }
# a distinctive version, so the assertion cannot pass by matching the real one
python3 - "$VER_SRC/kit/package.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["version"]="9.9.9-test"; json.dump(d,open(p,"w"),indent=2)
PY

( cd "$VER_P1" && git init -q . && bash "$VER_SRC/kit/install.sh" --harness claude >/dev/null 2>&1 )
V1="$VER_P1/.claude/skills/hektor-flaky-triage/core/.version"
[ -f "$V1" ] && ok || bad "install.sh must write core/.version"
# The plainest delivery path, completing the trio with the tarball and npm ones
# below: core/.gitignore reaches an installed project by cp -R from a source
# checkout. Deleting that file as "redundant" is the exact move the spec correction
# warns about — it is the ONLY layer keeping .lock-state out of an artifact.
[ -f "$VER_P1/.claude/skills/hektor-flaky-triage/core/.gitignore" ] \
  && ok || bad "a source-checkout install must carry core/.gitignore downstream"
[ "$(cut -d' ' -f1 < "$V1")" = "9.9.9-test" ] \
  && ok || bad "core/.version must carry package.json's version, not a literal"

# Written per-install, not copied: two installs from ONE source differ in instant.
sleep 1
( cd "$VER_P2" && git init -q . && bash "$VER_SRC/kit/install.sh" --harness claude >/dev/null 2>&1 )
V2="$VER_P2/.claude/skills/hektor-flaky-triage/core/.version"
[ "$(cut -d' ' -f2 < "$V1")" != "$(cut -d' ' -f2 < "$V2")" ] \
  && ok || bad "two installs from one source must record DIFFERENT instants — proving .version is written, not carried"

# The structural guarantee: no .version anywhere in the source.
[ -z "$(find "$KITSRC" -name '.version' -print -quit)" ] \
  && ok || bad "the source tree must carry no .version — that is what keeps it unlike .lock-state"

# `--version` answers about the SOURCE; `status` answers about a PROJECT. Spec §5
# named both, but only `status` was ever implemented — `--version` fell through to
# "unknown subcommand" and exit 64. Read against the 9.9.9-test fixture so it cannot
# pass by matching the real version.
VOUT="$(bash "$VER_SRC/kit/hektor-triage-kit" --version 2>&1)"; VRC=$?
[ "$VRC" -eq 0 ] && ok || bad "--version must exit 0, got $VRC: $VOUT"
case "$VOUT" in *9.9.9-test*) ok ;; *) bad "--version must report package.json's version, got: $VOUT" ;; esac
# From an installed kit there is no manifest. Name the command that DOES know rather
# than inventing a version — the same reading `status` gives an install with no
# .version. A lone copy of the CLI is the only way HERE lacks package.json.
VNM="$(mktemp -d)"; cp "$VER_SRC/kit/hektor-triage-kit" "$VNM/hektor-triage-kit"
VNOUT="$(bash "$VNM/hektor-triage-kit" --version 2>&1)"; VNRC=$?
[ "$VNRC" -eq 66 ] && ok || bad "--version with no manifest must exit 66, got $VNRC: $VNOUT"
# Matched on the full command, not the bare word: the unknown-subcommand hint also
# contains "status", so a bare match would pass against a --version that was never
# implemented at all and simply fell through to that hint — which is the defect.
case "$VNOUT" in *"hektor-triage-kit status"*) ok ;; *) bad "--version with no manifest must point at 'hektor-triage-kit status', got: $VNOUT" ;; esac
rm -rf "$VNM"

# The hint a wrong subcommand prints is the only discovery surface some users get.
# It omitted `build` from the day build landed, and would have omitted `--version`
# too. Checked per subcommand so a new one added to the case block without a matching
# hint entry reddens here.
HOUT="$(bash "$VER_SRC/kit/hektor-triage-kit" definitely-not-a-subcommand 2>&1)"
for w in install build lock unlock status link --version help; do
  case "$HOUT" in *"$w"*) ok ;; *) bad "the unknown-subcommand hint must name '$w': $HOUT" ;; esac
done
rm -rf "$VER_SRC" "$VER_P1" "$VER_P2"

# --- build: pack, then verify what was packed ---------------------------------
# The retired zip passed packaging and was still wrong — it carried a hardened
# .lock-state and lacked the installer fix. A build that does not check its own
# output is how that ships.
BLD="$(mktemp -d)"
cp -R "$KITSRC/." "$BLD/kit/" 2>/dev/null || { mkdir -p "$BLD/kit"; cp -R "$KITSRC/." "$BLD/kit/"; }
( cd "$BLD/kit" && bash ./hektor-triage-kit build >"$BLD/out" 2>"$BLD/err" ); BRC=$?
[ "$BRC" = 0 ] && ok || bad "build must succeed on a clean kit (rc=$BRC: $(tail -1 "$BLD/err"))"
TGZ="$(ls "$BLD/kit"/hektor-flaky-triage-*.tgz 2>/dev/null | head -1)"
[ -n "$TGZ" ] && ok || bad "build must leave a versioned tarball in the kit dir"
grep -q "$(basename "${TGZ:-none}")" "$BLD/out" && ok || bad "build must print the artifact path"
# An empty $TGZ means the artifact was never produced (the "must leave a versioned
# tarball" assertion above already failed) — `tar tzf ""` does NOT error in that
# case, it reads from STDIN, so an interactive run blocks indefinitely right here.
# A non-tty sandbox merely hits EOF and mis-reports, which is why this hid until
# driven directly. Guard it so both assertions below fail loudly with a reason
# instead of ever touching stdin.
if [ -n "$TGZ" ]; then
  tar tzf "$TGZ" 2>/dev/null | grep -q '^package/core/apply.sh$' \
    && ok || bad "npm tarballs are prefixed package/, and the engine must be inside"
  tar tzf "$TGZ" 2>/dev/null | grep -q 'lock-state' && bad "a tarball must never carry .lock-state" || ok
  # core/.gitignore must SHIP. npm's always-ignore list drops every .gitignore from
  # a tarball even though core/ is whitelisted, so it needs its OWN `files` entry to
  # override that. It is also the one and only layer that keeps core/.lock-state out
  # of an artifact — `files: ["core/"]` includes everything under core/ minus ignore
  # rules, so with this file gone the whitelist ships .lock-state, verified.
  tar tzf "$TGZ" 2>/dev/null | grep -qxF 'package/core/.gitignore' \
    && ok || bad "the tarball must carry core/.gitignore — npm's always-ignore drops it unless files names it explicitly"

  # An install FROM THE TARBALL must be indistinguishable from one from the source:
  # this branch exists to reach someone who does NOT have the source directory, so
  # anything the tarball drops is dropped for them permanently. core/.gitignore is
  # what stops them committing .lock-state into their repo — a teammate who clones
  # that gets a record saying `hardened` over a tree that is not root-owned, which
  # integrity_tier reads as `mismatch` and every entrypoint then refuses.
  UNP="$(mktemp -d)"; TP="$(mktemp -d)"
  tar xzf "$TGZ" -C "$UNP" 2>/dev/null
  ( cd "$TP" && git init -q . && bash "$UNP/package/install.sh" --harness claude >/dev/null 2>&1 )
  [ -f "$TP/.claude/skills/hektor-flaky-triage/core/.gitignore" ] \
    && ok || bad "an install from the TARBALL must carry core/.gitignore downstream — cp -R can only carry what shipped"
  [ -f "$TP/.claude/skills/hektor-flaky-triage/core/.version" ] \
    && ok || bad "an install from the TARBALL must record .version (npm ships package.json in every tarball regardless of files)"

  # An UNPACKED TARBALL passes build's package.json check — npm ships package.json in
  # every tarball — but `scripts/` is deliberately outside the whitelist, so npm pack
  # dies on a missing prepack target. That reachable case used to be reported as "the
  # prepack hostname scan refuses a dirty tree", sending a consumer hunting a
  # disclosure that never happened in a tree with nothing wrong with it.
  UBOUT="$( cd "$UNP/package" && bash ./hektor-triage-kit build 2>&1 )"; UBRC=$?
  [ "$UBRC" = 66 ] \
    && ok || bad "build from an unpacked tarball must exit 66 like any non-source tree, got $UBRC"
  case "$UBOUT" in *scripts/scan-kit.sh*) ok ;; *) bad "build from an unpacked tarball must name the missing scripts/scan-kit.sh: $(printf '%s' "$UBOUT" | tail -1)" ;; esac
  case "$UBOUT" in *"refuses a dirty tree"*) bad "build from an unpacked tarball must not blame the hostname scan — nothing was scanned" ;; *) ok ;; esac
  rm -rf "$UNP" "$TP"

  # ...and through npm ITSELF, which is not the same thing as `tar xzf`. npm's
  # EXTRACTOR renames .gitignore to .npmignore on the way into node_modules: the
  # tarball carries core/.gitignore, plain tar writes core/.gitignore, npm writes
  # core/.npmignore — a name git never reads. So every tar-based assertion above can
  # be green while the only path a consumer actually uses still drops the protection.
  # Found by driving the real consumer path end to end; nothing short of it sees this.
  # Isolated --prefix under mktemp, never the user's real npm prefix.
  NPX="$(mktemp -d)"; NPP="$(mktemp -d)"
  npm i -g --prefix "$NPX" --no-audit --no-fund "$TGZ" >/dev/null 2>&1
  [ -L "$NPX/bin/hektor-triage-kit" ] \
    && ok || bad "npm i -g must install the CLI as a bin SYMLINK — the fixture the symlink test models is npm's actual behaviour, not an invention"
  ( cd "$NPP" && git init -q . && "$NPX/bin/hektor-triage-kit" install --harness claude >/dev/null 2>&1 )
  NPS="$NPP/.claude/skills/hektor-flaky-triage"
  [ -f "$NPS/core/apply.sh" ] \
    && ok || bad "an npm-global install must reach install.sh through the bin symlink and lay down the engine"
  [ -f "$NPS/core/.gitignore" ] \
    && ok || bad "an npm-global install must land core/.gitignore under the name GIT reads — npm's extractor renamed it to .npmignore"
  [ ! -f "$NPS/core/.npmignore" ] \
    && ok || bad "the installed tree must not keep npm's renamed copy beside the normalised one"
  # The contract itself, in git's own words, in the consumer's own repo: shipping the
  # file is only worth anything if THEIR repo ignores THEIR kit's .lock-state.
  ( cd "$NPP" && git check-ignore -q ".claude/skills/hektor-flaky-triage/core/.lock-state" ) \
    && ok || bad "a consumer's repo must ignore the installed kit's core/.lock-state — a committed 'hardened' record reads back as mismatch on every clone and refuses all thirteen entrypoints"

  # THE UPGRADE PATH, which a first-install-only test cannot see — and a first-install-only
  # test is exactly how the defect this covers got written. A later kit version adds a rule;
  # npm delivers it as core/.npmignore; re-installing over an existing project must carry it
  # through. Guarding the normalisation on "the destination has no .gitignore yet" made it
  # first-install-only: the guard skipped, and the `rm -f` after it then deleted the incoming
  # copy — so the new rule reached source-path users and silently never reached npm-path
  # users, which is this branch's own staleness shape one path over. Simulated on the
  # INSTALLED PACKAGE, because that is where a real upgrade puts the new file.
  printf '\n# added by a later kit version\n.hook-audit.log\n' >> "$NPX/lib/node_modules/hektor-flaky-triage/core/.npmignore"
  ( cd "$NPP" && "$NPX/bin/hektor-triage-kit" install --harness claude >/dev/null 2>&1 )
  grep -q '^\.hook-audit\.log$' "$NPS/core/.gitignore" 2>/dev/null \
    && ok || bad "re-installing on the npm path must deliver a rule added by a later kit version — normalising only on first install strands every npm consumer at the rules they installed with"
  [ ! -f "$NPS/core/.npmignore" ] \
    && ok || bad "a re-install must not leave npm's renamed copy behind either"
  rm -rf "$NPX" "$NPP"
else
  bad "npm tarballs are prefixed package/, and the engine must be inside (no artifact: \$TGZ was empty)"
  bad "a tarball must never carry .lock-state (no artifact: \$TGZ was empty)"
  bad "the tarball must carry core/.gitignore (no artifact: \$TGZ was empty)"
  bad "an install from the TARBALL must carry core/.gitignore downstream (no artifact: \$TGZ was empty)"
  bad "an install from the TARBALL must record .version (no artifact: \$TGZ was empty)"
  bad "build from an unpacked tarball must exit 66 (no artifact: \$TGZ was empty)"
  bad "build from an unpacked tarball must name scripts/scan-kit.sh (no artifact: \$TGZ was empty)"
  bad "build from an unpacked tarball must not blame the hostname scan (no artifact: \$TGZ was empty)"
  bad "npm i -g must install the CLI as a bin symlink (no artifact: \$TGZ was empty)"
  bad "an npm-global install must lay down the engine (no artifact: \$TGZ was empty)"
  bad "an npm-global install must land core/.gitignore (no artifact: \$TGZ was empty)"
  bad "the installed tree must not keep npm's renamed copy (no artifact: \$TGZ was empty)"
  bad "a consumer's repo must ignore the installed kit's core/.lock-state (no artifact: \$TGZ was empty)"
  bad "re-installing on the npm path must deliver a later version's rule (no artifact: \$TGZ was empty)"
  bad "a re-install must not leave npm's renamed copy behind (no artifact: \$TGZ was empty)"
fi

# --- build must report the cause it ACTUALLY hit ------------------------------
# npm's stderr was discarded and one guessed cause printed as fact. When the prepack
# scan IS the cause its own refusal — which names the file and line — must reach the
# operator; a guess that happens to be right is still a guess, and it was wrong for
# every other way npm pack can fail. The hostname is assembled at runtime for the
# same reason as the scan fixtures above: this file ships.
DRT="$(mktemp -d)"
cp -R "$KITSRC/." "$DRT/kit/" 2>/dev/null || { mkdir -p "$DRT/kit"; cp -R "$KITSRC/." "$DRT/kit/"; }
_h="$(printf '%s%s.%stzla.%s%s' 'ocpt' 'box' '' 'sahibinden' 'local.net')"
printf '\nsee %s\n' "$_h" >> "$DRT/kit/cross-harness.md"
DOUT="$( cd "$DRT/kit" && bash ./hektor-triage-kit build 2>&1 )"; DRC=$?
[ "$DRC" = 70 ] && ok || bad "build must exit 70 when npm pack writes no artifact, got $DRC"
case "$DOUT" in *REFUSING*) ok ;; *) bad "build must surface the prepack scan's own refusal, not a guessed cause: $(printf '%s' "$DOUT" | tail -1)" ;; esac
case "$DOUT" in *cross-harness.md*) ok ;; *) bad "build must name the file the scan refused, which only the scan's own output knows" ;; esac
[ -z "$(ls "$DRT/kit"/*.tgz 2>/dev/null)" ] && ok || bad "a refused pack must leave no artifact behind"
rm -rf "$DRT"

# build refuses from an INSTALLED kit, which has only SKILL.md and core/. The installed
# tree ships no hektor-triage-kit binary of its own — install.sh never copies one — so
# this plants a COPY of the CLI there and runs it from that location. HERE resolves from
# BASH_SOURCE, not from cwd: invoking the SOURCE binary by its absolute path while merely
# `cd`ing into the installed dir (as a first draft of this fixture did) leaves HERE
# pointing at the source, which still has package.json, and the guard never fires —
# verified by running exactly that and reading rc=0 back. Only a binary whose OWN
# directory lacks package.json exercises the check.
BINST="$(mktemp -d)"
( cd "$BINST" && git init -q . && bash "$BLD/kit/install.sh" --harness claude >/dev/null 2>&1 )
cp "$BLD/kit/hektor-triage-kit" "$BINST/.claude/skills/hektor-flaky-triage/hektor-triage-kit"
( cd "$BINST/.claude/skills/hektor-flaky-triage" && bash ./hektor-triage-kit build >/dev/null 2>&1 ); IRC=$?
[ "$IRC" = 66 ] && ok || bad "build from an installed kit must exit 66, got $IRC"
rm -rf "$BLD" "$BINST"

# --- the retired packager stays retired ---------------------------------------
[ ! -f "$KITSRC/scripts/package-kit.sh" ] \
  && ok || bad "scripts/package-kit.sh is retired; scan-kit.sh + npm pack replace it"
[ ! -f "$KITSRC/../flaky-triage-kit.zip" ] \
  && ok || bad "the zip is retired; two artifacts means one goes stale"
# ...and its replacement must not become the same problem. `build` writes the tarball
# into THIS tracked directory (npm pack writes where it runs, and README says to run it
# here), so `git add -A` after a build commits a 250 KB binary that goes stale — the
# exact dynamic retiring the zip was meant to end. git's own answer, not our reading:
( cd "$KITSRC" && git check-ignore -q "hektor-flaky-triage-1.0.0.tgz" ) \
  && ok || bad "built tarballs must be git-ignored — build writes them into the tracked kit directory"
# --exclude=install-guard-test.sh: this file's OWN assertion above necessarily names
# "package-kit.sh" to check for its absence — a self-match there is not a survivor.
grep -rqn "package-kit\.sh" "$KITSRC" --exclude-dir=.achilles --exclude=install-guard-test.sh 2>/dev/null \
  && bad "a doc or script still points at the retired packager" || ok

echo "install-guard-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
