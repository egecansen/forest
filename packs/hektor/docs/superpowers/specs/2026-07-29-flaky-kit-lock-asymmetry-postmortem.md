# Flaky-Kit Lock Asymmetry — Post-Mortem

**Date:** 2026-07-30 · **Branch:** `worktree-flaky-kit-lock-asymmetry` (38 commits) · **Suite:** 275 → 461

Kept because the SDD workspace that held it is git-ignored and does not survive the merge. The
design is in `2026-07-29-flaky-kit-lock-asymmetry-design.md`; the plan and its eight in-flight
amendments are in `../plans/2026-07-29-flaky-kit-lock-asymmetry.md`. This file records only what the
run taught, which is not recoverable from either.

## What was wrong, and what replaced it

`core/lock-kit.sh` called itself "the REAL wall" and its unlock "keyed to human consent". Both were
false: the agent owned the files, `chmod` requires ownership rather than write permission, and the
"consent" was an environment variable the agent could type. It was defeated in one command.

The branch built a real asymmetry — the safety surface, **including the kit root**, owned by root, so
reopening costs a password no agent can supply — and then made the documentation say what the
mechanism actually does, including the five things it still does not cover.

## Three bypasses found, all after the mechanism "worked"

Each was found by a review after the implementation was green, and each was a level up from where
the previous fix had looked.

1. **`chmod u+w $KIT && mv $KIT/core aside`** — `harden_targets()` chowned `core/` but not the kit
   root, and `rename()` is governed by the parent's write bit, never the child's ownership. Two
   commands, no password.
2. **An environment override inside the detector** — a test seam read in preference to the real owner
   uid, so one variable turned a mismatched tree into a silent `hardened`. The ruling was *remove,
   don't fence*: the seam moved to a function boundary and the override left production entirely.
3. **The shadow detector tested presence, not protection** — `[ ! -d core ]`, so rename-aside-**and-
   replace**, the case its own warning text describes, was silent. Found by the whole-branch review
   after seven tasks had each declared the area done.

## The lesson that generalises

**Scope by the property being asserted, never by the location or the wording.**

Task 8 needed four fix rounds and every one was caused by the controller's scope, not by implementer
error. The criterion was narrowed three different ways, and each narrowing failed identically:

| Round | Criterion given | What it structurally could not see |
|---|---|---|
| 1 | a file list | claims in files not on the list |
| 2 | a phrase list (`REAL wall`, `human consent`, …) | the same claim in different words |
| 3 | "does it overclaim the **lock**?" | a false claim about the **gate's** enforcement |
| 4 | "does it say anything untrue about **what protects what**?" | — |

The same failure appears in code, not just prose: C1's plan text specified the *condition to write*
(`! -d core`) instead of the *property to detect* (the tree at this path is no longer the protected
one), and the test then confirmed the condition rather than the property. A reference code block in a
plan should be preceded by the property it must satisfy, so a reviewer can check the code against the
property rather than the implementation against the code.

## Tests: green is not evidence

The run produced **eight** assertions that passed without testing what they named. Every one was
found by mutation; not one was found by reading.

- two matched the `chmod` sweep lines in the same log rather than the `chown` operand list
- one was vacuous — the counters were non-zero either way
- two matched pre-existing boilerplate, so they passed against a build with the feature deleted
- `integrity_guard() { return 0; }` left **all 345** assertions green — Task 4's entire deliverable
- the fix wave introduced two more, including one guarding the branch's headline Critical
- a pin's comment advertised a tripwire direction the pin did not have

The controller also produced a **false negative** while verifying the last of these: two mutation
regexes silently failed to match the real code (`!= "0"` with quotes; a line beginning with
`[ "$escalated"` rather than with `sudo -k`), so nothing was mutated, the suite stayed green, and the
output read as proof of a defect. A check that does not check.

**Practice worth keeping:** for any security-relevant assertion, mutate what it names and confirm the
suite goes red — and assert that the mutation actually changed the file before drawing a conclusion
from the result.

## Honest framing as a working discipline

The branch treats a documented claim the mechanism does not deliver as a defect equal in severity to
a broken mechanism. That is why several "documentation" findings were Critical or Important, and why
corrections are made **in place with the mistake left legible** rather than deleted — `lock-kit.sh`'s
header, both gates, and `core/lock-kit.sh:2` all still quote what they used to claim and say why it
was wrong.

The same discipline caught an error pointing the other way: `unprotected` was collapsed into
`degraded`, so a fresh install — plainly writable, never locked — was described as "read-only but
reversible". Understating the risk is the same defect as overstating the protection.

## Accepted residuals

Named here so they are not rediscovered as surprises. All are documented at their decision points.

1. **Shadowing** — the kit directory can be renamed aside; its parent must stay user-writable so
   other skills can install there. Detected via the out-of-tree record, not prevented.
2. **That record is deletable** by the same actor. Chowning its directory *would* close this; the
   decision not to rests on the standing cost of routing every future pack-hook update through
   sudo — not on any claim that it would not help.
3. **Social engineering** a human into running the unlock.
4. **The maintenance window** after the password is typed.
5. **A relative surface path inside an interpreter inline program** (`python3 -c 'open("core/x")'`)
   is not detected; closing it requires parsing the inline program as code, which `shell-guard.py`
   declines by design. The hardened tier covers the case.

Plus four parked minors: wider false positives when cwd is inside the kit tree; a trailing-slash gap
in the bash fallback (only reachable without python3); `claim_free`'s sweep root is the kit tree, so
superseded code listings in the plan doc still quote retracted phrases; and the deliberate non-fix
above is a narrow regression at cwd `<kit>/core`, not "unchanged", as two comments state.

## Still owed

`docs/superpowers/plans/2026-07-29-flaky-kit-lock-manual-acceptance.md` — 21 steps that only a human
can run, because only a human can make `chown root` succeed. The hardened tier has never been
exercised for real; every test of it runs through a PATH-shimmed `sudo`.
