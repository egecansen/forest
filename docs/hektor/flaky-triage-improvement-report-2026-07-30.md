# Flaky-Triage Kit — Improvement Report

**Date:** 2026-07-30 · **Scope:** `kits/flaky-triage-kit` · **Branch:** `worktree-kit-wiring-self-check`
**Status:** Tasks 1–4 merged into the branch and reviewed clean; Task 5 (this document, plus the residual sweep) in progress.
**2026-07-31 addendum below:** a follow-on branch (`worktree-kit-wiring-self-repair`) turned the wiring
check this report describes into a repair. See the addendum at the end of this document before
treating anything below as the current state of the wiring axis.

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

## Parked at the final review

The whole-branch review found one Critical and four Important issues, all fixed in a single wave. The
Critical is worth recording because of where it came from: the two axes disagreed about what a valid
registration *is*. The gate had been changed to judge a matcher by the set of tools it covers — so it
allowed widening `Write|Edit` to `Write|Edit|MultiEdit` as strictly better — while the wiring check
still compared the matcher string, read the same file as `partial`, and refused from all thirteen
entrypoints. The remedy it printed could not be run either: `install.sh` exits 75 on a root-owned
`core/`, so recovery needed the password. Both axes now share one slot model, and a parity assertion
compares them document by document rather than trusting a comment.

That defect was visible earlier as a Minor in Task 1 and was deferred. It became Critical only when a
later task changed the other axis. Per-task review cannot see that; this is what the whole-branch pass
is for.

These remain open, each with a ruling rather than a fix:

| Parked | Ruling |
|---|---|
| `core/tests/integrity-test.sh:591` — the locality assertion claims "removing any name from any `local` line goes red", but `gate` in `_wiring_one` stays green: the probe passes an empty gate path, so an empty leak is indistinguishable from no leak | Real, and the seventh instance on this branch of an assertion claiming more than it tests. Not load-bearing: no entrypoint uses `gate` as a global, so the consequence is confined to the assertion overclaiming. One line — a second call with a non-empty path — and it goes first in the next round |
| The cross-axis parity assertion compares slot *derivation* only; `_wiring_cover` and the gate's `_slots_kept` are still kept in step by comment | The covering rule is pinned behaviourally by fixtures on both sides, so a divergence goes red — but structurally, not by construction. Same distrust the `SURF` drift check exists to encode |
| At `degraded`, the printed "re-run the kit installer" is executable but noisy: `core/` is `chmod a-w`, so the engine copy fails with EACCES while the parts that actually repair wiring still land | Loud, not false. Fixing it means teaching the installer to skip an unwritable engine copy, which is its own change |
| With no `.harness` record, a `chmod 000` settings file reads `absent` while a malformed one reads `unregistered` | Consistent with the ruling as scoped — that ruling covered record-present cases. The spec's failure table does not cover no-record-unreadable either way, and should when someone next touches it |
| `docs/superpowers/plans/2026-07-30-kit-wiring-self-check.md:307,490-491` still carry claims the branch retracted | Executed plan text is a historical record, not living spec. The spec and every shipped file are corrected; the plan stays as it was carried out |

## Next

**Enforce `hedge-scan` as a Stop hook.** Selected as the next piece of work once this run completes.
*(2026-07-31: it was not next — see the addendum below.)*

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

## Addendum (2026-07-31) — the wiring self-repair

Everything above describes the wiring axis as a detector only: it asks whether the gate will run and
says so when it will not. A follow-on branch (`worktree-kit-wiring-self-repair`) closed that gap —
`integrity_guard` now repairs what it detects, not only reports it. `core/_wiring_repair.sh` is sourced
by `core/_integrity.sh` at load time from its own directory, and `integrity_guard` calls
`wiring_repair <kit_root> <tier> <wiring>` between computing the wiring verdict and reporting it.

**What it repairs — and the one place it deliberately repairs nothing.** Below root ownership: the
registration, additively and idempotently, with the same jq merge `install.sh` performs, across
`unregistered`, `partial`, and `dangling` alike; and the gate FILE, restored from a copy vendored into
`core/gate-src/<harness>/`. `foreign` is never touched. **Where the tree is root-owned — `hardened` and
`stale` — `wiring_repair` writes nothing at all, registration included.** The first version of this work
repaired the registration there too, on the reasoning that a rewritten registration doesn't arm the
session that wrote it, so the tier's refusal would hold regardless. Measured, that reasoning held for
exactly **one call**: `integrity_guard` recomputes both axes from the filesystem every time, so the
registration the repair had just written was read as `wired` by the very next entrypoint, which returned
0 while that session's harness still had no gate loaded. One call refused; every call after it proceeded
unprotected — the exact silent loss of protection this axis exists to catch, reintroduced by the repair
meant to help. Corrected: at those two tiers the guard detects, says what is wrong, and returns without
touching disk, so the refusal holds on every call because nothing on disk ever changes.

This narrows nothing in the "What this still does not cover" list above — none of those five residuals
is about writing — and opens residuals of its own, the authoritative list now in `core/lock-kit.sh`'s
header (items 10–13; that file, `kits/flaky-triage-kit/README.md`, `core/README.md`, and `kernel.md`'s
P4 row are the living description, this document is not). One of the four is worth stating precisely
here because an earlier draft of this addendum got its mechanism wrong: the registration repair is
additive-only, the same way `install.sh`'s own merge is, except that `install.sh` also purges a
pre-relocation registration before merging and the repair does not — so a dead command, once registered,
stays registered forever. That dead entry does **not** gate whether the wiring axis converges, in either
direction: `_wiring_slots` sorts same-tool commands (jq `unique`) and `_wiring_cover`
(`core/_integrity.sh:134-147`) returns the first of them, and the relocated path (`.claude/hooks/...`)
sorts before the pre-relocation one (`.claude/skills/.../hooks/...`) **unconditionally** — with or
without the dead entry present, with or without `core/gate-src` ever having been vendored. What decides
`wired` vs `dangling` is solely whether a file exists at the resolved (relocated) path; the dead entry is
never even `stat`'d. The residual this leaves, stated precisely: once that file exists — by this repair
restoring it, or by any other means — the axis reads `wired` while a harness that loads every hook
registered under a matcher, not only the one this axis happens to check, still attempts the dead command
on every matching tool call. That is the original "No such file" symptom the whole self-check arc was
built to surface, now permanently invisible to it. Re-running the kit installer, which purges the dead
entry, is the only real fix; the automatic repair alone never removes it.

That corrects the "Repairing the stale registration" item under Pending above: the automatic repair is
not a substitute for it. Whether the worktree named there converges to `wired` (if the relocated gate
file can be restored — it needs `core/gate-src` already vendored there) or stays `dangling` forever
(if it cannot), the dead pre-relocation entry itself is never removed either way, and — in the
converges-to-`wired` case — the axis stops saying anything is wrong even though the harness keeps
attempting the dead hook on every call. Re-running the installer remains the actual fix, exactly as
that Pending line already said, and for a stronger reason than "the automatic repair hasn't reached it
yet".

The "Next" section above named `hedge-scan` as a Stop hook as the next selected piece of work. It ran
second, not first: this wiring-self-repair branch is what actually followed. `hedge-scan`-as-Stop-hook
remains unbuilt and still worth doing — it was simply not next.
