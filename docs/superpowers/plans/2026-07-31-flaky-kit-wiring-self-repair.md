# Kit Wiring Self-Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the kit runs, it repairs its own gate registration instead of only reporting that it is broken.

**Architecture:** A new unit `core/_wiring_repair.sh` holds the mutation; `core/_integrity.sh` keeps its detector functions pure and calls the repair from `integrity_guard` between detection and reporting. The registration is repaired at every tier; the gate *file* is restored only where the tree is not root-owned, from a copy `install.sh` ships inside `core/`. A repair arms on the next session, so the verdict passed to `integrity_report` is the pre-repair one and a root-owned tree still refuses.

**Tech Stack:** bash 3.2-compatible shell, `jq`, POSIX `stat`, the kit's plain-bash test suites (`core/tests/*.sh`, `ok()`/`bad()` counters, exit on `$fail -eq 0`).

**Spec:** `docs/superpowers/specs/2026-07-31-flaky-kit-wiring-self-repair-design.md` (commit `68cade7`)

## Global Constraints

- **bash 3.2 compatible** — macOS system bash. No associative arrays, no `${var^^}`.
- **`_integrity.sh` and `_wiring_repair.sh` must never wedge a caller.** Every function returns 0 and prints its answer. A repair that cannot run resolves to doing nothing and saying why; it never aborts an entrypoint.
- **No environment override may enter either file.** `core/tests/integrity-test.sh` greps for the *shape* of any `$UPPERCASE` read outside a comment — a variable a caller can set is a skeleton key to the check it guards. Test seams run through function arguments. **One name is excluded:** `CLAUDE_PROJECT_DIR` appears in `_wiring_repair.sh` as a literal inside single quotes — the text written into the settings file, expanded by the harness when it later runs the gate, never by bash here. grep cannot distinguish a read from a literal, so the exclusion is by name and Task 2 closes it with a behavioural assertion instead: with `CLAUDE_PROJECT_DIR` set to a hijacked path in the environment, the written command must still carry the unexpanded text.
- **stderr only.** Four entrypoints (`rerun`, `gate`, `ledger`, `summary`) emit a machine-read contract on stdout, so the repair's narration goes to stderr and nothing else.
- **`stat` is not portable:** BSD/macOS `stat -f %u`, GNU `stat -c %u`. `integrity_owner_uid` already branches on `uname -s` — reuse it, do not re-implement.
- **`foreign` is never repaired.** A gate at the kit's path that is not the kit's is someone else's; overwriting it is the kit deciding a conflict it cannot see both sides of.
- **The gate file is restored only where the tree is NOT root-owned** — that is, at every tier except `hardened` and `stale`. Both, not `hardened` alone: `stale` means the tree *is* root-owned and only `.lock-state` disagrees. Keying the restore on the recorded tier while `_wiring_one` keys its identity test on ownership would split one property across two conditions, which is the defect that cost the previous cycle its only Critical.
- **Do NOT run `core/lock-kit.sh lock`/`unlock`** — a bare `lock` shells out to `sudo chown -R root` and will hang on a password prompt you cannot answer. Use `mktemp -d` fixtures.
- **Run `core/tests/lock-tier-test.sh` unmodified** — a blanket `HEKTOR_FK_NO_SUDO=1` over the whole file breaks its own PATH-shimmed-sudo section and yields spurious failures.
- **Test fixtures that write settings files live under `mktemp -d`, never in a real project** — the harness has its own protected-artifact guard and a test writing to a real `.claude/` will collide with it.
- **No bare `git stash`** — the stash stack is shared across worktrees and sessions.
- **Commit messages carry no AI trailers** — no `Co-Authored-By`, no "Generated with", no session link.
- **The suite is 634 assertions, 0 failures, across 11 files.** Derive and state your own totals rather than adopting that number; nine earlier rounds corrected the author's arithmetic and all nine were right.
- **Mutation is the only accepted evidence for a new security assertion.** For each assertion you add, break what it names and show the suite goes red, and assert the mutation **actually changed the file** before drawing any conclusion — a `sed` that silently matched nothing has twice been misread here as proof of a defect.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `core/_wiring_repair.sh` | create | The whole mutation: locking, the registration merge, the tier-gated gate-file restore, and the narration |
| `core/_integrity.sh` | modify | Source the new unit; `integrity_guard` calls it between detection and reporting. No detector function changes |
| `install.sh` | modify | Ship the restore source into `core/gate-src/<harness>/` |
| `core/tests/integrity-test.sh` | modify | Fixtures for every repairable and unrepairable state, crossed with ownership |
| `core/README.md`, `kernel.md`, `core/lock-kit.sh` header | modify | Describe the repair and the residuals it leaves |

**`integrity_report` keeps its two-argument contract.** A third `repaired` argument was considered and dropped: the report's existing remedy line ("re-run the kit installer against this project to repair it") stays true after a repair — the installer is idempotent and is still what fixes a root-owned tree's gate file after an unlock — so it is redundant, not wrong. Adding a third argument would churn every call site and every row of the tier × wiring matrix to remove a redundancy. The repair narrates itself instead.

---

## Task 1: Ship the restore source

**Files:**
- Modify: `kits/flaky-triage-kit/install.sh`
- Modify: `kits/flaky-triage-kit/core/tests/install-guard-test.sh`

**Interfaces:**
- Produces: `<kit>/core/gate-src/claude/flaky-kit-self-protection-gate.sh` and `<kit>/core/gate-src/claude/lib/audit.sh`; the same two under `cursor/` when that harness is installed. Task 3 restores from these paths.

