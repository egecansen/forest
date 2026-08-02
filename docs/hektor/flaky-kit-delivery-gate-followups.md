# Delivery gate — follow-up register

Four items left open when `worktree-kit-delivery-gate` merged (2026-08-02, 27 commits,
suite 1023/0). Each was found by review, adjudicated, and parked with a reason. None
changes a verdict, bricks a project, or opens a surface — that is why they are here and
not in the branch.

They are recorded because the branch's execution ledger lived in a git-ignored workspace
that goes away with the worktree.

## 1. `install.sh:376` undercounts when two merges fail — and that state has no fixture

The closing block says "Locking now turns **one repairable failure** into unlock
(password) → fix → reinstall → relock." When both the Stop merge and the Cursor merge
fail, two independent registrations failed, and the numbered repair list two lines below
correctly enumerates two separate steps.

The sentence two lines *above* it already handles this — "the axis reads `unregistered`
for the affected **slot(s)**" is deliberately plural-safe. The phrasing was not carried
through.

Nobody is misdirected: the repair list is correct and complete in every state. Reword to
mirror line 374.

**The gap underneath it:** the simultaneous both-merges-fail state has no fixture in
`core/tests/install-guard-test.sh`. Each merge is tested failing alone. The reviewer built
that state by hand to check the text and it behaved correctly — full run-to-completion,
rc 74, both bad files untouched, every other registration landed — but nothing pins it.
Add the fixture with the reword.

## 2. `core/tests/integrity-test.sh:1531`'s negative assertion is a floor, not a proof

It enumerates literals that must not appear in the `hardened|stale` remedy paragraph.
Demonstrated inadequate: a re-worded false per-gate claim ("losing it also means losing the
only out-of-tree record of what this tree should contain, so a wholesale replacement of the
kit would go undetected") uses none of the enumerated literals, is false of the delivery
gate, and leaves the suite green.

The positive half — the paragraph must name `$which`, plus the self-protection mirror
forbidding `delivery gate` — is what carries the weight. Strengthening the negative half
needs a property to check against, and there is none short of a third field on the axis
contract, which was ruled not worth a Minor when the same question came up for the remedy
wording.

Recorded so the next reader knows this assertion is decoration rather than trusting it.

## 3. `core/tests/install-guard-test.sh:179` cannot fail independently

The `PreToolUse length = 2` check on `$S3` is already implied by the `cmp -s
"$P3/before.json" "$S3"` byte-equality at `:147` — `before.json` is a copy taken after the
first install and contains exactly those two commands, so equality forces the count.

Redundant, not wrong. The group's own comment already concedes the weaker point for its
three siblings.

## 4. The pack installer's WARN text is correct but pinned by nothing

`install.sh:177` in the pack (not the kit) had a WARN reading "pack assets are installed,
that kit is NOT" — made false by the kit installer's new exit-74 contract, since after a
failed Stop merge the engine, the delivery-gate file, the PreToolUse registrations and the
Cursor wiring are all present. The wording was corrected and verified by hand.

The pack installer has no test file in this suite, so nothing pins it. Inventing a
pack-level harness for one sentence with no behaviour attached was out of proportion at
merge time; it is worth doing when the pack installer next gets tests for any reason.

## Not in this register

The kit's own residuals — what the hardened tier does not cover — live in
`kits/flaky-triage-kit/core/lock-kit.sh`'s STILL NOT COVERED header, which is the
authoritative list. This branch added entries there for the delivery gate's real gaps
(Claude-only; it proves what the session recorded rather than what it did; `core/apply` and
`core/rerun` are its dividing line for "work was done"; it is not itself unrepairable at a
refusing tier; and the one-token `core/ledger` escape in the no-ledger rule).
