# Hektor Flaky-Triage Kit

Triage a flaky **testbox** run for a Selenium/JUnit suite: take an s-report URL + a testbox, re-run the
report's failing tests on that box, present **one** easy-fix→likely-bug clusters table, the user picks,
then fix the picked ones end-to-end — verified green (pass^N), flagging suspected app-bugs. **Testbox-only.
Never commits, files tickets, or disables tests.**

The engine is plain shell, so it runs from **any** harness with a terminal (Claude Code, Cursor, Codex,
…, or a human). See [`cross-harness.md`](./cross-harness.md) for the capability matrix.

## Requirements
`bash` · `jq` · `curl` · `python3` · `gradle` (+ JDK 17 for the suite). Network access to your ES report
host and the testbox.

## Install — one command, every harness

Drop this `flaky-triage-kit/` folder anywhere and run the command:

```bash
./hektor-triage-kit install --project /path/to/your/repo      # default --harness all
# from anywhere after putting it on PATH:
./hektor-triage-kit link            # symlink onto ~/.local/bin
hektor-triage-kit install --project /path/to/your/repo
```

`install` auto-configures everything — **no manual config step**: it auto-detects **JDK 17** (writes
`run.java_home`) and **source_roots** (your `src/test/java`), then wires every harness. Other subcommands:
`hektor-triage-kit lock|unlock|status` (the OS-level protection tier — **hardened** when `sudo` is
available, chmod-only **degraded** otherwise; see `core/lock-kit.sh`'s header) and `link` (put it on PATH).
(`./install.sh` still works directly if you prefer.)

`all` wires it **everywhere** in one shot:
- **Claude Code** — engine + skill at `.claude/skills/hektor-flaky-triage/`, gate registered in `.claude/settings.json`.
- **Cursor** — rule + gate + vendored libs, registered in `.cursor/hooks.json`.
- **Any other LLM** (Codex, Gemini, …) — an `AGENTS.md` pointer block (appended, never clobbered).
- **Bare terminal / human** — the engine just runs; nothing else needed.

Scope it with `--harness claude|cursor|agents|both` if you want only some. It's **idempotent**
(re-runnable, no duplicate registrations, preserves existing settings/AGENTS.md). **Restart Claude
Code / Cursor** so the hooks load; the engine works from a terminal immediately.

## Configure (the only edit needed for a same-infra team)
Edit `<repo>/.claude/skills/hektor-flaky-triage/core/config.json`:
- `source_roots` — your test/page packages (where `apply` is allowed to write). **Required.**
- `run.workdir` — the Gradle module (default `web-ui-test`).
- `es.host` (+ add it to `es.host_allowlist`) / `qagent` / `jira` — already point at the shared org
  infra; change only if yours differs. **No secrets in this file** (it's the config seam, kernel §10).

Set the JDK once: `export HEKTOR_FK_JAVA_HOME=/path/to/jdk-17`.

## Run
The LLM drives the loop in `SKILL.md` by calling the engine:
```bash
KIT=.claude/skills/hektor-flaky-triage/core
"$KIT/ingest.sh"  "<s-report-url>"   > fails.json     # validates + pins the build; strips smuggled text
"$KIT/cluster.sh" < fails.json       > clusters.json  # root-cause clusters (bounds-capped)
"$KIT/rerun.sh"   "<fqcn-csv>" <tb>                    # the verification oracle (RERUN_EARLY_EXIT=0 = full N)
echo '{"file":"…","old":"…","new":"…"}' | "$KIT/apply.sh"   # working-tree edit, confined to source_roots
"$KIT/summary.sh" < ledger.json                        # convergence report (structured tokens only)
```

## Self-protection
The kit guards its own `core/` · `SKILL.md` — plus its own protection gate at
`.claude/hooks/flaky-kit-self-protection-gate.sh` (deliberately installed OUTSIDE this tree so
renaming the tree can't take the detector with it) — from silent self-modification (a gate that
denies agent writes there unless `HEKTOR_FLAKYKIT_UNLOCK=1`). Underneath that gate, `lock-kit.sh`
reaches for an OS-level tier: **hardened** — `core/**` and the kit root chown'd to root, so
reopening needs a password — is the wall that holds in every harness, because it's enforced by the
OS, not by any hook. Without `sudo` it **degrades** to a chmod-only read-only bit the same user (and
therefore an agent running as them) can reverse — friction, not a wall. `lock-kit.sh status` names
which tier is actually in effect.
```bash
core/lock-kit.sh lock        # hardens (chown to root) when sudo is available; degrades to a
                              # chmod-only read-only bit otherwise
HEKTOR_FLAKYKIT_UNLOCK=1 core/lock-kit.sh unlock
```

## Manual hook registration (if you skip install.sh)
**Claude Code** — add to `.claude/settings.json` under `hooks.PreToolUse`, on both a `"Write|Edit"` and a
`"Bash"` matcher:
```json
{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\"", "timeout": 10 }
```
**Cursor** — add to `.cursor/hooks.json`: the gate `.cursor/hooks/flaky-kit-self-protection-gate.sh` under
`beforeShellExecution` (no matcher) **and** under `preToolUse` with `"matcher": "Write|Edit"`. Ensure
`.cursor/hooks/lib/cursor-compat.sh` is present (vendored by install.sh).

## What's in here
```
core/         engine: ingest·cluster·rerun·apply·summary·compile·dom-capture / shell-guard·sanitize·lock-kit / config.json
adapters/
  claude/     SKILL.md + the gate (Claude format)
  cursor/     the gate (Cursor format) + standalone rule + vendored cursor-compat
install.sh    per-harness installer (idempotent)
kernel.md · cross-harness.md · enforcement-codeowners.md    the spec + portability + VCS-layer hardening
```

Spec: [`kernel.md`](./kernel.md). Engine contracts: `core/README.md`.
