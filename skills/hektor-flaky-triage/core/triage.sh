#!/bin/bash
# core/triage.sh — convenience entrypoint: ingest + cluster in one call.
# Contract: $1 = s-report URL → stdout JSON [clusters]
# (The skill then re-groups by MEANING, presents ONE easy→bug table, and on selection drives
#  apply→compile→rerun→ledger→summary. Keep it simple — see SKILL.md "Presentation discipline".)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${1:-}" ] || { echo "usage: triage.sh <s-report-url>" >&2; exit 64; }
"$HERE/ingest.sh" "$1" | "$HERE/cluster.sh"
