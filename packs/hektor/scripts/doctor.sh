#!/bin/bash
# doctor.sh — deterministic self-audit of the Hektor pack (and an installed target).
#
# `hektor doctor` runs this. It answers the two questions a solo maintainer has no
# CI reviewer to answer: "is the pack internally consistent?" (no dead routes: every
# registered gate has a script, every skill has valid frontmatter, every schema
# parses, catalog ↔ skills agree, every agent role a gate keys on is defined) and
# "is it actually wired?" in a target repo.
#
# Usage:  doctor.sh [--project DIR]
#   PACK checks always run against this pack. TARGET checks run if --project (or the
#   detected repo) has a .cursor/ install.
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
  # Cursor's skill name grammar: lowercase, digits, hyphens.
  printf '%s' "$name" | grep -qE '^[a-z0-9-]+$' || bad "$name: dir name must be lowercase/digits/hyphens only"
  # Only fields Cursor actually reads. A typo here is silent — the field is ignored.
  while IFS= read -r key; do
    case "$key" in
      name|description|paths|disable-model-invocation|icon|color|metadata) ;;
      '') ;;
      *) warn "$name: unknown frontmatter key '$key' (Cursor ignores it)" ;;
    esac
  done < <(printf '%s\n' "$fm" | sed -nE 's/^([a-zA-Z][a-zA-Z0-9_-]*):.*/\1/p')
  # description word count (context-budget nudge; WARN only — Hektor descriptions carry trigger phrases)
  dwords="$(printf '%s\n' "$fm" | awk '/^description:/{g=1} g&&/^[a-z_-]+:/&&!/^description:/{exit} g{print}' | wc -w | tr -d ' ')"
  [ "${dwords:-0}" -le 120 ] || warn "$name: description is ${dwords} words (long — it is scanned on every turn)"
done
sc=$(ls -d "$PACK_DIR"/skills/*/ 2>/dev/null | wc -l | tr -d ' '); ok "$sc skill dirs scanned"
echo

# --- agents -----------------------------------------------------------------
echo "agents"
for a in "$PACK_DIR"/agents/hektor-*.md; do
  [ -f "$a" ] || continue
  b="$(basename "$a" .md)"
  fm="$(awk 'NR==1&&$0=="---"{f=1;next} f&&$0=="---"{exit} f' "$a")"
  n="$(printf '%s\n' "$fm" | sed -nE 's/^name:[[:space:]]*//p' | head -1)"
  [ "$n" = "$b" ] || bad "agents/$b.md: frontmatter name '$n' != filename '$b'"
  printf '%s\n' "$fm" | grep -qE '^description:' || bad "agents/$b.md: missing description:"
done
an=$(ls "$PACK_DIR"/agents/hektor-*.md 2>/dev/null | wc -l | tr -d ' '); ok "$an agent roles scanned"
# Every role prefix a gate keys on must have a schema to validate its return against.
for role in composer probe diagnosis reviewer; do
  [ -f "$PACK_DIR/schemas/subagent-returns/$role.schema.json" ] \
    && ok "role '$role-*' → $role.schema.json" \
    || bad "gates key on role '$role-*' but schemas/subagent-returns/$role.schema.json is missing"
done
echo

# --- rules ------------------------------------------------------------------
echo "rules"
R="$PACK_DIR/rules/hektor-kernel.mdc"
if [ -f "$R" ]; then
  head -1 "$R" | grep -qx -- '---' && ok "hektor-kernel.mdc has frontmatter" || bad "hektor-kernel.mdc: no frontmatter (Cursor ignores a .mdc without it)"
  grep -qE '^alwaysApply:' "$R" && ok "hektor-kernel.mdc declares alwaysApply" || warn "hektor-kernel.mdc has no alwaysApply: — it will only load when @-mentioned"
  rl=$(wc -l < "$R" | tr -d ' ')
  [ "$rl" -le 500 ] && ok "hektor-kernel.mdc is $rl lines (under the 500 guidance)" || warn "hektor-kernel.mdc is $rl lines (>500 — split it)"
else
  bad "rules/hektor-kernel.mdc missing"
fi
echo

# --- schemas parse ----------------------------------------------------------
echo "schemas"
while IFS= read -r s; do
  [ -f "$s" ] || continue
  "$JQ" -e . "$s" >/dev/null 2>&1 && ok "$(basename "$s") parses" || bad "$(basename "$s") is invalid JSON"
done < <(find "$PACK_DIR/schemas" -name '*.json' 2>/dev/null | sort)
echo

# --- gate registration ↔ scripts (no orphan either way) --------------------
echo "gate wiring (hooks.json ↔ hooks/)"
SH="$PACK_DIR/hooks.json"
if [ -f "$SH" ] && "$JQ" -e . "$SH" >/dev/null 2>&1; then
  # Only events Cursor actually fires. A typo'd event key is silent — it never runs.
  KNOWN="sessionStart sessionEnd preToolUse postToolUse postToolUseFailure subagentStart subagentStop beforeShellExecution afterShellExecution beforeMCPExecution afterMCPExecution beforeReadFile afterFileEdit beforeSubmitPrompt preCompact stop afterAgentResponse afterAgentThought workspaceOpen"
  while IFS= read -r ev; do
    case " $KNOWN " in *" $ev "*) ok "event '$ev' is a real Cursor hook event" ;;
      *) bad "hooks.json registers event '$ev' — Cursor has no such event, it will never fire" ;;
    esac
  done < <("$JQ" -r '.hooks | keys[]' "$SH" 2>/dev/null)

  # Every registered command must name a script this pack ships.
  while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    rel="${cmd#./}"; rel="${rel#.cursor/}"
    if [ -f "$PACK_DIR/$rel" ]; then ok "registered → $rel exists"; else bad "registered gate has NO script: $rel (dead route)"; fi
  done < <("$JQ" -r '[.hooks[]?[]?.command] | unique | .[]' "$SH" 2>/dev/null)

  # And every gate the pack ships should be registered somewhere.
  for hk in "$PACK_DIR"/hooks/*.sh; do
    b="$(basename "$hk")"
    grep -qF "/$b" "$SH" || warn "hooks/$b is not registered in hooks.json (orphan gate — intended?)"
  done
else
  bad "hooks.json missing or invalid JSON"
fi
echo

# --- catalog ↔ skills -------------------------------------------------------
echo "catalog ↔ skills"
CAT="$PACK_DIR/catalog.json"
if [ -f "$CAT" ] && "$JQ" -e . "$CAT" >/dev/null 2>&1; then
  while IFS= read -r id; do
    [ -d "$PACK_DIR/skills/$id" ] && ok "catalog '$id' → skill dir exists" || bad "catalog lists '$id' with no skills/$id/ dir"
  done < <("$JQ" -r '.skillsets[].id' "$CAT" 2>/dev/null)
  for d in "$PACK_DIR"/skills/*/; do
    id="$(basename "$d")"
    "$JQ" -e --arg i "$id" '.skillsets[]|select(.id==$i)' "$CAT" >/dev/null 2>&1 || warn "skills/$id/ has no catalog.json entry"
  done
