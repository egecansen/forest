# Hektor

A shareable QA methodology pack for the sahibinden Selenium/JUnit suite —
skills + enforcement gates that help you author `*Page/*Layout/*Test.java`
(web-test) and `*ResourceClient/AbName.java` (test-data-client) so code **passes
the automated PR reviewer on the first try**, plus journey mapping, coverage
expansion, flaky triage, EDR/VRT/security workflows.

Works on **Claude Code**, **Cursor**, and any AGENTS.md-reading LLM (Codex,
Gemini, …) from one install.

## Install (teammates: start here)

Add the `hektor/` directory to your repo (clone or copy it in), then run one
command from the repo:

```bash
./hektor/hektor package install        # wires Claude Code + Cursor + AGENTS.md
```

Then **restart Claude Code / Cursor** so the hooks load. That's it — re-running
is safe (idempotent). Requires `jq` on PATH.

Want the bare `hektor` command instead of `./hektor/hektor`? Link it once:

```bash
./hektor/hektor package link           # symlinks `hektor` into ~/.local/bin
hektor package install                 # now works from any repo you're in
```

### The `hektor` CLI

| Command | Does |
|---|---|
| `hektor package install [--project DIR] [--harness all\|claude\|cursor\|agents]` | wire the pack into a repo (auto-detects the repo you run from) |
| `hektor package status [--project DIR]` | show what's installed |
| `hektor doctor [--project DIR]` | self-audit the pack (no dead routes / valid schemas / gates installed) |
| `hektor package uninstall [--project DIR]` | remove Hektor (leaves your other `.claude`/`.cursor` entries untouched) |
| `hektor package link` / `unlink` | put `hektor` on / off your PATH |
| `hektor version` / `help` | — |

`install` under the hood just runs `install.sh`, which you can also call directly
(`./install.sh --project /path/to/repo`). Install into each repo you work in
(`web-test`, `test-data-client`, …).

## What you get

- **Skills** (`.claude/skills/hektor-*/`) — the authoring/triage playbooks. The
  two that make PRs pass:
  - `hektor-conventions` — every **web-test** PR-reviewer rule (BLOCKER/WARNING)
    with the correct pattern. Read before any `*Page/*Layout/*Test.java`.
  - `hektor-resource-client` — the **test-data-client** rules (`extends
    AbstractService`, `@Component`, `clients.*` URL shape, `@Slf4j`, enum casing).
- **`pr-rules-gate`** — a local mirror of the reviewer's deterministic (Katman
  1a) checks that runs **at write-time**, so a violation is caught before you
  push instead of on the PR. Hard block on Claude Code; advisory on Cursor.
- **`commit-gate`** and the rest of the enforcement layer (see
  [`hooks/README.md`](./hooks/README.md)).

## Harness support

| | Claude Code | Cursor | Other LLMs |
|---|---|---|---|
| Skills / rules | native | `.cursor/rules/hektor.mdc` → same skills | `AGENTS.md` pointer |
| `pr-rules-gate` | hard block | advisory (`afterFileEdit`) | run by hand |
| `commit-gate` | hard block | hard block (`beforeShellExecution`) | — |

Cursor support is the **ECC adapter-shim pattern** (`github.com/affaan-m/ECC`):
one thin translator (`.cursor/hooks/adapter.sh`) runs the *unmodified*
`.claude/hooks/*.sh` gates under Cursor's events. Full detail + the compliance
matrix: [`docs/cross-harness.md`](./docs/cross-harness.md).

## Kill switches

Each gate has its own env switch — `HEKTOR_PR_RULES_GATE=off`,
`HEKTOR_COMMIT_GATE=off`, … — for a deliberate, documented exception.
`HEKTOR_CURSOR_HOOKS=off` disables all Cursor adaptation.

## Layout

```
hektor                  the CLI — `hektor package install|status|uninstall|link`
install.sh              the installer the CLI drives (Claude + Cursor + AGENTS.md)
catalog.json            skill/kit index
settings.hooks.json     Claude gate registrations (merged into .claude/settings.json)
skills/hektor-*/        the skills
hooks/                  the enforcement gates (+ hooks/README.md)
schemas/                subagent return-shape contracts
adapters/cursor/        the Cursor adapter shim (adapter.sh, lib/, rules/)
kits/flaky-triage-kit/  the standalone flaky-triage kit (own installer)
docs/cross-harness.md   how it maps across harnesses
```

## Note on commits

The gates enforce a team rule: **the agent never commits or pushes** — you
review the working tree and commit yourself. That's intentional, not a bug.