An installed kit carries only `SKILL.md` and `core/`; `install.sh` copies the gate from `adapters/claude/` in the **source** tree, which is gone after installation. There is nothing to restore from, so Task 3 has nothing to do until this lands.

`core/` is what `harden_targets` chowns, so at a root-owned tier this copy is root-owned too — the copy an agent would have to poison in order to have a poisoned gate restored is exactly the one it cannot write.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/install-guard-test.sh`, inside the block that already installs into a fixture project (reuse that fixture's variable for the installed kit root rather than building a second one):

```bash
# --- the restore source ships with the engine ------------------------------------------------
# Task 3 restores a deleted gate from here. It lives under core/ deliberately: harden_targets
# chowns that directory, so at a root-owned tier the restore source is root-owned and an agent
# cannot poison what would be restored.
GS="$PROJ/.claude/skills/hektor-flaky-triage/core/gate-src/claude"
[ -f "$GS/flaky-kit-self-protection-gate.sh" ] && ok || bad "install must ship the claude gate restore source"
[ -x "$GS/flaky-kit-self-protection-gate.sh" ] && ok || bad "the restore source must stay executable"
[ -f "$GS/lib/audit.sh" ] && ok || bad "install must ship the audit lib beside the restore source"
# It must be the SAME file the gate was installed from, or a restore would install a different
# gate than the one the install registered.
cmp -s "$GS/flaky-kit-self-protection-gate.sh" "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" \
  && ok || bad "the restore source must be byte-identical to the installed gate"
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/install-guard-test.sh`
Expected: FAIL — the four assertions above, because nothing writes `core/gate-src/` yet.

- [ ] **Step 3: Implement in `install.sh`**

In the Claude block, immediately after the `vendor "$HERE/adapters/_lib/audit.sh" …` line:

```bash
  # The restore source for core/_wiring_repair.sh. Under core/ so harden_targets covers it: at a
  # root-owned tier the file a repair would copy from cannot be rewritten by an agent.
  mkdir -p "$SKILL_DIR/core/gate-src/claude/lib"
  cp "$HERE/adapters/claude/flaky-kit-self-protection-gate.sh" "$SKILL_DIR/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
  chmod +x "$SKILL_DIR/core/gate-src/claude/flaky-kit-self-protection-gate.sh" 2>/dev/null || true
  vendor "$HERE/adapters/_lib/audit.sh" "$SKILL_DIR/core/gate-src/claude/lib/audit.sh"
```

In the Cursor block, immediately after its own `vendor …` line, the same four lines with `claude` replaced by `cursor` in both the source and destination paths.

- [ ] **Step 4: Run the tests**

Run: `bash core/tests/install-guard-test.sh`
Expected: PASS. State the file's new total.

- [ ] **Step 5: Prove the assertions are load-bearing**

Each assertion needs a mutation that **isolates** it. A mutation that removes the file altogether fails
`-f`, `-x` and `cmp` together and therefore distinguishes none of them; it shows only that something
in the block matters. Work on a scratch copy of the kit, and for each one assert the file actually
changed before reading the result.

| Mutation | Must redden, and only it |
|---|---|
| the gate-src `cp` reads a different existing file (point its source at the cursor gate) | the `cmp -s` byte-identity assertion |
| the gate-src `cp` becomes `cat "$src" > "$dst"` **and the `chmod +x` on the next line is neutered** — both, or the result is green | the `-x` assertion |
| the `vendor` call for `gate-src/claude/lib/audit.sh` is removed | the `lib/audit.sh` assertion |
| the gate-src `cp` source points at a nonexistent path | the `-f` assertion (and, unavoidably, the three above it) |

The second row is the reason this table exists, and it needs both halves. `cp` preserves the source's
mode and the adapter gate is tracked `100755`, so neutering the `chmod +x` alone leaves the suite green
— the copy already arrived executable. Replacing the `cp` with `cat >` alone also leaves it green — the
`chmod +x` on the next line puts the bit back. Only both together produce a file that exists, matches
byte for byte, and is not executable, which is the one state this assertion exists to catch.

That redundancy does not make the assertion worthless: it guards against a future change to a copy
mechanism that drops the bit, and the `chmod +x` mirrors the existing pattern at `install.sh:154`. What
it does mean is that an assertion is not load-bearing on the strength of a mutation that never produced
the state it names. Run each row and read only what it isolates.

- [ ] **Step 6: Run the whole suite and commit**

```bash
for t in core/tests/*.sh; do bash "$t"; done
git add kits/flaky-triage-kit/install.sh kits/flaky-triage-kit/core/tests/install-guard-test.sh
git commit -m "kit: ship the gate's restore source with the engine

An installed kit carried only SKILL.md and core/, so a repair had nothing
to restore a deleted gate from. The copy lives under core/ because
harden_targets chowns that directory: at a root-owned tier the file a
restore would read is root-owned, so poisoning what gets restored needs
the password."
```

---

## Task 2: `wiring_repair` — the registration half

**Files:**
- Create: `kits/flaky-triage-kit/core/_wiring_repair.sh`
- Modify: `kits/flaky-triage-kit/core/tests/integrity-test.sh`

**Interfaces:**
- Produces: `wiring_repair <kit_root> <tier> <wiring>` → narrates to stderr, always returns 0. Task 4 calls it from `integrity_guard`.
- Consumes: `integrity_project_root`, `_wiring_want`, `_wiring_slots`, `_wiring_cover` (all already in `_integrity.sh`).

This task repairs `unregistered` and `partial` by writing the missing slots. The gate-file restore is Task 3; a `dangling` state does nothing here yet.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/integrity-test.sh`. `wire_fixture` is the existing helper that builds an installed layout; reuse it rather than writing a second one.

```bash
# --- wiring_repair: the registration half ------------------------------------------------------
. "$HERE/../_wiring_repair.sh"
slots_of() { _wiring_slots "$1" | sed 's/\t.*//' | sort | tr '\n' ' '; }

