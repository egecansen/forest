#!/bin/bash
# core/tests/delivery-gate-test.sh — the Stop hook that refuses a session ending on an unproven fix.
#
# Two halves, blocking differently on purpose, so the suite is written in two registers:
#   I11        — a property. Blocks EVERY stop, no stop_hook_active escape, no environment bypass.
#   hedge-scan — phrasing. Blocks ONCE; a false positive costs one turn.
#
# Two shapes of assertion need care here, because both can pass for the wrong reason:
#   - "must stay silent" passes when the gate does nothing at all, so the suite refuses to run
#     unless the file under test is present (first assertion), and the mutations in the task brief
#     are what prove each silence is a decision rather than an absence.
#   - "fails open" passes when a check silently vanishes. A check that cannot run is not a verdict,
#     so every fail-open path is asserted to leave an audit line naming what could not run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# core/tests -> core -> the kit root. Two levels, not one: the sibling suites bind `$HERE/..` to
# core/ and stop there, and borrowing that shape for a path that has to reach adapters/ puts the
# gate at core/adapters/, where it is simply absent — and an absent gate prints nothing, which is
# what half the assertions below are checking for.
KIT="$(cd "$HERE/../.." && pwd)"
GATE="$KIT/adapters/claude/flaky-kit-delivery-gate.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

WORK="$(mktemp -d)"
# The audit log is flagged append-only where the OS supports it, which also blocks its removal —
# clear the flag before rm, or the fixture outlives the run.
trap 'chflags -R nouappend "$WORK" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# --- the subject must be here -------------------------------------------------------------------
# Every "must stay silent" assertion below passes when the gate is absent, because a gate that never
# runs prints nothing either. Refuse to report on a suite that never loaded its subject.
if [ -r "$GATE" ]; then ok; else
  bad "the gate is missing at $GATE — every silence assertion below would pass vacuously"
  echo "delivery-gate-test: $pass passed, $fail failed"
  exit 1
fi

# A transcript is JSONL; the gate reads the LAST assistant text turn and every shell command.
tx() {  # tx <file> <assistant-text> [<bash-command> ...]
  local f="$1" txt="$2"; shift 2
  : > "$f"
  local c
  for c in "$@"; do
    jq -cn --arg c "$c" '{type:"assistant",message:{role:"assistant",content:[{type:"tool_use",name:"Bash",input:{command:$c}}]}}' >> "$f"
  done
  jq -cn --arg t "$txt" '{type:"assistant",message:{role:"assistant",content:[{type:"text",text:$t}]}}' >> "$f"
}

# The gate is always driven from a chosen cwd, never from this suite's own. hektor_audit appends to
# docs/hektor/.hook-audit.log under the git toplevel of the CALLER's cwd, so a gate run from inside
# the checkout writes into the checkout — a hundred lines of test traffic in the repo's real audit
# trail, in the one file a reader consults to find out what a gate actually did.
run_in() {  # run_in <gate> <cwd> <transcript> [stop_hook_active]
  ( cd "$2" && jq -cn --arg t "$3" --argjson a "${4:-false}" \
      '{transcript_path:$t, stop_hook_active:$a}' | bash "$1" 2>/dev/null )
}
audit_home() {  # audit_home <name> -> a scratch git repo whose docs/hektor/ the gate will write to
  local d="$WORK/audit-$1"
  mkdir -p "$d" && git -C "$d" init -q >/dev/null 2>&1
  printf '%s' "$d"
}
audit_log() { cat "$1/docs/hektor/.hook-audit.log" 2>/dev/null; }
MAIN_HOME="$(audit_home main)"           # the scratch repo the unremarkable runs below write into
run() {  # run <transcript> [stop_hook_active] -> stdout of the gate
  run_in "$GATE" "$MAIN_HOME" "$1" "${2:-false}"
}
blocked() { case "$1" in *'"block"'*) return 0 ;; *) return 1 ;; esac; }

# --- no kit invocation at all: silent. The kit runs standalone; a warning here is noise. --------
tx "$WORK/t1" "All done."
[ -z "$(run "$WORK/t1")" ] && ok || bad "a session that never touched the kit must pass silently"

# ... and that silence covers the hedge half too: the gate speaks about work the kit did, and a
# session it was never part of is none of its business however the author phrased it.
tx "$WORK/t1b" "It should probably work, I only ran it once."
[ -z "$(run "$WORK/t1b")" ] && ok || bad "a hedged summary with no kit usage must still pass silently"

# --- read-only exploration owes no state -------------------------------------------------------
tx "$WORK/t2" "Here is the report." "$KIT/core/ingest.sh /tmp/x" "$KIT/core/cluster.sh /tmp/x"
[ -z "$(run "$WORK/t2")" ] && ok || bad "ingest/cluster alone must not require a ledger"

