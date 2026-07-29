#!/bin/bash
# install.sh — install the whole Hektor QA pack into a project so it works across
# harnesses: Claude Code, Cursor, and any AGENTS.md-reading LLM (Codex, Gemini, …).
#
# Self-contained + idempotent (re-runnable, never duplicates). Lays the durable
# assets (skills/ hooks/ schemas/) into the project's .claude/ — the canonical
# home every harness reads from — then wires each harness on top:
#   Claude : merges settings.hooks.json into .claude/settings.json (the gates).
#   Cursor : rule + hooks.json registrations that run the SAME .claude/hooks/*.sh
#            gates via the ECC-style adapter shim (.cursor/hooks/adapter.sh).
#   AGENTS : an AGENTS.md pointer for any other terminal LLM.
#
# Usage:
#   ./install.sh [--harness all|claude|cursor|agents|both] [--project <dir>]
#     --harness  what to wire up (default: all = claude + cursor + AGENTS.md)
#     --project  target project root (default: current directory)
#
# After install: restart Claude Code / Cursor so the hooks load. Each gate has
# its own kill switch (HEKTOR_PR_RULES_GATE=off, HEKTOR_COMMIT_GATE=off, …);
# HEKTOR_CURSOR_HOOKS=off disables all Cursor adaptation.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v jq >/dev/null || { echo "install: jq is required" >&2; exit 69; }

HARNESS="all"; PROJ="$(pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --harness) HARNESS="${2:-all}"; shift 2 ;;
    --project) PROJ="${2:-$(pwd)}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "install: unknown arg: $1" >&2; exit 64 ;;
  esac
done
do_claude=0; do_cursor=0; do_agents=0
case "$HARNESS" in
  claude) do_claude=1 ;;
  cursor) do_cursor=1 ;;
  agents) do_agents=1 ;;
  both)   do_claude=1; do_cursor=1 ;;
  all)    do_claude=1; do_cursor=1; do_agents=1 ;;
  *) echo "install: --harness must be all|claude|cursor|agents|both" >&2; exit 64 ;;
esac
[ -d "$PROJ" ] || { echo "install: no such project dir: $PROJ" >&2; exit 66; }
PROJ="$(cd "$PROJ" && pwd)"

