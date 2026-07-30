# Kit Wiring Self-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the kit notice when its own gate is not actually wired, and stop an agent from silently deleting the registration that wires it.

**Architecture:** A second axis alongside the existing lock tier. `integrity_wiring` answers "will the gate actually run?" from the harness settings files and the gate file on disk; `integrity_report` takes both axes and refuses only when a `hardened` tier has lost its wiring. The gates gain the settings files as surface — asymmetrically, because Write/Edit can inspect the proposed outcome and Bash cannot.

**Tech Stack:** bash 3.2-compatible shell, `jq`, POSIX `stat`, the kit's plain-bash test suites (`core/tests/*.sh`, `ok()`/`bad()` counters, exit on `$fail -eq 0`).

**Spec:** `docs/superpowers/specs/2026-07-30-kit-wiring-self-check-design.md` (commit `06b9f05`)

## Global Constraints

- **bash 3.2 compatible** — macOS system bash. No associative arrays, no `${var^^}`.
- **`_integrity.sh` must never wedge a caller.** Every function returns 0 and prints its answer; a broken check must not break the kit. `jq` unavailable, unreadable settings, or a non-installed layout all resolve to `absent` and print nothing.
- **stderr only.** Four entrypoints (`rerun`, `gate`, `ledger`, `summary`) emit a machine-read contract on stdout.
- **`stat` is not portable:** BSD/macOS `stat -f %u`, GNU `stat -c %u`. `integrity_owner_uid` already branches on `uname -s` — reuse it, do not re-implement.
- **No environment override may enter `_integrity.sh`.** `core/tests/integrity-test.sh` greps the file to prove it: a variable that lets a caller fake the answer is a skeleton key to this very check. Test seams run through function boundaries.
- **Do NOT run `core/lock-kit.sh lock`/`unlock`** against the real kit, and never without `HEKTOR_FK_NO_SUDO=1` — a bare `lock` shells out to `sudo chown -R root` and will hang on a password prompt you cannot answer. Use `mktemp -d` fixtures.
- **Run `core/tests/lock-tier-test.sh` unmodified** — a blanket `HEKTOR_FK_NO_SUDO=1` over the whole file breaks its own PATH-shimmed-sudo section and yields spurious failures. Five people have hit this.
- **No bare `git stash`** — the stash stack is shared across worktrees and sessions.
- **Commit messages carry no AI trailers** — no `Co-Authored-By`, no "Generated with", no session link.
- **All 461 existing assertions must stay green.** Derive and state your own totals rather than adopting a number from this plan; four earlier tasks corrected the author's arithmetic and all four were right.
- **Mutation is the only accepted evidence for a new security assertion.** Eight assertions in the preceding lock work passed without testing what they named — every one found by mutation, none by reading, and two were introduced by the fix wave correcting the others. For each assertion you add, break what it names and show the suite goes red.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `core/_integrity.sh` | modify | Add `integrity_project_root`, `integrity_wiring`, the two per-harness helpers, the worse-wins combiner; extend `integrity_report` to two axes; add the per-process latch to `integrity_guard` |
| `core/tests/integrity-test.sh` | modify | Fixtures for all six wiring values, the tier × wiring matrix, the fixture-reaches-non-absent control, the no-override grep (already present — keep it passing) |
| `adapters/claude/flaky-kit-self-protection-gate.sh` | modify | Settings files in `SURF_RE`/`match_surface` (Bash branch); outcome inspection in the Write/Edit branch |
| `adapters/cursor/flaky-kit-self-protection-gate.sh` | modify | The same two changes, byte-identical patterns |
| `core/shell-guard.py` | modify | Settings files in its own `SURF` — it is the primary Bash decision path, not the gates' grep |
| `core/tests/self-protection-test.sh` | modify | Bash-branch and Write/Edit-branch assertions for the settings files |
| `core/README.md`, `kernel.md`, `core/lock-kit.sh` header | modify | Describe the second axis and what it does not cover |

---

## Task 1: `integrity_wiring` and its fixtures

**Files:**
- Modify: `kits/flaky-triage-kit/core/_integrity.sh`
- Modify: `kits/flaky-triage-kit/core/tests/integrity-test.sh`

**Interfaces:**
- Produces: `integrity_project_root <kit_root>` → the project root, or empty when the kit is not in an installed layout. Always returns 0.
- Produces: `integrity_wiring <kit_root> <tier>` → one of `wired|unregistered|dangling|foreign|partial|absent`. Always returns 0.
- Consumes: `integrity_owner_uid` (already in the file).
- Task 2 composes both into `integrity_guard`.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/integrity-test.sh`, before its final `echo`:

```bash
# --- integrity_project_root: verify the SHAPE, never a level count -------------------
PR="$(mktemp -d)"
mkdir -p "$PR/proj/.claude/skills/hektor-flaky-triage/core"
[ "$(integrity_project_root "$PR/proj/.claude/skills/hektor-flaky-triage")" = "$PR/proj" ] \
  && ok || bad "project root must be derived from an installed layout"
mkdir -p "$PR/wrong/skills/hektor-flaky-triage"
[ -z "$(integrity_project_root "$PR/wrong/skills/hektor-flaky-triage")" ] \
  && ok || bad "a layout whose grandparent is not .claude must yield no project root"
