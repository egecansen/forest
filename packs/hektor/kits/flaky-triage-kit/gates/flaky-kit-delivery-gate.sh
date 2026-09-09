#!/bin/bash
# flaky-kit-delivery-gate.sh — stop hook: refuse a session that ends unproven.
#
# Event : stop
# State : none (reads the transcript, read-only)
#
# The kit's own job is refusing a red test rationalised away, and until now that job rested on two
# controls the kit only ASKED for. kernel.md states I11 as an invariant and core/ledger.sh calls
# `validate --final` "the machine gate: no session ends with selected/applied clusters" — and nothing
# called it. core/hedge-scan.sh performs its detection and SKILL.md asks the agent to pipe through it.
# This hook makes both of them run.
#
# The two halves fire differently ON PURPOSE. I11 is a property: a cluster is in a terminal state or
# it is not, and the remedy is in the agent's hands — `ledger.sh cluster-state <id> green|flagged|
# deferred` is exactly the work we want. So it fires on every stop, with no loop-count escape and
# no environment bypass. The pack's delivery-gate.sh ships HEKTOR_DELIVERY_GATE=off; this kit does
# not, because it removed environment overrides from core/_integrity.sh on the finding that a variable
# the SUBJECT of a check can set is a skeleton key, and a stop hook runs in the agent's own
# environment at the moment it is being checked.
#
# The hedge half matches phrasing, so it can be wrong. It fires once: a false positive costs one turn.
#
# Fail open, never wedge, and never silently. A missing jq, an unreadable transcript, an engine this
# gate cannot reach, a `validate --final` that exits anything but 0 or 67 — each exits 0 and leaves one
# audit line. A check that could not run is not a verdict, and a silent pass there is indistinguishable
# from a clean ledger, which is exactly the distinction a reader needs when a session ends that should
# not have.
set -uo pipefail

