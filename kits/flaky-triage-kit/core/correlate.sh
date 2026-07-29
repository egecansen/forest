#!/bin/bash
# core/correlate.sh — extract the dev tickets ("Issue Distribution" / linked issues) from a Jira issue JSON.
#
# The skill fetches the report's build.jiraTicket via the Atlassian MCP (jira_get_issue, fields=issuelinks),
# unescapes the result, and pipes the inner issue JSON here. This is the deterministic PARSE only
# (read-only; the kit never writes Jira — I8). Cross-referencing clusters↔tickets is the skill's job.
#
# Output: { distribution:[...], confounds:[...], other:[...] } of {key,summary,itype,rel}.
#   DEP ticket  → distribution = issuelinks of type "Deployment" (the shipped dev tickets).
#   Story/Task  → distribution empty; use 'other' (linked, e.g. Cloners) + the parent epic (caller fetches).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_integrity.sh"; integrity_guard "$HERE/.." || exit 76
command -v jq >/dev/null || { echo "correlate: jq required" >&2; exit 69; }

jq '
  [ .issuelinks[]?
    | (.outward_issue // .inward_issue) as $i
    | select($i != null)
    | {key:$i.key, summary:$i.fields.summary, itype:$i.fields.issuetype.name, rel:.type.name} ]
  | unique_by(.key)
  | { dev_links:    [ .[] | select(.rel!="Tests") ],            # EVERY linked dev ticket — skill fetches each one hop + reads its description
      distribution: [ .[] | select(.rel=="Deployment") ],       # DEP ⇒ Issue Distribution
      confounds:    [ .[] | select(.rel=="Conflict" or .rel=="Defect") ] }
'
# NOTE: the build's jiraTicket is BUILD-LEVEL (tags every failing test) — a FALSE per-cluster signal.
# True scope = the ticket's description + ALL dev_links (+ parent epic + epic siblings), read one hop.