# unregistered -> all three slots written, at every tier.
for T in hardened stale degraded unprotected unlocked; do
  R="$(mktemp -d)"; W="$(wire_fixture "$R")"; echo '{}' > "$W/.claude/settings.json"
  wiring_repair "$W/.claude/skills/hektor-flaky-triage" "$T" unregistered >/dev/null 2>&1
  case "$(slots_of "$W/.claude/settings.json")" in
    *PreToolUse:Bash*) ok ;; *) bad "$T: repair must register the Bash slot" ;;
  esac
  case "$(slots_of "$W/.claude/settings.json")" in
    *PreToolUse:Write*) ok ;; *) bad "$T: repair must register the Write slot" ;;
  esac
  case "$(slots_of "$W/.claude/settings.json")" in
    *PreToolUse:Edit*) ok ;; *) bad "$T: repair must register the Edit slot" ;;
  esac
  rm -rf "$R"
done

# partial -> only the missing slot is added, and the present one is not duplicated.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
jq 'del(.hooks.PreToolUse[] | select(.matcher=="Bash"))' "$W/.claude/settings.json" > "$W/s" && mv "$W/s" "$W/.claude/settings.json"
wiring_repair "$W/.claude/skills/hektor-flaky-triage" degraded partial >/dev/null 2>&1
[ "$(jq '[.hooks.PreToolUse[] | select(.matcher=="Write|Edit")] | length' "$W/.claude/settings.json")" = 1 ] \
  && ok || bad "repair must not duplicate a matcher that is already registered"
case "$(slots_of "$W/.claude/settings.json")" in *PreToolUse:Bash*) ok ;; *) bad "partial: the missing slot must be added" ;; esac
rm -rf "$R"

# foreign is NEVER written to. The file must come back byte-identical.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
cp "$W/.claude/settings.json" "$R/before.json"
wiring_repair "$W/.claude/skills/hektor-flaky-triage" hardened foreign >/dev/null 2>&1
cmp -s "$R/before.json" "$W/.claude/settings.json" && ok || bad "foreign must never be repaired — a stranger's gate is not ours to overwrite"
rm -rf "$R"

# wired and absent do nothing.
for V in wired absent; do
  R="$(mktemp -d)"; W="$(wire_fixture "$R")"; cp "$W/.claude/settings.json" "$R/before.json"
  wiring_repair "$W/.claude/skills/hektor-flaky-triage" degraded "$V" >/dev/null 2>&1
  cmp -s "$R/before.json" "$W/.claude/settings.json" && ok || bad "$V must not touch the settings file"
  rm -rf "$R"
done

# The repair is ADDITIVE: unrelated keys survive untouched.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"
jq '.permissions = {allow:["Bash(ls:*)"]} | .env = {FOO:"bar"} | .model = "sonnet"' "$W/.claude/settings.json" > "$W/s" && mv "$W/s" "$W/.claude/settings.json"
jq 'del(.hooks.PreToolUse[] | select(.matcher=="Bash"))' "$W/.claude/settings.json" > "$W/s" && mv "$W/s" "$W/.claude/settings.json"
wiring_repair "$W/.claude/skills/hektor-flaky-triage" degraded partial >/dev/null 2>&1
[ "$(jq -r '.permissions.allow[0]' "$W/.claude/settings.json")" = "Bash(ls:*)" ] && ok || bad "repair must leave permissions untouched"
[ "$(jq -r '.env.FOO' "$W/.claude/settings.json")" = "bar" ] && ok || bad "repair must leave env untouched"
[ "$(jq -r '.model' "$W/.claude/settings.json")" = "sonnet" ] && ok || bad "repair must leave model untouched"
rm -rf "$R"

# Not an installed layout -> nothing is written anywhere. Running the suite from the source tree
# must never mutate a settings file.
R="$(mktemp -d)"; mkdir -p "$R/notakit/core"
wiring_repair "$R/notakit" degraded unregistered >/dev/null 2>&1
[ -z "$(find "$R" -name 'settings*.json' 2>/dev/null)" ] && ok || bad "a non-installed layout must never be written to"
rm -rf "$R"

# It narrates on stderr and nothing reaches stdout — four entrypoints emit a contract there.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; echo '{}' > "$W/.claude/settings.json"
[ -z "$(wiring_repair "$W/.claude/skills/hektor-flaky-triage" degraded unregistered 2>/dev/null)" ] \
  && ok || bad "wiring_repair must never write to stdout"
case "$(wiring_repair "$W/.claude/skills/hektor-flaky-triage" degraded unregistered 2>&1 >/dev/null)" in
  *REPAIRED*) ok ;; *) bad "a repair must say so on stderr" ;;
esac
rm -rf "$R"

# No environment override may enter the repair unit either — with ONE excluded name.
# CLAUDE_PROJECT_DIR appears in this file as a LITERAL inside single quotes: it is the text written
# into the settings file, which the harness expands when it later runs the gate. Bash never expands
# it here, so it is not a read and the property the constraint protects is untouched. grep cannot
# tell a read from a literal, so the exclusion is by name and the assertion below closes it by
# behaviour instead — which is stronger than the grep it replaces.
grep -v '^[[:space:]]*#' "$HERE/../_wiring_repair.sh" | grep -v 'CLAUDE_PROJECT_DIR' \
  | grep -qE '(^|[^\\])\$\{?[A-Z][A-Z0-9_]*' \
  && bad "no environment override may enter _wiring_repair.sh" || ok

