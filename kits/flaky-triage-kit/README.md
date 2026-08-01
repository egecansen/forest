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

## Delivery gate
On Claude Code, the delivery gate — installed to `.claude/hooks/flaky-kit-delivery-gate.sh` (source:
`adapters/claude/flaky-kit-delivery-gate.sh`) — runs at session **Stop** and refuses to let a session
end unproven. It carries two checks, deliberately at different hardness:

- **I11** — derives the ledger path(s) straight out of the transcript and runs
  `core/ledger.sh validate <ledger> --final` on each (that argument order: the file first, the flag
  after — reversed, the command exits 65 "not a ledger" rather than I11's own 67). This blocks **every** stop
  while any cluster is still `selected`/`applied`: no `stop_hook_active` escape, and **no environment
  bypass** — the remedy is entirely in the agent's hands (move each cluster to green/flagged/deferred
  and finish again). A session that ran `core/apply` or `core/rerun` and left no ledger at all is
  blocked the same way; a session that only `ingest`ed or `cluster`ed passes with no check; a session
  that never touched the kit is silent.

  **The no-ledger half has a one-token escape, and it is deliberate.** It fires only when the
  transcript names no `core/ledger` at all. A session that ran `core/apply` and also mentions the
  token — `true # core/ledger` is enough — takes the fail-open arm instead: audited, not blocked
  (verified: `core/apply.sh c3` alone blocks; the same session plus that one command passes). That
  arm exists because a ledger path containing a space cannot be resolved by a transcript scan that
  splits on whitespace, and blocking there would be unanswerable — the I11 half has no
  `stop_hook_active` escape, so following the block's own printed remedy reproduces the block and the
  session loops with no way out. A false block with no exit is worse than a hole that leaves an audit
  line, so the hole stays and is named here rather than left for a reader to find. **The
  open-cluster half above has no such escape**: it reads the ledger's state, not the transcript's
  wording.
- **hedge-scan** — re-runs the same scan `SKILL.md` already asks the agent to pipe its own summary
  through, this time over the session's last assistant message. This blocks **once**: a false
  positive costs one extra turn, not the rest of the session.

Every path the gate can't evaluate — no `jq`, an unreadable transcript, the engine not found, a
`validate --final` that exits something other than a verdict — fails open and writes one audit line;
it never wedges a caller and never fails silently. It is Claude-only: Cursor has no Stop event, so on
Cursor these two remain what they always were, prose the agent is trusted to honour.

## Self-protection
The kit guards its own `core/` · `SKILL.md` — plus its own protection gate at
`.claude/hooks/flaky-kit-self-protection-gate.sh`, the delivery gate beside it at
`.claude/hooks/flaky-kit-delivery-gate.sh`, that gate's vendored `lib/`, the Cursor gate and
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

The delivery gate's `Stop` registration is a slot of that same model, so a `del(.hooks.Stop)` that
leaves `PreToolUse` untouched is denied exactly as dropping a `PreToolUse` matcher is — the two
controls are unregistered by the same edit and cost the same. A settings file that carries no `Stop`
registration (any install predating the delivery gate) does not start needing one: the rule is
"would lose what it has", never "must always end registered".

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

It announces a repair only where one actually happened. The repair re-merges **every** slot whenever
the axis reports any failure, so on a mixed state (one control broken, another already fine) each
merge that had nothing to add is an idempotent no-op — and *"REPAIRED — the … registration has been
rewritten"* is a claim about a state change, false when no state changed. All three registrars
(Claude `PreToolUse`, Cursor, Claude `Stop`) therefore report three outcomes rather than two — landed
and changed, landed and changed nothing, did not land — and only the first is announced, by name, per
control. Silence from one of them means it had nothing to do, never that it was skipped: a merge that
does not land says so on stderr instead.

The wall, where there is one, is underneath: `lock-kit.sh` reaches for an OS-level tier. **hardened** —
`core/**`, `SKILL.md`, the gate scripts, the vendored libs and the kit root itself chown'd to root, so
reopening needs a password — holds in every harness, because the kernel enforces it rather than a hook.
Without `sudo` it **degrades** to a chmod-only read-only bit the same user (and therefore an agent
running as them) can reverse — friction, not a wall. `lock-kit.sh status` names the tier actually in
effect and prints the OWNER of every surface path, which is the only way to spot a `chown` that applied
to some paths and not others. **Read `core/lock-kit.sh`'s header before calling a kit protected:** it
is the authoritative, living list of what the hardened tier does not cover — that file, not this page,
is the one to trust for the current count. What follows is a copy for this page's convenience, kept in
step by hand and not a substitute for the header; if the two ever disagree, the header wins:

