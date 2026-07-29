#!/bin/bash
# core/hedge-scan.sh — cheap deterministic pre-screen: does the fixer's own summary
# HEDGE? A hit means "don't trust this as done — escalate to the independent reviewer."
#
# Port of ECC agent-self-evaluation danger_patterns (skills/agent-self-evaluation/
# scripts/evaluate.py:66-76: "should work / probably / untested" → deduction; :349-351
# min<=2 → Redo). Runs BEFORE spending a reviewer/judge call, so trivially-hedged
# work is caught for free.
#
# Usage:  printf '%s' "$fixer_summary" | core/hedge-scan.sh
#   exit 0  = clean (no hedging)
#   exit 2  = hedged; matched phrases printed to stdout (feed them into the reviewer brief)
set -uo pipefail
TXT="$(cat)"
[ -n "$TXT" ] || exit 0

RE='(should (probably )?work|probably (fine|works|ok)|i think (it|this) works|likely (fine|works)|seems? to work)'
RE="$RE"'|(only ran|ran) (it |this )?once\b|didn.?t (fully |really )?(verify|test|check)|not (fully |100%%? )?(verified|tested|sure)'
RE="$RE"'|(hopefully|presumably|in theory|should be (fine|ok|enough))'
RE="$RE"'|(4/5|3/5|2/3|most) .{0,20}(runs?|passes) .{0,15}(fine|good enough|ok\b)'
RE="$RE"'|(assume|assuming) (it|this|the fix) (works|holds|is fine)'

HIT="$(printf '%s' "$TXT" | grep -ioE "$RE" 2>/dev/null | sort -u | head -6)"
if [ -n "$HIT" ]; then
  printf 'HEDGED — the fix summary is not confident; escalate to an independent reviewer:\n%s\n' "$HIT"
  exit 2
fi
exit 0
