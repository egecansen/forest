#!/bin/bash
# install.sh — install the Hektor QA pack into a project as native Cursor assets.
#
# Everything lands under the project's .cursor/, which is the only tree Cursor
# reads:
#
#   .cursor/skills/<name>/SKILL.md     the playbooks (auto-invoked by description,
#                                      or explicitly as /<name>)
#   .cursor/agents/*.md                the subagent roles the skills dispatch
#   .cursor/rules/hektor-kernel.mdc    the always-applied router
#   .cursor/hooks/ + hooks.json        the enforcement gates
#   .cursor/schemas/                   subagent return contracts
#
# Self-contained and idempotent — re-running never duplicates a registration and
# never touches a .cursor/hooks.json entry that isn't Hektor's.
#
# Usage:
#   ./install.sh [--project <dir>] [--no-kits]
#     --project  target project root (default: current directory)
#     --no-kits  skip the bundled kits' own installers
#
# After install: reload the Cursor window so the hooks and skills load.
# Kill switches: HEKTOR_CURSOR_HOOKS=off (everything), HEKTOR_<GATE>=off (one),
# HEKTOR_HOOK_PROFILE=minimal|standard|strict (tier).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v jq >/dev/null || { echo "install: jq is required" >&2; exit 69; }

PROJ="$(pwd)"; DO_KITS=1; HARNESS="all"
while [ $# -gt 0 ]; do
  case "$1" in
    --harness) HARNESS="${2:-all}"; shift 2 ;;
    --project) PROJ="${2:-$(pwd)}"; shift 2 ;;
    --no-kits) DO_KITS=0; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "install: unknown arg: $1" >&2; exit 64 ;;
  esac
done

# --harness exists because scripts/worktree-provision.sh passes it on every call.
# It was dropped when the adapters/ tree was folded into hooks/, so provisioning
# ANY worktree died on "install: unknown arg: --harness" — every tree stood up
# after that refactor was Hektor-blind, under a provisioner reporting success.
do_cursor=0; do_agents=0; want_claude=0
case "$HARNESS" in
  cursor) do_cursor=1 ;;
  agents) do_agents=1 ;;
  claude) want_claude=1 ;;
  both)   do_cursor=1; want_claude=1 ;;
  all)    do_cursor=1; do_agents=1; want_claude=1 ;;
  *) echo "install: --harness must be all|claude|cursor|agents|both (got: $HARNESS)" >&2; exit 64 ;;
esac
[ -d "$PROJ" ] || { echo "install: no such project dir: $PROJ" >&2; exit 66; }
PROJ="$(cd "$PROJ" && pwd)"
CUR="$PROJ/.cursor"

# ---------------------------------------------------------------------------
# 1) Assets.
# ---------------------------------------------------------------------------
mkdir -p "$CUR/skills" "$CUR/agents" "$CUR/rules" "$CUR/hooks/lib" "$CUR/schemas"
cp -R "$HERE/skills/."  "$CUR/skills/"
cp -R "$HERE/agents/."  "$CUR/agents/"
cp -R "$HERE/hooks/."   "$CUR/hooks/"
cp -R "$HERE/schemas/." "$CUR/schemas/"
cp "$HERE/rules/hektor-kernel.mdc" "$CUR/rules/hektor-kernel.mdc"

