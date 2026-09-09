# Hektor skill registry

Cursor loads a skill when its `description:` matches what you're doing, and you
can always invoke one explicitly with `/<skill-name>`. This file is the
human-readable index — never rely on memory to spell a skill name; copy it from
here verbatim.

Two of these are **glob-scoped** (`paths:` in their frontmatter) so they attach
automatically when you open a file they govern: `hektor-conventions` on
`web-ui-test/**/*.java`, `hektor-resource-client` on `*ResourceClient.java` /
`AbName.java`, and `hektor-test-dao` on `*DAO.java` / `*DAOImpl.java`. Four are
**explicit-only** (`disable-model-invocation: true`) —
`hektor-distill`, `hektor-skill-stocktake`, `hektor-test-catalogue`,
`hektor-work-summary-deck` — because each is on-demand reporting or maintenance
that should never fire mid-task.

| Skill | When |
|---|---|
| [`hektor-orchestrator`](./hektor-orchestrator/SKILL.md) | Root router. The first hop for any `Hektor, ...` user prompt. |
| [`hektor-from-jira`](./hektor-from-jira/SKILL.md) | ONE ticket, end to end. Fetches it via the Atlassian MCP, plans, gates on the plan, composes, gates again on the fixes, hands the files back uncommitted. Never commits, never comments on Jira. |
| [`hektor-multi-ticket`](./hektor-multi-ticket/SKILL.md) | TWO OR MORE tickets in one request. One fully Hektor-active worktree per ticket (forest-managed), waves of 2–3, every `gradle test` serialised through a lease over the reserved testbox pool, one report table back to the primary session. Drives `hektor-from-jira` per ticket. |
| [`hektor-conventions`](./hektor-conventions/SKILL.md) | The framework-rules kernel. Read BEFORE any code change to `*Page.java`, `*Layout.java`, or `*Test.java`. |
| [`hektor-resource-client`](./hektor-resource-client/SKILL.md) | REST test-data helpers in `test-data-client`. Reuse an existing `*ResourceClient` method first; if missing, `tech/TDC-<n>` then consume from web-test. Never write a client in `web-ui-test/`. |
| [`hektor-test-dao`](./hektor-test-dao/SKILL.md) | SQL helpers in `test-dao`. Reuse an existing `*DAO` method first; if missing, `tech/DAO-<n>` then consume from web-test. Never write a DAO in `web-ui-test/`. |
| [`hektor-qagent`](./hektor-qagent/SKILL.md) | The QA-corpus retrieval kernel (`qagent` MCP). Read-only semantic search over every existing test, the documented business rules, and step-level run traces. Consulted for dedup, rule-grounding, and historical selectors. |
| [`hektor-journey-mapping`](./hektor-journey-mapping/SKILL.md) | Map user journeys for a sahibinden section. Mandatory before coverage expansion. |
| [`hektor-page-authoring`](./hektor-page-authoring/SKILL.md) | Author/modify `*Page.java` + `*Layout.java` matching framework conventions. |
| [`hektor-test-composer`](./hektor-test-composer/SKILL.md) | Compose the full test portfolio for ONE journey. |
| [`hektor-coverage-expansion`](./hektor-coverage-expansion/SKILL.md) | Iterate the journey map and dispatch composer per journey. |
| [`hektor-failure-diagnosis`](./hektor-failure-diagnosis/SKILL.md) | Diagnose ONE failing test through evidence-based triage. |
| [`hektor-test-repair`](./hektor-test-repair/SKILL.md) | Batch-heal a rotted suite by clustering failures by shared root cause. |
| `hektor-flaky-triage` (installed by [the kit](../kits/flaky-triage-kit/)) | Triage a flaky testbox run from an s-report URL: re-run the failures on that box, present ONE easy→bug clusters table, fix what the user picks, prove it green. |
| [`hektor-bug-discovery`](./hektor-bug-discovery/SKILL.md) | Adversarial probing of the live app; landed regression specs + bug ledger. |
| [`hektor-verify`](./hektor-verify/SKILL.md) | Single-change verification with full evidence bundle. |
| [`hektor-visual-regression`](./hektor-visual-regression/SKILL.md) | VRT baseline management via `@VisualRegression` + `@VisualRegressionTest`. |
| [`hektor-edr-contract`](./hektor-edr-contract/SKILL.md) | Lock Kafka EDR event contracts via the existing `EdrTestCycleDataCtx` plumbing. |
| [`hektor-security-zap`](./hektor-security-zap/SKILL.md) | OWASP ZAP probes via `@ZapSecurityTest`. Authorisation required. |
| [`hektor-test-catalogue`](./hektor-test-catalogue/SKILL.md) | Stakeholder-facing scenario inventory of the existing suite. |
| [`hektor-work-summary-deck`](./hektor-work-summary-deck/SKILL.md) | Branded HTML/PDF report of Hektor's QA output for a period. |
| [`hektor-write-language-test`](./hektor-write-language-test/SKILL.md) | Author a language test — ONE method that passes in the default TR run AND under `-Dtest.lang=en`. |
| [`hektor-distill`](./hektor-distill/SKILL.md) | Mine `docs/hektor/observations.jsonl` + the recent diff to PROPOSE `MEMORY.md` entries. Never auto-writes. |
| [`hektor-skill-stocktake`](./hektor-skill-stocktake/SKILL.md) | Periodic quality audit of the Hektor pack itself — Keep / Improve / Update / Retire / Merge per skill. |
| [`turkce-imla-anlatim`](./turkce-imla-anlatim/SKILL.md) | Türkçe metinlerde imla ve anlatım kontrolü, TDK Sözlük API üzerinden. Not a QA skill — bundled because the same people write Turkish test data and release notes. |

