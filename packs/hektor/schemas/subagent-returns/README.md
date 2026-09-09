# Hektor subagent-return schemas

Machine-readable contracts for what each Hektor subagent role must return to
the orchestrator. JSON Schema (draft 2020-12). These are the **single source
of truth** the schema hooks read:

- `.cursor/hooks/subagent-schema-preread-gate.sh` (subagentStart) — denies a
  schema-validated dispatch whose brief doesn't cite its schema filename.
- `.cursor/hooks/subagent-return-schema-guard.sh` (subagentStop) — flags
  when a return is missing a required field or violates a top-level enum.

## Role-prefix → schema map

A dispatch opts into validation by starting its Agent `description` with one of
these role prefixes. Dispatches without a recognised prefix are silent-allowed
(gradual adoption — the same model the reviewer cluster uses).

| Description prefix | Schema | Subagent |
|---|---|---|
| `composer-<j-slug>:` | [`composer.schema.json`](./composer.schema.json) | hektor-test-composer |
| `probe-<j-slug>:` | [`probe.schema.json`](./probe.schema.json) | hektor-bug-discovery |
| `workflow-reviewer-*` / `phase-validator-*` | [`reviewer.schema.json`](./reviewer.schema.json) | reviewer / validator |
| `diagnosis-<...>:` | [`diagnosis.schema.json`](./diagnosis.schema.json) | hektor-failure-diagnosis |
| (any of the above) | [`handover.schema.json`](./handover.schema.json) | shared `handover` block |

## What the guard enforces vs. documents

The guard is **jq-driven and dependency-free** (no node/ajv). It enforces the
parts a small validator can check reliably:

- **`required` top-level keys present** in the return.
- **top-level `enum` membership** for scalar fields (e.g. `verdict` ∈ approve/reject/escalate).

Conditional rules (`allOf`/`if`/`then` — e.g. "verdict: approve ⇒ attestation
required") are **documented in the schema** but enforced separately:
`reviewer-attestation-gate.sh` covers the approve⇒evidence case today. To
enforce the full conditional set, add a `node`+`ajv` validation branch to the
guard (Achilles' model) — the schemas are already written to support it.

## Returns are YAML

Subagents return YAML in practice. The guard extracts top-level scalar fields
by line (`^key:`) — robust for flat required-field and enum checks, which is all
it claims to do.
