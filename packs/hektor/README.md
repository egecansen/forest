# Hektor

A shareable QA methodology pack for the sahibinden Selenium/JUnit suite, built for
**Cursor** — skills + enforcement gates that help you author `*Page/*Layout/*Test.java`
(web-test) and `*ResourceClient/AbName.java` (test-data-client) so code **passes the
automated PR reviewer on the first try**, plus journey mapping, coverage expansion,
flaky triage, EDR/VRT/security workflows.

## Install (teammates: start here)

Add the `hektor/` directory to your repo (clone or copy it in), then run one
command from the repo:

```bash
./hektor/hektor package install
```

Then **reload the Cursor window** (`Cmd/Ctrl+Shift+P` → *Developer: Reload
Window*) so the skills and hooks load. That's it — re-running is safe
(idempotent). Requires `jq` on PATH.

Want the bare `hektor` command instead of `./hektor/hektor`? Link it once:

```bash
./hektor/hektor package link           # symlinks `hektor` into ~/.local/bin
hektor package install                 # now works from any repo you're in
```

### The `hektor` CLI

| Command | Does |
|---|---|
| `hektor package install [--project DIR] [--no-kits]` | wire the pack into a repo (auto-detects the repo you run from) |
| `hektor package status [--project DIR]` | show what's installed, and flag any registration pointing at a missing script |
| `hektor doctor [--project DIR]` | self-audit the pack (no dead routes / valid frontmatter / real Cursor events / valid schemas) |
| `hektor package uninstall [--project DIR]` | remove Hektor (leaves your other `.cursor` entries and your run state untouched) |
| `hektor package link` / `unlink` | put `hektor` on / off your PATH |
| `hektor version` / `help` | — |

`install` under the hood just runs `install.sh`, which you can also call directly
(`./install.sh --project /path/to/repo`). Install into each repo you work in
(`web-test`, `test-data-client`, …).

## What you get

Everything lands under the project's `.cursor/`, which is the only tree Cursor reads:

```
.cursor/
├── skills/<name>/SKILL.md    auto-invoked by description, or explicitly as /<name>
├── agents/hektor-*.md        the subagent roles the skills dispatch
├── rules/hektor-kernel.mdc   always applied — the router + the testbox contract
├── hooks/ + hooks.json       the enforcement gates
└── schemas/                  subagent return contracts
```

- **Skills** — the authoring/triage playbooks. The two that make PRs pass are
  glob-scoped, so they attach automatically when you open a file they govern:
  - `hektor-conventions` — every **web-test** PR-reviewer rule (BLOCKER/WARNING)
    with the correct pattern. Attaches on `web-ui-test/**/*.java`.
  - `hektor-resource-client` — the **test-data-client** rules (`extends
    AbstractService`, `@Component`, `clients.*` URL shape, `@Slf4j`, enum casing).
    Attaches on `*ResourceClient.java` / `AbName.java`.

  Start anywhere else with `/hektor-orchestrator`, or just describe the task.

- **Subagents** — `hektor-composer`, `-prober`, `-diagnoser`, `-reviewer`,
  `-mapper`, `-distiller`. The skills dispatch these in parallel; the reviewer is
  `readonly: true` because its whole job is to inspect, not to fix.

- **`pr-rules-gate`** — a local mirror of the reviewer's deterministic (Katman 1a)
  checks that runs **at write-time**, so a violation is caught before you push
  instead of on the PR. BLOCKERs veto the write; WARNINGs come back as a note.

- **The rest of the enforcement layer** — see [`hooks/README.md`](./hooks/README.md).

## Enforcement at a glance

| Cursor event | Gates | Effect |
|---|---|---|
| `sessionStart` | kernel-inject | injects the router once per session |
| `beforeShellExecution` | commit, destructive-command | hard block |
| `preToolUse` | pr-rules, invisible-unicode, journey-map-sentinel, run-status-write, enforcement-self-protection | hard block |
| `subagentStart` | approver-registry, reviewer-brief, schema-preread, dispatch-ordering, first-pass-guard | deny |
| `subagentStop` | reviewer-attestation, return-schema | follow-up turn |
| `postToolUse` | pr-rules (advisory half), observe | note / silent capture |
| `stop` | delivery-gate | follow-up turn |

## Kill switches

Each gate has its own env switch — `HEKTOR_PR_RULES_GATE=off`,
`HEKTOR_COMMIT_GATE=off`, … — for a deliberate, documented exception. Coarser
dials: `HEKTOR_HOOK_PROFILE=minimal|standard|strict` picks a tier,
`HEKTOR_DISABLED_HOOKS=a,b` names gates, and `HEKTOR_CURSOR_HOOKS=off` disables
the whole layer.

These are friction, not a security boundary — the agent being gated can set every
one of them. Their use is recorded to `docs/hektor/.hook-audit.log`. See
[`hooks/README.md`](./hooks/README.md) §Vulnerabilities.

## Layout

```
hektor                  the CLI — `hektor package install|status|doctor|uninstall|link`
install.sh              the installer the CLI drives
catalog.json            skill/kit index
hooks.json              gate registrations (merged into .cursor/hooks.json)
skills/<name>/          the skills
agents/                 the subagent role definitions
rules/                  the always-applied kernel rule
hooks/                  the enforcement gates (+ hooks/README.md)
schemas/                subagent return-shape contracts
kits/flaky-triage-kit/  the standalone flaky-triage kit (own installer)
docs/cursor-parity.md   what Cursor gives the pack, and the one thing it doesn't
```

## Note on commits

The gates enforce a team rule: **the agent never commits or pushes** — you
review the working tree and commit yourself. That's intentional, not a bug.