# --- apply/rerun with NO ledger path anywhere: the work left no record --------------------------
tx "$WORK/t3" "Fixed it." "$KIT/core/apply.sh cluster-3"
blocked "$(run "$WORK/t3")" && ok || bad "apply with no ledger must block — the run left no record"
case "$(run "$WORK/t3")" in *"no ledger"*) ok ;; *) bad "the no-ledger block must say what is missing" ;; esac

# --- a ledger with an open cluster: I11 -------------------------------------------------------
L="$WORK/led.json"
jq -n '{clusters:[{id:"c1",status:"applied",title:"t"}],events:[]}' > "$L"
tx "$WORK/t4" "Done." "$KIT/core/apply.sh c1" "$KIT/core/ledger.sh cluster-state $L c1 applied"
blocked "$(run "$WORK/t4")" && ok || bad "an open selected/applied cluster must block"
case "$(run "$WORK/t4")" in *c1*) ok ;; *) bad "the I11 block must name the open cluster" ;; esac

# `selected` is the other half of I11's own wording, and it is the state a session is likeliest to
# end in — a cluster picked and then abandoned. Asserting only `applied` would leave the more
# common abandonment untested.
jq -n '{clusters:[{id:"c9",status:"selected",title:"t"}],events:[]}' > "$WORK/sel.json"
tx "$WORK/t4s" "Done." "$KIT/core/apply.sh c9" "$KIT/core/ledger.sh cluster-state $WORK/sel.json c9 selected"
blocked "$(run "$WORK/t4s")" && ok || bad "a selected cluster must block as surely as an applied one"

# --- the hard block has NO stop_hook_active escape --------------------------------------------
blocked "$(run "$WORK/t4" true)" && ok || bad "I11 must block even on a re-triggered stop"

# --- a block is a VERDICT on stdout, not a failure ---------------------------------------------
# The harness reads the decision object from stdout of a hook that exited 0; a non-zero exit is how
# a hook reports its own breakage, and would be a different event entirely.
OUT="$(run "$WORK/t4")"; RC=$?
[ "$RC" -eq 0 ] && ok || bad "a block must be delivered by exit 0 with a decision object, not by a non-zero exit (got $RC)"
printf '%s' "$OUT" | jq -se 'length==1 and (.[0]|type)=="object" and (.[0]|keys)==["decision","reason"] and .[0].decision=="block"' >/dev/null 2>&1 \
  && ok || bad "stdout must carry exactly one {decision,reason} object and nothing else"

# The reason is read by the agent as instruction. ledger.sh writes its unrelated integrity notice to
# the same stream as its verdict, and that notice ends in 'core/lock-kit.sh lock (needs sudo)' — a
# command that stops for a password nobody is there to type. The block must carry the verdict only.
case "$OUT" in *lock-kit*) bad "the I11 reason must not carry the engine's unrelated integrity notice" ;; *) ok ;; esac

# --- a check that cannot run is not a verdict: fail open, and SAY so ---------------------------
# `ledger.sh` exits 67 for I11 and 75 for a lock timeout; only 67 means a cluster is open. Treating
# every non-zero as "open" would block on a transient lock, and treating every non-67 as "clean"
# silently passes a session whose state nobody could read.
jq -n '{clusters:"not-an-array",events:[]}' > "$WORK/bad.json"
tx "$WORK/t4b" "Done." "$KIT/core/apply.sh c1" "$KIT/core/ledger.sh cluster-state $WORK/bad.json c1 applied"
[ -z "$(run "$WORK/t4b")" ] && ok || bad "a ledger the checker cannot read must fail open, not block"
A_LEDGER="$(audit_home ledger)"
[ -z "$(run_in "$GATE" "$A_LEDGER" "$WORK/t4b")" ] && ok || bad "the unreadable-ledger fail-open must stay silent on stdout"
case "$(audit_log "$A_LEDGER")" in *"not a verdict"*) ok ;; *) bad "a validate --final that could not reach a verdict must leave an audit line — a silent pass there reads exactly like a clean ledger" ;; esac

# --- closing the cluster clears it -------------------------------------------------------------
jq -n '{clusters:[{id:"c1",status:"green",title:"t",passes:5,runs:5}],events:[]}' > "$L"
[ -z "$(run "$WORK/t4")" ] && ok || bad "a terminal cluster must let the session end"

# --- the ledger path is read out of the transcript, quotes and all -----------------------------
# Agents quote their paths. A quoted path the gate cannot resolve looks exactly like no ledger at
# all, which turns a finished session into a false block — the costliest way for this gate to fail.
tx "$WORK/t4q" "Done." "$KIT/core/apply.sh c1" "\"$KIT/core/ledger.sh\" cluster-state \"$L\" c1 green"
[ -z "$(run "$WORK/t4q")" ] && ok || bad "a quoted ledger path must be found, not read as a missing ledger"

