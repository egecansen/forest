#!/bin/bash
# doctor.sh — deterministic self-audit of the Hektor pack (and an installed target).
#
# `hektor doctor` runs this. It answers the two questions a solo maintainer has no
# CI reviewer to answer: "is the pack internally consistent?" (no dead routes: every
# registered gate has a script, every skill has frontmatter, every schema parses,
# catalog ↔ skills agree) and "are the gates actually installed?" in a target repo.
# Port of the intent of ECC scripts/harness-audit.js + observability-readiness.md
# (a local, file-backed readiness gate — no telemetry, reproducible).
#
# Usage:  doctor.sh [--project DIR]
#   PACK checks always run against this pack. TARGET checks run if --project (or the
#   detected repo) has a .claude/ install.
# Exit: 0 if no FAIL, 1 if any FAIL (WARN never fails).
set -uo pipefail
PACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JQ="$(command -v jq || true)"
[ -n "$JQ" ] || { echo "doctor: jq is required"; exit 1; }

PROJ=""
while [ $# -gt 0 ]; do case "$1" in --project) PROJ="${2:-}"; shift 2 ;; *) shift ;; esac; done

FAIL=0; WARN=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARN=$((WARN+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
# fall back to plain marks if not a tty
[ -t 1 ] || { ok(){ echo "  [ok]  $1"; }; warn(){ echo "  [warn] $1"; WARN=$((WARN+1)); }; bad(){ echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }; }

echo "Hektor doctor — pack: $PACK_DIR"
echo

# --- deps -------------------------------------------------------------------
echo "dependencies"
command -v jq      >/dev/null && ok "jq present"      || bad "jq missing (required by every gate)"
command -v python3 >/dev/null && ok "python3 present" || warn "python3 missing (invisible-unicode-gate + flaky kit degrade to fail-open)"
echo

# --- skills: frontmatter + name↔dir + description sanity --------------------
echo "skills"
for d in "$PACK_DIR"/skills/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"; f="$d/SKILL.md"
  [ -f "$f" ] || { bad "$name: no SKILL.md"; continue; }
  fm="$(awk 'NR==1&&$0=="---"{f=1;next} f&&$0=="---"{exit} f' "$f")"
  fmname="$(printf '%s\n' "$fm" | sed -nE 's/^name:[[:space:]]*//p' | head -1 | tr -d '"'"'"' ')"
  hasdesc="$(printf '%s\n' "$fm" | grep -cE '^description:')"
  if [ -z "$fmname" ]; then bad "$name: frontmatter missing name:";
  elif [ "$fmname" != "$name" ]; then bad "$name: frontmatter name '$fmname' != dir '$name'"; fi
  [ "${hasdesc:-0}" -ge 1 ] || bad "$name: frontmatter missing description:"
  # description word count (context-budget nudge; WARN only — Hektor descriptions carry trigger phrases)
  dwords="$(printf '%s\n' "$fm" | awk '/^description:/{g=1} g&&/^[a-z_]+:/&&!/^description:/{exit} g{print}' | wc -w | tr -d ' ')"
  [ "${dwords:-0}" -le 80 ] || warn "$name: description is ${dwords} words (>80 — trim toward the ≤30 ideal; it loads on every match)"
done
sc=$(ls -d "$PACK_DIR"/skills/*/ 2>/dev/null | wc -l | tr -d ' '); ok "$sc skill dirs scanned"
echo

# --- schemas parse ----------------------------------------------------------
echo "schemas"
for s in "$PACK_DIR"/schemas/*.json "$PACK_DIR"/schemas/**/*.json; do
  [ -f "$s" ] || continue
  "$JQ" -e . "$s" >/dev/null 2>&1 && ok "$(basename "$s") parses" || bad "$(basename "$s") is invalid JSON"
done
echo

# --- gate registration ↔ scripts (no orphan either way) --------------------
echo "gate wiring (settings.hooks.json ↔ hooks/)"
SH="$PACK_DIR/settings.hooks.json"
if [ -f "$SH" ] && "$JQ" -e . "$SH" >/dev/null 2>&1; then
  # every referenced .claude/hooks/<x>.sh (or skills/.../hooks/<x>.sh) must exist in the pack
  while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    rel="$(printf '%s' "$cmd" | sed -E 's#.*/\.claude/##; s/"$//')"   # -> hooks/x.sh or skills/.../x.sh
    [ -n "$rel" ] || continue
    if [ -f "$PACK_DIR/$rel" ]; then ok "registered → $rel exists"; else bad "registered gate has NO script: $rel (dead route)"; fi
  done < <("$JQ" -r '[.hooks[]?[]?.hooks[]?.command] | .[]' "$SH" 2>/dev/null | grep -o '[^"]*\.sh' | sort -u)
  # every top-level hooks/*.sh (excluding lib/) should be registered OR be a known non-registered helper
  for hk in "$PACK_DIR"/hooks/*.sh; do
    b="$(basename "$hk")"
    if grep -qF "/hooks/$b" "$SH"; then :; else warn "hooks/$b is not registered in settings.hooks.json (orphan gate — intended?)"; fi
  done
else
  bad "settings.hooks.json missing or invalid JSON"
fi
echo

# --- catalog ↔ skills -------------------------------------------------------
echo "catalog ↔ skills"
CAT="$PACK_DIR/catalog.json"
if [ -f "$CAT" ] && "$JQ" -e . "$CAT" >/dev/null 2>&1; then
  while IFS= read -r id; do
    [ -d "$PACK_DIR/skills/$id" ] && ok "catalog '$id' → skill dir exists" || bad "catalog lists '$id' with no skills/$id/ dir"
  done < <("$JQ" -r '.skillsets[].id' "$CAT" 2>/dev/null)
  # every skill dir should have a catalog entry
  for d in "$PACK_DIR"/skills/*/; do
    id="$(basename "$d")"
    "$JQ" -e --arg i "$id" '.skillsets[]|select(.id==$i)' "$CAT" >/dev/null 2>&1 || warn "skills/$id/ has no catalog.json entry"
  done
else
  bad "catalog.json missing or invalid JSON"
fi
echo

# --- executable bits on shipped scripts ------------------------------------
echo "executable bits"
nonx=0
while IFS= read -r sh; do [ -x "$sh" ] || { nonx=$((nonx+1)); warn "not +x: ${sh#$PACK_DIR/}"; }; done \
  < <(find "$PACK_DIR/hooks" "$PACK_DIR/scripts" "$PACK_DIR/adapters" -name '*.sh' 2>/dev/null)
[ "$nonx" -eq 0 ] && ok "all shipped .sh are executable"
echo

# --- TARGET install state (optional) ---------------------------------------
if [ -z "$PROJ" ]; then
  PROJ="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || echo "")"
fi
if [ -n "$PROJ" ] && [ -d "$PROJ/.claude" ] && [ "$PROJ" != "$PACK_DIR" ]; then
  echo "installed target: $PROJ"
  TS="$PROJ/.claude/settings.json"
  if [ -f "$TS" ] && "$JQ" -e . "$TS" >/dev/null 2>&1; then
    while IFS= read -r b; do
      if "$JQ" -e --arg b "$b" '[.hooks[]?[]?.hooks[]?.command // empty] | any(contains($b))' "$TS" >/dev/null 2>&1; then
        ok "gate registered in target: $b"
      else warn "gate NOT registered in target settings.json: $b (run: hektor package install)"; fi
    done < <(ls "$PACK_DIR"/hooks/*.sh | xargs -n1 basename)
    for hk in "$PROJ"/.claude/hooks/*.sh; do [ -f "$hk" ] && { [ -x "$hk" ] || warn "target hook not +x: $(basename "$hk")"; }; done
  else
    warn "target has .claude/ but no valid settings.json"
  fi
  echo
fi

echo "───"
if [ "$FAIL" -gt 0 ]; then
  echo "doctor: $FAIL FAIL, $WARN warn — fix the FAILs (dead routes / missing frontmatter break the pack)."
  exit 1
else
  echo "doctor: 0 FAIL, $WARN warn — pack is internally consistent."
  exit 0
fi