# ---------------------------------------------------------------------------
# 1) Durable assets -> .claude/ (canonical home for EVERY harness). Always done.
# ---------------------------------------------------------------------------
CL="$PROJ/.claude"
mkdir -p "$CL/skills" "$CL/hooks" "$CL/schemas"
cp -R "$HERE/skills/." "$CL/skills/"
cp -R "$HERE/hooks/."  "$CL/hooks/"
cp -R "$HERE/schemas/." "$CL/schemas/"
chmod +x "$CL/hooks"/*.sh "$CL/hooks/lib"/*.sh 2>/dev/null || true
find "$CL/skills" -name '*.sh' -exec chmod +x {} + 2>/dev/null || true
find "$CL/skills" -name '*.py' -exec chmod +x {} + 2>/dev/null || true
find "$CL" -name '.DS_Store' -delete 2>/dev/null || true
echo "install: skills/ hooks/ schemas/ -> .claude/"

# ---------------------------------------------------------------------------
# 2) Claude Code — merge the gate registrations into .claude/settings.json.
#    Idempotent: ensures each (event, matcher, command) exists exactly once.
# ---------------------------------------------------------------------------
if [ "$do_claude" = 1 ]; then
  S="$CL/settings.json"; [ -f "$S" ] || echo '{}' > "$S"
  # Extract every (event, matcher, command, timeout) tuple. Fields are joined on the
  # ASCII Unit Separator (), NOT a tab — a matcher-less event (Stop) has an
  # empty matcher field, and `read` would collapse an empty tab-delimited field.
  while IFS=$'\037' read -r EV M CMD TMO; do
    [ -n "$EV" ] || continue
    t="$(mktemp)"
    if [ -n "$M" ]; then
      # matcher-scoped events (PreToolUse/PostToolUse): key on matcher.
      jq --arg ev "$EV" --arg m "$M" --arg c "$CMD" --argjson to "${TMO:-10}" '
        .hooks //= {} | .hooks[$ev] //= [] |
        (if any(.hooks[$ev][]?; .matcher==$m) then . else .hooks[$ev] += [{matcher:$m, hooks:[]}] end) |
        .hooks[$ev] |= map(
          if .matcher==$m then (.hooks //= []) |
            (if any(.hooks[]?; .command==$c) then . else .hooks += [{type:"command", command:$c, timeout:$to}] end)
          else . end)
      ' "$S" > "$t" && mv "$t" "$S"
    else
      # matcher-less events (Stop): a single entry with no matcher key.
      jq --arg ev "$EV" --arg c "$CMD" --argjson to "${TMO:-10}" '
        .hooks //= {} | .hooks[$ev] //= [] |
        (if any(.hooks[$ev][]?; (.matcher // null)==null) then . else .hooks[$ev] += [{hooks:[]}] end) |
        .hooks[$ev] |= map(
          if (.matcher // null)==null then (.hooks //= []) |
            (if any(.hooks[]?; .command==$c) then . else .hooks += [{type:"command", command:$c, timeout:$to}] end)
          else . end)
      ' "$S" > "$t" && mv "$t" "$S"
    fi
  done < <(jq -r '.hooks | to_entries[] | .key as $ev | .value[] | (.matcher // "") as $m
                  | .hooks[] | [$ev, $m, .command, (.timeout // 10 | tostring)] | join("")' "$HERE/settings.hooks.json")
  echo "install: Claude Code wired (.claude/settings.json: $(jq -r '[.hooks[][]?.hooks[]?] | length' "$HERE/settings.hooks.json") gate registrations, idempotent)"
fi

# ---------------------------------------------------------------------------
# 3) Cursor — rule + the ECC-style adapter that runs the SAME .claude gates.
# ---------------------------------------------------------------------------
if [ "$do_cursor" = 1 ]; then
  mkdir -p "$PROJ/.cursor/hooks/lib" "$PROJ/.cursor/rules"
  cp "$HERE/adapters/cursor/adapter.sh"        "$PROJ/.cursor/hooks/adapter.sh"
  cp "$HERE/adapters/cursor/lib/cursor-compat.sh" "$PROJ/.cursor/hooks/lib/cursor-compat.sh"
  cp "$HERE/adapters/cursor/rules/hektor.mdc"  "$PROJ/.cursor/rules/hektor.mdc"
  chmod +x "$PROJ/.cursor/hooks/adapter.sh" 2>/dev/null || true

  H="$PROJ/.cursor/hooks.json"; [ -f "$H" ] || echo '{"version":1,"hooks":{}}' > "$H"
  # (event, cursor-command) registrations. adapter.sh runs the named .claude gate.
  #   beforeShellExecution -> commit-gate (real block on git commit/push)
  #   afterFileEdit        -> pr-rules-gate (advisory PR-rule findings; Cursor
  #                           has no reliable pre-edit block)
  reg() { # $1=event  $2=command
    local t; t="$(mktemp)"
    jq --arg e "$1" --arg c "$2" '
      .hooks //= {} | .hooks[$e] //= [] |
      (if any(.hooks[$e][]?; .command==$c) then . else .hooks[$e] += [{command:$c, event:$e}] end)
    ' "$H" > "$t" && mv "$t" "$H"
  }
  reg "beforeShellExecution" "bash .cursor/hooks/adapter.sh --gate commit-gate.sh --tool Bash --mode pre"
  reg "afterFileEdit"        "bash .cursor/hooks/adapter.sh --gate pr-rules-gate.sh --tool Write --mode post"
  echo "install: Cursor wired (.cursor/: hektor.mdc rule + adapter on beforeShellExecution + afterFileEdit)"
fi

# ---------------------------------------------------------------------------
# 4) Any other LLM/harness — an AGENTS.md pointer (Codex, Gemini, etc. read it).
# ---------------------------------------------------------------------------
if [ "$do_agents" = 1 ]; then
  AG="$PROJ/AGENTS.md"; MARK="<!-- hektor:begin -->"
  if [ -f "$AG" ] && grep -qF "$MARK" "$AG"; then
    echo "install: AGENTS.md pointer already present"
  else
    { [ -f "$AG" ] && printf '\n'; cat <<'EOF'
<!-- hektor:begin -->
## Hektor QA methodology

Authoring + triage for the sahibinden Selenium/JUnit suite. Specs are plain
markdown at `.claude/skills/hektor-*/SKILL.md` — read them directly.

BEFORE writing code, read the kernel for the repo you're touching:
- web-test (`*Page/*Layout/*Test.java`): `.claude/skills/hektor-conventions/SKILL.md`
- test-data-client (`*ResourceClient/AbName.java`): `.claude/skills/hektor-resource-client/SKILL.md`
Router for the full flow: `.claude/skills/hektor-orchestrator/SKILL.md`.

PR reviewer (binding): every PR is scanned; a BLOCKER marks it Needs Work.
`.claude/hooks/pr-rules-gate.sh` mirrors those checks — run it / heed it before
opening a PR. Never `new XxxPage()`; no XPath in `@FindBy(css=…)`; no
`getRemoteWebDriver()`/`getShadowRoot()` in a test/layout; `@ScheduledDisable`
needs `reason`; `*ResourceClient` extends `AbstractService` + `@Component`;
`clients.*` URLs start with `/` and never contain `//`.

The agent never commits/pushes — the user reviews the working tree and commits.
<!-- hektor:end -->
EOF
    } >> "$AG"
    echo "install: AGENTS.md pointer added"
  fi
fi

# ---------------------------------------------------------------------------
# 5) Kits — delegate to each kit's own installer. LAST, so a kit's harness
#    registrations land on top of the pack's rather than under them.
#
#    Why delegate instead of shipping a copy under skills/: the flaky-triage kit
#    used to exist TWICE — once as kits/flaky-triage-kit (maintained) and once as
#    skills/hektor-flaky-triage (a frozen fork). Both installed to the SAME path,
#    .claude/skills/hektor-flaky-triage, so whichever installer ran last won, and
#    running this one last silently downgraded a hardened kit to the stale fork.
#    The fork is gone; the kit is now the single source and installs itself here.
#    Sibling skills that reference `hektor-flaky-triage/core/*` (hektor-verify,
#    hektor-bug-discovery, hektor-visual-regression) keep resolving unchanged —
#    the install path is identical, only the content is now the maintained one.
# ---------------------------------------------------------------------------
for kit_installer in "$HERE"/kits/*/install.sh; do
  [ -x "$kit_installer" ] || continue
  kit_name="$(basename "$(dirname "$kit_installer")")"
  "$kit_installer" --harness "$HARNESS" --project "$PROJ"; kit_rc=$?
  if [ "$kit_rc" -eq 0 ]; then
    echo "install: kit '$kit_name' installed (delegated to its own installer)"
  else
    # Never fail the whole pack install because one kit's installer did — the pack's
    # skills/hooks are already in place and useful on their own. Say so loudly instead.
    echo "install: WARN kit '$kit_name' installer FAILED (exit $kit_rc) — pack assets are installed, that kit is NOT; re-run $kit_installer to see why" >&2
  fi
done

cat >&2 <<EOF

install: done ($HARNESS) in $PROJ
next:
  1) restart Claude Code / Cursor so the new hooks load
  2) read  .claude/skills/hektor-conventions/SKILL.md  (web-test rules)
       and  .claude/skills/hektor-resource-client/SKILL.md  (test-data-client rules)
kill switches (per gate): HEKTOR_PR_RULES_GATE=off · HEKTOR_COMMIT_GATE=off · … ·
                          HEKTOR_CURSOR_HOOKS=off (all Cursor adaptation)
EOF