# --- a ledger path with a space in it: fail open, never an inescapable block --------------------
# The extraction splits on whitespace, so this path cannot be recovered. What matters is which way it
# fails. Blocking would be UNANSWERABLE: the I11 half has no stop_hook_active escape and no bypass, so
# following the block's own remedy — re-run core/ledger.sh with that path — reproduces the identical
# block and the session loops with no way out. `mktemp -d` never contains a space, which is precisely
# why no other fixture here can catch this.
SPACED="$WORK/a dir with spaces"; mkdir -p "$SPACED"
jq -n '{clusters:[{id:"c1",status:"green",title:"t",passes:5,runs:5}],events:[]}' > "$SPACED/led.json"
A_SPACE="$(audit_home space)"
tx "$WORK/t4sp" "Done." "$KIT/core/apply.sh c1" "$KIT/core/ledger.sh cluster-state $SPACED/led.json c1 green"
[ -z "$(run_in "$GATE" "$A_SPACE" "$WORK/t4sp")" ] \
  && ok || bad "a ledger path containing a space must not produce a block the session cannot answer"
case "$(audit_log "$A_SPACE")" in *"no readable ledger file could be resolved"*) ok ;; *) bad "the unresolvable-ledger fail-open must say so — it is the difference between 'clean' and 'could not tell'" ;; esac

# The same path quoted, which is how an agent is likeliest to write it, must fail open too and not
# fall through to a block by a different route.
A_SPACEQ="$(audit_home spaceq)"
tx "$WORK/t4spq" "Done." "$KIT/core/apply.sh c1" "$KIT/core/ledger.sh cluster-state \"$SPACED/led.json\" c1 green"
[ -z "$(run_in "$GATE" "$A_SPACEQ" "$WORK/t4spq")" ] \
  && ok || bad "a quoted ledger path containing a space must not produce an unanswerable block either"

# --- the hedge half: blocks once ---------------------------------------------------------------
tx "$WORK/t5" "It should probably work, I only ran it once." "$KIT/core/apply.sh c1" "$KIT/core/ledger.sh cluster-state $L c1 green"
blocked "$(run "$WORK/t5")" && ok || bad "a hedged final message must block"
[ -z "$(run "$WORK/t5" true)" ] && ok || bad "the hedge half must block ONCE — the re-triggered stop passes"

# --- a confident message with a closed ledger passes -------------------------------------------
tx "$WORK/t6" "Cluster c1 is green: 5/5 passes, verified by core/gate." "$KIT/core/apply.sh c1" "$KIT/core/ledger.sh cluster-state $L c1 green"
[ -z "$(run "$WORK/t6")" ] && ok || bad "a proven, unhedged summary must pass"

# --- hedge-scan says nothing when it finds nothing ---------------------------------------------
# The gate's `… | hedge-scan.sh` && exit 0` is an EQUIVALENT mutant — deleting it changes no
# observable behaviour, because the next line exits on an empty $HIT anyway. That equivalence is a
# property of hedge-scan.sh (it writes to stdout only on the branch that exits 2), not of the gate,
# and nothing coupled the two until here. If hedge-scan ever starts printing on a clean scan, the
# gate would block a proven summary on empty-looking evidence, and this is the assertion that says so.
HS_OUT="$(printf '%s' "Cluster c1 is green: 5/5 passes, verified by core/gate." | bash "$KIT/core/hedge-scan.sh" 2>/dev/null)"; HS_RC=$?
{ [ "$HS_RC" -eq 0 ] && [ -z "$HS_OUT" ]; } \
  && ok || bad "a clean hedge-scan must exit 0 AND print nothing (rc=$HS_RC, out='$HS_OUT') — the gate's clean-scan exit is only redundant while this holds"

# --- fail open: no transcript, unreadable transcript, no jq ------------------------------------
[ -z "$(run_in "$GATE" "$MAIN_HOME" /nonexistent/x)" ] && ok || bad "a missing transcript must fail open"
[ -z "$( cd "$MAIN_HOME" && printf '' | bash "$GATE" 2>/dev/null )" ] && ok || bad "empty stdin must fail open"
A_TX="$(audit_home transcript)"
run_in "$GATE" "$A_TX" /nonexistent/x >/dev/null 2>&1
case "$(audit_log "$A_TX")" in *"no readable transcript"*) ok ;; *) bad "an unreadable transcript must leave an audit line — the gate read nothing, and that is not the same as reading a clean session" ;; esac

