# Flaky-Kit Delivery Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a session from ending with a red test rationalised away, by enforcing the two controls the kit currently only asks for.

**Architecture:** A `Stop` hook carrying two halves at deliberately different hardness. The I11 half derives ledger paths from the transcript and runs `ledger.sh validate --final`; it blocks every stop, because the remedy — moving a cluster to a terminal state — is in the agent's hands. The hedge half pipes the last assistant message through `core/hedge-scan.sh` and blocks once, because it matches phrasing and can be wrong. The gate joins the kit's own protected surface and the wiring axis, the latter through a versioned `core/.harness` capability record so installs that predate it are not bricked.

**Tech Stack:** bash 3.2-compatible shell, `jq`, the kit's plain-bash test suites (`core/tests/*.sh`, `ok()`/`bad()` counters, exit on `$fail -eq 0`).

**Spec:** `docs/superpowers/specs/2026-07-31-flaky-kit-delivery-gate-design.md` (commit `a864abd`)

## Global Constraints

- **bash 3.2 compatible** — macOS system bash. No associative arrays, no `${var^^}`.
- **Fail open, never wedge.** Missing `jq`, an unreadable transcript, a `ledger.sh` that will not run — every one exits 0. A broken check must not block a session, and every such exit writes one line through `hektor_audit` so failing open silently and failing open deliberately stay distinguishable.
- **The I11 half has no escape.** No `stop_hook_active` bypass and no environment variable. The pack's `delivery-gate.sh` ships `HEKTOR_DELIVERY_GATE=off`; this kit does not, because it spent a full cycle removing environment overrides from `core/_integrity.sh` on the finding that a variable the subject of a check can set is a skeleton key. A Stop hook runs in an environment the agent influences, at the moment it is being checked.
- **The hedge half blocks once.** `stop_hook_active=true` passes. A false positive costs one turn, never a loop.
- **`core/hedge-scan.sh` is reused as-is.** Its regex is the kit's; a second copy is a drift obligation.
- **Claude only.** Cursor has no stop event. Check during implementation whether it has since gained one rather than assuming — the last cycle's Cursor assumption was wrong in the other direction — and record the answer.
- **`_wiring_slots` is not extended to a second filename.** It matches `flaky-kit-self-protection-gate.sh`, and adding the delivery gate's name to it would let a `PreToolUse` registration of the delivery gate count as covering Write or Edit. The Stop slot gets its own emitter.
- **`_wiring_one`'s contract is unchanged.** It stats one gate path; with two gates, `dangling` would become ambiguous. The Stop slot is evaluated separately and merged through the existing `_wiring_worse`.
- **Existing installs must not be bricked.** `core/.harness` records one token today. A record without a `stop` capability requires exactly the slots it requires now.
- **No environment override may enter `core/_integrity.sh` or `core/_wiring_repair.sh`** beyond the two names already excluded by the scans with stated reasons.
- **Do NOT run `core/lock-kit.sh lock`/`unlock`** — a bare `lock` shells out to `sudo chown -R root` and will hang on a password prompt you cannot answer. Use `mktemp -d` fixtures.
- **Run `core/tests/lock-tier-test.sh` unmodified.**
- **Test fixtures live under `mktemp -d`, never in a real project.**
- **No bare `git stash`**; **commit messages carry no AI trailers**.
- **The suite is 767 assertions, 0 failures, across 11 files.** Derive and state your own totals; fifteen earlier rounds corrected the author's arithmetic and all fifteen were right.
- **Mutation is the only accepted evidence for a new security assertion**, and each mutation must be shown to have applied **and to have produced the state its assertion names**. The preceding two branches produced an assertion that passed against a state its mutation never produced in *every single task*. Assume yours can too.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `adapters/claude/flaky-kit-delivery-gate.sh` | create | The Stop hook: transcript scan, I11 via `validate --final`, hedge via `hedge-scan`, the two block shapes |
| `core/tests/delivery-gate-test.sh` | create | Synthetic transcripts driven through the hook's stdin contract |
| `install.sh` | modify | Ship the gate, register it at `Stop`, write the `stop` capability into `core/.harness`, ship its restore source |
| `core/_integrity.sh` | modify | `_wiring_want` gains a third field; `_wiring_slots_stop`; a third block in `integrity_wiring` |
| `core/_wiring_repair.sh` | modify | `_wr_register_stop` — the Stop-shaped merge, subject to the same tier rule as everything else |
| `core/lock-kit.sh` | modify | `harden_targets` covers the new gate; residuals |
| `core/README.md`, `kernel.md`, `README.md` | modify | Describe the gate and what it does not cover |

---

## Task 1: Close the two parked residuals

**Files:**
- Modify: `kits/flaky-triage-kit/core/README.md`
- Modify: `kits/flaky-triage-kit/core/_integrity.sh`
- Modify: `kits/flaky-triage-kit/core/tests/integrity-test.sh`

**Interfaces:**
- Produces: nothing later tasks consume. This task exists to start from a tree with no known-false claims in it.

Two findings were parked at the previous branch's final review rather than fixed, because there is no second fix wave. They are cheap, they are in files this plan touches, and one has behaviour behind it.

- [ ] **Step 1: Write the failing test for the `declare -F` half**

`command -v wiring_repair` resolves PATH executables, not only functions. With a `wiring_repair` binary early on `PATH` and `core/_wiring_repair.sh` absent, the fallback does not fire and the integrity path execs that binary with `<kit> <tier> <wiring>`. Append to `core/tests/integrity-test.sh`:

```bash
# --- the repair fallback keys on a FUNCTION, not on anything PATH can answer -------------------
# `command -v` resolves executables too, so a `wiring_repair` on PATH satisfied it and the no-op
# fallback never fired — the integrity path then exec'd that binary. `declare -F` asks the property.
R="$(mktemp -d)"; K="$(wire_fixture "$R")"
rm -f "$K/core/_wiring_repair.sh"
mkdir -p "$R/fakebin"
printf '#!/bin/sh\necho PATH-BINARY-RAN >&2\nexit 0\n' > "$R/fakebin/wiring_repair"
chmod +x "$R/fakebin/wiring_repair"
OUT="$(PATH="$R/fakebin:$PATH" bash -c ". \"$K/core/_integrity.sh\"; integrity_guard \"$K\"" 2>&1 >/dev/null)"
case "$OUT" in
  *PATH-BINARY-RAN*) bad "a wiring_repair on PATH must not satisfy the repair-unit check" ;;
  *) ok ;;
esac
rm -rf "$R"
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/integrity-test.sh`
Expected: FAIL — `a wiring_repair on PATH must not satisfy the repair-unit check`.

- [ ] **Step 3: Implement**

In `core/_integrity.sh`, replace the fallback's test:

```bash
declare -F wiring_repair >/dev/null 2>&1 || wiring_repair() { return 0; }
```

`declare -F` is bash 3.2-safe and answers the question the line is asking: is there a *function* by that name. Update the comment beside it to say so — the file's own header records that a proxy standing in for a property has caused four separate defects in this kit, and `command -v` was the fifth.

- [ ] **Step 4: Fix `core/README.md`'s stale `_integrity` row**

The module table's `_integrity` row still states the pre-correction rule — that the guard writes below root ownership and nothing at `hardened`/`stale` — and contradicts the `_wiring_repair` row directly beneath it, which carries the corrected rule including `mismatch`. Rewrite the `_integrity` row so both rows say the same thing: **every tier that refuses — `hardened`, `stale`, `mismatch` — writes nothing at all.**

While you are there, `core/_integrity.sh`'s `integrity_guard` comment keys the same rule on root ownership alone. Correct it to name all three refusing tiers.

- [ ] **Step 5: Run the tests and prove the assertion is load-bearing**

Run: `bash core/tests/integrity-test.sh` — expected PASS.

Mutation, on a scratch copy, asserting it applied before reading the result: put `command -v wiring_repair >/dev/null 2>&1` back. The new assertion must redden and nothing else.

- [ ] **Step 6: Run the whole suite and commit**

```bash
for t in core/tests/*.sh; do bash "$t"; done
git add kits/flaky-triage-kit/core/_integrity.sh kits/flaky-triage-kit/core/README.md kits/flaky-triage-kit/core/tests/integrity-test.sh
git commit -m "kit: ask declare -F for a function, and stop the module table contradicting itself

command -v resolves PATH executables, so a wiring_repair binary on PATH
satisfied the repair-unit check and the no-op fallback never fired — the
integrity path then exec'd it. declare -F asks the property. This file's
header already records that a proxy standing in for a property has caused
four defects here; that was the fifth.

The _integrity module row still said the guard writes below root ownership
and nothing at hardened/stale, contradicting the row directly beneath it.
Every tier that refuses writes nothing: hardened, stale, mismatch."
```

---

## Task 2: The gate itself

**Files:**
- Create: `kits/flaky-triage-kit/adapters/claude/flaky-kit-delivery-gate.sh`
- Create: `kits/flaky-triage-kit/core/tests/delivery-gate-test.sh`

**Interfaces:**
- Produces: a Stop hook reading the harness's JSON on stdin and writing either nothing (allow) or a `{"decision":"block","reason":…}` object on stdout.
- Consumes: `core/hedge-scan.sh` (stdin → exit 2 + matched phrases on stdout when hedged), `core/ledger.sh validate <file> --final` (exit 67 when a `selected`/`applied` cluster remains).

- [ ] **Step 1: Write the failing tests**

Create `core/tests/delivery-gate-test.sh`. It builds synthetic transcript JSONL under `mktemp -d` and drives the gate exactly as the harness would.

