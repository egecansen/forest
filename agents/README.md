# Hektor subagents

Cursor discovers these from `.cursor/agents/`. Each is a role the Hektor skills
dispatch into; the skill owns the *method*, the agent file owns the *contract*
(what it may touch, what it must return).

## The `role:` line — required on every Hektor dispatch

The enforcement gates key on a short role label. Cursor's `subagentStart` payload
carries `task` but no `description`, so **the first line of every Hektor dispatch
must name the role**:

```
role: composer-j-hybrid-search-istanbul
<the rest of the brief>
```

Recognised prefixes, and what each unlocks:

| Role prefix | Agent | Gates that fire |
|---|---|---|
| `composer-<j-slug>` | `hektor-composer` | schema-preread (composer.schema.json), return-schema |
| `probe-<j-slug>` | `hektor-prober` | schema-preread (probe.schema.json), return-schema |
| `diagnosis-<target>` | `hektor-diagnoser` | schema-preread (diagnosis.schema.json), return-schema |
| `workflow-reviewer-<phase\|pass>-<N>` | `hektor-reviewer` | brief-integrity, approver lease, attestation, return-schema |
| `phase-validator-<N>` | `hektor-reviewer` | approver lease, schema-preread, return-schema |
| `[group] …` / `[P3-batch] …` | `hektor-composer` | first-pass guard (denied on Pass 1 / under `depth`) |

A dispatch with no recognised prefix runs ungated — that is deliberate, so
ad-hoc exploration is not blocked. It also means an ungated dispatch cannot land
a ledger approval.

## Return shapes

`composer`, `probe`, `diagnosis` and `reviewer` returns are validated against
`.cursor/schemas/subagent-returns/*.schema.json` at `subagentStop`. The brief
must name the schema (the schema-preread gate denies the dispatch otherwise), so
the subagent knows the shape before it starts rather than after it is graded.