1. **Shadowing** — `mv` the kit dir aside and replace it. Detected via the out-of-tree record, not prevented.
2. **That record is itself deletable** — its directory must stay user-owned, so the same actor can erase the expectation.
3. **Every out-of-tree surface path** (all three gate scripts — both self-protection gates and the delivery gate — and the vendored libs) is protected against *edit*, not against *replacement*: their parents stay user-owned.
4. **Social engineering** a human into running the unlock.
5. **Anything after the password is typed** — `lock`/`unlock` end with `sudo -k`, but the window between the prompt and the end of the privileged section remains.
6. **Partial hardening** — a `chown` can succeed on some operands and fail on others; the tier is sampled from `core/` alone. Announced and diagnosable, not prevented.
7. **The harness settings files are not chown'd at any tier**, hardened included — the harness keeps editing them for its own reasons. Their only protection is the PreToolUse gate described above, which since 2026-08-01 covers the delivery gate's `Stop` registration as well as the self-protection gate's `PreToolUse` one: a heuristic policy layer with no ownership floor under it. It denies only a change that would *lose* a registration the file carries today, never "must always end registered".
8. **The wiring check reads the same settings files an agent can write.** It proves a registration is present and, where the tree is root-owned, that it points at a file this kit still owns. It cannot prove the harness will *honour* that registration at any tier.
9. **A bare `.claude` operand matches no surface pattern**, so `rm -rf .claude` is allowed — and at the hardened tier it unlinks the root-owned self-protection gate, the root-owned delivery gate, the audit lib, `.flaky-kit-expect` and both registrations. Pre-existing and scheduled as separate work: widening the pattern to a bare `.claude` changes the surface from "the kit's files" to "the harness's entire configuration tree" and needs its own design round.
10. **A repair arms on the next session, never the one that made it.** The harness reads hook config at startup, so between the repair and a restart the gate is registered and not running.
11. **The kit repairs its own registration only.** A neighbouring pack's stale registration is not the kit's to fix and is not fixed.
12. **Below a root-owned tree the restore source has no more protection than anything else** — a poisoned `core/gate-src` restores a poisoned gate. That is what the lower tiers already mean.
13. **The registration repair is purely additive, never a purge.** `install.sh` drops a pre-relocation registration before merging; the repair does not, so a dead command it finds stays registered forever alongside whatever the repair adds. It does not block convergence — the relocated path sorts ahead of the pre-relocation one *within one settings file* (not guaranteed split across `settings.json`/`settings.local.json`: `integrity_wiring` concatenates each file's `unique` output in file order and `_wiring_cover` takes the first line, so there is no cross-file sort. Measured with the dead entry in `settings.json` and the relocated one in `settings.local.json`, the cover for `PreToolUse:Bash` is the *pre-relocation* command and the verdict is `dangling`). The repair still converges there, because it always writes into `settings.json`, which is read first — measured, `dangling` on the read before and `wired` on the read after a single repair call. So once the relocated gate file exists the axis reads `wired` while a harness that runs every registered hook, not only the one this axis checks, still attempts the dead command on every matching call: the original symptom, now invisible to the axis that used to catch it. Re-running the installer, which does purge it, is the actual fix.
14. **The delivery gate is Claude-only** — Cursor has no Stop event, so on Cursor I11 and hedge-scan
remain what they were before this change: prose the agent is trusted to honour.
15. **The gate reads the transcript the harness wrote, not the session itself** — it proves what
was recorded, not what happened; a ledger the agent never named on a command line is invisible to it.
16. **`core/apply`/`core/rerun` is the dividing line for "work was done"** — a session that changed
things some other way and left no ledger is not caught.
17. **The delivery gate's own protection is entirely second-order.** It is a `Stop` hook: it runs
once, at end-of-session, and observes no tool call, so it can never deny the call that removes it.
Everything that does deny that call — the surface match on its file, and the outcome test that
refuses an edit dropping its `Stop` registration — lives in the *PreToolUse self-protection gate*.
Defeat that gate first (residual 7's escape classes, or residual 9's bare `.claude`) and the delivery
gate falls with no further friction. Root-owning its file buys less here than residual 3 concedes:
the registration is not chown'd at any tier, and unregistering is cheaper than editing. Detected
afterwards by the wiring axis — but only on the *next* entrypoint, and a session whose whole goal is
to stop never runs one.
18. **The no-ledger block has a one-token escape, by design** — see the delivery-gate section above
for what it is, why it is there, and why it audits instead of blocking.
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
...and the delivery gate under `hooks.Stop` (one entry, no matcher — `Stop` fires once per session):
```json
{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-delivery-gate.sh\"", "timeout": 20 }
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
