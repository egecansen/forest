# Kit Wiring Self-Check — Design

**Date:** 2026-07-30 · **Status:** approved for planning · **Owner:** Egecan Sen
**Applies to:** `kits/flaky-triage-kit` (`core/_integrity.sh`, both self-protection gates, `install.sh`)

The kit protects its own **files** and, since the hardened tier, owns them as root. It does not
protect or verify its own **wiring**. A project whose `settings.json` registers the gate at a path
the kit no longer installs to gets a non-blocking "No such file" on every tool call and no statement
anywhere that the protection is off — observed live in a `web-test` worktree carrying a
pre-relocation registration. And nothing stops an agent from deleting that registration: verified,
`sed -i '' .claude/settings.json` is ALLOW today.

This is the same defect class the lock work spent eight tasks on — a control that is not itself
guarded. The kit added shadow detection for a renamed *tree*; a stale or deleted *registration* is
the same loss by a different route.

## What the pack already does that the kit does not

Surveyed `hooks/README.md` and the sixteen pack hooks for patterns worth adopting. Three gaps are
real; the rest are either already covered or out of scope.

| Pack pattern | Kit status |
|---|---|
| `enforcement-self-protection-gate` covers `.claude/settings.json` | **Missing.** The kit's surface is `core/`, `SKILL.md`, the gates and their libs — not the registration that makes any of it run. Adopted here |
| `delivery-gate.sh` — a **Stop** hook that blocks a final message rationalising away a red test | `core/hedge-scan.sh` does the same detection but the SKILL only *asks* the agent to pipe through it. Out of scope for this spec; recorded as the strongest remaining candidate |
| Reviewer-attestation cluster (registry → brief gate → write gate → attestation) enforces anti-self-grading | The kit's `gate.sh` emits a verdict and `SKILL.md` states a "two-key rule", but nothing enforces that a reviewer rather than the fixer ran it. Out of scope; larger than this spec |
| `destructive-command-gate` (`rm -rf`, `git reset --hard`, `git clean`) | Not in the kit. Its entire output is uncommitted working-tree edits, so these commands destroy exactly what it produces — but the pack already ships it, and vendoring a copy buys a drift obligation. Out of scope |
| `invisible-unicode-gate` (ASCII smuggling) | Already covered — `ingest` strips invisible codepoints |
| `hook_profile.sh` dial (`minimal\|standard\|strict`) | YAGNI for a single-purpose kit |

## Decisions taken (with the user)

| Decision | Choice |
|---|---|
| Scope | The wiring self-check **and** `settings.json` on the kit's surface — detection and prevention halves of one hole; separately they are half-measures |
| Behaviour on a broken wiring | **Tier-coupled**, mirroring the kit's existing three-valued rule: refuse at `hardened`, warn at `degraded`/`unprotected`/`unlocked`, silent when no harness is configured at all |
| `settings.json` protection breadth | **Asymmetric.** Write/Edit inspects the payload and denies only when the kit's registration would not survive; Bash denies any mutation, because that branch has no content to inspect |

## 1. Two axes, deliberately not merged

`integrity_tier` answers *how strong is the lock*. Wiring is orthogonal: a hardened install can have
broken wiring, and a never-locked one can be wired perfectly. Collapsing them into one vocabulary
would repeat the `unprotected`-into-`degraded` mistake that told fresh installs they were protected.

So a second function with its own values, and `integrity_guard` evaluates both.

| Value | Meaning |
|---|---|
| `wired` | registered, the file exists, root-owned at the hardened tier, both matchers present |
| `unregistered` | a settings file exists but carries no registration for the kit's gate |
| `dangling` | registered, but the file it points at is absent — **the observed case** |
| `foreign` | the file exists but is not root-owned at the hardened tier, so it cannot be the kit's gate |
| `partial` | one matcher registered, the other not — half the protection is silently off |
| `absent` | no harness settings file at all. **Not a defect and not a warning** |

`absent` is separate on purpose. The kit claims to run standalone from a terminal, so "no gate" and
"a gate that should be there and isn't" are different facts. Merging them would print a meaningless
warning on every terminal-only invocation, and noise is how warnings stop being read.

**Identity comes free from the tier.** `harden_targets` already chowns the gate file, and a
replacement cannot be root-owned without the password. So at `hardened`, `integrity_owner_uid` on the
gate distinguishes the kit's gate from a stranger's without inventing a marker — the same
protection-not-presence test C1's fix introduced, reused rather than re-invented. Below `hardened`,
ownership proves nothing and the check stops at existence.

## 2. Components and flow

```
entrypoint → integrity_guard "$KIT"
               ├─ tier   = integrity_tier    (real ownership vs recorded tier)
               ├─ wiring = integrity_wiring  (project root)
               └─ integrity_report "$tier" "$wiring"   → 0 | 76
```

`integrity_report` takes both arguments and **neither is optional**. A default that turned a missing
argument into `absent` would silently stop checking wiring — the quiet-default shape this codebase
has been bitten by repeatedly. Task 4's and Task 7's report tests are updated to pass both.

