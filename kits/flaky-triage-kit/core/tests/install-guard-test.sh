#!/bin/bash
# core/tests/install-guard-test.sh — install.sh must refuse to cp over a hardened kit instead of
# emitting a wall of EACCES, must tell the user how to harden a fresh install, and must clean up the
# pre-relocation in-tree gate when it upgrades an existing install.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KITSRC="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
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
GS="$P/.claude/skills/hektor-flaky-triage/core/gate-src/claude"
[ -f "$GS/flaky-kit-self-protection-gate.sh" ] && ok || bad "install must ship the claude gate restore source"
[ -x "$GS/flaky-kit-self-protection-gate.sh" ] && ok || bad "the restore source must stay executable"
[ -f "$GS/lib/audit.sh" ] && ok || bad "install must ship the audit lib beside the restore source"
# It must be the SAME file the gate was installed from, or a restore would install a different
# gate than the one the install registered.
cmp -s "$GS/flaky-kit-self-protection-gate.sh" "$P/.claude/hooks/flaky-kit-self-protection-gate.sh" \
  && ok || bad "the restore source must be byte-identical to the installed gate"

echo "install-guard-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