else
  bad "catalog.json missing or invalid JSON"
fi
echo

# --- no stale cross-harness references -------------------------------------
# The pack targets Cursor only. A surviving `.claude/` path is a dead route that
# reads as live documentation, which is worse than an obvious gap.
echo "no stale harness references"
stale=$(grep -rl '\.claude/' "$PACK_DIR/skills" "$PACK_DIR/agents" "$PACK_DIR/rules" "$PACK_DIR/hooks" "$PACK_DIR/hooks.json" 2>/dev/null | wc -l | tr -d ' ')
[ "${stale:-0}" -eq 0 ] && ok "no .claude/ references in shipped assets" \
  || { grep -rl '\.claude/' "$PACK_DIR/skills" "$PACK_DIR/agents" "$PACK_DIR/rules" "$PACK_DIR/hooks" 2>/dev/null | sed "s#$PACK_DIR/#  #" | while IFS= read -r x; do bad "stale .claude/ reference in ${x# }"; done; }
echo

# --- executable bits on shipped scripts ------------------------------------
echo "executable bits"
nonx=0
while IFS= read -r sh; do [ -x "$sh" ] || { nonx=$((nonx+1)); warn "not +x: ${sh#$PACK_DIR/}"; }; done \
  < <(find "$PACK_DIR/hooks" "$PACK_DIR/scripts" -name '*.sh' 2>/dev/null)
[ "$nonx" -eq 0 ] && ok "all shipped .sh are executable"
echo

# --- gates are syntactically valid -----------------------------------------
echo "gate syntax"
gerr=0
while IFS= read -r sh; do
  bash -n "$sh" 2>/dev/null || { bad "syntax error: ${sh#$PACK_DIR/}"; gerr=$((gerr+1)); }
done < <(find "$PACK_DIR/hooks" -name '*.sh' 2>/dev/null)
[ "$gerr" -eq 0 ] && ok "every gate parses"
echo

# --- TARGET install state (optional) ---------------------------------------
if [ -z "$PROJ" ]; then
  PROJ="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || echo "")"
fi
if [ -n "$PROJ" ] && [ -d "$PROJ/.cursor" ] && [ "$PROJ" != "$PACK_DIR" ]; then
  echo "installed target: $PROJ"
  TH="$PROJ/.cursor/hooks.json"
  if [ -f "$TH" ] && "$JQ" -e . "$TH" >/dev/null 2>&1; then
    while IFS= read -r b; do
      if "$JQ" -e --arg b "$b" '[.hooks[]?[]?.command // empty] | any(contains($b))' "$TH" >/dev/null 2>&1; then
        ok "gate registered in target: $b"
      else warn "gate NOT registered in target: $b (run: hektor package install)"; fi
    done < <(ls "$PACK_DIR"/hooks/*.sh | xargs -n1 basename)
    # A registration naming a missing script runs nothing, silently.
    while IFS= read -r cmd; do
      p="${cmd#./}"
      [ -f "$PROJ/$p" ] || bad "target registration points at a missing script: $cmd"
    done < <("$JQ" -r '.hooks[]?[]?.command // empty' "$TH" 2>/dev/null)
    for hk in "$PROJ"/.cursor/hooks/*.sh; do [ -f "$hk" ] && { [ -x "$hk" ] || warn "target hook not +x: $(basename "$hk")"; }; done
  else
    warn "target has .cursor/ but no valid hooks.json"
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