# Builtins only — no `dirname`. Everything this gate can do hangs off $_DIR (the audit lib AND the
# engine), so a PATH without coreutils would leave $_DIR empty, silently disable hektor_audit, and
# turn every "fail open and SAY so" path back into a quiet exit 0. Found while covering the missing-jq
# case: a degraded PATH is exactly the environment where that guarantee has to hold.
case "${BASH_SOURCE[0]}" in
  */*) _DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)" ;;
  *)   _DIR="$(pwd)" ;;
esac

# --- where the audit log and the engine live ----------------------------------------------------
# Both are resolved RELATIVE TO THIS SCRIPT, and from nothing else. Two layouts are real:
#
#   installed    <proj>/.cursor/hooks/                             (install.sh copies the gate here)
#                <proj>/.cursor/skills/hektor-flaky-triage/core/   (and the engine here)
#   source tree  kits/flaky-triage-kit/gates/                      (this file, in the repo)
#                kits/flaky-triage-kit/core/                       (the engine, in the repo)
#
# so `$_DIR/../skills/hektor-flaky-triage/core` and `$_DIR/../core` cover both, and the first that
# actually holds the two engines wins. The same two-layout split governs the audit lib: installed it
# is vendored to lib/audit.sh beside the gate, in the source tree it is gates/lib/audit.sh.
#
# The self-protection gate anchors its own lookup on the reported workspace root — correct there,
# because it hunts for the PROJECT'S kit tree to judge whether it was swapped out, and that tree
# bears no relation to the gate's own location. This gate wants its OWN engine, and its own
# location is the better anchor: the harness invokes it by path, so $BASH_SOURCE is not something the
# session can redirect, whereas an environment-anchored fallback would let the subject of the check
# choose which ledger.sh judges it — the same skeleton-key shape this kit removed from
# core/_integrity.sh. Nothing found means fail open with an audit line, never a block: a gate that
# cannot reach the engine cannot tell a finished session from an unfinished one, and blocking there
# wedges every stop in the project.
if   [ -f "$_DIR/lib/audit.sh" ];     then . "$_DIR/lib/audit.sh"
else hektor_audit() { :; }; fi

CORE=""
for _c in "$_DIR/../skills/hektor-flaky-triage/core" "$_DIR/../core"; do
  if [ -r "$_c/ledger.sh" ] && [ -r "$_c/hedge-scan.sh" ]; then CORE="$_c"; break; fi
done

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || { hektor_audit "delivery-gate: no jq, failing open"; exit 0; }

INPUT="$(head -c 1048576)"
[ -n "$INPUT" ] || { hektor_audit "delivery-gate: empty stdin, failing open"; exit 0; }

TRANSCRIPT="$(printf '%s' "$INPUT" | "$JQ" -r '.transcript_path // empty' 2>/dev/null || true)"
[ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ] || { hektor_audit "delivery-gate: no readable transcript, failing open"; exit 0; }
# Cursor reports how many times this stop has already been re-triggered, and hooks.json caps the
# repeat with loop_limit besides. Non-zero means "we already nudged" — the hedge half stands down.
LOOPS="$(printf '%s' "$INPUT" | "$JQ" -r '.loop_count // 0' 2>/dev/null || echo 0)"
case "$LOOPS" in ''|0) ACTIVE=false ;; *) ACTIVE=true ;; esac

# Every shell command the session ran, one per line.
#
# Parsed line by line with `fromjson?` rather than slurped with -s, and the reason is the difference
# between a gate and a decoration. A JSONL transcript being appended to LIVE normally ends mid-record,
# and `jq -s` rejects the whole file for that one truncated tail — so the strict form loses every
# command the session ran, `KIT_USED` falls to 0, and the gate exits saying nothing. That silence is
# indistinguishable from "the kit was never used", which is the exact state this file's header
# forbids, and a partial trailing line is the COMMON case, not an exotic one. Unparseable lines are
# dropped and counted; the session is judged on the records that did parse.
#
# The count rides on the first output line so this stays one pass over the transcript. `|| true` is
# deliberately absent: jq's exit status is the only signal that the read itself failed, and swallowing
# it is what turned this whole gate into a silent no-op.
RAW="$("$JQ" -Rrs '
  [ split("\n")[] | select(length > 0) ] as $lines
  | [ $lines[] | (fromjson? // empty) ] as $docs
  | "\($lines | length) \($docs | length)",
    ( $docs[] | (.message.content? // .content? // []) | if type=="array" then .[] else empty end
              | select(.type?=="tool_use") | (.input.command? // "") )
' "$TRANSCRIPT" 2>/dev/null)"; JQ_RC=$?
[ "$JQ_RC" -eq 0 ] || { hektor_audit "delivery-gate: could not read the transcript $TRANSCRIPT (jq exited $JQ_RC), failing open"; exit 0; }

COUNTS="$(printf '%s\n' "$RAW" | head -1)"
CMDS="$(printf '%s\n' "$RAW" | tail -n +2)"
LINES="${COUNTS%% *}"; DOCS="${COUNTS##* }"
[ "${DOCS:-0}" -gt 0 ] 2>/dev/null \
  || { hektor_audit "delivery-gate: nothing in the transcript $TRANSCRIPT parsed as JSON ($LINES lines read), failing open"; exit 0; }
[ "$DOCS" = "$LINES" ] \
  || hektor_audit "delivery-gate: $((LINES - DOCS)) of $LINES transcript lines did not parse (a transcript still being written ends mid-record); judging this session on the $DOCS that did"

# Did the session run the kit at all, and did it CHANGE anything? apply/rerun is where a session
# stops reading and starts changing things, and it is the point a ledger is owed.
KIT_USED=0; CHANGED=0
case "$CMDS" in *core/ingest*|*core/cluster*|*core/triage*|*core/apply*|*core/rerun*|*core/gate*|*core/ledger*) KIT_USED=1 ;; esac
case "$CMDS" in *core/apply*|*core/rerun*) CHANGED=1 ;; esac
[ "$KIT_USED" = 1 ] || exit 0            # the kit was not in play; a warning here is noise

# The engine is needed from here on, and only from here on — checked at the point of use rather than
# at resolution so a project whose kit tree has gone missing logs on the stops this gate would have
# had something to say about, not on every unrelated one.
[ -n "$CORE" ] || { hektor_audit "delivery-gate: engine not found near $_DIR (no ledger.sh + hedge-scan.sh under ../skills/hektor-flaky-triage/core or ../core), failing open"; exit 0; }

# Cursor's stop verdict is a follow-up turn, not a veto — by the time this fires there is nothing
# left to veto. followup_message puts the finding in front of the agent and makes it work again.
block() { "$JQ" -n --arg r "$1" '{followup_message:$r}'; exit 0; }

# --- I11 -----------------------------------------------------------------------------------------
# The ledger's path is whatever the caller passed, and the kit imposes no convention — so it is read
# out of the transcript, the one artifact the agent does not write. Anchor on the `core/ledger` token
# and take the argument two fields along (`ledger.sh <subcommand> <file>`), which survives a `cd … &&`
# prefix and a line that invokes the ledger more than once; strip surrounding quotes, because a quoted
# path this gate fails to resolve is indistinguishable from no ledger at all, and that turns a
# finished session into a false block — the costliest way for this gate to be wrong.
LEDGERS="$(printf '%s\n' "$CMDS" \
  | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /core\/ledger/) print $(i + 2) }' \
  | tr -d "\"'" | grep -v '^$' | sort -u)"
LEDGER_NAMED=0
case "$CMDS" in *core/ledger*) LEDGER_NAMED=1 ;; esac
OPEN=""
FOUND_LEDGER=0
while IFS= read -r L; do
  # -f as well as -r: a path split on a space can land on a DIRECTORY, and a directory is readable.
  [ -n "$L" ] && [ -f "$L" ] && [ -r "$L" ] || continue
  FOUND_LEDGER=1
  MSG="$(bash "$CORE/ledger.sh" validate "$L" --final 2>&1)"; RC=$?
  case "$RC" in
    0)  : ;;                                   # final: no selected/applied cluster left
    67) # I11's own exit — the one that blocks. ledger.sh writes its integrity notice to the same
        # stream as its verdict, and that notice ends in a sudo command; the reason below is read by
        # the agent as instruction, so it carries the verdict line and nothing else.
        DETAIL="$(printf '%s\n' "$MSG" | grep -F 'NOT FINAL' | head -1)"
        [ -n "$DETAIL" ] || DETAIL="$(printf '%s\n' "$MSG" | tail -1)"
        OPEN="$OPEN
$L — $DETAIL" ;;
    *)  # Anything else is the CHECK failing, not the run failing. `ledger.sh` exits 75 on a lock
        # timeout and 65 on a malformed ledger, and neither tells us a cluster is open. Fail open —
        # but say so, because a silent pass here is indistinguishable from a clean ledger, and the
        # difference is exactly what a reader needs when a session ends that should not have.
        hektor_audit "delivery-gate: validate --final on $L exited $RC, not a verdict — failing open" ;;
  esac
done <<EOF
$LEDGERS
EOF

if [ -n "$OPEN" ]; then
  hektor_audit "delivery-gate: blocked on I11"
  block "[flaky-kit delivery-gate] This session is ending with work the ledger still calls unfinished.
$OPEN

I11: a session may not end while any cluster is selected or applied. Move each one to a terminal
state that reflects what you actually proved — green (with the passes and runs that prove it),
flagged, or deferred — then finish again. This gate does not block once and let go: it blocks until
the ledger says the work is done."
fi

if [ "$FOUND_LEDGER" = 0 ] && [ "$CHANGED" = 1 ] && [ "$LEDGER_NAMED" = 1 ]; then
  # The session DID name core/ledger; this gate just could not turn the words into a readable file —
  # a path with a space in it, most likely, since the extraction above splits on whitespace, or a
  # ledger since moved. Firing here would be unanswerable: the I11 half has no loop-count
  # escape and no bypass, so following this gate's own remedy — re-run core/ledger.sh with that same
  # path — reproduces the identical finding, and the session loops with no way out. A check that cannot
  # run is not a verdict, so it fails open and says so, the same rule as a non-verdict exit above.
  hektor_audit "delivery-gate: the session named core/ledger but no readable ledger file could be resolved from the transcript (a path containing spaces, or a file since moved) — not blocking on 'no ledger', failing open"
elif [ "$FOUND_LEDGER" = 0 ] && [ "$CHANGED" = 1 ]; then
  hektor_audit "delivery-gate: blocked, no ledger for a run that changed things"
  block "[flaky-kit delivery-gate] This session ran core/apply or core/rerun and left no ledger.

I11 is the machine gate for 'the work is done', and a run with no state cannot satisfy it. Record the
run with core/ledger.sh and move every cluster to a terminal state, then finish again."
fi

# --- the hedge half: blocks ONCE ----------------------------------------------------------------
[ "$ACTIVE" = "true" ] && exit 0

# Same tolerant read, and re-read rather than reused: the transcript is being written while this runs,
# so the file can have grown (or gained a truncated tail) since the pass above.
LAST="$("$JQ" -Rrs '
  [ split("\n")[] | select(length > 0) | (fromjson? // empty) ]
  | [ .[] | select(.type=="assistant" or (.message.role? // "")=="assistant")
      | ((.message.content? // .content? // []))
      | if type=="array" then ([ .[] | select(.type?=="text") | .text ] | join("\n"))
        elif type=="string" then . else "" end ]
  | map(select(. != "")) | (.[-1] // "")' "$TRANSCRIPT" 2>/dev/null)"; JQ_RC=$?
[ "$JQ_RC" -eq 0 ] \
  || { hektor_audit "delivery-gate: could not re-read the transcript $TRANSCRIPT for the final message (jq exited $JQ_RC), failing open"; exit 0; }
[ -n "$LAST" ] || exit 0

HIT="$(printf '%s' "$LAST" | bash "$CORE/hedge-scan.sh" 2>/dev/null)" && exit 0
[ -n "$HIT" ] || exit 0
hektor_audit "delivery-gate: blocked on a hedged final message"
block "[flaky-kit delivery-gate] Your own summary says you are not sure:

$HIT

One green run is not proof — a flake passes about half the time, so a single green is the most likely
false 'fixed'. Get the proof (core/rerun … | core/gate, and treat only decision:\"accepted\" as green)
or say plainly what is still unproven. This half blocks once: if the wording was a false alarm, finish
again and it will let you through."
