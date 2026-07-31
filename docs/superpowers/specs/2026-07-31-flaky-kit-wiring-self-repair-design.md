# Flaky-Kit Wiring Self-Repair — Design

**Date:** 2026-07-31 · **Status:** approved for planning · **Owner:** Egecan Sen
**Applies to:** `kits/flaky-triage-kit` (new `core/_wiring_repair.sh`, `core/_integrity.sh`, `install.sh`, `core/lock-kit.sh`)

The kit can now tell when its gate is not wired. It cannot do anything about it, and the reporting
half alone has not been enough: the same defect has now been observed twice in `~/.forest/wt/web-test`
worktrees, because whether a project ends up correctly wired depends on which tool provisioned it.

The second occurrence was diagnosed on 2026-07-31. That worktree carried the kit's payload under
`.claude/kits/` and nothing else — no `skills/`, no `hooks/`, no `settings.json`. Its provision record
read `{skills: [], kits: [flaky-triage-kit], hooks: false}`, and it carried none of the marker
`scripts/worktree-provision.sh` writes, so it was not produced by the provisioner that already guards
this failure mode. The kit was present, unusable, and silent about why.

Provisioning is being consolidated separately. This design closes the other half: **when the kit runs
at all, its own wiring is its own responsibility** — it should not depend on whatever created the
project having done the right thing.

## Decisions taken (with the user)

| Decision | Choice |
|---|---|
| Trigger | **Automatic.** Any entrypoint whose guard sees a repairable wiring state repairs it |
| Registration | Repaired **only where the tree is not root-owned** — see §4, which corrects an earlier draft that repaired at every tier |
| Gate file | Restored **only where the tree is not root-owned**, from a copy installed inside `core/` |
| Where the tree is root-owned | **Nothing is repaired at all** — not the registration, not the gate file. See §4, which corrects an earlier draft that repaired the registration and reasoned the refusal would hold anyway; measured, that held for exactly one call |
| Neighbouring hooks | Out of scope. The kit repairs its own registration, not the project's other packs' |

## 1. What is repairable, and what is not

`integrity_wiring`'s six values split cleanly by whether a repair is both possible and correct:

| Wiring | Action |
|---|---|
| `unregistered` | **Repair where the tree is not root-owned** by writing the kit's registration into the harness settings file. At `hardened`/`stale`, report and refuse — see §4 |
| `partial` | **Repair where the tree is not root-owned** by writing whichever required slots are missing. At `hardened`/`stale`, report and refuse — see §4 |
| `dangling` | **Repair where the tree is not root-owned** by restoring the gate file, then the registration. At `hardened`/`stale`, report and refuse — see §2 and §4 |
| `foreign` | **Never repair.** A gate that is not this kit's is someone else's; overwriting it would be this kit deciding it wins a conflict it cannot see the other side of |
| `wired`, `absent` | Nothing to do |

Below root ownership, repair is idempotent and additive: it writes slots that are missing and leaves
everything else in the settings file untouched, the same merge `install.sh` already performs. Running
it twice changes nothing the second time. Where the tree is root-owned, nothing is written at all —
see §4.

## 2. Tier coupling, and why the gate file is different from the registration

The registration lives in `.claude/settings.json`, which `harden_targets` does not chown at any tier
— that is already a stated residual — so the kit *could* rewrite it as the user at every tier. §4
explains why it deliberately does not: at `hardened`/`stale` a rewrite would be read as `wired` by the
very next entrypoint and silence the refusal this tier exists to keep.

The gate file is the opposite. Where the tree is root-owned,
`.claude/hooks/flaky-kit-self-protection-gate.sh` is **root-owned by design**, and that ownership is
the whole identity test: `_wiring_one` reports `foreign` when a gate at that path is not root-owned. A
kit running as the user can create a file there — `.claude/hooks/` is user-owned, which is how the
file can go missing in the first place — but the file it creates would be user-owned, so the repair
would convert a `dangling` into a `foreign` and the kit would have broken itself while trying to heal.