# --- a transcript with a truncated trailing record: the COMMON case ----------------------------
# A JSONL transcript being appended to live normally ends mid-record. Slurping it (`jq -s`) rejects
# the whole file for that one tail, which empties the command list, which reads as "the kit was never
# used" — the gate disables itself on the ordinary case while still exiting 0 and looking healthy.
# The session below is the same one that blocks on I11 above, so anything other than a block here
# means the truncated tail silently switched the gate off.
cp "$WORK/t4" "$WORK/t4trunc"
jq -n '{clusters:[{id:"c1",status:"applied",title:"t"}],events:[]}' > "$L"   # reopen c1
printf '{"type":"assistant","message":{"role":"assist' >> "$WORK/t4trunc"
A_TRUNC="$(audit_home truncated)"
blocked "$(run_in "$GATE" "$A_TRUNC" "$WORK/t4trunc")" \
  && ok || bad "a truncated trailing record must not disable the gate — the parsed records still carry the session"
case "$(audit_log "$A_TRUNC")" in *"did not parse"*) ok ;; *) bad "dropping transcript lines must be audited — the verdict was reached on less than the whole session" ;; esac

# --- a transcript nothing can be read from: fail open, and SAY so ------------------------------
printf 'not json at all\n{"also": not json\n' > "$WORK/tjunk"
A_JUNK="$(audit_home junk)"
[ -z "$(run_in "$GATE" "$A_JUNK" "$WORK/tjunk")" ] \
  && ok || bad "a transcript with no parseable record must fail open"
case "$(audit_log "$A_JUNK")" in *"parsed as JSON"*) ok ;; *) bad "a transcript nothing parsed from must leave an audit line — silence there is indistinguishable from a clean session" ;; esac

# --- no jq: the gate cannot do anything, and must say that rather than pass quietly ------------
# jq lives in /usr/bin on this box, so trimming PATH is not enough; the shim holds everything
# hektor_audit needs to keep working (that is the point — the audit line must still land) and no jq.
NOJQ="$WORK/nojq-bin"; mkdir -p "$NOJQ"
for _b in bash sed git mkdir date basename uname cat chflags chattr; do
  _p="$(command -v "$_b" 2>/dev/null)" && ln -sf "$_p" "$NOJQ/$_b"
done
A_NOJQ="$(audit_home nojq)"
NOJQ_OUT="$( cd "$A_NOJQ" && printf '{"transcript_path":"%s","stop_hook_active":false}' "$WORK/t4" \
             | PATH="$NOJQ" bash "$GATE" 2>/dev/null )"
[ -z "$NOJQ_OUT" ] && ok || bad "a gate with no jq must fail open, not emit a half-built verdict"
case "$(audit_log "$A_NOJQ")" in *"no jq"*) ok ;; *) bad "a gate with no jq must leave an audit line — it decided nothing, and that must not read as a clean session" ;; esac

# --- the engine it checks against may be missing: fail open, and SAY so ------------------------
# The gate ships to <proj>/.claude/hooks/ and the engine to <proj>/.claude/skills/hektor-flaky-
# triage/core/. Rename the kit tree aside and the gate is still registered but has nothing to ask.
# Blocking there would wedge every stop in the project; passing silently would look like a clean
# session forever after.
# Laid out as a real install with the kit tree removed, and nested deeply enough that BOTH paths the
# gate probes land inside this fixture — a shallower copy would send `../../core` outside $WORK, and
# the assertion would then depend on what happens to sit next to the temp directory.
LONE="$WORK/lonely/.claude/hooks"; mkdir -p "$LONE/lib"
cp "$GATE" "$LONE/flaky-kit-delivery-gate.sh"
cp "$KIT/adapters/_lib/audit.sh" "$LONE/lib/audit.sh"
A_ENG="$(audit_home engine)"
[ -z "$(run_in "$LONE/flaky-kit-delivery-gate.sh" "$A_ENG" "$WORK/t4")" ] \
  && ok || bad "a gate that cannot find its engine must fail open, not block"
case "$(audit_log "$A_ENG")" in *"engine not found"*) ok ;; *) bad "a gate that cannot find its engine must leave an audit line" ;; esac

# --- nothing may reach stdout except the verdict JSON ------------------------------------------
OUT="$(run "$WORK/t1")"
[ -z "$OUT" ] && ok || bad "an allow must print nothing at all on stdout"

# --- no environment override may enter the gate ------------------------------------------------
# HEKTOR* is the bypass the pack ships and this kit ruled out. CLAUDE_PROJECT_DIR is the other half:
# the sibling self-protection gate anchors on it legitimately (it hunts the PROJECT'S kit tree), but
# this gate resolves its OWN engine, and anchoring that on an environment variable would let the
# subject of the check choose which ledger.sh judges it. Both belong in the same alternation, or the
# decision to anchor solely on $BASH_SOURCE could be reverted with nothing noticing.
grep -v '^[[:space:]]*#' "$GATE" | grep -qE '(^|[^\\])\$\{?(HEKTOR[A-Z_]*|CLAUDE_PROJECT_DIR)' \
  && bad "the delivery gate must carry no environment bypass and no environment-anchored engine lookup" || ok

echo "delivery-gate-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
