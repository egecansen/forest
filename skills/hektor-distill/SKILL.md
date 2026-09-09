---
name: hektor-distill
description: >
  Turn a session's captured tool log into PROPOSED memory. Reads
  docs/hektor/observations.jsonl (written by the observe.sh postToolUse hook) plus
  the recent git diff, hands them to one cheap read-only subagent, and proposes new
  MEMORY.md entries for the maintainer to accept or reject — it never writes memory itself.
  On-demand only. Triggers on "distill this session", "what did we learn",
  "propose memory from the log", "run distill". Adapted from ECC
  continuous-learning-v2, minus the daemon / confidence-scoring (see docs/ecc-backlog.md).
disable-model-invocation: true
---

# Hektor distill

The `observe.sh` hook deterministically logs every work-bearing tool call to
`docs/hektor/observations.jsonl` (secret-scrubbed). This skill mines that log —
manually, when you ask — for patterns worth remembering, and **proposes** memory
entries. The human is always the write-gate: nothing lands in `MEMORY.md`
automatically. (That single constraint — dropping `Write` from the model's
allowed tools — is what makes this safe to run.)

## Run it

Two steps: gather the raw material with shell, then hand it to a **read-only
subagent** to distil.

**1. Gather.**

```bash
ROOT=$(git rev-parse --show-toplevel)
OBS="$ROOT/docs/hektor/observations.jsonl"
[ -f "$OBS" ] || { echo "no observations yet (is observe.sh installed + a Hektor project?)"; exit 0; }

{ echo "## Observations (last 500 tool calls)"; tail -n 500 "$OBS"
  echo; echo "## Recent changes"; git -C "$ROOT" diff --stat 2>/dev/null | tail -40
  git -C "$ROOT" log --oneline -10 2>/dev/null; } > "$ROOT/docs/hektor/.distill-input.md"
```

**2. Distil.** Dispatch the `hektor-distiller` subagent with the contents of
`scripts/distill-prompt.txt` as its brief, pointing it at
`docs/hektor/.distill-input.md`. Ask it to write its proposals to
`docs/hektor/memory-proposals.md`.

That subagent is defined `readonly: true` (`.cursor/agents/hektor-distiller.md`),
so it can read the log and verify a pattern in the repo but **cannot persist
anything** — you paste its output into `memory-proposals.md` yourself, or let it
return the block and write it in the main session. That single constraint is what
makes this safe to run unattended.

Why a subagent and not a CLI call: this used to shell out to a one-shot
`claude --model haiku --print`. That coupled the skill to a specific vendor CLI
being installed and authenticated. A subagent gets the same isolated cheap pass
using the harness that is already running, with the read-only restriction
declared in one place instead of re-argued per invocation.

## What the distiller looks for

Only patterns that recur (be conservative — ECC's rule is 3+ observations), in
four buckets, mapped to Hektor's memory `type`:

| Pattern | → memory type |
|---|---|
| A correction you gave the agent ("no, use X") | `feedback` |
| An error → the fix that resolved it (a reusable recipe) | `reference` |
| A repeated workflow / convention in this repo | `project` |
| A stated tool/style preference | `user` |

Each proposal is one MEMORY.md-shaped block (frontmatter `name` / `description` /
`type`, then the fact + **Why:** / **How to apply:** for feedback/project). No
code snippets — patterns only. If nothing recurs 3+ times, it proposes nothing.

The prompt lives in `scripts/distill-prompt.txt` beside this file.

## Review

Read `docs/hektor/memory-proposals.md`. For each proposal you accept, create the
memory file and add its `MEMORY.md` pointer line yourself (or ask the agent to,
which then goes through the normal review). Discard the rest. Then optionally
truncate `observations.jsonl` so the next distill starts fresh.

`observations.jsonl`, `.distill-input.md` and `memory-proposals.md` are all
gitignored — they never reach a PR.