So: restore the gate file only where the tree is **not** root-owned. That condition is `hardened` and
`stale` together, not `hardened` alone — `stale` means the tree *is* root-owned and only `.lock-state`
disagrees, so the gate there is root-owned for exactly the same reason. Keying the restore on the
recorded tier while the identity test keys on ownership would split one property across two
conditions, which is the defect the previous cycle's whole-branch review found and which cost a
Critical: the two axes disagreed about the same file. The refusal, the identity test and the restore
all read the same condition.

Where the tree is root-owned, a missing gate file is reported and refused, and the remedy is the one
that can actually produce a root-owned file — unlock, reinstall, lock.

## 3. The restore source

An installed kit today carries only `SKILL.md` and `core/`; `install.sh` copies the gate from
`adapters/claude/` in the **source** tree, which is not present after installation. There is nothing
to restore from.

So `install.sh` additionally installs the gate's source next to the engine, and the restore reads from
there. It goes inside `core/` deliberately: at `hardened` that directory is root-owned, so the copy an
agent would have to poison in order to have a poisoned gate restored is exactly the copy it cannot
write. Below `hardened` the restore source is no better protected than anything else, which is what
`degraded` and `unprotected` already mean.

## 4. Repair does not mean protected

A written registration does not arm a running session. The harness reads hook configuration at
session start, so a repair takes effect on the next session and not before.

This is stated rather than smoothed over, and it decides the post-repair behaviour — but the first
draft of that decision was wrong, and implementation proved it.

The draft said: where the tree is root-owned the guard repairs and still returns 76, because the
protection it records is not in place for this session. That holds for exactly **one call**.
`integrity_guard` recomputes both axes from the filesystem every time, and the repair writes the
registration to disk — so the next entrypoint reads `wired` and returns 0, while the running session's
harness still has no gate loaded. Measured: `integrity_report hardened unregistered` → 76,
`integrity_report hardened wired` → 0. One entrypoint refuses, every entrypoint after it proceeds
unprotected. That is the silent loss of protection this whole arc exists to prevent, reintroduced by
the repair itself.

**So where the tree is root-owned, nothing is repaired — not the gate file, and not the registration
either.** The guard detects, says exactly what is wrong, and refuses; because nothing changes on disk,
it goes on refusing until a human unlocks, reinstalls and locks. The refusal is worth more there than
the repair: at that tier the protection is real, its loss is serious, and a registration written into
a session that cannot load it buys nothing while destroying the only signal that anything is wrong.

**`mismatch` is the third refusing tier, and it writes nothing either.** The ruling above was phrased
"where the tree is root-owned", which reaches `hardened` and `stale` but not `mismatch` — the tier
whose whole meaning is that the record *claims* root ownership the tree does not have. The whole-branch
review measured what the repair did there: it restored the gate script **out of a tree the same run
declares untrustworthy** — "this is not the tree that was hardened; nothing it produces should be
trusted" — into the path that is the kit's own protection hook, and flipped the axis from `dangling` to
`wired`.

The run is refused anyway, so the write buys nothing, which is the argument that settled `hardened`
and `stale`. What it costs is real: `harden_targets` picks up `.claude/hooks/flaky-kit-self-protection-gate.sh`
only when the file exists, so before this branch a re-lock left that path empty and the kit went on
refusing until someone reinstalled. With the file planted, the re-lock chowns it to root and the
ownership identity test accepts it — a signal that used to survive the printed remedy no longer does.
No attacker gains a capability they lacked, since at `mismatch` they already own the tree; the point is
that there is no upside to set against the loss.

Everywhere else the repair runs in full and the run proceeds, unchanged from the warn-and-proceed rule.
Self-repair is a convenience for the tiers that admit they are conveniences. Every tier that refuses —
`hardened`, `stale`, `mismatch` — writes nothing at all.

## 5. Considered and rejected: a liveness heartbeat