# The excluded name is genuinely a literal: set it in the environment to something else and the
# written command must still carry the unexpanded text, never the hijacked path. If this ever fails,
# the exclusion above has stopped being safe and the grep is no longer the thing to fix.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; echo '{}' > "$W/.claude/settings.json"
CLAUDE_PROJECT_DIR=/tmp/hijack-me wiring_repair "$W/.claude/skills/hektor-flaky-triage" degraded unregistered >/dev/null 2>&1
grep -q 'CLAUDE_PROJECT_DIR' "$W/.claude/settings.json" && ok || bad "the registered command must keep \$CLAUDE_PROJECT_DIR unexpanded"
grep -q '/tmp/hijack-me' "$W/.claude/settings.json" && bad "the registered command must not expand CLAUDE_PROJECT_DIR from the caller's environment" || ok
rm -rf "$R"
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/integrity-test.sh`
Expected: FAIL at the `.` on line 1 of the new block — `core/_wiring_repair.sh` does not exist.

- [ ] **Step 3: Implement `core/_wiring_repair.sh`**

```bash
#!/bin/bash
# core/_wiring_repair.sh — the kit re-asserts its own gate registration.
#
# Detection alone was not enough. Whether a project ends up wired depends on which tool provisioned
# it, and a worktree was twice observed holding this kit with none of it wired and nothing saying
# why. So when the kit runs at all, its own wiring is its own responsibility.
#
# This unit is the ONLY place in the integrity path that writes. `_integrity.sh` stays a detector —
# thirteen entrypoints source it under a contract that it never wedges a caller — and mixing a
# filesystem mutation into that would blur the one property those entrypoints rely on.
#
# Every failure mode here resolves to doing nothing and saying why. A repair that cannot run must
# never abort a triage.

_WR_LOCKFD="201"
_WR_LOCKDIR=""

_wr_unlock() {
  [ -n "$_WR_LOCKDIR" ] && { rmdir "$_WR_LOCKDIR" 2>/dev/null || true; _WR_LOCKDIR=""; }
  eval "exec ${_WR_LOCKFD}>&-" 2>/dev/null || true
  return 0
}

# _wr_lock <file> -> 0 if held, 1 if not. Mirrors core/ledger.sh's discipline (flock where present,
# portable mkdir spinlock otherwise) with one deliberate difference: ledger.sh dies on timeout and
# this RETURNS. A lost lock means one entrypoint skips a repair the next one will retry; it must not
# take the caller down with it.
_wr_lock() {
  local target="${1:-}" waited=0
  if command -v flock >/dev/null 2>&1; then
    eval "exec ${_WR_LOCKFD}>\"\$target.lock\"" 2>/dev/null || return 1
    flock -w 10 "$_WR_LOCKFD" 2>/dev/null || return 1
    return 0
  fi
  until mkdir "$target.lock.d" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -ge 200 ] && return 1      # 200 * 0.05s = 10s cap
    sleep 0.05
  done
  _WR_LOCKDIR="$target.lock.d"
  return 0
}

