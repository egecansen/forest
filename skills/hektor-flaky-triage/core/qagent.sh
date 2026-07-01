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
echo "qagent is skill-side (MCP tools mcp__qagent__*); see SKILL.md §evidence and kernel §5.0" >&2
exit 64
