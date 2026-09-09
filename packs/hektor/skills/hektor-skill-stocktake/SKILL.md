---
name: hektor-skill-stocktake
description: >
  Periodic quality audit of the Hektor pack itself — walk every skill and return a
  Keep / Improve / Update / Retire / Merge verdict, so a growing single-maintainer
  pack doesn't accumulate overlap, drift, and stale tool/flag references with no CI
  reviewer to catch it. Opt-in and on-demand only (like hektor-test-catalogue /
  hektor-work-summary-deck) — never during authoring or triage. A mtime quick-scan
  re-audits only skills changed since the last run, so re-audits cost minutes.
  Triggers on "stocktake the skills", "audit the pack", "which skills overlap",
  "are any skills stale". Pairs with `hektor doctor` (structure) — this is content.
---

# Hektor skill-stocktake

`hektor doctor` answers *is the pack structurally sound* (no dead routes, valid
schemas, frontmatter present). This skill answers the harder, holistic question:
*is each skill still pulling its weight, or is it overlapping / stale / redundant?*
Adapted from ECC `skills/skill-stocktake` (the mtime-diff quick-scan + the
self-contained-reason discipline).

Run it every so often (e.g. after a batch of new skills lands), not during work.

## The two modes

Cache lives at `docs/hektor/skill-stocktake.json` (`{evaluated_at, skills:{<name>:{verdict, reason, mtime}}}`).

**Quick scan (default when a cache exists).** Only re-evaluate skills whose
`SKILL.md` changed since `evaluated_at`:

```bash
CACHE=docs/hektor/skill-stocktake.json
find skills -name SKILL.md -newer "$CACHE" 2>/dev/null    # the only skills to re-audit
```

Carry every unchanged skill's prior verdict forward verbatim — do NOT re-reason
about it (that's the whole point; a full re-audit of a 19-skill pack is minutes,
not seconds).

**Full stocktake (no cache, or on request).** Audit every skill. For >~10 skills,
dispatch one reviewer subagent per ~10-skill chunk to keep context bounded; merge
the returned verdicts.

## The verdict per skill

Assign exactly one, each with a **self-contained reason** (ECC rule: never write
"unchanged" — restate the evidence, so the cache is readable a month later):

| Verdict | When | The reason MUST name |
|---|---|---|
| **Keep** | Single-purpose, current, no overlap | why it's still distinct |
| **Improve** | Right scope, but thin / unclear triggers / missing boundary | the specific gap |
| **Update** | References a renamed skill, dead flag, moved path, or superseded convention | the stale reference |
| **Retire** | Its need is fully covered elsewhere | **which skill(s) cover it now** |
| **Merge** | Overlaps another enough to combine | **the merge target** |

The Retire/Merge "must name the target" rule is the antidote to silent overlap —
e.g. is `hektor-bug-discovery` drifting into `hektor-coverage-expansion`'s
adversarial passes? is a domain skill really distinct from `hektor-test-composer`?

## Checklist per skill

- **Overlap:** does another skill's description claim the same triggers? (grep the
  other `description:` blocks for the same phrases.)
- **Freshness:** does it name a file / flag / skill that still exists? Cross-check
  against `hektor doctor` output and the real tree.
- **Boundary:** does it say what it does NOT do and point to the sibling that does?
  (Hektor's authoring convention — single-purpose + "does NOT do X → see Y".)
- **Triggers:** would the `description:` actually match the user phrasing it's for?

## Output

1. One table: skill · verdict · one-line reason. Ordered Retire/Merge first (the
   actionable ones), then Update, Improve, Keep.
2. Write/refresh `docs/hektor/skill-stocktake.json` (gitignored) with each verdict
   + reason + the SKILL.md mtime, and `evaluated_at`.
3. **Propose** the Retire/Merge/Update actions — never apply them silently; the
   maintainer decides. (Same propose-don't-write discipline as the memory loop.)

Resume: if a full stocktake is interrupted, cached entries with a verdict are
done; only skills still missing from the cache need (re-)evaluation.