mkdir -p "$PR/nope/.claude/plugins/hektor-flaky-triage"
[ -z "$(integrity_project_root "$PR/nope/.claude/plugins/hektor-flaky-triage")" ] \
  && ok || bad "a layout whose parent is not skills must yield no project root"
[ -z "$(integrity_project_root "$PR/proj/.claude/skills")" ] \
  && ok || bad "a directory not named hektor-flaky-triage must yield no project root"
[ -z "$(integrity_project_root)" ] && ok || bad "no argument must yield no project root, not an error"

# --- integrity_wiring: one fixture builder, six outcomes ----------------------------
# wire_fixture <dir> — an installed layout with both harnesses correctly registered.
wire_fixture() {
  local d="$1" k="$1/.claude/skills/hektor-flaky-triage"
  mkdir -p "$k/core" "$d/.claude/hooks" "$d/.cursor/hooks"
  printf 'x\n' > "$d/.claude/hooks/flaky-kit-self-protection-gate.sh"
  printf 'x\n' > "$d/.cursor/hooks/flaky-kit-self-protection-gate.sh"
  cat > "$d/.claude/settings.json" <<'JSON'
{"hooks":{"PreToolUse":[
  {"matcher":"Write|Edit","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]},
  {"matcher":"Bash","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]}
]}}
JSON
  cat > "$d/.cursor/hooks.json" <<'JSON'
{"version":1,"hooks":{
  "beforeShellExecution":[{"command":".cursor/hooks/flaky-kit-self-protection-gate.sh"}],
  "preToolUse":[{"command":".cursor/hooks/flaky-kit-self-protection-gate.sh","matcher":"Write|Edit"}]
}}
JSON
  echo "$k"
}
W="$(mktemp -d)"; K1="$(wire_fixture "$W/a")"

# CONTROL, required: prove the fixture actually reaches a non-absent state. `absent` silences every
# assertion below, so a fixture that quietly fails to look installed would make them all vacuously
# pass — which is exactly how C1's "the fixture was too kind" defect survived a full review.
[ "$(integrity_wiring "$K1" degraded)" != absent ] \
  && ok || bad "CONTROL: the fixture must reach a non-absent wiring state, or every assertion below is vacuous"
[ "$(integrity_wiring "$K1" degraded)" = wired ] && ok || bad "a correctly registered fixture must be wired"

# dangling: registered, file gone — the case observed live in a web-test worktree
K2="$(wire_fixture "$W/b")"; rm -f "$W/b/.claude/hooks/flaky-kit-self-protection-gate.sh"
[ "$(integrity_wiring "$K2" degraded)" = dangling ] && ok || bad "a registration pointing at a missing file must be dangling"

# unregistered: settings present, no registration for the kit's gate
K3="$(wire_fixture "$W/c")"; printf '{"hooks":{"PreToolUse":[]}}\n' > "$W/c/.claude/settings.json"
printf '{"version":1,"hooks":{}}\n' > "$W/c/.cursor/hooks.json"
[ "$(integrity_wiring "$K3" degraded)" = unregistered ] && ok || bad "settings with no kit registration must be unregistered"

# partial: one matcher registered, the other dropped
K4="$(wire_fixture "$W/d")"
jq '.hooks.PreToolUse |= map(select(.matcher != "Bash"))' "$W/d/.claude/settings.json" > "$W/d/s" && mv "$W/d/s" "$W/d/.claude/settings.json"
rm -f "$W/d/.cursor/hooks.json"
[ "$(integrity_wiring "$K4" degraded)" = partial ] && ok || bad "one matcher registered and one missing must be partial"

# absent: an installed layout with no harness settings at all — terminal-only use, NOT a defect
K5="$(wire_fixture "$W/e")"; rm -f "$W/e/.claude/settings.json" "$W/e/.cursor/hooks.json"
[ "$(integrity_wiring "$K5" degraded)" = absent ] && ok || bad "no harness settings at all must be absent, not a defect"

# foreign: hardened tier, gate file present but NOT root-owned — it cannot be the kit's gate.
# Below hardened the same tree is `wired`, because ownership proves nothing there.
K6="$(wire_fixture "$W/f")"
[ "$(integrity_wiring "$K6" hardened)" = foreign ] && ok || bad "at hardened, a non-root-owned gate file must be foreign"
[ "$(integrity_wiring "$K6" degraded)" = wired ] && ok || bad "below hardened, ownership proves nothing — the same tree is wired"

# worse-value-wins across harnesses: a working half must not hide a broken half
K7="$(wire_fixture "$W/g")"; rm -f "$W/g/.cursor/hooks/flaky-kit-self-protection-gate.sh"
[ "$(integrity_wiring "$K7" degraded)" = dangling ] && ok || bad "a dangling Cursor gate must not be masked by a wired Claude gate"

# not an installed layout -> absent, silent. Running the suite from the source tree must not warn.
[ "$(integrity_wiring "$W" degraded)" = absent ] && ok || bad "a non-installed layout must be absent"
rm -rf "$PR" "$W"
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/integrity-test.sh`
Expected: FAIL — `integrity_project_root: command not found`

- [ ] **Step 3: Implement in `core/_integrity.sh`**

Add below `integrity_owner_uid`:

```bash
# integrity_project_root <kit_root> -> the project root, or empty when this is not an installed kit.
#
# Verifies the SHAPE of the installed layout — <proj>/.claude/skills/hektor-flaky-triage — rather
# than counting three levels up. Counting is a proxy that happens to be right for one layout; the
# shape is the property being asked about. It also means running the suite from the source tree
# (kits/flaky-triage-kit) yields nothing and the wiring check stays silent there, instead of
# accidentally resolving to some unrelated directory.
integrity_project_root() {
  local kit="${1:-}" k s c
  [ -n "$kit" ] || return 0
  k="$(cd "$kit" 2>/dev/null && pwd -P)" || return 0
  [ -n "$k" ] || return 0
  [ "$(basename "$k")" = "hektor-flaky-triage" ] || return 0
  s="$(dirname "$k")"; [ "$(basename "$s")" = "skills" ] || return 0
  c="$(dirname "$s")"; [ "$(basename "$c")" = ".claude" ] || return 0
  dirname "$c"
  return 0
}

# _wiring_reg_claude <settings-file> <matcher> -> 0 if the kit's gate is registered for that matcher.
_wiring_reg_claude() {
  jq -e --arg m "$2" '
    (.hooks.PreToolUse // [])
    | map(select(.matcher == $m))
    | map((.hooks // []) | map(.command // "")
          | map(select(test("flaky-kit-self-protection-gate\\.sh"))) | length)
    | (add // 0) > 0
  ' "$1" >/dev/null 2>&1
}

# _wiring_reg_cursor <hooks-file> <event> -> 0 if the kit's gate is registered for that event.
_wiring_reg_cursor() {
  jq -e --arg e "$2" '
    ((.hooks[$e]) // []) | map(.command // "")
    | map(select(test("flaky-kit-self-protection-gate\\.sh"))) | length > 0
  ' "$1" >/dev/null 2>&1
}

# _wiring_one <gate-file> <tier> <registered-count> <expected-count> -> a wiring value for one harness
_wiring_one() {
  local gate="$1" tier="$2" got="$3" want="$4"
  [ "$got" -eq 0 ] && { echo unregistered; return 0; }
  [ "$got" -lt "$want" ] && { echo partial; return 0; }
  [ -f "$gate" ] || { echo dangling; return 0; }
  # Identity comes free from the tier: harden_targets chowns the gate, and a replacement cannot be
  # root-owned without the password. Below hardened, ownership proves nothing, so existence is all
  # there is to check — claiming more there would be the overclaim this kit keeps retracting.
  if [ "$tier" = hardened ] && [ "$(integrity_owner_uid "$gate")" != "0" ]; then echo foreign; return 0; fi
  echo wired
  return 0
}

# _wiring_rank <value> -> a severity rank. Higher is worse. `absent` is NOT ranked: it means "this
# harness is not configured", so it must never drag down a harness that is.
_wiring_rank() {
  case "${1:-}" in
    wired) echo 1 ;; partial) echo 2 ;; dangling) echo 3 ;;
    unregistered) echo 4 ;; foreign) echo 5 ;; *) echo 0 ;;
  esac
}