```bash
#!/bin/bash
# core/tests/delivery-gate-test.sh — the Stop hook that refuses a session ending on an unproven fix.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$HERE/.."
GATE="$KIT/adapters/claude/flaky-kit-delivery-gate.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A transcript is JSONL; the gate reads the LAST assistant text turn and every shell command.
tx() {  # tx <file> <assistant-text> [<bash-command> ...]
  local f="$1" txt="$2"; shift 2
  : > "$f"
  local c
  for c in "$@"; do
    jq -cn --arg c "$c" '{type:"assistant",message:{role:"assistant",content:[{type:"tool_use",name:"Bash",input:{command:$c}}]}}' >> "$f"
  done
  jq -cn --arg t "$txt" '{type:"assistant",message:{role:"assistant",content:[{type:"text",text:$t}]}}' >> "$f"
}

run() {  # run <transcript> [stop_hook_active] -> stdout of the gate
  jq -cn --arg t "$1" --argjson a "${2:-false}" '{transcript_path:$t, stop_hook_active:$a}' | bash "$GATE" 2>/dev/null
}
blocked() { case "$1" in *'"block"'*) return 0 ;; *) return 1 ;; esac; }

# --- no kit invocation at all: silent. The kit runs standalone; a warning here is noise. --------
tx "$WORK/t1" "All done."
[ -z "$(run "$WORK/t1")" ] && ok || bad "a session that never touched the kit must pass silently"

# --- read-only exploration owes no state -------------------------------------------------------
tx "$WORK/t2" "Here is the report." "$KIT/core/ingest.sh /tmp/x" "$KIT/core/cluster.sh /tmp/x"
[ -z "$(run "$WORK/t2")" ] && ok || bad "ingest/cluster alone must not require a ledger"

# --- apply/rerun with NO ledger path anywhere: the work left no record --------------------------
tx "$WORK/t3" "Fixed it." "$KIT/core/apply.sh cluster-3"
blocked "$(run "$WORK/t3")" && ok || bad "apply with no ledger must block — the run left no record"
case "$(run "$WORK/t3")" in *"no ledger"*) ok ;; *) bad "the no-ledger block must say what is missing" ;; esac

# --- a ledger with an open cluster: I11 -------------------------------------------------------
L="$WORK/led.json"
jq -n '{clusters:[{id:"c1",status:"applied",title:"t"}],events:[]}' > "$L"
tx "$WORK/t4" "Done." "$KIT/core/apply.sh c1" "$KIT/core/ledger.sh cluster-state $L c1 applied"
blocked "$(run "$WORK/t4")" && ok || bad "an open selected/applied cluster must block"
case "$(run "$WORK/t4")" in *c1*) ok ;; *) bad "the I11 block must name the open cluster" ;; esac

# --- the hard block has NO stop_hook_active escape --------------------------------------------
blocked "$(run "$WORK/t4" true)" && ok || bad "I11 must block even on a re-triggered stop"

# --- a check that cannot run is not a verdict: fail open, and SAY so ---------------------------
# `ledger.sh` exits 67 for I11 and 75 for a lock timeout; only 67 means a cluster is open. Treating
# every non-zero as "open" would block on a transient lock, and treating every non-67 as "clean"
# silently passes a session whose state nobody could read.
jq -n '{clusters:"not-an-array",events:[]}' > "$WORK/bad.json"
tx "$WORK/t4b" "Done." "$KIT/core/apply.sh c1" "$KIT/core/ledger.sh cluster-state $WORK/bad.json c1 applied"
[ -z "$(run "$WORK/t4b")" ] && ok || bad "a ledger the checker cannot read must fail open, not block"

# --- closing the cluster clears it -------------------------------------------------------------
jq -n '{clusters:[{id:"c1",status:"green",title:"t",passes:5,runs:5}],events:[]}' > "$L"
[ -z "$(run "$WORK/t4")" ] && ok || bad "a terminal cluster must let the session end"

# --- the hedge half: blocks once ---------------------------------------------------------------
tx "$WORK/t5" "It should probably work, I only ran it once." "$KIT/core/apply.sh c1" "$KIT/core/ledger.sh cluster-state $L c1 green"
blocked "$(run "$WORK/t5")" && ok || bad "a hedged final message must block"
[ -z "$(run "$WORK/t5" true)" ] && ok || bad "the hedge half must block ONCE — the re-triggered stop passes"

# --- a confident message with a closed ledger passes -------------------------------------------
tx "$WORK/t6" "Cluster c1 is green: 5/5 passes, verified by core/gate." "$KIT/core/apply.sh c1" "$KIT/core/ledger.sh cluster-state $L c1 green"
[ -z "$(run "$WORK/t6")" ] && ok || bad "a proven, unhedged summary must pass"

# --- fail open: no transcript, unreadable transcript, no jq ------------------------------------
[ -z "$(jq -cn '{transcript_path:"/nonexistent/x", stop_hook_active:false}' | bash "$GATE" 2>/dev/null)" ] \
  && ok || bad "a missing transcript must fail open"
[ -z "$(printf '' | bash "$GATE" 2>/dev/null)" ] && ok || bad "empty stdin must fail open"

# --- nothing may reach stdout except the verdict JSON ------------------------------------------
OUT="$(run "$WORK/t1")"
[ -z "$OUT" ] && ok || bad "an allow must print nothing at all on stdout"

# --- no environment override may enter the gate ------------------------------------------------
grep -v '^[[:space:]]*#' "$GATE" | grep -qE '(^|[^\\])\$\{?HEKTOR[A-Z_]*' \
  && bad "the delivery gate must carry no environment bypass — the pack's does; this kit ruled it out" || ok

echo "delivery-gate-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/delivery-gate-test.sh`
Expected: FAIL — the gate does not exist, so every assertion that expects a verdict fails.

- [ ] **Step 3: Implement the gate**

```bash
#!/bin/bash
# adapters/claude/flaky-kit-delivery-gate.sh — Stop hook: refuse a session that ends unproven.
#
# Hook  : Stop
# State : none (reads the transcript, read-only)
#
# The kit's own job is refusing a red test rationalised away, and until now that job rested on two
# controls the kit only ASKED for. kernel.md states I11 as an invariant and core/ledger.sh calls
# `validate --final` "the machine gate: no session ends with selected/applied clusters" — and nothing
# called it. core/hedge-scan.sh performs its detection and SKILL.md asks the agent to pipe through it.
# This hook makes both of them run.
#
# The two halves block differently ON PURPOSE. I11 is a property: a cluster is in a terminal state or
# it is not, and the remedy is in the agent's hands — `ledger.sh cluster-state <id> green|flagged|
# deferred` is exactly the work we want. So it blocks every stop, with no stop_hook_active escape and
# no environment bypass. The pack's delivery-gate.sh ships HEKTOR_DELIVERY_GATE=off; this kit does
# not, because it removed environment overrides from core/_integrity.sh on the finding that a variable
# the SUBJECT of a check can set is a skeleton key, and a Stop hook runs in the agent's own
# environment at the moment it is being checked.
#
# The hedge half matches phrasing, so it can be wrong. It blocks once: a false positive costs one turn.
set -uo pipefail

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$_DIR/lib/audit.sh" ]; then . "$_DIR/lib/audit.sh"; else hektor_audit() { :; }; fi

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || { hektor_audit "delivery-gate: no jq, failing open"; exit 0; }

