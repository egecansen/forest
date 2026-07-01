#!/bin/bash
# subagent-return-schema-guard.sh — validates a subagent's return against its
#                                   role schema (required keys + top-level enums).
#
# Hook    : PostToolUse:Agent
# Mode    : WARN (PostToolUse can't reverse a return; surface a systemMessage.
#                 Achilles ships this as WARN initially too, pending false-
#                 positive calibration before any flip to DENY.)
# State   : reads .claude/schemas/subagent-returns/<role>.schema.json (read-only)
# Env     : none
#
# What it checks (jq-driven, dependency-free)
# -------------------------------------------
# - Every `required` top-level key in the schema is present in the YAML return.
# - Every top-level scalar field carrying an `enum` holds an allowed value.
#
# Conditional rules (allOf/if/then in the schema) are NOT evaluated here — see
# the schema README. The reviewer approve⇒attestation case is covered by
# reviewer-attestation-gate.sh.
#
# Returns are YAML; top-level scalar fields are read by line (`^key:`). Nested
# blocks (handover.*) are checked only for the block's presence (`^handover:`).
#
# Port of Achilles' subagent-return-schema-guard.sh, jq-only Hektor variant.
set -uo pipefail

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")
[ "$TOOL_NAME" = "Agent" ] || exit 0

DESCRIPTION=$(echo "$INPUT" | "$JQ" -r '.tool_input.description // ""' 2>/dev/null || echo "")
case "$DESCRIPTION" in
  composer-*)         SCHEMA_BASE="composer.schema.json" ;;
  probe-*)            SCHEMA_BASE="probe.schema.json" ;;
  workflow-reviewer-*|phase-validator-*) SCHEMA_BASE="reviewer.schema.json" ;;
  diagnosis-*)        SCHEMA_BASE="diagnosis.schema.json" ;;
  *)                  exit 0 ;;
esac

GUARD_CWD=$(echo "$INPUT" | "$JQ" -r '.cwd // "."' 2>/dev/null || echo ".")
REPO_ROOT=$(git -C "$GUARD_CWD" rev-parse --show-toplevel 2>/dev/null || echo "$GUARD_CWD")
SCHEMA="$REPO_ROOT/.claude/schemas/subagent-returns/$SCHEMA_BASE"
[ -f "$SCHEMA" ] || exit 0   # schema missing -> nothing to validate against

