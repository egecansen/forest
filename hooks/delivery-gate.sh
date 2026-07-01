#!/bin/bash
# delivery-gate.sh — Stop-hook that blocks a session from ENDING on a rationalization.
#
# Hook    : Stop
# Mode    : block-once (default) — decision:block on the first stop that carries a
#           rationalization; the re-triggered stop (stop_hook_active=true) is allowed,
#           so a false positive costs one extra turn, never a loop.
# State   : none (reads the transcript's last assistant turn, read-only)
# Env     : HEKTOR_DELIVERY_GATE=off    advisory bypass (document the authorisation)
#           HEKTOR_DELIVERY_GATE=warn   surface as systemMessage instead of blocking
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
if [ -f "$_DIR/lib/audit.sh" ]; then . "$_DIR/lib/audit.sh"; else hektor_audit() { :; }; fi
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }

MODE="${HEKTOR_DELIVERY_GATE:-block}"
[ "$MODE" = "off" ] && { hektor_audit "delivery-gate bypassed (HEKTOR_DELIVERY_GATE=off)"; exit 0; }
hektor_hook_enabled delivery-gate "standard,strict" || exit 0   # human-nag gate: skipped under minimal/CI

JQ="$(command -v jq || true)"; [ -n "$JQ" ] || exit 0   # jq absent -> fail-open

INPUT=$(head -c 1048576)   # fail-open stdin hardening: cap at 1 MB
[ -n "$INPUT" ] || exit 0

# Loop guard: if we already nudged on this stop, let it through.
ACTIVE=$(printf '%s' "$INPUT" | "$JQ" -r '.stop_hook_active // false' 2>/dev/null || echo false)
[ "$ACTIVE" = "true" ] && exit 0

TRANSCRIPT=$(printf '%s' "$INPUT" | "$JQ" -r '.transcript_path // empty' 2>/dev/null || echo "")
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

# Extract the LAST assistant turn's visible text (not thinking) — the "I'm done" message.
LAST=$("$JQ" -rs '
  [ .[]
    | select(.type=="assistant" or (.message.role? // "")=="assistant")
    | ((.message.content? // .content? // []) )
    | (if type=="array" then [ .[] | select(.type?=="text") | .text ] | join("\n")
       elif type=="string" then . else "" end) ]
  | map(select(. != "")) | (.[-1] // "")
' "$TRANSCRIPT" 2>/dev/null || echo "")
# Fallback if the transcript schema didn't parse.
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

If the work is genuinely clean and this is a false positive, say so explicitly and finish again — this gate blocks only once per stop. If not, fix it first.

Bypass (authorised): HEKTOR_DELIVERY_GATE=off. Soften to a warning: HEKTOR_DELIVERY_GATE=warn."

if [ "$MODE" = "warn" ]; then
  "$JQ" -n --arg m "$REASON" '{ "systemMessage": $m, "suppressOutput": false }'
else
  "$JQ" -n --arg r "$REASON" '{ "decision": "block", "reason": $r }'
fi
exit 0