**The project root is derived by verifying the installed shape**, not by counting directory levels:
the kit directory must be named `hektor-flaky-triage`, its parent `skills`, its grandparent
`.claude`. If the shape does not hold, the answer is `absent` and the check is silent — so running
the suite from the source tree (`kits/flaky-triage-kit`) never warns. Counting levels would be a
proxy that happens to be right; checking the shape is the property itself.

| Harness | File | Looked for |
|---|---|---|
| Claude | `<proj>/.claude/settings.json`, `settings.local.json` | the gate command under `PreToolUse`, in **both** the `Write\|Edit` and `Bash` matchers |
| Cursor | `<proj>/.cursor/hooks.json` | `beforeShellExecution` and `preToolUse` registrations |

Each harness is only required if its settings file exists, so a single-harness install raises nothing
for the other. On the Claude side a registration in **either** `settings.json` or
`settings.local.json` counts as wired — requiring both would fail every project that uses only one.

**When both harnesses are configured, the worse value wins.** A project whose Claude gate is `wired`
and whose Cursor gate is `dangling` reports `dangling`, and the message names which harness. Taking
the better value would let a broken half hide behind a working half, which is the one-harness
asymmetry Tasks 5 and 6 each had to fix; taking the worse one is also what the tier axis already does
when protection and record disagree.

**Cost, and the cache that was rejected.** One `jq` invocation per settings file present (at most
three: the Claude pair and Cursor's) plus one or two `stat` calls per entrypoint — roughly double to
quadruple today's guard. `triage.sh` calls the guard and then execs `ingest` and `cluster`, so one
triage pays it three times.

An earlier draft cached the computed pair in an exported variable so a process tree would evaluate
once, which would also have relieved the deferred minor about the degraded notice printing three
times. **Rejected.** The environment belongs to whoever launches the entrypoint, so a cache of the
answer is indistinguishable from a forgery of it: one variable would have skipped both axes at all
thirteen call sites, at the hardened tier, with no password — `INTEGRITY_FAKE_UID` returned under a
new name, and past the assertion written to prevent it, because that assertion named one variable
instead of the shape. The guard therefore recomputes on every call and `_integrity.sh` reads nothing
from the environment; the assertion is broadened to match any `HEKTOR_*`/`INTEGRITY_*` read. Three
jq calls are the price of the check being real, and the repeated notice stays deferred.

## 3. `settings.json` on the surface

**Write/Edit — check the outcome, not the text.** The branch has `tool_input.content` (Write) or
`old_string`/`new_string` (Edit), so the gate can answer the real question: *with this change applied,
is the kit's gate still registered?* Deny only when it currently is and would not be. An edit that
changes permissions, env or model leaves the registration intact and passes. Matching on "the gate
command string appears in the payload" would be a textual proxy for that property, and this project
has now been burned three times by proxies standing in for properties.

**Bash — deny mutations.** No content is available and the outcome of `jq … > tmp && mv tmp
settings.json` cannot be predicted from the command string, so the settings files join `SURF` as
mutation targets. Reads still pass. The false-positive cost is small: mutating `settings.json` from a
shell is rare and normally a human's deliberate act.

Both of Claude's settings files are covered — `settings.json` and `settings.local.json` — because a
registration can live in either, so protecting only one leaves an obvious detour. Cursor's
`hooks.json` is covered on the same footing. Whether Cursor has a `.local` variant should be checked
during implementation rather than assumed here; if it does, it is covered too.

**The installer does not trip its own gate:** `./install.sh --project X` contains no settings path,
and its `jq` pipeline runs in a subprocess the gate never sees. An agent running the raw `jq`
by hand does trip it, which is the intended asymmetry.

## 4. Failure handling

| Case | Behaviour |
|---|---|
| `jq` unavailable | The gate already exits 0 at its top without `jq`; `_integrity.sh` likewise stays silent. A broken check must not wedge the kit |
| Proposed JSON unparseable | **Deny** — the registration's survival cannot be verified, and writing malformed settings is itself a defect (the pack's `run-status-write-gate` sets this precedent) |
| Settings file unreadable | Treat as `absent`, silent. Not knowing is not the same as broken |
| Installed shape does not hold | `absent`, silent |

## 5. Testing

`integrity_wiring` is driven with real fixtures: build a `.claude/settings.json` plus a gate file
under `mktemp -d`, then break each path in turn and assert all six values. A **tier × wiring matrix**
asserts that only `hardened` combined with a non-`wired` value returns 76, that the lower tiers warn
and proceed, and that `absent` is silent at every tier.

Every new assertion must be shown to **fail when what it names regresses**. This is not a style
preference here: eight assertions across the lock work passed without testing what they named, every
one found by mutation and none by reading, and two of those were introduced by the fix wave that was
correcting the others.

Two traps to guard explicitly:

1. **`absent` silences everything**, so a fixture that does not actually reproduce the installed
   shape makes every wiring assertion vacuously pass. A control asserting the fixture reaches a
   non-`absent` state is required — without it this repeats C1's "the fixture was too kind" failure
   exactly.
2. **Gate tests write settings files**, which can collide with the harness's protected-artifact
   guard. Fixtures live under `mktemp -d`, never in a real project.

## 6. Out of scope

Enforcing `hedge-scan` as a Stop hook; the reviewer-attestation cluster; `destructive-command-gate`;
the hook-profile dial. The first two are the strongest remaining candidates and are recorded above
with what they would buy.
