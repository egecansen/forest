#!/bin/bash
# delivery-gate.sh — stop-hook that stops a session ENDING on a rationalization.
#
# Event   : stop
# Mode    : follow-up-once (default) — emits a followup_message on the first stop
#           that carries a rationalization. Cursor's own `loop_limit` in
#           hooks.json caps the repeat, and the gate additionally stands down
#           once `loop_count` is non-zero, so a false positive costs one extra
#           turn, never a loop.
# State   : none (reads the transcript's last assistant turn, read-only)
# Env     : HEKTOR_DELIVERY_GATE=off    advisory bypass (document the authorisation)
#
# Why
# ---
# Hektor's anti-shortcut invariants live as prose the agent is trusted to honour:
# "green-proof = pass^N", "never Thread.sleep to force green", "@ScheduledDisable
# needs a reason", "no third exit — don't scope-reduce Pass 1", "don't weaken an
# assert/locator to pass". This gate mechanises the last line of defence: the agent
# must not FINISH a session having rationalised away a red/flaky test. Port of ECC's
# delivery-gate quality-gate.py RATIONALIZE check (skills/delivery-gate/hooks/quality-gate.py:22-27),
# retargeted to Hektor's real rationalisations. The stale-memory half of ECC's hook
# is intentionally not ported (noisy for a QA session; the rationalisation grep is
# the load-bearing half).
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

[ "${HEKTOR_DELIVERY_GATE:-on}" = "off" ] && { hektor_audit "delivery-gate bypassed (HEKTOR_DELIVERY_GATE=off)"; exit 0; }
hektor_gate_init delivery-gate "standard,strict"   # human-nag gate: skipped under minimal/CI

# Only nag on a session that ran to completion — an aborted or errored stop has
# its own explanation and does not need this one.
STATUS="$(hektor_status)"
case "$STATUS" in ""|completed) ;; *) exit 0 ;; esac

# Loop guard: if this stop is already a re-trigger, let it through.
LOOPS="$(hektor_loop_count)"
case "$LOOPS" in ''|0) ;; *) exit 0 ;; esac

TRANSCRIPT="$(hektor_json '.transcript_path // empty')"
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

# Extract the LAST assistant turn's visible text (not thinking) — the "I'm done"
# message. Try a JSONL transcript first; fall back to a raw tail, which is what
# actually fires when the transcript is plain text.
LAST=$("$CC_JQ" -rs '
  [ .[]
    | select(.type=="assistant" or (.message.role? // "")=="assistant")
    | ((.message.content? // .content? // []) )
    | (if type=="array" then [ .[] | select(.type?=="text") | .text ] | join("\n")
       elif type=="string" then . else "" end) ]
  | map(select(. != "")) | (.[-1] // "")
' "$TRANSCRIPT" 2>/dev/null || echo "")
[ -n "$LAST" ] || LAST="$(tail -c 8000 "$TRANSCRIPT" 2>/dev/null || echo "")"
[ -n "$LAST" ] || exit 0

# Hektor-specific rationalisations (the phrases that precede a masked red/flaky test).
RE='skip(ping)? (the |those |remaining )?tests? (for now|and mov|until)'
RE="$RE"'|pre-?existing (failure|bug|issue|test|red|and unrelated)'
RE="$RE"'|(leaving|left|keep) (the |them )?(broken|failing|red) tests?'
RE="$RE"'|tests? .{0,15}failing but .{0,40}(later|move on|not related|unrelated)'
RE="$RE"'|(4/5|3/5|2/3|most) .{0,20}(runs?|passes) .{0,15}(fine|good enough|ok\b|acceptable)'
RE="$RE"'|good enough for now'
RE="$RE"'|Thread\.sleep'
RE="$RE"'|(disabl|quarantin)(e|ed|ing).{0,40}(to (get|make).{0,10}green|for now|so it passes)'
RE="$RE"'|(weaken|loosen|relax|soften)(ed|ing)? (the )?(assert|assertion|expectation|locator|selector|check)'
RE="$RE"'|(only ran|ran) (it )?once\b'
RE="$RE"'|(should (probably )?work|probably fine|i think (it )?works|likely fine)'
RE="$RE"'|scope-?reduc|given (the )?session length|pragmatic pass 1 only|no third exit'

HIT=$(printf '%s' "$LAST" | grep -ioE "$RE" 2>/dev/null | sort -u | head -4 | sed 's/^/  • /')
[ -n "$HIT" ] || exit 0

REASON="[Hektor delivery-gate] This session looks like it's ending on a rationalisation. Phrase(s) detected in the final message:
$HIT

Before finishing, confirm you did NOT:
  · skip / disable / quarantine a test to go green (green-proof = pass^N, confidence==1.0)
  · leave a pre-existing red as 'not mine' without flagging it
  · weaken an assertion / loosen a locator to pass
  · Thread.sleep to force timing green
  · scope-reduce a required pass ('no third exit')
  · use @ScheduledDisable without a reason

If the work is genuinely clean and this is a false positive, say so explicitly and finish again — this gate fires only once per stop. If not, fix it first.

Bypass (authorised): HEKTOR_DELIVERY_GATE=off."

hektor_followup "$REASON"
exit 0