# integrity_wiring <kit_root> <tier> -> wired|unregistered|dangling|foreign|partial|absent
#
# The SECOND axis, deliberately separate from integrity_tier. A hardened install can be miswired and
# a never-locked one can be wired perfectly; folding them into one vocabulary would repeat the
# collapse that once reported a plainly-writable fresh install as "degraded — read-only".
#
# Every failure mode resolves to `absent` and prints nothing: no jq, unreadable settings, or a
# layout that is not an installed kit. Not knowing is not the same as broken, and a check that
# cannot run must not wedge the caller.
integrity_wiring() {
  local kit="${1:-}" tier="${2:-}" root f got want v best=0 out=absent
  root="$(integrity_project_root "$kit")"
  [ -n "$root" ] || { echo absent; return 0; }
  command -v jq >/dev/null 2>&1 || { echo absent; return 0; }

  # Claude: a registration in EITHER settings file counts — requiring both would fail every project
  # that uses only one. Both matchers are required, because half a registration is half the gate.
  if [ -r "$root/.claude/settings.json" ] || [ -r "$root/.claude/settings.local.json" ]; then
    got=0; want=2
    for m in 'Write|Edit' 'Bash'; do
      for f in "$root/.claude/settings.json" "$root/.claude/settings.local.json"; do
        [ -r "$f" ] || continue
        if _wiring_reg_claude "$f" "$m"; then got=$((got+1)); break; fi
      done
    done
    v="$(_wiring_one "$root/.claude/hooks/flaky-kit-self-protection-gate.sh" "$tier" "$got" "$want")"
    if [ "$(_wiring_rank "$v")" -gt "$best" ]; then best="$(_wiring_rank "$v")"; out="$v"; fi
  fi

  # Cursor: one file, two events.
  if [ -r "$root/.cursor/hooks.json" ]; then
    got=0; want=2
    for e in beforeShellExecution preToolUse; do
      _wiring_reg_cursor "$root/.cursor/hooks.json" "$e" && got=$((got+1))
    done
    v="$(_wiring_one "$root/.cursor/hooks/flaky-kit-self-protection-gate.sh" "$tier" "$got" "$want")"
    if [ "$(_wiring_rank "$v")" -gt "$best" ]; then best="$(_wiring_rank "$v")"; out="$v"; fi
  fi

  echo "$out"
  return 0
}
```

- [ ] **Step 4: Run the tests**

Run: `bash core/tests/integrity-test.sh`
Expected: PASS, all assertions green. State the file's new total.

- [ ] **Step 5: Prove each new assertion is load-bearing**

For each mutation below, apply it to a **scratch copy outside the repo**, run `integrity-test.sh`, and record which assertion failed. Every one must fail something:

| Mutation | Must fail |
|---|---|
| `integrity_project_root` returns `dirname` of three levels without checking names | the two shape assertions |
| `_wiring_one` skips the `[ -f "$gate" ]` check | dangling |
| `_wiring_one` ignores `$tier` and never returns `foreign` | the hardened/foreign assertion |
| `_wiring_rank` returns 1 for `absent` | the worse-wins assertion (absent would outrank nothing, but a configured harness would be masked — check which fires and record it) |
| `_wiring_one` treats `got -lt want` as `wired` | partial |

If any mutation fails nothing, that assertion is decoration — fix the assertion, not the mutation.

- [ ] **Step 6: Commit**

```bash
git add kits/flaky-triage-kit/core/_integrity.sh kits/flaky-triage-kit/core/tests/integrity-test.sh
git commit -m "kit: integrity_wiring — does the gate actually run?