INPUT="$(head -c 1048576)"
[ -n "$INPUT" ] || { hektor_audit "delivery-gate: empty stdin, failing open"; exit 0; }

TRANSCRIPT="$(printf '%s' "$INPUT" | "$JQ" -r '.transcript_path // empty' 2>/dev/null || true)"
[ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ] || { hektor_audit "delivery-gate: no readable transcript, failing open"; exit 0; }
ACTIVE="$(printf '%s' "$INPUT" | "$JQ" -r '.stop_hook_active // false' 2>/dev/null || echo false)"

# Every shell command the session ran, one per line.
CMDS="$("$JQ" -rs '[ .[] | (.message.content? // .content? // []) | if type=="array" then .[] else empty end
                    | select(.type?=="tool_use") | (.input.command? // "") ] | .[]' "$TRANSCRIPT" 2>/dev/null || true)"

# Did the session run the kit at all, and did it CHANGE anything? apply/rerun is where a session
# stops reading and starts changing things, and it is the point a ledger is owed.
KIT_USED=0; CHANGED=0
case "$CMDS" in *core/ingest*|*core/cluster*|*core/triage*|*core/apply*|*core/rerun*|*core/gate*|*core/ledger*) KIT_USED=1 ;; esac
case "$CMDS" in *core/apply*|*core/rerun*) CHANGED=1 ;; esac
[ "$KIT_USED" = 1 ] || exit 0            # the kit was not in play; a warning here is noise

block() { "$JQ" -n --arg r "$1" '{decision:"block", reason:$r}'; exit 0; }

# --- I11 -----------------------------------------------------------------------------------------
# The ledger's path is whatever the caller passed, and the kit imposes no convention — so it is read
# out of the transcript, the one artifact the agent does not write.
LEDGERS="$(printf '%s\n' "$CMDS" | sed -n 's|.*core/ledger\(\.sh\)\{0,1\} [a-z-]* \([^ ]*\).*|\2|p' | sort -u)"
OPEN=""
FOUND_LEDGER=0
for L in $LEDGERS; do
  [ -r "$L" ] || continue
  FOUND_LEDGER=1
  MSG="$(bash "$LEDGER_SH" validate "$L" --final 2>&1)"; RC=$?
  case "$RC" in
    0)  : ;;                                   # final: no selected/applied cluster left
    67) OPEN="$OPEN
$MSG" ;;                                       # I11's own exit — the one that blocks
    *)  # Anything else is the CHECK failing, not the run failing. `ledger.sh` exits 75 on a lock
        # timeout and 65 on a malformed ledger, and neither tells us a cluster is open. Fail open —
        # but say so, because a silent pass here is indistinguishable from a clean ledger, and the
        # difference is exactly what a reader needs when a session ends that should not have.
        hektor_audit "delivery-gate: validate --final on $L exited $RC, not a verdict — failing open" ;;
  esac
done

if [ -n "$OPEN" ]; then
  hektor_audit "delivery-gate: blocked on I11"
  block "[flaky-kit delivery-gate] This session is ending with work the ledger still calls unfinished.
$OPEN

I11: a session may not end while any cluster is selected or applied. Move each one to a terminal
state that reflects what you actually proved — green (with the passes and runs that prove it),
flagged, or deferred — then finish again. This gate does not block once and let go: it blocks until
the ledger says the work is done."
fi

if [ "$FOUND_LEDGER" = 0 ] && [ "$CHANGED" = 1 ]; then
  hektor_audit "delivery-gate: blocked, no ledger for a run that changed things"
  block "[flaky-kit delivery-gate] This session ran core/apply or core/rerun and left no ledger.

I11 is the machine gate for 'the work is done', and a run with no state cannot satisfy it. Record the
run with core/ledger.sh and move every cluster to a terminal state, then finish again."
fi

# --- the hedge half: blocks ONCE ----------------------------------------------------------------
[ "$ACTIVE" = "true" ] && exit 0