# _wr_register <settings-file> <command> <matcher>... -> 0. Idempotent and additive: adds the matcher
# block if absent and the command inside it if absent, and touches nothing else in the document.
# Same merge install.sh performs, so an install and a repair cannot disagree about the shape.
_wr_register() {
  local s="$1" c="$2" m t
  shift 2
  for m in "$@"; do
    t="$(mktemp)" || return 0
    if jq --arg m "$m" --arg c "$c" '
      .hooks //= {} | .hooks.PreToolUse //= [] |
      (if any(.hooks.PreToolUse[]?; .matcher==$m) then . else .hooks.PreToolUse += [{matcher:$m, hooks:[]}] end) |
      .hooks.PreToolUse |= map(if .matcher==$m then (.hooks //= []) |
        (if any(.hooks[]?; .command==$c) then . else .hooks += [{type:"command", command:$c, timeout:10}] end)
        else . end)' "$s" > "$t" 2>/dev/null && [ -s "$t" ]; then
      mv "$t" "$s"
    else
      rm -f "$t"
    fi
  done
  return 0
}

# _wr_register_cursor <hooks-file> <command> -> 0. Cursor's spelling of the same three slots.
_wr_register_cursor() {
  local s="$1" c="$2" t
  t="$(mktemp)" || return 0
  if jq --arg c "$c" '
    .hooks //= {} |
    .hooks.beforeShellExecution //= [] |
    (if any(.hooks.beforeShellExecution[]?; .command==$c) then . else .hooks.beforeShellExecution += [{command:$c, timeout:10}] end) |
    .hooks.preToolUse //= [] |
    (if any(.hooks.preToolUse[]?; .command==$c) then . else .hooks.preToolUse += [{command:$c, matcher:"Write|Edit", timeout:10}] end)
  ' "$s" > "$t" 2>/dev/null && [ -s "$t" ]; then
    mv "$t" "$s"
  else
    rm -f "$t"
  fi
  return 0
}

# wiring_repair <kit_root> <tier> <wiring> -> narrates to stderr, always returns 0.
wiring_repair() {
  local kit="${1:-}" tier="${2:-}" wiring="${3:-}" root wc wu s did=0
  case "$wiring" in
    unregistered|partial|dangling) : ;;
    *) return 0 ;;                      # wired, absent, foreign: nothing to do or nothing that is ours
  esac
  root="$(integrity_project_root "$kit")"
  [ -n "$root" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  set -- $(_wiring_want "$kit" "$root")
  wc="${1:-0}"; wu="${2:-0}"

  if [ "$wc" = 1 ]; then
    s="$root/.claude/settings.json"
    [ -e "$s" ] || echo '{}' > "$s" 2>/dev/null
    if [ -w "$s" ] && jq -e . "$s" >/dev/null 2>&1; then
      if _wr_lock "$s"; then
        _wr_register "$s" '"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh"' 'Write|Edit' 'Bash'
        _wr_unlock
        did=1
      else
        echo "integrity: could not lock $s to repair the registration; the next entrypoint will retry." >&2
      fi
    else
      echo "integrity: cannot repair the registration — $s is unwritable or not parseable JSON." >&2
    fi
  fi

  if [ "$wu" = 1 ]; then
    s="$root/.cursor/hooks.json"
    [ -e "$s" ] || echo '{"version":1,"hooks":{}}' > "$s" 2>/dev/null
    if [ -w "$s" ] && jq -e . "$s" >/dev/null 2>&1; then
      if _wr_lock "$s"; then
        _wr_register_cursor "$s" '.cursor/hooks/flaky-kit-self-protection-gate.sh'
        _wr_unlock
        did=1
      else
        echo "integrity: could not lock $s to repair the registration; the next entrypoint will retry." >&2
      fi
    else
      echo "integrity: cannot repair the registration — $s is unwritable or not parseable JSON." >&2
    fi
  fi

  [ "$did" = 1 ] && echo "integrity: REPAIRED — the kit's gate registration has been rewritten." >&2
  return 0
}
```

- [ ] **Step 4: Run the tests**

Run: `bash core/tests/integrity-test.sh`
Expected: PASS. State the file's new total.

- [ ] **Step 5: Prove each new assertion is load-bearing**

Run each mutation on a scratch copy, and for each one first assert the file actually changed:

| Mutation | Must redden |
|---|---|
| `wiring_repair`'s `case` accepts `foreign` too | the byte-identical foreign assertion |
| `_wr_register` drops its `any(.hooks[]?; .command==$c)` guard | the no-duplicate assertion |
| `_wr_register`'s jq replaces the document instead of merging (`'{hooks:{PreToolUse:[]}}'`) | the three additive assertions |
| the `[ -n "$root" ] || return 0` guard is removed | the non-installed-layout assertion |
| the `REPAIRED` line is echoed to stdout instead of stderr | the stdout assertion |

- [ ] **Step 6: Commit**

```bash
git add kits/flaky-triage-kit/core/_wiring_repair.sh kits/flaky-triage-kit/core/tests/integrity-test.sh
git commit -m "kit: re-assert the gate registration instead of only reporting it

Detection alone left a worktree holding the kit with none of it wired,
twice, because whether a project ends up wired depends on which tool
provisioned it. The registration is now rewritten at every tier.

The mutation lives in its own unit. _integrity.sh is sourced by thirteen
entrypoints under a contract that it never wedges a caller, and a
filesystem write mixed into a detector blurs exactly that. foreign is
never repaired: a gate at our path that is not ours belongs to someone
else."
```

---

## Task 3: Restore the gate file where ownership allows

**Files:**
- Modify: `kits/flaky-triage-kit/core/_wiring_repair.sh`
- Modify: `kits/flaky-triage-kit/core/tests/integrity-test.sh`

**Interfaces:**
- Consumes: `<kit>/core/gate-src/<harness>/flaky-kit-self-protection-gate.sh` from Task 1.

`dangling` means the registration resolves to a file that is not there. Rewriting the registration does not fix that; the file has to come back.

But only where the tree is not root-owned. At `hardened` and `stale` the gate's path must hold a **root-owned** file — that ownership *is* `_wiring_one`'s identity test — and a kit running as the user can only create a user-owned one. The repair would turn a `dangling` into a `foreign`: broken differently, and now unrepairable by design.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/integrity-test.sh`:

```bash
# --- wiring_repair: the gate file --------------------------------------------------------------
# Below root ownership the file comes back.
for T in degraded unprotected unlocked; do
  R="$(mktemp -d)"; W="$(wire_fixture "$R")"; K="$W/.claude/skills/hektor-flaky-triage"
  mkdir -p "$K/core/gate-src/claude/lib"
  printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
  chmod +x "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
  printf 'audit\n' > "$K/core/gate-src/claude/lib/audit.sh"
  rm -f "$W/.claude/hooks/flaky-kit-self-protection-gate.sh"
  wiring_repair "$K" "$T" dangling >/dev/null 2>&1
  [ -x "$W/.claude/hooks/flaky-kit-self-protection-gate.sh" ] && ok || bad "$T: a dangling gate must be restored, executable"
  [ -f "$W/.claude/hooks/lib/audit.sh" ] && ok || bad "$T: the audit lib must be restored beside it"
  rm -rf "$R"
done

# Where the tree is root-owned it is NOT restored — a user-owned file there reads as `foreign`,
# so the repair would break the kit differently while claiming to heal it. Asserted at BOTH
# hardened and stale: a rule that read the recorded tier instead of ownership would pass the
# first and fail the second.
for T in hardened stale; do
  R="$(mktemp -d)"; W="$(wire_fixture "$R")"; K="$W/.claude/skills/hektor-flaky-triage"
  mkdir -p "$K/core/gate-src/claude/lib"
  printf '#!/bin/sh\nexit 0\n' > "$K/core/gate-src/claude/flaky-kit-self-protection-gate.sh"
  rm -f "$W/.claude/hooks/flaky-kit-self-protection-gate.sh"
  wiring_repair "$K" "$T" dangling >/dev/null 2>&1
  [ ! -e "$W/.claude/hooks/flaky-kit-self-protection-gate.sh" ] && ok || bad "$T: a root-owned tree must not get a user-owned gate"
  case "$(wiring_repair "$K" "$T" dangling 2>&1 >/dev/null)" in
    *root-owned*) ok ;; *) bad "$T: refusing to restore must say why" ;;
  esac
  rm -rf "$R"
done

# No restore source -> no restore, and it says so rather than failing silently.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; K="$W/.claude/skills/hektor-flaky-triage"
rm -rf "$K/core/gate-src"
rm -f "$W/.claude/hooks/flaky-kit-self-protection-gate.sh"
wiring_repair "$K" degraded dangling >/dev/null 2>&1
[ ! -e "$W/.claude/hooks/flaky-kit-self-protection-gate.sh" ] && ok || bad "no restore source must mean no restore"
case "$(wiring_repair "$K" degraded dangling 2>&1 >/dev/null)" in
  *restore\ source*) ok ;; *) bad "a missing restore source must be named" ;;
esac
rm -rf "$R"
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/integrity-test.sh`
Expected: FAIL — `dangling` currently only rewrites the registration, so the gate file never comes back.

