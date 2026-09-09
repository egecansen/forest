---
name: hektor-distill
description: >
  Turn a session's captured tool log into PROPOSED memory. Reads
  docs/hektor/observations.jsonl (written by the observe.sh PostToolUse hook) plus
  the recent git diff, runs one cheap Haiku pass, and proposes new MEMORY.md
  entries for the maintainer to accept or reject — it never writes memory itself.
  On-demand only. Triggers on "distill this session", "what did we learn",
  "propose memory from the log", "run distill". Adapted from ECC
  continuous-learning-v2, minus the daemon / confidence-scoring (see docs/ecc-backlog.md).
---

# Hektor distill

The `observe.sh` hook deterministically logs every work-bearing tool call to
`docs/hektor/observations.jsonl` (secret-scrubbed). This skill mines that log —
manually, when you ask — for patterns worth remembering, and **proposes** memory
entries. The human is always the write-gate: nothing lands in `MEMORY.md`
automatically. (That single constraint — dropping `Write` from the model's
allowed tools — is what makes this safe to run.)

## Run it

```bash
ROOT=$(git rev-parse --show-toplevel)
OBS="$ROOT/docs/hektor/observations.jsonl"
[ -f "$OBS" ] || { echo "no observations yet (is observe.sh installed + a Hektor project?)"; exit 0; }

{ echo "## Observations (last 500 tool calls)"; tail -n 500 "$OBS"
  echo; echo "## Recent changes"; git -C "$ROOT" diff --stat 2>/dev/null | tail -40
  git -C "$ROOT" log --oneline -10 2>/dev/null; } \
| claude --model haiku --print --allowedTools Read \
    -p "$(cat "$ROOT/.claude/skills/hektor-distill/distill-prompt.txt")" \
> "$ROOT/docs/hektor/memory-proposals.md"

echo "proposals written to docs/hektor/memory-proposals.md — review, then hand-copy the good ones into MEMORY.md"
```

(`claude --print` runs one non-interactive Haiku turn. `--allowedTools Read`
deliberately omits Write/Edit — the pass can read to verify a pattern but cannot
persist anything.)

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

The prompt lives in `distill-prompt.txt` beside this file.

## Review

Read `docs/hektor/memory-proposals.md`. For each proposal you accept, create the
memory file and add its `MEMORY.md` pointer line yourself (or ask the agent to,
which then goes through the normal review). Discard the rest. Then optionally
truncate `observations.jsonl` so the next distill starts fresh.

Both `observations.jsonl` and `memory-proposals.md` are gitignored — they never
reach a PR.
