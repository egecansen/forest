#!/bin/bash
# subagent-return-schema-guard.sh — validates a subagent's return against its
#                                   role schema (required keys + top-level enums).
#
# Event   : subagentStop
# Mode    : FOLLOW-UP (the return already ran and cannot be reversed, so the
#                 gate makes the parent take another turn. Achilles ships this
#                 non-blocking too, pending false-positive calibration.)
# State   : reads .cursor/schemas/subagent-returns/<role>.schema.json (read-only)
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

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

hektor_gate_init subagent-return-schema-guard "standard,strict"

DESCRIPTION="$(hektor_role)"
case "$DESCRIPTION" in
  composer-*)         SCHEMA_BASE="composer.schema.json" ;;
  probe-*)            SCHEMA_BASE="probe.schema.json" ;;
  workflow-reviewer-*|phase-validator-*) SCHEMA_BASE="reviewer.schema.json" ;;
  diagnosis-*)        SCHEMA_BASE="diagnosis.schema.json" ;;
  *)                  exit 0 ;;
esac

REPO_ROOT="$(hektor_repo_root)"
SCHEMA="$REPO_ROOT/.cursor/schemas/subagent-returns/$SCHEMA_BASE"
[ -f "$SCHEMA" ] || exit 0   # schema missing -> nothing to validate against

RESPONSE="$(hektor_summary)"
case "$RESPONSE" in ""|"null"|"{}"|"[]") exit 0 ;; esac

emit_warn() { hektor_followup "$1"; }

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
REQUIRED=$("$CC_JQ" -r '.required[]? // empty' "$SCHEMA" 2>/dev/null || echo "")
while IFS= read -r key; do
  [ -z "$key" ] && continue
  if ! printf '%s\n' "$RESPONSE" | grep -qE "^$key:"; then
    VIOLATIONS="${VIOLATIONS}
  - missing required field: \`$key\`"
  fi
done <<< "$REQUIRED"

# --- top-level enum membership ---
# Emit "key\tval1,val2,..." lines for every top-level property carrying an enum.
ENUM_LINES=$("$CC_JQ" -r '
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
RULES=$("$CC_JQ" -r '
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
the return. Schema: .cursor/schemas/subagent-returns/${SCHEMA_BASE}

A follow-up rather than a block — subagentStop cannot reverse a return that already ran."
exit 0
