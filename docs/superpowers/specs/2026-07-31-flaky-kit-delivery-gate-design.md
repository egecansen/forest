# Flaky-Kit Delivery Gate — Design

**Date:** 2026-07-31 · **Status:** approved for planning · **Owner:** Egecan Sen
**Applies to:** `kits/flaky-triage-kit` (new `adapters/*/flaky-kit-delivery-gate.sh`, `core/_integrity.sh`, `core/lock-kit.sh`, `install.sh`)

Everything the kit has hardened so far is perimeter: its files, its lock, its wiring, its
registration. None of it touches the kit's actual job, which is refusing a session that ends with a
red test rationalised away. That job rests on two controls, and neither is enforced.

`core/hedge-scan.sh` performs the detection; `adapters/claude/SKILL.md:67` only *asks* the agent to
pipe its summary through it. An agent that skips the pipe loses nothing.

The second is worse, because it describes itself as enforced. `kernel.md:174` states invariant
**I11** — *"A session may not end while any cluster is `selected`/`applied`"* — and
`core/ledger.sh:5` calls `validate --final` **"the machine gate: no session ends with selected/applied
clusters."** A repo-wide grep finds no caller. The machine gate is a sentence in three documents.

Same defect class as the lock and the wiring work, one level in: a control that is not itself
guarded.

## Decisions taken (with the user)

| Decision | Choice |
|---|---|
| What the gate checks | **Both halves, I11 load-bearing.** Ledger state first, then the final message's phrasing |
| How it finds the ledger | **Derived from the transcript** — the one artifact the agent does not write |
| No ledger in the transcript | Block only when `core/apply` or `core/rerun` appears — work was done and left no record |
| Blocking hardness | **Asymmetric.** I11 blocks every stop, with no `stop_hook_active` escape and no environment bypass; the hedge half blocks once |
| Harness coverage | **Claude only.** Cursor has no stop event; recorded as a residual rather than approximated with a different one |
| Wiring-axis coverage | Required slots come from a **versioned install record**, so the new registration is protected without bricking installs that predate it |

## 1. Two halves, deliberately different in hardness

```
Stop → transcript
  ├─ I11:  ledger paths extracted from the transcript → validate --final
  │        an open selected/applied cluster    → block, every time
  │        apply/rerun present but no ledger   → block, every time
  └─ hedge: the last assistant message → core/hedge-scan.sh
           a hit                                → block once
```