A second axis beside the lock tier. The kit protected its files and owned
them as root but never checked that the registration making any of it run
still points at a file that exists — the case seen live in a worktree
carrying a pre-relocation path. absent is kept distinct from broken so
terminal-only use raises nothing."
```

---

## Task 2: Two axes through `integrity_report`, and a per-process latch

**Files:**
- Modify: `kits/flaky-triage-kit/core/_integrity.sh` (`integrity_report`, `integrity_guard`)
- Modify: `kits/flaky-triage-kit/core/tests/integrity-test.sh`

**Interfaces:**
- Consumes: `integrity_wiring` and `integrity_tier`.
- Produces: `integrity_report <tier> <wiring>` → 0 or 76. **Both arguments required.**
- Produces: `integrity_guard <kit_root>` → 0 or 76, unchanged signature, so the 13 call sites stay byte-identical.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/integrity-test.sh`:

```bash
# --- tier x wiring: refuse only when a HARDENED tier has lost its wiring ------------
rep2()    { integrity_report "$1" "$2" >/dev/null 2>&1; echo $?; }
rep2_out(){ integrity_report "$1" "$2" 2>&1; }

for w in wired absent; do
  [ "$(rep2 hardened "$w")" = 0 ] && ok || bad "hardened + $w must proceed"
done
for w in unregistered dangling foreign partial; do
  [ "$(rep2 hardened "$w")" = 76 ] && ok || bad "hardened + $w must refuse — the shadow detector went with the gate"
  case "$(rep2_out hardened "$w")" in *WIRING*) ok ;; *) bad "hardened + $w must name the wiring problem" ;; esac
done
for t in degraded unprotected unlocked; do
  for w in unregistered dangling foreign partial; do
    [ "$(rep2 "$t" "$w")" = 0 ] && ok || bad "$t + $w must warn and proceed — there is no wall to have lost"
  done
  case "$(rep2_out "$t" dangling)" in *WIRING*) ok ;; *) bad "$t + dangling must still say so" ;; esac
done
# absent is silent at EVERY tier: no harness configured is not a defect.
for t in hardened degraded unprotected unlocked; do
  case "$(rep2_out "$t" absent)" in *WIRING*) bad "absent must never mention wiring (tier: $t)" ;; *) ok ;; esac
done
# mismatch still refuses regardless of wiring, and still names the tier problem.
[ "$(rep2 mismatch wired)" = 76 ] && ok || bad "a tier mismatch must refuse even when the wiring is fine"
# Nothing may reach stdout: four entrypoints emit a contract there.
for t in hardened degraded unprotected unlocked stale mismatch; do
  for w in wired dangling absent; do
    [ -z "$(integrity_report "$t" "$w" 2>/dev/null)" ] || bad "integrity_report must never write to stdout ($t/$w)"
  done
done; ok
# Both arguments are required — a default that turned a missing wiring argument into `absent` would
# silently stop checking wiring, which is the quiet-default shape this codebase keeps being bitten by.
grep -qE 'integrity_report\(\)[^}]*local[^}]*wiring="\$\{2:-\}"' "$HERE/../_integrity.sh" \
  && bad "integrity_report must not default its wiring argument" || ok
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/integrity-test.sh`
Expected: FAIL — the `hardened + dangling` cases return 0, because `integrity_report` ignores its second argument.

- [ ] **Step 3: Implement**

Replace `integrity_report`'s signature line and add the wiring branch before the final `return 0`:

```bash
integrity_report() {
  local tier="$1" wiring="$2" rc=0
```

Then, after the existing tier `case ... esac` (capture its outcome instead of returning directly — change each `return 0` in the tier case to `rc=0` and the `mismatch` arm's `return 76` to `rc=76`), add:

```bash
  # The wiring axis. `absent` is silent at every tier: the kit runs standalone from a terminal, so
  # "no gate configured" and "a gate that should be here and isn't" are different facts, and warning
  # on the first would train the reader to ignore the second.
  case "$wiring" in
    wired|absent) : ;;
    *)
      echo "integrity: WIRING $wiring — the kit's self-protection gate is not going to run as registered." >&2
      case "$wiring" in
        dangling)     echo "integrity: a harness registration points at a gate file that does not exist (a pre-relocation path, or the file was removed)." >&2 ;;
        unregistered) echo "integrity: a harness settings file exists but carries no registration for the kit's gate." >&2 ;;
        partial)      echo "integrity: only one of the two required registrations is present, so half the surface is unguarded." >&2 ;;
        foreign)      echo "integrity: the registered gate file is not root-owned at the hardened tier, so it is not the file this kit installed." >&2 ;;
      esac
      echo "integrity: re-run the kit installer against this project to repair it." >&2
      if [ "$tier" = hardened ]; then
        echo "integrity: refusing — at the hardened tier the gate also carries the out-of-tree shadow record, so losing it means losing the only detector for a replaced kit tree. That is weaker than the recorded protection." >&2
        rc=76
      fi ;;
  esac
  return "$rc"
}
```

Then the guard, with the latch:

```bash
# integrity_guard <kit_root> -> 0 to proceed, 76 to refuse.
# The composition of both axes. It reads NO environment override for its ANSWER; the latch below
# caches only the already-computed result for the current process tree, so a triage that execs
# ingest and cluster evaluates once instead of three times. A cached value can only ever repeat what
# this process already decided — it cannot introduce one.
integrity_guard() {
  local kit="${1:-}" tier wiring
  if [ -n "${HEKTOR_FK_GUARD_LATCH:-}" ]; then
    integrity_report "${HEKTOR_FK_GUARD_LATCH%%:*}" "${HEKTOR_FK_GUARD_LATCH##*:}"
    return $?
  fi
  tier="$(integrity_tier "$(integrity_owner_uid "$kit/core")" "$(integrity_state "$kit")")"
  wiring="$(integrity_wiring "$kit" "$tier")"
  export HEKTOR_FK_GUARD_LATCH="$tier:$wiring"
  integrity_report "$tier" "$wiring"
}
```

- [ ] **Step 4: Run the tests**

Run: `bash core/tests/integrity-test.sh`
Expected: PASS.

- [ ] **Step 5: Update the 13 entrypoints' expectations and run the whole suite**

The call sites do not change — `integrity_guard "$HERE/.."` is unchanged. But confirm it, because a silent signature drift here disables the guard everywhere:

Run: `grep -c 'integrity_guard "' core/*.sh`
Expected: 13

Run: `for t in core/tests/*.sh; do bash "$t"; done`
Expected: every file green. State the suite total.

- [ ] **Step 6: Prove the latch cannot weaken the guard**

```bash
# A latch value can only repeat a decision this process already made. Confirm a forged one cannot
# turn a refusal into a pass for a DIFFERENT kit — the guard recomputes when the latch is unset, and
# the latch is only ever set by the guard itself.
HEKTOR_FK_GUARD_LATCH="hardened:wired" bash -c '. core/_integrity.sh; integrity_guard /nonexistent; echo rc=$?'
```
Expected: `rc=0` — and record this honestly in the report as what the latch does and does not protect. It is a performance cache inside one process tree, not a trust boundary; the environment it lives in belongs to the agent. Note it in the residual list rather than implying otherwise.

- [ ] **Step 7: Commit**

```bash
git add kits/flaky-triage-kit/core/_integrity.sh kits/flaky-triage-kit/core/tests/integrity-test.sh
git commit -m "kit: report both axes, refuse only when hardened loses its wiring

integrity_report takes tier and wiring, neither optional — a default would
silently stop checking. Refusal is tier-coupled: at hardened the gate also
carries the shadow record, so losing it is weaker than recorded; below
hardened there is no wall to have lost, so it warns. absent is silent at
every tier."
```

---

## Task 3: The settings files on the Bash surface

**Files:**
- Modify: `kits/flaky-triage-kit/core/shell-guard.py` (its own `SURF` — the primary Bash decision path)
- Modify: `kits/flaky-triage-kit/adapters/claude/flaky-kit-self-protection-gate.sh` (`SURF_RE`, `match_surface`)
- Modify: `kits/flaky-triage-kit/adapters/cursor/flaky-kit-self-protection-gate.sh` (the same two, byte-identical)
- Modify: `kits/flaky-triage-kit/core/tests/self-protection-test.sh`

**Interfaces:** none new. This widens three existing patterns that must stay in step — the suite already asserts the two gates' `SURF_RE` are byte-identical, and a drift test covers the python/bash pair.

**Why all three files:** the gates' bash `SURF_RE` is only the *degraded fallback* used when python3 is unavailable; `shell-guard.py`'s `SURF` is the primary decision. Updating the gates alone leaves the real engine blind — that exact omission shipped a live bypass once already in this kit.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/self-protection-test.sh`:

```bash
# --- the settings files are surface for Bash MUTATIONS, reads still pass -------------
for s in ".claude/settings.json" ".claude/settings.local.json" ".cursor/hooks.json"; do
  assert_claude_bash_deny  "sed -i '' $s"        "Bash mutation of $s must be denied"
  assert_claude_bash_deny  "rm -f $s"            "removing $s must be denied"
  assert_claude_bash_allow "cat $s"              "reading $s must be allowed"
  assert_claude_bash_allow "jq . $s"             "inspecting $s must be allowed"
done
# The registration is what makes every other protection run; unregistering it must cost as much as
# editing the gate itself.
assert_claude_bash_deny "printf '{}' > .claude/settings.json" "truncating settings.json must be denied"
```

If the fixture has no `assert_claude_bash_deny`/`allow` helper, add them next to the existing
`assert_claude_edit_deny`/`allow` pair, built on the same `bash_json`/`claude_denied` primitives the
file already uses for its Bash cases.

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/self-protection-test.sh`
Expected: FAIL — the settings paths are not on the surface, so the mutations are allowed.

- [ ] **Step 3: Add the settings files to `core/shell-guard.py`'s `SURF`**

Extend the default alternation (keep the `_SURF_ROOT` override additive, as it already is):

```python
                     r'|\.(claude|cursor)/settings(\.local)?\.json'
                     r'|\.cursor/hooks\.json'
```

- [ ] **Step 4: Add them to both gates' `SURF_RE` and `match_surface`**

`SURF_RE` gains the same two alternatives. `match_surface` gains:

```bash
    */.claude/settings.json|*/.claude/settings.local.json) SURFACE="harness settings (holds the gate's registration)"; return 0 ;;
    */.cursor/settings.json|*/.cursor/settings.local.json|*/.cursor/hooks.json) SURFACE="harness settings (holds the gate's registration)"; return 0 ;;
```

Check during implementation whether Cursor actually has a `settings.local.json`; if it does not, drop that arm rather than carrying a pattern for a file that cannot exist — and say so in your report.

- [ ] **Step 5: Verify directly, not only through the suite**

```bash
printf '%s' "sed -i '' .claude/settings.json" | HEKTOR_FK_CWD=/tmp python3 core/shell-guard.py; echo "expect 0 (deny): $?"
printf '%s' "cat .claude/settings.json"       | HEKTOR_FK_CWD=/tmp python3 core/shell-guard.py; echo "expect 1 (allow): $?"
```

- [ ] **Step 6: Check for new false positives**

The kit's own installer must not trip its own gate. Confirm:

```bash
printf '%s' "./install.sh --project /tmp/x" | HEKTOR_FK_CWD=/tmp python3 core/shell-guard.py; echo "expect 1 (allow): $?"
```
The command string carries no settings path and the installer's `jq` pipeline runs in a subprocess the gate never sees. Report the result either way.

- [ ] **Step 7: Run the whole suite and commit**

```bash
git add kits/flaky-triage-kit/core/shell-guard.py kits/flaky-triage-kit/adapters kits/flaky-triage-kit/core/tests/self-protection-test.sh
git commit -m "kit: harness settings are surface for Bash mutations

Deleting the registration is what turns every other protection off, and it
was allowed and unaudited. All three patterns move together — the gates'
SURF_RE is only the fallback, shell-guard.py's SURF is the primary Bash
decision, and updating the gates alone once shipped a live bypass here."
```

---

## Task 4: Write/Edit inspects the outcome, not the text

**Files:**
- Modify: `kits/flaky-triage-kit/adapters/claude/flaky-kit-self-protection-gate.sh` (Write/Edit branch)
- Modify: `kits/flaky-triage-kit/adapters/cursor/flaky-kit-self-protection-gate.sh` (the same)
- Modify: `kits/flaky-triage-kit/core/tests/self-protection-test.sh`

**Interfaces:** none new.

**The point:** blanket-denying Write/Edit on the settings files would make the kit block unrelated permission, env and model edits in every project it installs into — heavy for a component that claims to be standalone. The branch has the proposed content, so it can answer the real question instead: *with this change applied, is the kit's gate still registered?* Matching "the gate command string appears in the payload" would be a textual proxy for that property, and proxies standing in for properties have now caused three separate defects in this kit.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/self-protection-test.sh`:

```bash
# --- Write/Edit on settings: deny only when the registration would not survive -------
SJ="$PROJ/.claude/settings.json"
REG='{"hooks":{"PreToolUse":[{"matcher":"Write|Edit","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]},{"matcher":"Bash","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]}]}}'
printf '%s\n' "$REG" > "$SJ"

# A Write that drops the registration -> DENY
assert_claude_write_deny "$SJ" '{"hooks":{"PreToolUse":[]}}' \
  "a Write that leaves the kit unregistered must be denied"
# A Write that keeps the registration and changes something unrelated -> ALLOW
KEEP="$(printf '%s' "$REG" | jq '.permissions = {"allow":["Bash(ls:*)"]}')"
assert_claude_write_allow "$SJ" "$KEEP" \
  "a Write that keeps the registration must be allowed even though it touches settings.json"
# Unparseable proposed JSON -> DENY (survival cannot be verified, and writing broken settings is
# itself a defect — the pack's run-status-write-gate sets this precedent)
assert_claude_write_deny "$SJ" '{"hooks":' \
  "a Write of unparseable JSON must be denied"
# An Edit whose old_string carries the registration away -> DENY
assert_claude_edit_str_deny "$SJ" \
  '"matcher":"Bash","hooks":[{"type":"command","command":"\"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh\""}]' '' \
  "an Edit that removes the Bash registration must be denied"
# An Edit that touches an unrelated key -> ALLOW
assert_claude_edit_str_allow "$SJ" '"hooks"' '"hooks"' \
  "a no-op Edit that preserves the registration must be allowed"
# When the file is NOT currently registered, the gate has nothing to protect -> ALLOW
printf '{"hooks":{"PreToolUse":[]}}\n' > "$SJ"
assert_claude_write_allow "$SJ" '{"hooks":{"PreToolUse":[]}}' \
  "with no registration present there is nothing to lose, so the write must be allowed"
printf '%s\n' "$REG" > "$SJ"
```

Add the three helpers next to the existing assertion helpers, built on the same primitives:
`assert_claude_write_deny <path> <content> <label>`, `assert_claude_write_allow`, and
`assert_claude_edit_str_deny/allow <path> <old> <new> <label>` — each constructs the tool-call JSON
with `tool_input.content` or `tool_input.old_string`/`new_string` and asserts on `claude_denied`.

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/self-protection-test.sh`
Expected: FAIL — after Task 3 the settings files are surface, so the Write/Edit branch denies **all**
of these, including the two that must be allowed.

- [ ] **Step 3: Implement the outcome check in both gates' Write/Edit branch**

Insert before the existing `match_surface` decision, so a settings target is decided by outcome
rather than by path:

```bash
# Settings files are surface for Bash (no content to inspect there) but decided by OUTCOME here,
# where the payload is available: deny only when the kit's registration would not survive. Blanket-
# denying would make this kit block unrelated permission/env/model edits in every project it is
# installed into. `test(...)` on the gate filename, not on a whole command string, because we are
# asking whether the REGISTRATION exists — not whether some text happens to appear.
_reg_present() {  # $1 = a JSON document on stdin-file -> 0 if the kit's gate is registered
  "$JQ" -e '
    [ (.hooks.PreToolUse // [])[]? | (.hooks // [])[]? | (.command // "") ]
    + [ (.hooks.beforeShellExecution // [])[]? | (.command // "") ]
    + [ (.hooks.preToolUse // [])[]? | (.command // "") ]
    | map(select(test("flaky-kit-self-protection-gate\\.sh"))) | length > 0
  ' "$1" >/dev/null 2>&1
}
case "$(canon_path "$TARGET")" in
  */.claude/settings.json|*/.claude/settings.local.json|*/.cursor/hooks.json)
    [ -r "$TARGET" ] || exit 0                     # nothing registered yet -> nothing to lose
    _reg_present "$TARGET" || exit 0               # not currently registered -> nothing to lose
    _prop="$(mktemp)"
    if [ "$TOOL_NAME" = Write ]; then
      echo "$INPUT" | "$JQ" -r '.tool_input.content // ""' > "$_prop"
    else
      OLD=$(echo "$INPUT" | "$JQ" -r '.tool_input.old_string // ""')
      NEW=$(echo "$INPUT" | "$JQ" -r '.tool_input.new_string // ""')
      python3 - "$TARGET" "$OLD" "$NEW" > "$_prop" <<'PY' || cp "$TARGET" "$_prop"
import sys
src, old, new = open(sys.argv[1]).read(), sys.argv[2], sys.argv[3]
sys.stdout.write(src.replace(old, new, 1) if old else src)
PY
    fi
    if "$JQ" -e . "$_prop" >/dev/null 2>&1; then
      if _reg_present "$_prop"; then rm -f "$_prop"; exit 0; fi   # survives -> allow
      SURFACE="harness settings — this change would leave the kit's gate unregistered"
    else
      SURFACE="harness settings — the proposed content is not parseable JSON, so the registration's survival cannot be verified"
    fi
    rm -f "$_prop" ;;
  *)
    if match_surface "$(canon_path "$TARGET")"; then :; elif match_surface "$TARGET"; then :; else exit 0; fi ;;
esac
```

- [ ] **Step 4: Run the tests**

Run: `bash core/tests/self-protection-test.sh`
Expected: PASS.

- [ ] **Step 5: Prove the allow-path is not just a hole**

Mutate a scratch copy so `_reg_present` always returns 0 (always "survives"), and confirm the
`drops the registration` assertion fails. If it does not, the assertion is not testing survival.

- [ ] **Step 6: Run the whole suite and commit**

```bash
git add kits/flaky-triage-kit/adapters kits/flaky-triage-kit/core/tests/self-protection-test.sh
git commit -m "kit: on Write/Edit, deny a settings change only if the registration dies

The branch has the payload, so it can answer whether the registration
survives instead of matching text that resembles it. Blanket-denying would
make the kit block unrelated permission and env edits in every project it
installs into; a textual proxy for the property has caused three defects
here already."
```

---

## Task 5: Say what it does, and what it still does not

**Files:**
- Modify: `kits/flaky-triage-kit/core/README.md` (module table + the protection prose)
- Modify: `kits/flaky-triage-kit/kernel.md` (P4 row)
- Modify: `kits/flaky-triage-kit/core/lock-kit.sh` (the residual list in its header)

**Why a task and not a footnote:** this kit's governing rule is that a documented claim the mechanism does not deliver is a defect equal to a broken mechanism. New behaviour that nothing describes is the same failure with the sign flipped — a reader cannot rely on what they cannot find.

- [ ] **Step 1: Add the second axis to `core/README.md`'s module table**

Amend the `_integrity` row so it names both axes rather than only the tier:

```
| `_integrity` *(sourced)* | kit root → tier (`hardened`/`unlocked`/`degraded`/`unprotected`/`mismatch`/`stale`) **and** wiring (`wired`/`unregistered`/`dangling`/`foreign`/`partial`/`absent`) | **P4** both are asserted at every entrypoint, not assumed. Refuses (76) when protection is weaker than recorded — a tier mismatch, or a hardened tier whose gate registration no longer resolves |
```

- [ ] **Step 2: Extend `kernel.md`'s P4 row**

Append to the Status cell, keeping the existing text:

```
**2026-07-30:** the gate's own WIRING is now checked too. A registration pointing at a path the kit no longer installs to made every tool call emit a non-blocking "No such file" while nothing stated the protection was off (observed in a web-test worktree carrying a pre-relocation path), and deleting that registration was allowed outright. The harness settings files are now surface — by outcome on Write/Edit (deny only if the registration would not survive, so unrelated permission/env edits still pass) and as mutation targets on Bash, where no content is available to inspect. Residual, stated rather than implied: the settings files are protected against EDITS, but their parent directories stay user-owned, so they can still be replaced wholesale; and the per-process guard latch is a cache inside one process tree, not a trust boundary.
```

- [ ] **Step 3: Add two items to `lock-kit.sh`'s STILL NOT COVERED list**

```
#   6. The harness settings files are protected against edits, but their parents stay user-owned, so
#      a settings file can be replaced rather than edited. Same shape as residual 1, one level down.
#   7. The guard's per-process latch caches an already-computed decision for one process tree. It
#      cannot invent a verdict this process did not reach, but it lives in the agent's own
#      environment — a cache, never a trust boundary.
```

- [ ] **Step 4: Sweep for claims this change makes untrue**

Apply the criterion this kit settled on — *does any sentence say something untrue about what protects what?* — to every file mentioning the gate's registration or the settings files:

```bash
grep -rln 'settings.json\|registration\|registered' kits/flaky-triage-kit/ | grep -v '\.achilles'
```

Read every mention in each file returned and record it in your report, including the ones you judge
fine. Four rounds of the preceding documentation task each ended with a survivor because the sweep
was narrower than the claim; enumerate files, not phrases.

- [ ] **Step 5: Run the whole suite and commit**

```bash
git add kits/flaky-triage-kit/core/README.md kits/flaky-triage-kit/kernel.md kits/flaky-triage-kit/core/lock-kit.sh
git commit -m "kit: describe the wiring axis and the two residuals it leaves

New behaviour nothing documents is the same defect as a claim nothing
delivers, sign flipped. Names what the settings protection covers, and
states plainly that the files are protected against edits while their
parents are not, and that the guard latch is a cache and not a boundary."
```

---

## Self-Review

**Spec coverage:** §1 two axes and the six values → Task 1. Identity-from-tier → Task 1's `_wiring_one`. `absent` distinct and silent → Tasks 1 and 2. Tier coupling → Task 2. Both arguments required → Task 2 (with a grep assertion so it cannot regress). Installed-shape derivation → Task 1. Per-harness inference and worse-wins → Task 1. The latch → Task 2. §3 asymmetric settings protection → Tasks 3 (Bash) and 4 (Write/Edit outcome). §4 failure handling → Task 1's `absent` fallbacks and Task 4's unparseable-JSON deny. §5 testing, including the fixture-reaches-non-absent control and `mktemp -d` isolation → Tasks 1-4. §6 out-of-scope items are not implemented, and Task 5 records the residuals. No gaps.

**Name consistency:** `integrity_project_root`, `integrity_wiring`, `_wiring_reg_claude`, `_wiring_reg_cursor`, `_wiring_one`, `_wiring_rank`, `integrity_report <tier> <wiring>`, `integrity_guard <kit_root>` are defined in Tasks 1-2 and used under those exact names throughout. The six wiring values are spelled identically everywhere. Exit code 76 is the only refusal code, matching the existing guard contract.

**Ordering:** Task 2 needs Task 1. Task 4 needs Task 3 (it changes the branch Task 3 makes reachable for settings paths). Task 5 is last, because it describes what Tasks 1-4 actually built.
