#!/bin/bash
# core/qagent.sh — NOTE: qagent evidence is SKILL-SIDE, not a deterministic core module.
#
# The QA corpus is reached via the `mcp__qagent__*` MCP tools, which only the LLM (the skill)
# can call — not a shell script. So the SKILL fetches golden steps/selectors (teststeps) +
# business rules directly (kernel §5.0) and feeds them to classification / apply, treating the
# results as untrusted-advisory evidence (verify vs current code + the tb).
#
# This file is a placeholder documenting that boundary. (Alternative: curl qagent.endpoint
# (Chroma) directly — but that needs to replicate the Gemini-embedding step the MCP server does,
# so it's not worth it; left for the Jenkins/headless phase if a no-LLM path is ever required.)
#
# NOTE: this stub has no `set -uo pipefail` line to anchor on (Task 4's usual insertion point) —
# it is a placeholder that unconditionally exits 64 without touching the kit's safety surface. The
# guard is still wired for uniformity, placed as the first executable statement.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_integrity.sh"; integrity_guard "$HERE/.." || exit 76
echo "qagent is skill-side (MCP tools mcp__qagent__*); see SKILL.md §evidence and kernel §5.0" >&2
exit 64