# Flatten the return text.
RESPONSE=$(echo "$INPUT" | "$JQ" -r '
  [
    (.tool_response.output? | if type == "array" then map(.text? // (.|tostring)) | join("\n") elif type == "string" then . else (.|tostring) end),
    (.tool_response.result? // empty | tostring),
    (if (.tool_response | type) == "string" then .tool_response else empty end)
  ] | map(select(. != null and . != "")) | unique | join("\n")
' 2>/dev/null || echo "")
case "$RESPONSE" in ""|"null"|"{}"|"[]") exit 0 ;; esac

emit_warn() { "$JQ" -n --arg m "$1" '{ "systemMessage": $m, "suppressOutput": false }'; }

# Helper: read a top-level scalar field value from the YAML return.
# Matches `key: value` at column 0, strips inline comments + quotes + space.
yaml_top_value() {
  printf '%s\n' "$RESPONSE" \
    | grep -E "^$1:[[:space:]]*" \
    | head -1 \
    | sed -E "s/^$1:[[:space:]]*//; s/[[:space:]]*#.*$//; s/^[\"']//; s/[\"']$//; s/[[:space:]]*$//"
}

VIOLATIONS=""

# --- required top-level keys present ---
REQUIRED=$("$JQ" -r '.required[]? // empty' "$SCHEMA" 2>/dev/null || echo "")
while IFS= read -r key; do
  [ -z "$key" ] && continue
  if ! printf '%s\n' "$RESPONSE" | grep -qE "^$key:"; then
    VIOLATIONS="${VIOLATIONS}
  - missing required field: \`$key\`"
  fi
done <<< "$REQUIRED"

# --- top-level enum membership ---
# Emit "key\tval1,val2,..." lines for every top-level property carrying an enum.
ENUM_LINES=$("$JQ" -r '
  (.properties // {}) | to_entries[]
  | select(.value.enum != null)
  | "\(.key)\t\(.value.enum | join(","))"
' "$SCHEMA" 2>/dev/null || echo "")
while IFS=$'\t' read -r key allowed; do
  [ -z "$key" ] && continue
  val=$(yaml_top_value "$key")
  [ -z "$val" ] && continue   # absent: required-check above owns it; enum only checks present values
  case ",$allowed," in
    *",$val,"*) ;;
    *) VIOLATIONS="${VIOLATIONS}
  - field \`$key\` = \"$val\" is not one of: $allowed" ;;
  esac
done <<< "$ENUM_LINES"

# --- conditional required (schema allOf if/then) ---
# Enforces "if <field> <op> <val> then <req> required" for the patterns our
# schemas use (handover.status const, a top-level const, or a top-level numeric
# minimum). Dependency-free (jq + grep) — covers what an ajv engine would for
# these specific schemas, without vendoring ajv.
RULES=$("$JQ" -r '
  .allOf[]? | select(.if and .then) | . as $r
  | ($r.then.required // [])[] as $req
  | (
      if (($r.if.properties.handover.properties.status.const) // null) != null then
        {kind:"const", field:"handover.status", val:($r.if.properties.handover.properties.status.const|tostring), req:$req}
      elif ((($r.if.properties // {}) | to_entries | map(select(.value.const != null)) | length) > 0) then
        (($r.if.properties) | to_entries | map(select(.value.const != null))[0]) as $e
        | {kind:"const", field:$e.key, val:($e.value.const|tostring), req:$req}
      elif ((($r.if.properties // {}) | to_entries | map(select(.value.minimum != null)) | length) > 0) then
        (($r.if.properties) | to_entries | map(select(.value.minimum != null))[0]) as $e
        | {kind:"min", field:$e.key, val:($e.value.minimum|tostring), req:$req}
      else empty end
    )
  | "\(.kind)\t\(.field)\t\(.val)\t\(.req)"
' "$SCHEMA" 2>/dev/null || echo "")

while IFS="$(printf '\t')" read -r ckind cfield cval creq; do
  [ -z "$ckind" ] && continue
  if [ "$cfield" = "handover.status" ]; then
    actual=$(printf '%s\n' "$RESPONSE" | grep -E '^[[:space:]]+status:' | head -1 | sed -E 's/^[[:space:]]+status:[[:space:]]*//; s/[[:space:]]*#.*$//; s/^["'"'"']//; s/["'"'"']$//; s/[[:space:]]*$//')
  else
    actual=$(yaml_top_value "$cfield")
  fi
  [ -z "$actual" ] && continue
  fire=0; reldesc="is \"$cval\""
  case "$ckind" in
    const) [ "$actual" = "$cval" ] && fire=1 ;;
    min)   reldesc=">= $cval"; case "$actual" in ''|*[!0-9]*) ;; *) [ "$actual" -ge "$cval" ] && fire=1 ;; esac ;;
  esac
  [ "$fire" = "1" ] || continue
  if ! printf '%s\n' "$RESPONSE" | grep -qE "^$creq:"; then
    VIOLATIONS="${VIOLATIONS}
  - field \`$creq\` is required when \`$cfield\` $reldesc"
  fi
done <<< "$RULES"

[ -z "$VIOLATIONS" ] && exit 0

emit_warn "[WARN — Hektor return-schema-guard] ${DESCRIPTION} return does not conform to ${SCHEMA_BASE}.

Violations:${VIOLATIONS}

The return shape is the contract the orchestrator relies on to route next steps.
Re-dispatch the subagent with a brief that pins the missing fields, or correct
the return. Schema: .claude/schemas/subagent-returns/${SCHEMA_BASE}

WARN, not DENY: PostToolUse cannot reverse a return that already ran."
exit 0