- [ ] **Step 3: Implement**

Add to `core/_wiring_repair.sh`, above `wiring_repair`:

```bash
# _wr_restore_gate <kit_root> <project_root> <tier> <harness> <dest-dir> -> 0. Narrates; never fails.
#
# Restores only where the tree is NOT root-owned. At `hardened` and `stale` the gate's path must hold
# a root-owned file — that ownership IS _wiring_one's identity test — and this process runs as the
# user, so the file it wrote would report `foreign`: the repair would break the kit differently while
# claiming to heal it. `stale` is included with `hardened` because it means the tree IS root-owned and
# only .lock-state disagrees; keying this on the recorded tier while the identity test keys on
# ownership would split one property across two conditions.
_wr_restore_gate() {
  local kit="$1" root="$2" tier="$3" harness="$4" dest="$5" src="$kit/core/gate-src/$4"
  case "$tier" in
    hardened|stale)
      echo "integrity: not restoring the $harness gate — this tree is root-owned, so a file written as you would not be the kit's. Unlock, reinstall, lock." >&2
      return 0 ;;
  esac
  # This harness's gate is already there. `dangling` is a verdict over the whole project, so a
  # project whose Claude gate is missing and whose Cursor gate is fine reaches this function twice;
  # without this line the healthy one is overwritten and announced as "restored", which is a repair
  # claimed for a harness that was never broken — the same misattribution the per-harness `did_c`
  # and `did_u` split exists to prevent, one function over.
  [ -e "$dest/flaky-kit-self-protection-gate.sh" ] && return 0

  # `-s`, not `-r`. A zero-byte source is readable, and restoring it installs an empty gate that
  # allows everything — while `_wiring_one` below the root-owned tiers tests only `[ -f ]`, so the
  # answer flips from a loud, repairable `dangling` to a silent `wired`. A self-protection gate that
  # passes every check and enforces nothing is worse than a missing one. The merge path already
  # guards this class with `[ -s "$t" ]`.
  if [ ! -s "$src/flaky-kit-self-protection-gate.sh" ]; then
    echo "integrity: cannot restore the $harness gate — no usable restore source at $src." >&2
    return 0
  fi
  if ! mkdir -p "$dest/lib" 2>/dev/null; then
    echo "integrity: cannot restore the $harness gate — $dest is not creatable." >&2
    return 0
  fi
  if ! cp "$src/flaky-kit-self-protection-gate.sh" "$dest/flaky-kit-self-protection-gate.sh" 2>/dev/null; then
    echo "integrity: cannot restore the $harness gate — writing $dest failed." >&2
    return 0
  fi
  chmod +x "$dest/flaky-kit-self-protection-gate.sh" 2>/dev/null || true
  if [ -s "$src/lib/audit.sh" ] && ! cp "$src/lib/audit.sh" "$dest/lib/audit.sh" 2>/dev/null; then
    echo "integrity: restored the $harness gate, but its audit lib did not copy — the gate still runs, unaudited." >&2
  fi
  echo "integrity: restored the $harness gate from the engine's copy." >&2
  return 0
}
```

Then in `wiring_repair`, inside the `if [ "$wc" = 1 ]` block **before** the settings write:

```bash
    [ "$wiring" = dangling ] && _wr_restore_gate "$kit" "$root" "$tier" claude "$root/.claude/hooks"
```

and the matching line inside the `if [ "$wu" = 1 ]` block:

```bash
    [ "$wiring" = dangling ] && _wr_restore_gate "$kit" "$root" "$tier" cursor "$root/.cursor/hooks"
```

- [ ] **Step 4: Run the tests**

Run: `bash core/tests/integrity-test.sh`
Expected: PASS. State the file's new total.

- [ ] **Step 5: Prove the tier gate is load-bearing**

The single most important mutation in this plan: change `hardened|stale)` to `hardened)` on a scratch copy and confirm the **stale** assertions go red. A rule that reads the recorded tier instead of ownership passes every `hardened` test and fails only at `stale`, which is precisely how the previous cycle's Critical survived four task reviews.

Also mutate the whole `case` away (so it always restores) and confirm both root-owned rows redden.

- [ ] **Step 6: Run the whole suite and commit**

