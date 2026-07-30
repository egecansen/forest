# Flaky-Triage Kit — Improvement Report

**Date:** 2026-07-30 · **Scope:** `kits/flaky-triage-kit` · **Branch:** `worktree-kit-wiring-self-check`
**Status:** Tasks 1–4 merged into the branch and reviewed clean; Task 5 (this document, plus the residual sweep) in progress.

## What this covers

Two connected pieces of work on the same defect: **a control that is not itself guarded.**

The kit's job is to stop an agent from quietly rationalising away a red test. It does that with a
`PreToolUse` gate plus a deterministic engine. For that to mean anything, two things have to be true —
the kit's own files must be protected, and the gate that enforces the protection must actually run.
Neither was fully true.

| | Was | Is |
|---|---|---|
| Kit files | `chmod`-only, reversible by the same user in one command | Root-owned at the `hardened` tier; changing it needs a password |
| The gate's wiring | Never checked. A stale registration produced a non-blocking "No such file" on every tool call and no statement anywhere that protection was off | Checked on every entrypoint, on its own axis, with the registered path resolved |
| The registration itself | Deletable outright — `sed -i '' .claude/settings.json` was a verified ALLOW | Bash mutations denied; Write/Edit denied only when the registration would not survive |

## Part 1 — The lock (2026-07-29)

The lock claimed human consent it did not have. `chmod` is reversible by the file's owner, so the
"locked" kit could be unlocked, edited and relocked by the same agent it was constraining, with no
human in the loop.

The only real privilege asymmetry available on a dev laptop is **root ownership plus a
password-gated `sudo`**. `chflags uchg` was rejected because the owner can both set and clear it.
That produced three tiers, reported honestly rather than collapsed:

- `hardened` — the surface is owned by root. Reversing it costs a password.
- `degraded` — `chmod` only, because no `sudo` was available. Stated plainly as user-reversible.
- `unprotected` — `lock` never ran here. Previously this reported as protected, which was the worst
  of the three states to get wrong.

Three bypasses were found *after* the mechanism looked correct, each by testing rather than reading:
`chmod u+w $KIT && mv $KIT/core aside` (two commands, no password — closed by putting the kit root
itself on the harden surface); `INTEGRITY_FAKE_UID=0` (one environment variable silenced the whole
detector — removed from production); and a shadow detector that checked a file's *presence* rather
than its *protection*, so rename-and-replace was silent.

## Part 2 — The wiring self-check (2026-07-30)

Protecting the files is worth nothing if the hook is registered at a path the kit no longer installs
to. That was observed live in a `web-test` worktree carrying a pre-relocation registration: every tool
call emitted a non-blocking "No such file", and nothing anywhere said the protection was off.

### A second axis, deliberately not merged into the first

`integrity_tier` answers *how strong is the lock*. `integrity_wiring` answers *will the gate actually
run*. A hardened install can be miswired and a never-locked one can be wired perfectly, so folding
them into one vocabulary would repeat the mistake that once told fresh installs they were protected.

`wired` · `unregistered` · `dangling` · `foreign` · `partial` · `absent`

`absent` is a distinct value and is silent at every tier: the kit runs standalone from a terminal, so
"no gate configured" and "a gate that should be here and isn't" are different facts, and warning on
the first would train the reader to ignore the second.

`integrity_report` takes both axes and **neither argument is optional** — a default that turned a
missing wiring argument into `absent` would silently stop checking. Refusal is coupled to root
ownership, so `hardened` and `stale` refuse while the lower tiers warn and proceed: below root
ownership there is no wall that could have been lost.

### Four decisions that changed the design mid-flight

Each of these came out of a review finding, and each replaced a proxy with the property itself.

**The registered path is resolved, not assumed.** The first implementation asked whether *some*
command string mentioned the gate filename, then tested a hardcoded canonical path. Those are two
different questions: a `settings.json` copied between machines answers the first yes while the gate
never runs. The check now extracts the registered command, expands `$CLAUDE_PROJECT_DIR`, resolves
relative paths against the project root, and tests *that* file. The motivating case was previously
caught only incidentally.

**The installed harness is recorded, not inferred.** `--harness` was a flag that vanished after the
run, so the check inferred a requirement from "a settings file exists" — flagging a project carrying
a `.cursor/hooks.json` from an unrelated tool even though the kit was installed for Claude alone.
`install.sh` now writes its selection to `core/.harness`, inside the surface `harden_targets` chowns,
so at the hardened tier an agent cannot rewrite it to require nothing. No record falls back to the old
inference, because requiring nothing would turn every existing install into a green `wired`.

**The guard reads nothing from the environment.** A per-process cache of the computed verdict was
designed and rejected before implementation. The environment belongs to whoever launches the
entrypoint, so a cache of the answer is indistinguishable from a forgery of it — one variable would
have skipped both axes at all thirteen call sites, at the hardened tier, with no password. That is
`INTEGRITY_FAKE_UID` returning under a new name, and it would have passed the assertion written to
prevent it, because that assertion named one variable instead of the shape. The assertion now matches
the shape; the guard recomputes on every call, at a cost of at most three `jq` invocations.

**Write/Edit judges the outcome, and judges the edit that will actually be written.** The settings
files are on the gate's surface asymmetrically. Bash denies any mutation, because that branch has no
content to inspect — `jq … > tmp && mv tmp settings.json` cannot be predicted from the command
string. Write/Edit has the payload, so it reconstructs the proposed document and denies only when the
registration would not survive; an edit that changes permissions, env or model passes.