---

## Phase → skill mapping (see `METHODOLOGY.md` for the full doc)

```
Entry:  1 ticket   → hektor-from-jira
        N tickets  → hektor-multi-ticket  (one worktree per ticket; drives from-jira per ticket)
```

```
0. Corpus retrieval        → hektor-qagent  (cross-cutting; consulted by 2,4,5,7,10)
1. Convention check        → hektor-conventions
2. Journey mapping         → hektor-journey-mapping
3. Page/layout authoring   → hektor-page-authoring
3b. Data-layer (REST/SQL)  → hektor-resource-client / hektor-test-dao  (reuse first)
4. Test composition        → hektor-test-composer
5. Coverage expansion      → hektor-coverage-expansion
6. Failure diagnosis       → hektor-failure-diagnosis  → hektor-test-repair (if batch)
7. Bug discovery           → hektor-bug-discovery
8. Contract locks          → hektor-visual-regression / hektor-edr-contract / hektor-security-zap
9. Single-change verify    → hektor-verify
10. Report                 → hektor-test-catalogue / hektor-work-summary-deck
```

---

## Authoring new Hektor skills

If you need to add a Hektor skill that isn't in this registry:

1. Pick a name with the `hektor-` prefix.
2. Create `skills/<name>/SKILL.md` with a YAML frontmatter block carrying
   `name:` (matching the directory exactly) and `description:`. The description
   is what tells Cursor when to load it — be specific about triggers.
   Optional: `paths:` to glob-scope it, `disable-model-invocation: true` to make
   it `/<name>`-only. Those are the only frontmatter fields Cursor reads; a typo
   in a key is silently ignored, which `hektor doctor` warns about.
3. The skill body documents inputs, procedure, refusal cases, and return
   shape (mirror the existing skills). Bundle helpers under `scripts/` and long
   lookups under `references/` — both load on demand, keeping the body small.
4. Add a row to this registry and an entry to `catalog.json`.
5. If the skill belongs in the phase map, update `METHODOLOGY.md` and
   `hektor-orchestrator`'s entry classification table.
6. Run `hektor doctor` — it checks frontmatter, the name↔dir match, and the
   catalog cross-reference.