**I11 is a property.** A cluster is in a terminal state or it is not; no wording changes that. The
legitimate exit is in the agent's hands and is exactly the work we want — `core/ledger.sh
cluster-state <id> green|flagged|deferred`. Because a real remedy always exists, the hard block has
no escape: no `stop_hook_active` bypass, no environment variable.

That last point departs from the pack's `delivery-gate.sh`, which ships `HEKTOR_DELIVERY_GATE=off`.
This kit spent a full cycle removing environment overrides from `core/_integrity.sh` on the finding
that a variable a caller can set is a skeleton key to the check it guards. A Stop hook runs in an
environment the agent influences, at the moment the agent is being checked, so the same reasoning
applies with more force here than it did there. The kit's existing
`HEKTOR_FLAKYKIT_UNLOCK=1` is not a counter-example: it exists for a human doing maintenance on the
kit's own files, not for the subject of a check to opt out of it.

**The hedge scan is a proxy.** It matches phrasing, so it can be wrong. A false positive must not
wedge a session, so it blocks once: the re-triggered stop (`stop_hook_active=true`) passes, and the
cost of being wrong is one turn. `core/hedge-scan.sh` is reused as-is — its regex is the kit's, and a
second copy would be a drift obligation.

## 2. Finding the ledger

`core/ledger.sh` takes its file as an argument and the kit imposes no run-directory convention, so
there is nothing to look up. The Stop hook receives `transcript_path`; it scans the transcript for
`core/ledger.sh <cmd> <file>` invocations, collects the distinct paths, and runs `validate --final`
against each one that still exists.

The transcript is the right source because **the agent does not write it.** A pointer file would have
to live somewhere writable — `core/` is root-owned at the hardened tier, so `ledger.sh` could not
write there, and anywhere else the agent can simply delete it, which is the "absent silences
everything" trap the wiring axis already had to be taught to avoid.

Deriving paths from a transcript is inference, and the honest limit is that a ledger the agent never
mentioned on a command line is invisible. That is what §3 exists for.

## 3. When there is no ledger

Three cases, distinguished by what the transcript shows:

| Transcript | Verdict |
|---|---|
| No `core/*` invocation at all | **Silent.** The kit was not in play; a warning here is noise, and noise is how warnings stop being read |
| `core/ingest` or `core/cluster` only | **Pass.** Read-only exploration owes no state |
| `core/apply` or `core/rerun` present, no ledger path | **Block.** Something was changed and re-run, and the run left no record — I11 cannot be satisfied by a run that has no state |

`apply`/`rerun` is the dividing line because it is the point where the session stops reading and
starts changing things. Requiring a ledger for any `core/*` invocation would block someone who ran
`core/ingest` to read a report.

## 4. The gate protects itself, without bricking existing installs

The new gate is subject to the same rule as the one it joins: a control that can be silently
unregistered is not a control.

- `harden_targets` in `core/lock-kit.sh` gains the gate script, so at the hardened tier it is
  root-owned like its sibling.
- The `Stop` registration joins `integrity_wiring`'s required slots — but **only for installs that
  shipped it.**

That caveat is load-bearing. `integrity_wiring` reports `partial` when a required slot is missing,
and `partial` at the hardened tier refuses from all thirteen entrypoints. Adding a required slot
unconditionally would therefore take every project installed before this change and, on upgrade,
refuse every entrypoint until someone unlocked it with a password. The fix would brick exactly the
installs it was meant to protect.

So `core/.harness` becomes a **capability record** rather than a bare harness name. Its first token
stays the `--harness` selection (`all|both|claude|cursor|agents`), and installs that ship the
delivery gate append a `stop` token. `_wiring_want` requires the `Stop` slot only when the record
carries that token; a record without it — every install written before this change — requires exactly
what it required before. A record naming a capability this kit does not know is ignored for
requirement purposes, because an older kit cannot check a gate it does not ship.

## 5. Failure handling

| Case | Behaviour |
|---|---|
| `jq` unavailable | Exit 0, audit the reason. Every gate in this kit fails open; a broken check must not wedge a session |
| Transcript missing or unparseable | Exit 0, audit the reason |
| `core/ledger.sh` not executable, or `validate` errors for a reason other than exit 67 | Exit 0, audit the reason |
| A ledger path from the transcript no longer exists | Skip that path; it was a scratch file |

Failing open silently and failing open deliberately are different things, so every exit that is not a
verdict writes one line through `hektor_audit`. The kit already vendors that library for both gates.

## 6. Testing

Fixtures are synthetic transcript JSONL files under `mktemp -d`, driven through the hook's stdin
contract exactly as the harness would: an open-cluster ledger, a closed one, `apply` with no ledger,
`ingest` only, no kit invocation at all, a hedged final message, a clean one, and a repeat stop
carrying `stop_hook_active=true`.

Two properties need pinning beyond the obvious verdicts, because both are ways this gate could ship as
decoration:

1. **The hard block must not be escapable.** A `stop_hook_active=true` stop with an open cluster must
   still block, and no environment variable may change the verdict — asserted the way the integrity
   suite asserts it, by matching the shape of any `$UPPERCASE` read in the gate rather than a list of
   names.
2. **The silent path must be genuinely silent, and genuinely narrow.** A transcript with no kit
   invocation must produce no output and no block; the same transcript with `core/apply` added must
   block. Without the second half, a fixture that quietly fails to look like a kit session would make
   every assertion pass vacuously — the same trap the wiring fixtures needed a control for.

Every new assertion must be shown to fail when what it names regresses, and every mutation must be
shown to have actually applied before its result is read. Seven assertions across the preceding two
cycles passed without testing what they named; every one was caught by mutation or by a reviewer, none
by reading.

## 7. Residuals this creates

Stated here so the plan carries them into `core/lock-kit.sh`'s STILL NOT COVERED list rather than
leaving them to be discovered:

1. **Claude only.** Cursor has no stop event, so on Cursor I11 remains prose. Whether Cursor has since
   added one should be checked during implementation rather than assumed — the last cycle's Cursor
   assumption was wrong in the other direction.
2. **A ledger the agent never named on a command line is invisible** to the transcript scan. The
   `apply`/`rerun` rule is what covers the case that matters; a ledger written by some other route is
   not reached.
3. **The gate reads the transcript the harness wrote.** It proves what the session recorded, not what
   the session did.

## 8. Out of scope

The reviewer-attestation cluster, still the largest remaining candidate and still needing its own
design cycle. The `rm -rf .claude` surface gap, already scheduled separately. Porting the pack's
stale-memory half of `delivery-gate.sh`, which its own header calls the noisy half and which this kit
has no use for.