Two refinements landed there. Survival is measured by **the tools a slot covers**, not by the
matcher's literal spelling, so widening `Write|Edit` to `Write|Edit|MultiEdit` — a change that leaves
the registration strictly better — is allowed while dropping the `Bash` matcher is still denied. And
the reconstruction honours `replace_all`: ignoring it let the gate judge a document different from the
one being written, and a decoy mention of the gate filename — plantable by an edit the gate itself
allows — turned that gap into a two-step removal of both registrations.

## Evidence

The suite went from **461 to 601 assertions**, 0 failures, across 11 files.

```
apply-test              9      integrity-test        141      self-protection-test  185
gate-test              26      ledger-test           102      strict-test            23
install-guard-test     11      lock-tier-test         52      summary-test           14
rerun-test             24      sanitize-test          14
```

The number is not the point. **Mutation is the only evidence accepted for a new security assertion
here**, because eight assertions in the lock work passed without testing what they named — every one
found by mutation, none by reading, and two of them introduced by the wave that was correcting the
others. Every assertion added in this cycle was shown to fail when what it names regresses, and every
mutation was shown to have actually applied before its result was read: a `sed` that silently matched
nothing has already been mistaken here for proof of a defect.

That discipline paid for itself four times in this cycle alone. A `_wiring_rank` branch was found to
be unreachable, so its mutation killed nothing and its comment asserted a property no code path could
exercise. Two assertions were found to pass against their own literal spelling rather than the
property they named — one of them the very check meant to keep environment overrides out. Two of
`_reg_slots`' arms were reachable by no assertion at all. And a `hardened|stale` change was found to
leave the whole suite green when reverted, meaning the ruling behind it had no test.

## What this still does not cover

Stated rather than implied, because a control that overclaims is worse than one that is honest about
its edge:

1. The settings files carry no chown protection at all — unlike core/**, they must stay
   user-writable for the harness's own unrelated edits — so this gate (Bash mutation-deny, Write/Edit
   outcome-check) is their only defense, at every tier including hardened, and it shares the same
   heuristic-bypass limits already named for the rest of this gate.
2. The wiring check proves the registration is present and, at the hardened or stale tier, that it
   points at a file this kit owns — below those tiers only existence is checked. Either way it
   cannot prove the harness will honour it — a harness-level disable is outside anything the kit can
   see.
3. A registered gate path containing spaces resolves to its first token.
4. `_wiring_one` tests that the gate file exists, not that it is executable, at every tier including
   hardened — a registered, root-owned, non-executable gate still reads as `wired`.
5. The guard re-evaluates per entrypoint process, so the warning can print up to three times in a
   triage that chains `ingest` and `cluster`. This is the accepted cost of the guard reading nothing
   from the environment.

## Pending

- **The manual acceptance run** (`docs/superpowers/plans/2026-07-29-flaky-kit-lock-manual-acceptance.md`,
  21 steps). Only a human can make `chown root` succeed, so the `hardened` tier has never been
  exercised for real. Everything above about that tier is driven by a PATH-shimmed `sudo`.
- **Re-locking the source tree.** It was unlocked to complete an earlier merge and is currently
  `unprotected`. Re-locking needs a password.
- **Task 5** — the kit's own documentation of the second axis, and the sweep for sentences this change
  makes untrue.
- **Repairing the stale registration** in `~/.forest/wt/web-test/tech-WEBT-254904`, the worktree where
  the original defect was observed. Re-running the kit installer against it is the repair.

## Next

**Enforce `hedge-scan` as a Stop hook.** Selected as the next piece of work once this run completes.

Everything above hardens the kit's *perimeter* — its files, its lock, its wiring, its registration.
None of it touches the kit's actual job, which is stopping a final message that rationalises away a
red test. `core/hedge-scan.sh` already performs that detection; `SKILL.md` merely *asks* the agent to
pipe its summary through it. An agent that skips the pipe loses nothing, so the one control the kit
exists for is the only one still resting on the agent's cooperation — the same "a control that is not
itself guarded" shape as everything this report describes, one level in. The pack's `delivery-gate.sh`
already does it the enforced way: a Stop hook that blocks the message rather than a line in a prompt
that requests it.

Also recorded as out of scope, and not selected: the **reviewer-attestation cluster**
(registry → brief gate → write gate → attestation), which would make the kit's stated two-key rule
something other than a sentence in a prompt — nothing currently enforces that a reviewer rather than
the fixer ran `gate.sh`. It is larger than a single plan and would need its own design cycle.

One of the five residuals above is cheaply closeable if it's ever worth a round: testing the
registered gate for executability rather than mere existence (residual 4). Residual 1 has no cheap
fix. The settings files must stay user-writable for the harness's own unrelated edits (permissions,
env, model, MCP config), so there is no ownership floor to add without breaking that. Chowning
`.claude/`/`.cursor/` doesn't route around it either: the settings files would still need to stay
individually editable for those legitimate updates, and it collides with `core/lock-kit.sh`'s own
requirement that `.claude/hooks` (nested inside `.claude/`) stay user-writable for the pack
installer. What's there — the CLI gate's Bash mutation-deny and Write/Edit outcome-check — is
already the limit of what this residual can close without taking away the harness's own write
access to its own settings.
