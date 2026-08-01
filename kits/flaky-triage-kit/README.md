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
`.claude/hooks/flaky-kit-self-protection-gate.sh`, that gate's vendored `lib/`, the Cursor gate and
libs under `.cursor/hooks/`, the out-of-tree `.flaky-kit-expect` tier record, and both hook
directories as `mv`/`rm` operands. The gate is installed OUTSIDE this tree deliberately, so renaming
the tree can't take the detector with it. It denies agent writes to any of that unless
`HEKTOR_FLAKYKIT_UNLOCK=1` — real denials, honored by the CLI, but a heuristic string match all the
same: friction and an audit trail, not a wall.

**The harness settings files are on that surface too** — `.claude/settings.json`,
`.claude/settings.local.json` and `.cursor/hooks.json` — because unregistering the gate is cheaper
than editing it, and everything above is downstream of that one registration existing. The two tool
branches ask different questions about them, deliberately:

- **Bash — any mutation is denied**, whether or not it would actually change the registration. No
  file content is available there, so the rule is a path-plus-verb match. Expect these to be denied
  even though they look harmless: `cp .claude/settings.json /tmp/x` (a *copy out* still names a
  mutating verb), and `rm -f .claude/settings.json.bak` (the pattern has no end-of-token boundary, so
  any path merely *beginning* with a settings path matches — a known imprecision, erring toward
  flagging). Reads pass: `cat` / `jq .` on those files are untouched.
- **Write/Edit — decided by outcome.** The payload is available, so the gate asks whether the kit's
  registration survives the change and denies only when it would not. Editing permissions, env or
  model is allowed; so is *widening* the registration (`Write|Edit` → `Write|Edit|MultiEdit`, or both
  matchers collapsed into one `*`). Narrowing it, dropping a matcher, or proposing unparseable JSON is
  denied. A settings file that carries no registration today is not this kit's business at all.

`core/_integrity.sh` asks the second question — *will the gate actually run?* — from the same slot
model, so the two never disagree about what a valid registration is. Since 2026-07-31 it also REPAIRS
what it finds broken (`core/_wiring_repair.sh`, called between detection and reporting) — but only at a
tier that lets the run **proceed**: the registration is rewritten additively — `unregistered`,
`partial`, and `dangling` alike, with the same jq merge `install.sh` itself performs — and the gate
FILE is restored from the engine's own vendored copy; `foreign` is never touched either way. **At every
tier that REFUSES — `hardened`, `stale` and `mismatch` — nothing is written at all, not the gate file
and not the registration.** An
earlier version repaired the registration there too, on the theory that a rewritten registration
doesn't arm the session that wrote it, so the refusal would hold anyway. Measured, that held for
exactly one call: `integrity_guard` recomputes both axes from the filesystem every time, so the next
entrypoint read the registration it had just written, saw `wired`, and returned 0 — one call refusing,
every call after it silently unprotected. `mismatch` was missed by the first correction, which said
"where the tree is root-owned" and so reached the other two but not the one tier whose whole meaning is
a recorded root ownership the tree does *not* have — measured there, the repair copied the gate script
out of a tree the same run declares untrustworthy into the kit's own protection-hook path, and flipped
the axis from `dangling` to `wired`. Corrected: at all three the guard detects, says what is
wrong, and writes nothing, so the refusal (exit 76) holds on every entrypoint because nothing on disk
ever changes. The printed advice there is still to unlock, reinstall, and lock — the only path that
actually changes anything at that tier.

The wall, where there is one, is underneath: `lock-kit.sh` reaches for an OS-level tier. **hardened** —
`core/**`, `SKILL.md`, the gate scripts, the vendored libs and the kit root itself chown'd to root, so
reopening needs a password — holds in every harness, because the kernel enforces it rather than a hook.
Without `sudo` it **degrades** to a chmod-only read-only bit the same user (and therefore an agent
running as them) can reverse — friction, not a wall. `lock-kit.sh status` names the tier actually in
effect and prints the OWNER of every surface path, which is the only way to spot a `chown` that applied
to some paths and not others. **Read `core/lock-kit.sh`'s header before calling a kit protected:** it
is the authoritative list of what the hardened tier does not cover, and it currently has thirteen entries.
All thirteen, so this page does not under-describe the tier the way it used to:

1. **Shadowing** — `mv` the kit dir aside and replace it. Detected via the out-of-tree record, not prevented.
2. **That record is itself deletable** — its directory must stay user-owned, so the same actor can erase the expectation.
3. **Every out-of-tree surface path** (both gate scripts, the vendored libs) is protected against *edit*, not against *replacement*: their parents stay user-owned.
4. **Social engineering** a human into running the unlock.
5. **Anything after the password is typed** — `lock`/`unlock` end with `sudo -k`, but the window between the prompt and the end of the privileged section remains.
6. **Partial hardening** — a `chown` can succeed on some operands and fail on others; the tier is sampled from `core/` alone. Announced and diagnosable, not prevented.
7. **The harness settings files are not chown'd at any tier**, hardened included — the harness keeps editing them for its own reasons. Their only protection is the PreToolUse gate described above: a heuristic policy layer with no ownership floor under it.
8. **The wiring check reads the same settings files an agent can write.** It proves a registration is present and, where the tree is root-owned, that it points at a file this kit still owns. It cannot prove the harness will *honour* that registration at any tier.
9. **A bare `.claude` operand matches no surface pattern**, so `rm -rf .claude` is allowed — and at the hardened tier it unlinks the root-owned gate, the audit lib, `.flaky-kit-expect` and the registration itself. Pre-existing and scheduled as separate work: widening the pattern to a bare `.claude` changes the surface from "the kit's files" to "the harness's entire configuration tree" and needs its own design round.
10. **A repair arms on the next session, never the one that made it.** The harness reads hook config at startup, so between the repair and a restart the gate is registered and not running.
11. **The kit repairs its own registration only.** A neighbouring pack's stale registration is not the kit's to fix and is not fixed.
12. **Below a root-owned tree the restore source has no more protection than anything else** — a poisoned `core/gate-src` restores a poisoned gate. That is what the lower tiers already mean.
13. **The registration repair is purely additive, never a purge.** `install.sh` drops a pre-relocation registration before merging; the repair does not, so a dead command it finds stays registered forever alongside whatever the repair adds. It does not block convergence — the relocated path sorts ahead of the pre-relocation one *within one settings file* (not guaranteed split across `settings.json`/`settings.local.json`: `integrity_wiring` concatenates each file's `unique` output in file order and `_wiring_cover` takes the first line, so there is no cross-file sort. Measured with the dead entry in `settings.json` and the relocated one in `settings.local.json`, the cover for `PreToolUse:Bash` is the *pre-relocation* command and the verdict is `dangling`). The repair still converges there, because it always writes into `settings.json`, which is read first — measured, `dangling` on the read before and `wired` on the read after a single repair call. So once the relocated gate file exists the axis reads `wired` while a harness that runs every registered hook, not only the one this axis checks, still attempts the dead command on every matching call: the original symptom, now invisible to the axis that used to catch it. Re-running the installer, which does purge it, is the actual fix.
```bash
core/lock-kit.sh lock        # hardens (chown to root) when sudo is available; degrades to a
                              # chmod-only read-only bit otherwise. Ends with `sudo -k`, so the
                              # credential it just cached does not leave a no-prompt reopen window.
core/lock-kit.sh status      # per-path mode + OWNER + the effective tier
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