```bash
for t in core/tests/*.sh; do bash "$t"; done
git add kits/flaky-triage-kit/core/_wiring_repair.sh kits/flaky-triage-kit/core/tests/integrity-test.sh
git commit -m "kit: restore a deleted gate where ownership allows it

dangling means the registration resolves to a file that is not there, so
rewriting the registration does not fix it. The file is restored from the
engine's copy — but only where the tree is not root-owned.

At hardened and stale the gate's path must hold a root-owned file, and
that ownership is the identity test. A kit running as the user can only
write a user-owned one, so restoring there would turn a dangling into a
foreign: broken differently, and unrepairable by design. stale sits with
hardened because it means the tree IS root-owned and only the record
disagrees."
```

---

## Task 4: Call it from the guard

**Files:**
- Modify: `kits/flaky-triage-kit/core/_integrity.sh`
- Modify: `kits/flaky-triage-kit/core/tests/integrity-test.sh`

**Interfaces:**
- Consumes: `wiring_repair <kit_root> <tier> <wiring>` from Tasks 2 and 3.
- Produces: `integrity_guard <kit_root>` → 0 or 76, signature unchanged, so all 13 call sites stay byte-identical.

The verdict handed to `integrity_report` is the **pre-repair** wiring. That is not an oversight: a written registration does not arm a running session, because the harness reads hook configuration at startup. Where the tree is root-owned the guard must still refuse, because the protection it records is still not in place for this session.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/integrity-test.sh`:

```bash
# --- integrity_guard repairs, then still reports the PRE-repair verdict -------------------------
# A repair does not arm this session: the harness reads hook config at startup. So a root-owned
# tree still refuses, and the message tells the reader the one thing that will help.
R="$(mktemp -d)"; W="$(wire_fixture "$R")"; K="$W/.claude/skills/hektor-flaky-triage"
echo '{}' > "$W/.claude/settings.json"
integrity_guard "$K" >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok || bad "an unprotected tree must proceed after repairing"
case "$(slots_of "$W/.claude/settings.json")" in
  *PreToolUse:Bash*) ok ;; *) bad "the guard must have repaired the registration" ;;
esac
# Second call: now wired, and silent about wiring.
case "$(integrity_guard "$K" 2>&1 >/dev/null)" in
  *WIRING*) bad "a repaired registration must read as wired on the next call" ;; *) ok ;;
esac
rm -rf "$R"