LAST="$("$JQ" -rs '[ .[] | select(.type=="assistant" or (.message.role? // "")=="assistant")
                    | ((.message.content? // .content? // []))
                    | if type=="array" then ([ .[] | select(.type?=="text") | .text ] | join("\n"))
                      elif type=="string" then . else "" end ]
                  | map(select(. != "")) | (.[-1] // "")' "$TRANSCRIPT" 2>/dev/null || true)"
[ -n "$LAST" ] || exit 0

HIT="$(printf '%s' "$LAST" | bash "$_DIR/../../core/hedge-scan.sh" 2>/dev/null)" && exit 0
[ -n "$HIT" ] || exit 0
hektor_audit "delivery-gate: blocked on a hedged final message"
block "[flaky-kit delivery-gate] Your own summary says you are not sure:

$HIT

One green run is not proof — a flake passes about half the time, so a single green is the most likely
false 'fixed'. Get the proof (core/rerun … | core/gate, and treat only decision:\"accepted\" as green)
or say plainly what is still unproven. This half blocks once: if the wording was a false alarm, finish
again and it will let you through."
```

**Resolve `core/ledger.sh` and `core/hedge-scan.sh` against the INSTALLED layout, not the source tree.** The gate lives at `<proj>/.claude/hooks/` and the engine at `<proj>/.claude/skills/hektor-flaky-triage/core/`, so `$_DIR/../../core/…` — which the draft above uses for brevity — is wrong once installed. Read `install.sh` for the two real paths, derive them the way the self-protection gate already derives its own, and say in your report which expression you used. If the engine is not found, that is a fail-open exit with an audit line, not a block: a gate that cannot reach the engine cannot tell a finished session from an unfinished one, and blocking on that would wedge every stop.

- [ ] **Step 4: Run the tests**

Run: `bash core/tests/delivery-gate-test.sh`
Expected: PASS. State the file's total.

- [ ] **Step 5: Prove each half is load-bearing**

| Mutation | Must redden, and only it |
|---|---|
| `[ "$ACTIVE" = "true" ] && exit 0` moved above the I11 block | the "must block even on a re-triggered stop" assertion |
| the `FOUND_LEDGER = 0 && CHANGED = 1` block deleted | the apply-with-no-ledger assertions |
| `CHANGED` set from `core/ingest` too | the ingest/cluster-alone assertion |
| the hedge `exit 0` on a clean scan inverted | the proven-summary assertion |

Each on a scratch copy, each shown to have applied. A mutation that makes the gate exit 0 everywhere reddens most of the file and isolates nothing — that shape has been recorded as proof twice on this branch's predecessors and was wrong both times.

- [ ] **Step 6: Run the whole suite and commit**

```bash
for t in core/tests/*.sh; do bash "$t"; done
git add kits/flaky-triage-kit/adapters/claude/flaky-kit-delivery-gate.sh kits/flaky-triage-kit/core/tests/delivery-gate-test.sh
git commit -m "kit: enforce I11 and hedge-scan at Stop instead of asking for them

kernel.md states I11 as an invariant and ledger.sh calls validate --final
the machine gate; nothing called it. hedge-scan does its detection and the
SKILL asks the agent to pipe through it. Both now run.

The halves block differently on purpose. I11 is a property with a remedy
in the agent's hands, so it blocks every stop with no escape and no
environment bypass — the pack ships one, this kit ruled that a variable
the subject of a check can set is a skeleton key. The hedge half matches
phrasing, so it blocks once and a false positive costs one turn."
```

---

## Task 3: Install it, register it, record the capability

**Files:**
- Modify: `kits/flaky-triage-kit/install.sh`
- Modify: `kits/flaky-triage-kit/core/lock-kit.sh` (`harden_targets`)
- Modify: `kits/flaky-triage-kit/core/tests/install-guard-test.sh`

**Interfaces:**
- Produces: `<proj>/.claude/hooks/flaky-kit-delivery-gate.sh`, a `Stop` registration in `.claude/settings.json`, `<kit>/core/gate-src/claude/flaky-kit-delivery-gate.sh`, and a `core/.harness` whose first token is the harness and whose remaining tokens are capabilities — `claude stop`.
- Consumes: Task 2's gate.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/install-guard-test.sh`, reusing the existing Claude fixture and its `SKILL_DIR`:

```bash
# --- the delivery gate ships, registers, and records its capability ---------------------------
[ -x "$P/.claude/hooks/flaky-kit-delivery-gate.sh" ] && ok || bad "install must ship the delivery gate"
[ -f "$SKILL_DIR/core/gate-src/claude/flaky-kit-delivery-gate.sh" ] && ok || bad "the delivery gate needs a restore source like its sibling"
[ "$(jq -r '[.hooks.Stop[]?|(.hooks//[])[]?|.command|select(test("flaky-kit-delivery-gate"))]|length' "$P/.claude/settings.json")" = 1 ] \
  && ok || bad "install must register the delivery gate at Stop, exactly once"
# The capability record: first token the harness, remaining tokens capabilities.
[ "$(cat "$SKILL_DIR/core/.harness")" = "claude stop" ] && ok || bad "install must record the stop capability"
# Idempotent: a second install must not duplicate the registration or the token.
"$KITSRC/install.sh" --harness claude --project "$P" >/dev/null 2>&1
[ "$(jq -r '[.hooks.Stop[]?|(.hooks//[])[]?|.command|select(test("flaky-kit-delivery-gate"))]|length' "$P/.claude/settings.json")" = 1 ] \
  && ok || bad "a second install must not duplicate the Stop registration"
[ "$(cat "$SKILL_DIR/core/.harness")" = "claude stop" ] && ok || bad "a second install must not duplicate the capability token"
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/install-guard-test.sh`
Expected: FAIL on all six — none of it is written yet.

- [ ] **Step 3: Implement in `install.sh`**

In the Claude block, beside the self-protection gate's own copy and registration:

```bash
  cp "$HERE/adapters/claude/flaky-kit-delivery-gate.sh" "$PROJ/.claude/hooks/flaky-kit-delivery-gate.sh"
  chmod +x "$PROJ/.claude/hooks/flaky-kit-delivery-gate.sh" 2>/dev/null || true
  mkdir -p "$SKILL_DIR/core/gate-src/claude"
  cp "$HERE/adapters/claude/flaky-kit-delivery-gate.sh" "$SKILL_DIR/core/gate-src/claude/flaky-kit-delivery-gate.sh"
  chmod +x "$SKILL_DIR/core/gate-src/claude/flaky-kit-delivery-gate.sh" 2>/dev/null || true
  D='"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-delivery-gate.sh"'
  t="$(mktemp)"; jq --arg c "$D" '
    .hooks //= {} | .hooks.Stop //= [] |
    (if any(.hooks.Stop[]?; (.hooks // []) | any(.command==$c)) then .
     else .hooks.Stop += [{hooks:[{type:"command", command:$c, timeout:20}]}] end)' "$S" > "$t" && mv "$t" "$S"
```

And where `core/.harness` is written, append the capability when the Claude harness is installed:

```bash
  # First token: the --harness selection. Remaining tokens: capabilities this install shipped.
  # A record without `stop` is an install that predates the delivery gate and must go on requiring
  # exactly the slots it already required — that is what keeps the wiring axis from refusing every
  # entrypoint on every existing project the moment this ships.
  if [ "$do_claude" = 1 ]; then printf '%s stop\n' "$HARNESS" > "$SKILL_DIR/core/.harness"
  else printf '%s\n' "$HARNESS" > "$SKILL_DIR/core/.harness"; fi
```

In `core/lock-kit.sh`'s `harden_targets`, add the delivery gate beside the self-protection gate, guarded by the same `[ -f ]` test its sibling uses.

- [ ] **Step 4: Run the tests**

Run: `bash core/tests/install-guard-test.sh` — expected PASS. State the file's new total.

- [ ] **Step 5: Prove the assertions isolate**

| Mutation | Must redden, and only it |
|---|---|
| the `Stop` jq loses its `any(… .command==$c)` guard | the two idempotence assertions |
| the capability branch always writes the bare `$HARNESS` | the two `.harness` assertions |
| the `gate-src` copy removed | the restore-source assertion |
| `harden_targets`' new line removed | whichever lock-tier assertion names it — if none does, that is a finding, not a pass |

- [ ] **Step 6: Run the whole suite and commit**

```bash
for t in core/tests/*.sh; do bash "$t"; done
git add kits/flaky-triage-kit/install.sh kits/flaky-triage-kit/core/lock-kit.sh kits/flaky-triage-kit/core/tests/install-guard-test.sh
git commit -m "kit: install the delivery gate and record it as a capability

core/.harness becomes first-token-harness plus capability tokens. A record
without `stop` is an install that predates this gate and goes on requiring
exactly what it required before — which is what stops the wiring axis
refusing every entrypoint on every existing project the moment this ships."
```

---

## Task 4: The wiring axis and the repair learn the Stop slot

**Files:**
- Modify: `kits/flaky-triage-kit/core/_integrity.sh`
- Modify: `kits/flaky-triage-kit/core/_wiring_repair.sh`
- Modify: `kits/flaky-triage-kit/core/tests/integrity-test.sh`

**Interfaces:**
- Consumes: the `core/.harness` capability record from Task 3.
- Produces: `_wiring_want` → `"<claude> <cursor> <stop>"`; `_wiring_slots_stop <settings-file>` → `Stop:*\t<command>` lines; `_wr_register_stop <settings-file> <command>` → 0 on success, 1 on failure.

A control that can be silently unregistered is not a control — the same rule that put the self-protection gate on this axis.

- [ ] **Step 1: Write the failing tests**

```bash
# --- the Stop slot is required only when the record says the install shipped it ----------------
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
printf 'claude\n' > "$W/core/.harness"          # a record predating the delivery gate
[ "$(integrity_wiring "$W" degraded)" = wired ] && ok || bad "an install without the stop capability must not require the Stop slot"
printf 'claude stop\n' > "$W/core/.harness"     # this install shipped it, and it is not registered
[ "$(integrity_wiring "$W" degraded)" = partial ] && ok || bad "a stop-capable install with no Stop registration must read partial"
rm -rf "$R"

# --- registering it satisfies the axis ---------------------------------------------------------
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; P="$(dirname "$(dirname "$(dirname "$W")")")"
printf 'claude stop\n' > "$W/core/.harness"
mkdir -p "$P/.claude/hooks"; printf '#!/bin/sh\nexit 0\n' > "$P/.claude/hooks/flaky-kit-delivery-gate.sh"
chmod +x "$P/.claude/hooks/flaky-kit-delivery-gate.sh"
t="$(mktemp)"; jq '.hooks.Stop = [{hooks:[{type:"command",command:"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-delivery-gate.sh\"",timeout:20}]}]' \
  "$P/.claude/settings.json" > "$t" && mv "$t" "$P/.claude/settings.json"
[ "$(integrity_wiring "$W" degraded)" = wired ] && ok || bad "a registered, present delivery gate must read wired"
# and a registration whose file is gone is dangling, exactly as for the sibling gate
rm -f "$P/.claude/hooks/flaky-kit-delivery-gate.sh"
[ "$(integrity_wiring "$W" degraded)" = dangling ] && ok || bad "a Stop registration pointing at a missing file must read dangling"
rm -rf "$R"

# --- the repair writes the Stop slot below root ownership, and nothing at a refusing tier -------
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; P="$(dirname "$(dirname "$(dirname "$W")")")"
printf 'claude stop\n' > "$W/core/.harness"
wiring_repair "$W" degraded partial >/dev/null 2>&1
[ "$(jq -r '[.hooks.Stop[]?|(.hooks//[])[]?|.command|select(test("flaky-kit-delivery-gate"))]|length' "$P/.claude/settings.json")" = 1 ] \
  && ok || bad "below root ownership the repair must register the Stop slot"
rm -rf "$R"
for T in hardened stale mismatch; do
  R="$(mktemp -d)"; W="$(wire_fixture "$R")"; P="$(dirname "$(dirname "$(dirname "$W")")")"
  printf 'claude stop\n' > "$W/core/.harness"
  cp "$P/.claude/settings.json" "$R/before.json"
  wiring_repair "$W" "$T" partial >/dev/null 2>&1
  cmp -s "$R/before.json" "$P/.claude/settings.json" && ok || bad "$T: a refusing tier must not write the Stop slot either"
  rm -rf "$R"
done
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/integrity-test.sh`
Expected: FAIL — `_wiring_want` returns two fields, so `${3:-0}` is empty and no Stop slot is ever required.

- [ ] **Step 3: Implement**

`_wiring_want` parses the record as tokens and returns a third field:

```bash
_wiring_want() {
  local kit="${1:-}" root="${2:-}" h first c=0 u=0 s=0 tok
  h="$(cat "$kit/core/.harness" 2>/dev/null)"
  first="${h%% *}"
  case "$h" in *" stop"*|*" stop") s=1 ;; esac
  case "$first" in
    all|both) echo "1 1 $s"; return 0 ;;
    claude)   echo "1 0 $s"; return 0 ;;
    cursor)   echo "0 1 $s"; return 0 ;;
    agents)   echo "0 0 0"; return 0 ;;
  esac
  { [ -r "$root/.claude/settings.json" ] || [ -r "$root/.claude/settings.local.json" ]; } && c=1
  [ -r "$root/.cursor/hooks.json" ] && u=1
  echo "$c $u 0"
  return 0
}
```

A separate emitter for the Stop slot, deliberately NOT folded into `_wiring_slots`:

```bash
# _wiring_slots_stop <settings-file> -> "Stop:*\t<command>" lines.
#
# Its own function, not a second filename inside _wiring_slots. That function's `gate` predicate is
# consulted for the PreToolUse tools too, so teaching it the delivery gate's name would let a
# PreToolUse registration of the DELIVERY gate count as covering Write or Edit — a different gate
# satisfying a slot it does not guard.
_wiring_slots_stop() {
  jq -r '
    [ (.hooks.Stop // [])[]? | (.hooks // [])[]?
      | select((.command // "") | test("flaky-kit-delivery-gate\\.sh"))
      | "Stop:*\t\(.command)" ] | unique | .[]
  ' "$1" 2>/dev/null
}
```

In `integrity_wiring`, capture the third field and add a third block after the Cursor one — evaluated separately and merged through `_wiring_worse`, because `_wiring_one` stats ONE gate path and two gates would make `dangling` ambiguous:

```bash
  # The delivery gate is a second, independent slot: its own file, its own event, its own verdict,
  # merged by the same worse-wins rule. Folding it into the Claude block would hand _wiring_one two
  # candidate paths and make `dangling` unable to say which gate is missing.
  if [ "$ws" = 1 ]; then
    slots=''
    for f in "$root/.claude/settings.json" "$root/.claude/settings.local.json"; do
      if [ -r "$f" ]; then
        s="$(_wiring_slots_stop "$f")"
        if [ -n "$s" ]; then slots="$slots$s
"; fi
      fi
    done
    got=0; want=1; gate=''
    cmd="$(_wiring_cover "$slots" Stop '*')"
    if [ -n "$cmd" ]; then got=1; gate="$(_wiring_resolve "$cmd" "$root")"; fi
    out="$(_wiring_worse "$out" "$(_wiring_one "$gate" "$tier" "$got" "$want")")"
  fi
```

In `core/_wiring_repair.sh`, the Stop-shaped merge — same shape as `install.sh`'s, so the two cannot disagree:

```bash
# _wr_register_stop <settings-file> <command> -> 0, or 1 if the merge did not land.
_wr_register_stop() {
  local s="$1" c="$2" t rc=0
  t="$(mktemp)" || return 1
  if jq --arg c "$c" '
    .hooks //= {} | .hooks.Stop //= [] |
    (if any(.hooks.Stop[]?; (.hooks // []) | any(.command==$c)) then .
     else .hooks.Stop += [{hooks:[{type:"command", command:$c, timeout:20}]}] end)' "$s" > "$t" 2>/dev/null && [ -s "$t" ]; then
    mv "$t" "$s" || rc=1
  else
    rm -f "$t"; rc=1
  fi
  return "$rc"
}
```

and call it from `wiring_repair`'s Claude block, under the same lock and the same per-harness `did_c`, only when the record requires the capability. The refusing-tier guard already sits above it and needs no change — that is the point of having put it at the top.

- [ ] **Step 4: Run the tests**

Run: `bash core/tests/integrity-test.sh` — expected PASS. State the file's new total.

- [ ] **Step 5: Prove the no-brick guarantee and the tier rule**

The decisive mutation: make `_wiring_want` always return `1` for the third field. The "an install without the stop capability must not require the Stop slot" assertion must redden — that assertion is the whole no-brick guarantee, and without it this task ships a change that refuses every entrypoint on every project installed before today.

Then: revert the refusing-tier guard's reach over the new call and confirm the three `hardened|stale|mismatch` assertions redden, and only those.

- [ ] **Step 6: Run the whole suite and commit**

```bash
for t in core/tests/*.sh; do bash "$t"; done
git add kits/flaky-triage-kit/core/_integrity.sh kits/flaky-triage-kit/core/_wiring_repair.sh kits/flaky-triage-kit/core/tests/integrity-test.sh
git commit -m "kit: the wiring axis and the repair learn the Stop slot

A control that can be silently unregistered is not a control, so the
delivery gate joins the axis that already watches its sibling. It is a
separate slot with its own emitter and its own verdict, merged by
worse-wins: _wiring_slots' predicate is consulted for the PreToolUse tools
too, so teaching it a second filename would let one gate satisfy a slot it
does not guard, and _wiring_one stats one path, so two gates in one block
would make dangling unable to say which is missing.

Required only when core/.harness records the capability. An install that
predates the gate requires exactly what it required before."
```

---

## Task 5: Say what it enforces, and what it still does not

**Files:**
- Modify: `kits/flaky-triage-kit/core/README.md`, `kits/flaky-triage-kit/README.md`, `kits/flaky-triage-kit/kernel.md`, `kits/flaky-triage-kit/core/lock-kit.sh`
- Modify: `kits/flaky-triage-kit/adapters/claude/SKILL.md`

- [ ] **Step 1: Retire the request, keep the instruction**

`adapters/claude/SKILL.md` currently asks the agent to pipe its summary through `core/hedge-scan`. That request is now enforced at Stop. Keep the instruction — an agent that self-checks before finishing avoids a blocked stop — but say that it is checked either way, so a reader does not conclude the pipe is optional because the gate exists, nor that the gate is redundant because the pipe is documented.

Do the same for the `validate --final` sentence: `kernel.md`'s I11 row and `core/README.md`'s `ledger` row both call it "the machine gate". It finally is one. Say where it runs.

- [ ] **Step 2: Describe the gate**

Add a `delivery-gate` row to `core/README.md`'s module table naming both halves and their different hardness, and a paragraph to `kits/flaky-triage-kit/README.md` — the page a consumer reaches first — covering what blocks, what blocks once, and the fact that there is no environment bypass.

- [ ] **Step 3: Add the residuals to `lock-kit.sh`'s STILL NOT COVERED list**

```
#  14. The delivery gate is Claude-only. Cursor has no stop event, so on Cursor I11 and hedge-scan
#      remain what they were before this: prose the agent is trusted to honour.
#  15. The gate reads the transcript the harness wrote. It proves what the session RECORDED, not
#      what the session did; a ledger the agent never named on a command line is invisible to it.
#  16. `core/apply`/`core/rerun` is the dividing line for "work was done". A session that changed
#      things some other way and left no ledger is not caught.
```

- [ ] **Step 4: Sweep for claims this change makes untrue**

```bash
grep -rln 'hedge-scan\|validate --final\|I11\|only asks\|advisory' kits/flaky-triage-kit/ docs/hektor/ | grep -v '\.achilles'
```

Read every mention in every file returned and record it in your report, including the ones you judge fine. The criterion is *does this sentence say anything untrue about what is enforced?* — and the specific thing to hunt is any sentence that still calls either control advisory, a request, or unenforced.

Enumerate files, not phrases. Across the two preceding branches, seven sweep rounds each ended with a survivor, and the last one survived a phrase grep by using different words.

- [ ] **Step 5: Run the whole suite and commit**

```bash
for t in core/tests/*.sh; do bash "$t"; done
git add kits/flaky-triage-kit/core/README.md kits/flaky-triage-kit/README.md kits/flaky-triage-kit/kernel.md kits/flaky-triage-kit/core/lock-kit.sh kits/flaky-triage-kit/adapters/claude/SKILL.md
git commit -m "kit: describe the delivery gate and the three residuals it leaves

Two controls that described themselves as enforced now are. The documents
that called them requests are corrected, and the SKILL keeps asking the
agent to self-check — an agent that does avoids a blocked stop — while
saying plainly that it is checked either way."
```

---

## Self-Review

**Spec coverage:** §1 the two halves and their asymmetric hardness → Task 2. §2 transcript-derived ledger paths → Task 2. §3 the no-ledger rule and its `apply`/`rerun` dividing line → Task 2. §4 the gate on the protected surface and the versioned capability record → Tasks 3 and 4. §5 failure handling → Task 2's fail-open exits and their audit lines. §6 testing, including the silent path and the no-escape property → Task 2. §7 residuals → Task 5. §8 out of scope, not implemented. Two things the spec did not settle, decided here and flagged as such: whether the Stop slot is repairable (yes, below root ownership, by the rule the previous branch established) and how the axis holds two gates without making `dangling` ambiguous (a separate emitter and a separate verdict merged by worse-wins).

**Placeholder scan:** clean. A scaffolding artifact in Task 2's gate code was caught by this review and removed rather than shipped with a note telling the implementer to delete it — a plan that knowingly carries broken code is the shape this project keeps retracting.

**Type consistency:** `_wiring_want` returns three fields in Task 4 and is read as three there; `_wiring_slots_stop` and `_wr_register_stop` are named identically in their definitions, their call sites and the Interfaces blocks. `core/.harness`'s format — first token harness, remaining tokens capabilities — is written in Task 3 and parsed in Task 4.