chmod +x "$CUR/hooks"/*.sh "$CUR/hooks/lib"/*.sh 2>/dev/null || true
find "$CUR/skills" \( -name '*.sh' -o -name '*.py' \) -exec chmod +x {} + 2>/dev/null || true
find "$CUR" -name '.DS_Store' -delete 2>/dev/null || true

SKILL_N=$(find "$CUR/skills" -name SKILL.md | wc -l | tr -d ' ')
AGENT_N=$(find "$CUR/agents" -name 'hektor-*.md' | wc -l | tr -d ' ')
echo "install: $SKILL_N skills, $AGENT_N agents, 1 rule, gates + schemas -> .cursor/"

# ---------------------------------------------------------------------------
# 2) Gate registrations -> .cursor/hooks.json.
#
#    Idempotent and additive. For each Hektor registration the event's array is
#    rewritten as "everything that isn't this command, then this command" — so a
#    re-run replaces Hektor's own entry in place rather than duplicating it, and
#    a hook you added yourself to the same event survives untouched.
#
#    Registrations are applied in hooks.json order, so Hektor's gates end up in
#    that order within each event. That matters on subagentStart, where
#    reviewer-approver-registry must run before the gates that read its registry.
#
#    Rows are passed as compact JSON, one per line — not a delimited string. An
#    optional field (loop_limit) would otherwise arrive as an empty trailing
#    field, which `read` collapses.
# ---------------------------------------------------------------------------
H="$CUR/hooks.json"
[ -f "$H" ] || echo '{"version":1,"hooks":{}}' > "$H"
jq -e '.' "$H" >/dev/null 2>&1 || { echo "install: $H is not valid JSON — fix or remove it first" >&2; exit 65; }

REG=0
while IFS= read -r row; do
  [ -n "$row" ] || continue
  t="$(mktemp)"
  jq --argjson r "$row" '
    .version //= 1
    | .hooks //= {}
    | .hooks[$r.ev] //= []
    | .hooks[$r.ev] |= (
        map(select(.command != $r.cmd))
        + [ {command: $r.cmd, timeout: $r.to}
            + (if $r.loop == null then {} else {loop_limit: $r.loop} end) ]
      )
  ' "$H" > "$t" && mv "$t" "$H" && REG=$((REG+1)) || rm -f "$t"
done < <(jq -c '.hooks | to_entries[] | .key as $ev | .value[]
                | {ev: $ev, cmd: .command, to: (.timeout // 10), loop: (.loop_limit // null)}' \
              "$HERE/hooks.json")
echo "install: Cursor gates wired ($REG registrations in .cursor/hooks.json, idempotent)"

# ---------------------------------------------------------------------------
# 3) Working dir + gitignore for the run-local artefacts. These are session
#    state, not deliverables — they must never reach a PR.
# ---------------------------------------------------------------------------
mkdir -p "$PROJ/docs/hektor"
GI="$PROJ/.gitignore"; MARK="# hektor (generated — run state, never committed)"
if [ ! -f "$GI" ] || ! grep -qF "$MARK" "$GI" 2>/dev/null; then
  { [ -f "$GI" ] && printf '\n'; cat <<'EOF'
# hektor (generated — run state, never committed)
docs/hektor/run-status.json
docs/hektor/coverage-expansion-state.json
docs/hektor/multi-ticket-state.json
docs/hektor/observations.jsonl
docs/hektor/memory-proposals.md
docs/hektor/.distill-input.md
docs/hektor/.workflow-approvers.json
docs/hektor/.hook-audit.log
docs/hektor/.cursor-hook-payload.log
EOF
  } >> "$GI"
  echo "install: gitignore entries for docs/hektor/ run state added"
fi

# ---------------------------------------------------------------------------
# 4) Kits — each ships its own installer. Last, so a kit's registrations land on
#    top of the pack's rather than under them.
# ---------------------------------------------------------------------------
if [ "$DO_KITS" = 1 ]; then
  for kit_installer in "$HERE"/kits/*/install.sh; do
    [ -x "$kit_installer" ] || continue
    kit_name="$(basename "$(dirname "$kit_installer")")"
    "$kit_installer" --project "$PROJ"; kit_rc=$?
    if [ "$kit_rc" -eq 0 ]; then
      echo "install: kit '$kit_name' installed"
    else
      # Never fail the whole pack install because one kit's installer did — the
      # pack's skills and gates are already in place and useful on their own.
      # "did not finish cleanly", NOT "is not installed": a kit installer's
      # non-zero exit does not imply nothing landed.
      echo "install: WARN kit '$kit_name' did NOT finish cleanly (exit $kit_rc) — pack assets ARE installed; read that kit's own output above, or re-run $kit_installer" >&2
    fi
  done
fi

# ---------------------------------------------------------------------------
# 5) AGENTS.md — the pointer any non-Cursor terminal LLM reads. Cursor does not
#    read CLAUDE.md, so without this the build flags, the testbox discipline and
#    the "Never trust BUILD SUCCESSFUL" gate table are invisible outside Claude
#    Code. A symlink, so the two can never drift.
# ---------------------------------------------------------------------------
if [ "$do_agents" = 1 ] && [ -f "$PROJ/CLAUDE.md" ] && [ ! -e "$PROJ/AGENTS.md" ]; then
  ln -s CLAUDE.md "$PROJ/AGENTS.md" && echo "install: AGENTS.md -> CLAUDE.md (symlink)"
fi

# ---------------------------------------------------------------------------
# 6) The Claude axis is NOT installable from this pack right now — say so rather
#    than half-doing it. Since the adapters/ tree was folded into hooks/, every
#    gate denies through lib/cursor.sh:hektor_deny(), which emits Cursor's
#    {"permission":"deny"} and nothing else. Copying those into .claude/hooks/
#    would register gates that Claude Code parses as "allow" — enforcement that
#    looks installed and blocks nothing, which is strictly worse than absent.
#    Restoring it means giving hektor_deny a Claude branch
#    ({hookSpecificOutput:{permissionDecision:"deny"}}) and bringing back
#    settings.hooks.json (still in git: `git show b75ac8f:settings.hooks.json`).
# ---------------------------------------------------------------------------
if [ "$want_claude" = 1 ]; then
  echo "install: WARN --harness $HARNESS asked for the Claude axis, but this pack has no Claude-shaped gates" >&2
  echo "install:      since the adapters/ refactor (hooks/lib/cursor.sh emits Cursor's deny shape only)." >&2
  echo "install:      .cursor/ IS installed and enforcing. .claude/ was skipped deliberately — installing" >&2
  echo "install:      these gates there would block nothing while appearing wired." >&2
fi

cat >&2 <<EOF

install: done in $PROJ
next:
  1) reload the Cursor window so the skills, agents and hooks load
     (Cmd/Ctrl+Shift+P -> "Developer: Reload Window")
  2) try  /hektor-orchestrator  in Agent chat, or just describe the task
  3) read .cursor/skills/hektor-conventions/SKILL.md before writing Java
kill switches: HEKTOR_CURSOR_HOOKS=off (all) . HEKTOR_PR_RULES_GATE=off,
               HEKTOR_COMMIT_GATE=off, ... (per gate) .
               HEKTOR_HOOK_PROFILE=minimal|standard|strict (tier)
EOF