# The guard's signature is unchanged, so no call site moved.
[ "$(grep -c 'integrity_guard "' "$HERE"/../*.sh)" -ge 1 ] && ok || bad "integrity_guard call sites must not have moved"

# The ordering — repair, then report the pre-repair value — is pinned by behaviour above and by the
# mutation in Step 5, not by a grep for how the call is spelled. An assertion that matches source
# text passes whenever the text is right and says nothing about what the code does; this plan has
# now caught that shape twice, once in each of the preceding two cycles.
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/integrity-test.sh`
Expected: FAIL — `integrity_guard` does not call `wiring_repair` yet, so nothing is written.

- [ ] **Step 3: Implement**

At the top of `core/_integrity.sh`, beside the file's other sourcing, add:

```bash
# The repair unit. Sourced here so `integrity_guard` can call it, kept in its own file so the
# detector functions below stay free of any filesystem write. At LOAD time and from THIS file's own
# directory — not from `integrity_guard`'s argument. That argument previously only selected what to
# report on; sourcing from it would make the guard execute code from a path its caller chose, before
# it has learned anything about that tree's ownership.
_INTEGRITY_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -r "$_INTEGRITY_HERE/_wiring_repair.sh" ] && . "$_INTEGRITY_HERE/_wiring_repair.sh" || wiring_repair() { return 0; }
```

`${BASH_SOURCE[0]}` trips the no-environment-read scan, which matches any `$UPPERCASE`. **Exclude it by
name**, the way `CLAUDE_PROJECT_DIR` already is, and state the reason beside it. `BASH_SOURCE` is a
stronger candidate for exclusion than that precedent: bash maintains the array and overwrites element
0 on every source and function entry, so a caller cannot preset it, and the threat the assertion names
— *a caller who can set a variable silences the guard* — does not apply. The idiom is already in-repo
at `core/lock-kit.sh:150` and in `core/ledger.sh`. No behavioural backstop is needed, unlike
`CLAUDE_PROJECT_DIR`, whose exclusion had to be closed by one.

Both lines are production wiring that no assertion reaches by default, because the test file sources
`_wiring_repair.sh` globally and the fixtures never place it in their own `core/`. Pin them: drive
`integrity_guard` in a **subshell that does not already have `wiring_repair` defined** —
`bash -c '. "$K/core/_integrity.sh"; integrity_guard "$K"'` — against a fixture whose `core/` really
holds `_wiring_repair.sh`, and assert the registration was repaired. Then remove that file and assert
the guard still returns sanely and nothing wedges. Without those two, deleting either line leaves the
whole suite green and returns the branch to the inert state this task exists to end.

Then replace `integrity_guard`'s body:

```bash
integrity_guard() {
  local kit="${1:-}" tier wiring
  tier="$(integrity_tier "$(integrity_owner_uid "$kit/core")" "$(integrity_state "$kit")")"
  wiring="$(integrity_wiring "$kit" "$tier")"
  # Repair first, report the PRE-repair verdict. A written registration does not arm a running
  # session — the harness reads hook config at startup — so where the tree is root-owned this still
  # refuses, and it should: the protection the tier records is not in place for this session.
  wiring_repair "$kit" "$tier" "$wiring"
  integrity_report "$tier" "$wiring"
}
```

- [ ] **Step 4: Run the tests, then the 13 call sites**

Run: `bash core/tests/integrity-test.sh`
Expected: PASS.

Run: `grep -c 'integrity_guard "' core/*.sh`
Expected: 13.

- [ ] **Step 5: Prove the ordering and the pre-repair verdict**

```bash
# If the guard reported the POST-repair value, a hardened tree would proceed on the very call that
# found it broken. Mutate the guard to re-derive `wiring` after the repair and confirm the
# still-refuses assertion goes red.
```

Add that assertion if the block above does not already carry it: build a fixture whose `.harness` says `claude`, delete the registration, drive `integrity_guard` with a root-owned-tree fixture, and assert `rc=76` on the first call.

- [ ] **Step 6: Run the whole suite and commit**

```bash
for t in core/tests/*.sh; do bash "$t"; done
git add kits/flaky-triage-kit/core/_integrity.sh kits/flaky-triage-kit/core/tests/integrity-test.sh
git commit -m "kit: the guard repairs before it reports, and reports what it found

integrity_guard now calls wiring_repair between detection and reporting.
The verdict handed to integrity_report is the pre-repair one, deliberately:
a written registration does not arm a running session, so where the tree is
root-owned the guard still refuses. Reporting the post-repair value would
let the call that discovered the breakage proceed as though it had never
happened."
```

---

## Task 5: Say what it repairs, and what it does not

**Files:**
- Modify: `kits/flaky-triage-kit/core/README.md`
- Modify: `kits/flaky-triage-kit/kernel.md`
- Modify: `kits/flaky-triage-kit/core/lock-kit.sh` (header comment)
- Modify: `kits/flaky-triage-kit/README.md`

- [ ] **Step 1: Add the repair to `core/README.md`'s module table**

```
| `_wiring_repair` | re-asserts the kit's own gate registration when the guard finds it missing or dangling | registration at every tier · the gate FILE only where the tree is not root-owned · `foreign` never |
```

And extend the `_integrity` row's prose so the reader learns the guard now writes: it detects, repairs, then reports the pre-repair verdict.

- [ ] **Step 2: Extend `kernel.md`'s P4 row**

```
**2026-07-31:** the kit now REPAIRS its own wiring rather than only reporting it. Detection was not enough: whether a project ends up wired depends on which tool provisioned it, and a worktree was twice observed holding the kit with none of it wired and nothing saying why. The registration is rewritten at every tier; the gate file is restored only where the tree is not root-owned, because at hardened and stale that path must hold a root-owned file and a repair running as the user would turn a `dangling` into a `foreign`. A repair arms on the NEXT session — the harness reads hook config at startup — so a root-owned tree still refuses after repairing and says to restart.
```

- [ ] **Step 3: Add to `lock-kit.sh`'s STILL NOT COVERED list**

```
#  10. A repair arms on the next session, never the one that made it. The harness reads hook config
#      at startup, so between the repair and a restart the gate is registered and not running.
#  11. The kit repairs its OWN registration only. A neighbouring pack's stale registration — the
#      noise in the observed case — is not the kit's to fix and is not fixed.
#  12. Below a root-owned tree the restore source has no more protection than anything else, so a
#      poisoned source restores a poisoned gate. That is what the lower tiers already mean.
```

- [ ] **Step 4: Sweep for claims this change makes untrue**

Apply the criterion this kit settled on — *does any sentence say something untrue about what protects what?* — to every file that describes the guard or the wiring axis:

```bash
grep -rln 'integrity_guard\|wiring\|registration' kits/flaky-triage-kit/ docs/hektor/ | grep -v '\.achilles'
```

Read every mention in each file returned and record it in your report, including the ones you judge fine. Two are known to need attention: anything saying the guard only *reports*, and `docs/hektor/flaky-triage-improvement-report-2026-07-30.md`, whose residual list predates this change.

Enumerate files, not phrases. Five rounds of the preceding documentation tasks each ended with a survivor because the sweep was narrower than the claim, and the last one survived a phrase grep by using different words.

- [ ] **Step 5: Run the whole suite and commit**

```bash
for t in core/tests/*.sh; do bash "$t"; done
git add kits/flaky-triage-kit/core/README.md kits/flaky-triage-kit/kernel.md kits/flaky-triage-kit/core/lock-kit.sh kits/flaky-triage-kit/README.md
git commit -m "kit: describe the repair and the three residuals it leaves

New behaviour nothing documents is the same defect as a claim nothing
delivers, sign flipped. States what is repaired, what is not, and the one
that matters most to a reader: a repair arms on the next session, so
between the repair and a restart the gate is registered and not running."
```

---

## Self-Review

**Spec coverage:** §1 the repairable/unrepairable table → Tasks 2 and 3. §2 tier coupling and the `foreign` hazard → Task 3, with the `hardened|stale` mutation as its own step. §3 the restore source inside `core/` → Task 1. §4 repair does not mean protected, pre-repair verdict, still refuses → Task 4. §5 the rejected heartbeat is a decision not to build, so no task. §6 code location and the lock → Task 2. §7 failure handling → Task 2's guards and its unwritable/unparseable assertions. §8 the four properties → Task 2 (additive, foreign), Task 3 (root-owned restore), Task 4 (refusal survives). §9 residuals → Task 5. No gaps.

**Placeholder scan:** clean — every step carries its code or its exact command.

**Type consistency:** `wiring_repair <kit_root> <tier> <wiring>` is used identically in Tasks 2, 3 and 4. `_wr_restore_gate` takes the five arguments Task 3 passes. `slots_of` is defined once in Task 2 and reused in Task 4. `wire_fixture` is the existing helper throughout.