The honest question is not "is the gate registered" but "is the gate running", and registration is a
proxy for it. The obvious way to close that gap is to have the gate touch a file each time it fires
and have the guard check its freshness.

**Rejected.** The heartbeat has to live somewhere the gate can write as the user — at `hardened`,
`core/` is root-owned, so it cannot go there — and anything the gate can write, the agent can write.
A forgeable signal is harmless when its absence only raises a warning, but here its presence would be
used to *relax* a refusal, and a forgeable input to a relaxation is a skeleton key. This is the same
reasoning that removed `INTEGRITY_FAKE_UID` and rejected the guard's per-process cache; recording it
here so the idea is not re-proposed as new.

## 6. Where the code lives

Repair is a mutation and `core/_integrity.sh` is a detector that thirteen entrypoints source, with a
standing contract that it never wedges a caller and reads nothing from the environment. Putting a
filesystem write into it would blur that.

So the repair is its own unit, `core/_wiring_repair.sh`, exposing
`wiring_repair <kit_root> <tier> <wiring>` → prints what it did, always returns 0. `_integrity.sh`
sources it and `integrity_guard` calls it; the detection functions stay pure.

The settings file is read-modify-written, so the repair takes the same care `core/ledger.sh` already
takes for concurrent writers: an exclusive lock across the read-modify-write, `flock` where present
and the portable `mkdir` spinlock otherwise. Two entrypoints repairing at once must not lose one
another's slots.

## 7. Failure handling

| Case | Behaviour |
|---|---|
| `jq` unavailable | No repair, no error. The guard already resolves to `absent` without `jq` |
| Not an installed layout | No repair. Running the suite from the source tree must never write into anything |
| Settings file unreadable or unparseable | No repair; report it. Rewriting a file we cannot parse would destroy whatever it holds |
| Settings file not writable | No repair; say so plainly, naming the path |
| Lock cannot be acquired | No repair; the next entrypoint will try again |

Every one of these prints its reason through the existing audit library. Failing silently and failing
deliberately are different, and this arc has now spent two cycles on that distinction.

## 8. Testing

Fixtures under `mktemp -d`, reproducing the installed layout. The matrix is the six wiring values
crossed with the tiers, asserting for each: what the settings file contains afterwards, what the guard
returned, and what it printed.

Four properties need pinning beyond the obvious ones, because each is a way this could ship as
decoration or as damage:

1. **`foreign` is never written to.** Mutate the fixture so a root-owned stranger's gate is
   registered; the settings file must be byte-identical afterwards.
2. **A root-owned tree plus `dangling` does not create a user-owned gate file** — asserted at
   `hardened` **and** at `stale`, because a rule that read the recorded tier instead of ownership
   would pass the first and fail the second. The failure this design exists to avoid is the repair
   converting a `dangling` into a `foreign`.
3. **The repair is additive.** A settings file carrying unrelated permissions, env and model keys must
   still carry them, unchanged, after a repair — asserted by comparing everything except the kit's own
   slots.
4. **The refusal survives repeated calls where the tree is root-owned** — not only the one that first
   found the break. A registration quietly written there would turn 76 into 0 on the very next call,
   handing every miswired hardened install a silent free pass, which is the opposite of the point.

Every new assertion must be shown to fail when what it names regresses, and every mutation must be
shown to have actually applied before its result is read.

## 9. Residuals

1. **A repair arms on the next session, never this one.** Stated in the message, not implied.
2. **The kit repairs its own registration only.** A neighbouring pack's stale registration — the noise
   in the observed case — is not the kit's to fix and is not fixed.
3. **Below `hardened`, the restore source has no more protection than anything else**, so a poisoned
   source restores a poisoned gate. That is what the lower tiers already mean, but it is worth saying
   where the restore is concerned.
4. **`foreign` remains unrepairable by design**, so a project whose gate path is occupied by another
   tool's file stays refused at `hardened` until a human resolves the conflict.
