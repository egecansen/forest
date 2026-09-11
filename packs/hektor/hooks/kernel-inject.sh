#!/bin/bash
# kernel-inject.sh — put the Hektor router in front of the agent at session start.
#
# Event   : sessionStart
# Mode    : additive only (never blocks; sessionStart has no permission verdict)
# State   : none (reads the installed skill list)
# Env     : HEKTOR_KERNEL_INJECT=off   skip the injection
#
# Why
# ---
# Skills are pulled in on demand: Cursor reads each SKILL.md's `description` and
# loads the body when a task looks relevant. That works well once the agent knows
# Hektor exists — but the highest-cost mistake in this repo is writing a
# *Page/*Layout/*Test.java file WITHOUT having read the conventions kernel, and
# that is exactly the case where nothing has cued the selector yet.
#
# So this hook states the two non-negotiables and the routing table once per
# session, in ~40 lines. It deliberately does NOT inline the rules themselves —
# that is what the skills are for, and duplicating them here would give two
# sources of truth that drift.
#
# `beforeSubmitPrompt` would be the natural home for per-prompt detection, but
# its output schema is only {continue, user_message} — it can veto a prompt, not
# add context. sessionStart's `additional_context` is the injection point Cursor
# actually provides.
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

[ "${HEKTOR_KERNEL_INJECT:-on}" = "off" ] && exit 0
hektor_gate_init kernel-inject "standard,strict"

ROOT="$(hektor_repo_root)"
SKILLS="$ROOT/.cursor/skills"
[ -d "$SKILLS" ] || exit 0   # Hektor not installed here — say nothing

# Only advertise skills that are actually installed, so the router can never
# point at a skill that isn't there.
have() { [ -f "$SKILLS/$1/SKILL.md" ]; }
line() { have "$1" && printf -- '- `/%s` — %s\n' "$1" "$2"; }

CTX="## Hektor is installed in this repo

QA authoring + triage for the sahibinden Selenium/JUnit suite. Skills load on
demand; invoke one explicitly with \`/<name>\` or just describe the task.

**Before writing Java, read the kernel for the repo you are touching.** This is
the one rule worth stating up front, because a PR that breaks it is marked
\"Needs Work\" by the automated reviewer:
"
have hektor-conventions && CTX="${CTX}
- \`web-ui-test/\` (\`*Page.java\`, \`*Layout.java\`, \`*Test.java\`) → \`/hektor-conventions\`
  (strengthen an existing test method for an assertion gap — same CSS on a different UI layout is not a clone)"
have hektor-resource-client && CTX="${CTX}
- \`test-data-client/\` (\`*ResourceClient.java\`, \`AbName.java\`) → \`/hektor-resource-client\`
- a missing REST helper while writing a web-test → \`/hektor-resource-client\` (reuse first; else \`tech/TDC-<n>\` — never a client in web-ui-test)"
have hektor-test-dao && CTX="${CTX}
- \`test-dao/\` (\`*DAO.java\`, \`*DAOImpl.java\`) → \`/hektor-test-dao\`
- a missing SQL helper while writing a web-test → \`/hektor-test-dao\` (reuse first; else \`tech/DAO-<n>\`)"

ROUTING="$(
  line hektor-orchestrator      "the router — start here for \"test this feature end to end\""
  line hektor-from-jira         "a ticket key: fetch, plan, author, run"
  line hektor-journey-mapping   "map a domain's user journeys before covering it"
  line hektor-test-composer     "one journey's whole test portfolio"
  line hektor-page-authoring    "a missing Page/Layout object"
  line hektor-resource-client   "a missing ResourceClient — reuse TDC source, or tech/TDC-<n>"
  line hektor-test-dao          "a missing DAO method — reuse test-dao source, or tech/DAO-<n>"
  line hektor-coverage-expansion "walk the journey map and expand coverage"
  line hektor-failure-diagnosis "one failing test"
  line hektor-test-repair       "a rotted suite, clustered by root cause"
  line hektor-flaky-triage      "a flaky run"
  line hektor-verify            "evidence-first check of a single change"
)"
[ -n "$ROUTING" ] && CTX="${CTX}

Routing:
${ROUTING}"

CTX="${CTX}

Enforcement is live: the agent does not \`git commit\` / \`git push\` (you review
and commit), destructive shell is blocked, and PR-reviewer BLOCKER rules veto the
write that would trip them. Each gate has its own kill switch — see
\`.cursor/hooks/README.md\`."

hektor_context "$CTX"
exit 0
