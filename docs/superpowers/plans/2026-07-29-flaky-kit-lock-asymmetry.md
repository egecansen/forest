# Flaky-Kit Lock Privilege Asymmetry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `core/lock-kit.sh` a real capability asymmetry — root-owned `core/**` so unlocking requires a password only a human can supply — plus a four-state integrity check that announces a degraded or shadowed kit instead of silently pretending to enforce.

**Architecture:** `lock-kit.sh` gains a hardened tier that `chown`s the surface to root via an *internally* invoked `sudo` (never `sudo -E`, which sudoers' `env_reset` refuses), records the tier in a root-owned `core/.lock-state`, and degrades to today's `chmod a-w` when sudo is unavailable. A new sourced helper `core/_integrity.sh` — following the existing `_lock.sh` / `_strict.sh` pattern — compares real ownership against the recorded tier and returns one of four states. The self-protection gate relocates to `.claude/hooks/` so shadowing the kit directory does not remove the detector.

**Tech Stack:** bash 3.2-compatible shell, `jq`, POSIX `chown`/`chmod`/`stat`, the kit's existing plain-bash test suites (`core/tests/*.sh`, `ok()`/`bad()` counters, exit on `$fail -eq 0`).

**Spec:** `docs/superpowers/specs/2026-07-29-flaky-kit-lock-asymmetry-design.md`

## Global Constraints

- **The kit is unlocked for the whole run, not per task.** The controller unlocks once
  (`HEKTOR_FLAKYKIT_UNLOCK=1 core/lock-kit.sh unlock` from the kit root) before Task 1 and re-locks
  once after Task 8. Do **not** unlock or re-lock inside a task: Task 3 rewrites `lock-kit.sh`
  itself, so a per-task re-lock would run a half-migrated locker against a tree the next task must
  edit. If a write fails with `Permission denied`, stop and report it — do not work around it.
  Files under `adapters/` are not on the lock surface and never needed an unlock.
- **bash 3.2 compatible** — this is macOS's system bash. No associative arrays, no `${var^^}`. Keep EREs in unquoted variables inside `[[ =~ ]]` (see `core/_strict.sh`'s portability note).
- **No `sudo -E`, ever.** The script runs as the user and escalates internally for the single `chown`. Reading `HEKTOR_FLAKYKIT_UNLOCK` happens *before* any escalation.
- **`stat` is not portable:** BSD/macOS is `stat -f %u`, GNU/Linux is `stat -c %u`. Branch on `uname -s` exactly as `adapters/_lib/audit.sh` does for `chflags`/`chattr`.
- **Never fail a caller because integrity reporting failed.** `_integrity.sh` mirrors `hektor_audit`'s discipline: informative return codes, but a broken check must not wedge the kit.
- **Commit messages carry no AI trailers** (repo convention — no `Co-Authored-By`, no session line).
- **All existing tests must stay green:** `for t in core/tests/*.sh; do bash "$t"; done` — currently 275 passing.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `core/_integrity.sh` | create | Pure tier-decision function + a thin stat/state reader. Sourced, never executed directly |
| `core/.lock-state` | created at runtime | One JSON line recording the tier `lock` established. Root-owned in hardened mode |
| `core/lock-kit.sh` | modify | Hardened tier, internal escalation, per-path `status`, state writing |
| `core/config.json` | modify | Two new env-override doc keys |
| `core/rerun.sh` | modify | Honour `HEKTOR_FK_DATA_CENTER` / `HEKTOR_FK_CHROME_VERSION` |
| `core/tests/integrity-test.sh` | create | Drives the tier decision through all states with synthetic inputs, plus real-filesystem fixtures for the two readers — no sudo |
| `core/tests/self-protection-test.sh` | modify | Fixture follows the relocated gate |
| `adapters/claude/flaky-kit-self-protection-gate.sh` | modify | `SURF_RE`/`match_surface` for the new location; shadow detection |
| `adapters/cursor/flaky-kit-self-protection-gate.sh` | modify | Same two changes, Cursor side |
| `install.sh` (kit) | modify | Register the gate at its new path; detect a hardened install; print the hardening hint |
| `enforcement-codeowners.md` | modify | CODEOWNERS paths follow the gate |
| `kernel.md` | modify | P4 row + §14 honesty correction |
| `core/README.md` | modify | New module rows |
| `docs/superpowers/plans/…-manual-acceptance.md` | create | The privileged path, run once by hand |

---

## Task 1: Config env overrides

Removes the only day-to-day reason to open the lock. Independent of everything else — do it first so the wall never blocks routine work.

**Files:**
- Modify: `kits/flaky-triage-kit/core/config.json`
- Modify: `kits/flaky-triage-kit/core/rerun.sh:86-88` (the `PROF`/`LP`/`DC`/`BR` block)

**Interfaces:**
- Produces: env vars `HEKTOR_FK_DATA_CENTER`, `HEKTOR_FK_CHROME_VERSION`. Precedence is **env wins over config**, matching `HEKTOR_FK_JAVA_HOME` at `rerun.sh:85`.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/rerun-test.sh`, before its final `echo`:

```bash
# --- env overrides win over config.json (HEKTOR_FK_JAVA_HOME precedent) ---
DRY_OUT="$(HEKTOR_FK_DATA_CENTER=zz RERUN_DRY=1 bash "$HERE/../rerun.sh" com.x.AaTest 161 2>/dev/null)"
case "$DRY_OUT" in *"-Denv.data.center=zz"*) ok ;; *) bad "HEKTOR_FK_DATA_CENTER must override run.data_center" ;; esac
DRY_OUT="$(HEKTOR_FK_CHROME_VERSION=131 RERUN_DRY=1 bash "$HERE/../rerun.sh" com.x.AaTest 161 2>/dev/null)"
case "$DRY_OUT" in *"-Dchrome.version=131"*) ok ;; *) bad "HEKTOR_FK_CHROME_VERSION must inject the pin without editing config" ;; esac
DRY_OUT="$(HEKTOR_FK_CHROME_VERSION='1;rm -rf /' RERUN_DRY=1 bash "$HERE/../rerun.sh" com.x.AaTest 161 2>&1)"
case "$DRY_OUT" in *"I1"*) ok ;; *) bad "a malformed HEKTOR_FK_CHROME_VERSION must be I1-rejected, not passed through" ;; esac
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/rerun-test.sh`
Expected: FAIL — `HEKTOR_FK_DATA_CENTER must override run.data_center`

- [ ] **Step 3: Implement**

In `core/rerun.sh`, replace the `DC=` assignment and the `CV=` assignment:

```bash
DC="${HEKTOR_FK_DATA_CENTER:-$(jq -r '.run.data_center' "$CFG")}"; BR="$(jq -r '.run.browser' "$CFG")"
```

```bash
CV="${HEKTOR_FK_CHROME_VERSION:-$(jq -r '.run.chrome_version // ""' "$CFG")}"
```

The existing `strict_match "$CV" '[0-9]+(\.[0-9]+)*'` guard already covers the env path — it validates whatever `CV` ends up holding.

- [ ] **Step 4: Document the seam in config.json**

Change the `_portability` value to end with:

```
(3) run.data_center and run.chrome_version are per-run operational knobs, overridable via HEKTOR_FK_DATA_CENTER / HEKTOR_FK_CHROME_VERSION so a hardened (root-owned) kit never needs unlocking for routine work. The SECURITY fields — es.host, es.host_allowlist, jira.host, qagent.endpoint, source_roots — are deliberately NOT env-overridable and are protected by the lock.
```

- [ ] **Step 5: Run tests**

Run: `bash core/tests/rerun-test.sh`
Expected: PASS, 24 passed 0 failed

- [ ] **Step 6: Commit**

```bash
git add kits/flaky-triage-kit/core/rerun.sh kits/flaky-triage-kit/core/config.json kits/flaky-triage-kit/core/tests/rerun-test.sh
git commit -m "kit: env overrides for data_center and chrome_version

Routine per-run knobs must not require opening the lock. Follows the
HEKTOR_FK_JAVA_HOME precedent; the security fields stay file-only."
```

---

## Task 2: `core/_integrity.sh` + its test

The tier decision is a pure function so it can be tested without a password.

**Files:**
- Create: `kits/flaky-triage-kit/core/_integrity.sh`
- Create: `kits/flaky-triage-kit/core/tests/integrity-test.sh`

**Interfaces:**
- Produces: `integrity_tier <owner_uid> <recorded_tier>` → prints one of `hardened|unlocked|degraded|mismatch|stale` on stdout, returns 0 always.
- Produces: `integrity_owner_uid <path>` → prints the numeric owner uid, or empty on failure.
- Produces: `integrity_state <kit_root>` → prints the recorded tier from `.lock-state`, or empty when absent.
- Consumed by Task 4 (core entrypoints) and Task 3 (`lock-kit.sh status`).

**Decision rule (implement exactly this):** rank actual protection as `2` when the owner is uid 0, else `1`. Rank the recorded expectation as `2` for `hardened`, else `1`. Then:
- actual **<** expected → `mismatch` (protection is weaker than recorded — the dangerous direction)
- actual **>** expected → `stale` (stronger than recorded; safe, but the state file is out of date)
- actual **==** expected → the recorded tier itself (`hardened` / `unlocked` / `degraded`), defaulting to `degraded` when nothing is recorded

- [ ] **Step 1: Write the failing test**

Create `core/tests/integrity-test.sh`:

```bash
#!/bin/bash
# Test suite for core/_integrity.sh. Plain bash asserts, no framework.
# The REAL chown-to-root cannot be automated — it needs a password. But the hardened LOGIC can be:
# a PATH-shimmed `sudo` drives the whole branch as an unprivileged user (see the shim block below).
# Only actual root ownership is deferred to the manual checklist. The tier
# DECISION is a pure function of (owner uid, recorded tier) and is driven here with synthetic
# inputs, exactly as core/tests/rerun-test.sh drives aggregate() via RERUN_LIB_ONLY.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../_integrity.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }
is()  { [ "$(integrity_tier "$1" "$2")" = "$3" ] && ok || bad "owner=$1 state=$2 -> expected $3, got $(integrity_tier "$1" "$2")"; }

# root-owned, agrees with state
is 0 hardened hardened
# user-owned, agrees with state
is 501 unlocked unlocked
is 501 degraded degraded
# fresh install: nothing recorded, user-owned -> not merely "degraded", genuinely unprotected
is 501 "" unprotected
# THE dangerous direction: recorded hardened, no longer root-owned
is 501 hardened mismatch
# stronger than recorded is safe, but the state file is out of date
is 0 degraded stale
is 0 unlocked stale
is 0 "" stale
# any unknown recorded value is treated as unprotected, never as hardened
is 501 banana unprotected
is 0 banana stale

# --- the two readers: platform-branched stat and jq-less JSON scraping are the parts most likely
# --- to differ across environments, so they get real filesystem fixtures rather than trust.
RT="$(mktemp -d)"; trap 'rm -rf "$RT"' EXIT
mkdir -p "$RT/core"; printf 'x\n' > "$RT/core/probe"

# integrity_owner_uid
[ -z "$(integrity_owner_uid /nonexistent-path-xyz)" ] && ok || bad "owner_uid on a missing path must print nothing"
integrity_owner_uid /nonexistent-path-xyz >/dev/null; [ $? -eq 0 ] && ok || bad "owner_uid on a missing path must return 0"
[ -z "$(integrity_owner_uid)" ] && ok || bad "owner_uid with no argument must print nothing, not error"
[ "$(integrity_owner_uid "$RT/core/probe")" = "$(id -u)" ] && ok || bad "owner_uid must report the real owner of an existing file"
# THE wedge case: stat unavailable must not abort a `set -e` caller (this is why return 0 is explicit)
( set -euo pipefail; . "$HERE/../_integrity.sh"; PATH=/nonexistent-bin integrity_owner_uid /tmp >/dev/null ) 2>/dev/null \
  && ok || bad "owner_uid must not abort a set -e caller when stat is unavailable"

# integrity_state
[ -z "$(integrity_state "$RT")" ] && ok || bad "state with no .lock-state must print nothing"
integrity_state "$RT" >/dev/null; [ $? -eq 0 ] && ok || bad "state with no .lock-state must return 0"
[ -z "$(integrity_state)" ] && ok || bad "state with no argument must print nothing, not error"
printf '{"tier":"hardened","at":"2026-07-29T00:00:00Z"}\n' > "$RT/core/.lock-state"
[ "$(integrity_state "$RT")" = hardened ] && ok || bad "state must read the tier the writer emits"
printf '{"at":"x","note":"no tier here"}\n' > "$RT/core/.lock-state"
[ -z "$(integrity_state "$RT")" ] && ok || bad "state must print nothing when no tier key is present"
# Ambiguity: two tier keys must resolve the SAME way regardless of line wrapping — first wins.
printf '{"history":[{"tier":"unlocked"},{"tier":"hardened"}]}\n' > "$RT/core/.lock-state"
[ "$(integrity_state "$RT")" = unlocked ] && ok || bad "two tier keys on ONE line must resolve first-wins"
printf '{"history":[{"tier":"unlocked"},\n{"tier":"hardened"}]}\n' > "$RT/core/.lock-state"
[ "$(integrity_state "$RT")" = unlocked ] && ok || bad "two tier keys across TWO lines must resolve first-wins, same as one line"

echo "integrity-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/integrity-test.sh`
Expected: FAIL — `_integrity.sh` does not exist, sourcing errors out

- [ ] **Step 3: Implement `core/_integrity.sh`**

```bash
#!/bin/bash
# core/_integrity.sh — is this tree still the tree that was locked?
#
# WHY: core/lock-kit.sh can now establish a HARDENED tier (core/** owned by root, so only a
# password-gated sudo can reopen it) or fall back to a DEGRADED tier (chmod a-w only, which the
# owning user — and therefore the agent — can always reverse). A kit that silently slipped from the
# first to the second would still LOOK locked while enforcing nothing. Source this and ask.
#
# LIMIT, stated up front: this check lives INSIDE the tree it validates, so it cannot detect
# SHADOWING (`mv` the kit dir aside and put a fake one in its place) — a shadowed tree carries its
# own state file and is indistinguishable from a fresh un-hardened install. That case is the
# relocated gate's job (.claude/hooks/, outside the shadowable tree). This check catches ACCIDENTS:
# an upgrade that dropped ownership, a kit installed but never hardened, a maintenance unlock left
# open. Two different jobs, deliberately not conflated.
#
# Never wedges a caller: every function returns 0 and prints its answer, mirroring hektor_audit's
# "a broken check must not break the run" discipline.

# integrity_owner_uid <path> -> numeric uid, or empty. BSD and GNU stat take different flags.
integrity_owner_uid() {
  local p="${1:-}"
  [ -n "$p" ] && [ -e "$p" ] || return 0
  case "$(uname -s 2>/dev/null)" in
    Darwin|*BSD) stat -f %u "$p" 2>/dev/null ;;
    *)           stat -c %u "$p" 2>/dev/null ;;
  esac
  # Explicit, NOT decorative: without it the function exits with `stat`'s status, so a missing or
  # failing stat returns non-zero and aborts any caller running under `set -e` — the exact
  # "never wedge a caller" violation this file's header promises not to commit.
  return 0
}

# integrity_state <kit_root> -> the recorded tier, or empty when absent/unreadable.
integrity_state() {
  local f="${1:-}/core/.lock-state"
  [ -n "${1:-}" ] && [ -r "$f" ] || return 0
  # `[^}]*` before the key, not `.*`: a greedy `.*` walks past the FIRST "tier" to the last one on
  # the line, so a state file carrying two tier keys resolves to last-wins on one line and
  # first-wins when the same content is split across lines (head -1). Anchoring the prefix so it
  # cannot cross an object boundary makes the first occurrence win in both layouts. The legitimate
  # writer (Task 3) emits exactly one flat {"tier":...,"at":...}; this is about not being ambiguous
  # when handed something else.
  #
  # `[^}]`, NOT `[^"]` — an earlier draft of this plan specified the quote class and was wrong: the
  # prefix then cannot cross the quote in a leading key like {"history":…, so the match fails
  # outright and the function returns empty on exactly the ambiguous input it exists to
  # disambiguate. Verified on {"history":[{"tier":"unlocked"},{"tier":"hardened"}]}: the quote class
  # yields '' and the brace class yields 'unlocked'.
  sed -n 's/^[^}]*"tier"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$f" 2>/dev/null | head -1
  return 0
}

# integrity_tier <owner_uid> <recorded_tier> -> hardened|unlocked|degraded|unprotected|mismatch|stale
# Ranks protection: root-owned is 2, anything else is 1; a recorded "hardened" expects 2, all else 1.
# Weaker-than-recorded is the dangerous direction and is the only one that yields `mismatch`.
#
# `unprotected` vs `degraded` is a real distinction, not a synonym pair, and collapsing them was a
# bug: `degraded` means the surface IS read-only (chmod a-w) but this user can chmod it back;
# `unprotected` means `lock` never ran at all and the files are plainly writable. A fresh install is
# the second one — verified: no .lock-state, mode -rwxr-xr-x, a write succeeds. While both mapped to
# `degraded`, every message describing "read-only but reversible" was simply false for the fresh
# case, and `status` contradicted itself by printing `rw core/apply.sh` directly above
# `tier: degraded`. Anything unrecognised also lands here: an unreadable record means we do not know,
# and not-knowing must never read as protected.
integrity_tier() {
  local owner="${1:-}" recorded="${2:-}" actual=1 expected=1
  [ "$owner" = "0" ] && actual=2
  [ "$recorded" = "hardened" ] && expected=2
  if [ "$actual" -lt "$expected" ]; then echo mismatch; return 0; fi
  if [ "$actual" -gt "$expected" ]; then echo stale; return 0; fi
  case "$recorded" in
    hardened|unlocked|degraded) echo "$recorded" ;;
    *)                          echo unprotected ;;
  esac
  return 0
}
```

- [ ] **Step 4: Run the test**

Run: `bash core/tests/integrity-test.sh`
Expected: PASS, 22 passed 0 failed

- [ ] **Step 5: Commit**

```bash
chmod +x core/tests/integrity-test.sh
git add kits/flaky-triage-kit/core/_integrity.sh kits/flaky-triage-kit/core/tests/integrity-test.sh
git commit -m "kit: _integrity.sh — four-state lock-tier check

Pure decision function so the tier logic is testable without a password.
Weaker-than-recorded is the only state that reports mismatch. States the
limit in the header: an in-tree check cannot detect shadowing."
```

---

## Task 3: Hardened tier in `lock-kit.sh`

**Files:**
- Modify: `kits/flaky-triage-kit/core/lock-kit.sh` (whole `case` block, lines 54-75)

**Interfaces:**
- Consumes: `integrity_owner_uid`, `integrity_state`, `integrity_tier` from Task 2.
- Produces: `core/.lock-state` containing `{"tier":"hardened|unlocked|degraded","at":"<iso8601>"}`.
- Produces: `lock-kit.sh status` printing a `tier: <name>` line, consumed by Task 7's installer check.

- [ ] **Step 1: Write the failing test**

Create `core/tests/lock-tier-test.sh`:

```bash
#!/bin/bash
# Test suite for core/lock-kit.sh's tier behaviour that does NOT need root.
# The chown-to-root path needs a password and is covered by the manual acceptance checklist.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/../lock-kit.sh"
TMP="$(mktemp -d)"; trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

# fixture: a kit-shaped tree we own, so lock must land in the DEGRADED tier
KIT="$TMP/kit"; mkdir -p "$KIT/core"
cp "$LOCK" "$KIT/core/lock-kit.sh"; cp "$HERE/../_integrity.sh" "$KIT/core/_integrity.sh"
printf '{}\n' > "$KIT/core/config.json"; chmod +x "$KIT/core/lock-kit.sh"

# With sudo forced unavailable, lock must degrade, say so, and still exit 0.
OUT="$(HEKTOR_FK_NO_SUDO=1 "$KIT/core/lock-kit.sh" lock 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok || bad "lock must exit 0 when it degrades (an approved outcome, not a failure)"
case "$OUT" in *DEGRADED*) ok ;; *) bad "a degraded lock must say DEGRADED explicitly" ;; esac
[ -f "$KIT/core/.lock-state" ] && ok || bad "lock must record the tier it achieved"
grep -q '"tier"[[:space:]]*:[[:space:]]*"degraded"' "$KIT/core/.lock-state" && ok || bad "state must record degraded"
[ -w "$KIT/core/config.json" ] && bad "degraded lock must still remove the write bit" || ok
case "$(HEKTOR_FK_NO_SUDO=1 "$KIT/core/lock-kit.sh" status 2>&1)" in
  *"tier: degraded"*) ok ;; *) bad "status must print the tier line" ;;
esac
# unlock still requires the intent marker
HEKTOR_FK_NO_SUDO=1 "$KIT/core/lock-kit.sh" unlock >/dev/null 2>&1
[ "$?" -eq 77 ] && ok || bad "unlock without HEKTOR_FLAKYKIT_UNLOCK must exit 77"
HEKTOR_FLAKYKIT_UNLOCK=1 HEKTOR_FK_NO_SUDO=1 "$KIT/core/lock-kit.sh" unlock >/dev/null 2>&1
[ -w "$KIT/core/config.json" ] && ok || bad "unlock with the intent marker must restore writability"
grep -q '"tier"[[:space:]]*:[[:space:]]*"unlocked"' "$KIT/core/.lock-state" && ok || bad "state must record unlocked"

# --- the HARDENED branch, driven WITHOUT root via a PATH-shimmed sudo -------------
# An earlier draft of this plan asserted the hardened path could not be tested because it needs a
# password. That is false, and leaving harden_targets() — the function that decides what becomes
# root-owned — with zero coverage is how its first version shipped a two-command bypass. A shim
# that logs its arguments, no-ops `chown`, and execs everything else drives the whole branch as an
# unprivileged user: it cannot prove root ownership, but it pins the call SEQUENCE, the target
# SET, and the counters, which is where the defects actually live.
SHIM="$TMP/bin"; mkdir -p "$SHIM"
cat > "$SHIM/sudo" <<'SH'
#!/bin/bash
echo "$@" >> "$SUDO_LOG"
case "$1" in chown) exit 0 ;; *) exec "$@" ;; esac
SH
chmod +x "$SHIM/sudo"
export SUDO_LOG="$TMP/sudo.log"; : > "$SUDO_LOG"
KIT2="$TMP/kit2"; mkdir -p "$KIT2/core" "$KIT2/hooks"
cp "$LOCK" "$KIT2/core/lock-kit.sh"; cp "$HERE/../_integrity.sh" "$KIT2/core/_integrity.sh"
printf '{}\n' > "$KIT2/core/config.json"; printf 'x\n' > "$KIT2/SKILL.md"
printf 'x\n' > "$KIT2/hooks/flaky-kit-self-protection-gate.sh"; chmod +x "$KIT2/core/lock-kit.sh"
HOUT="$(PATH="$SHIM:$PATH" "$KIT2/core/lock-kit.sh" lock 2>&1)"

case "$HOUT" in *HARDENED*) ok ;; *) bad "with sudo available the lock must reach the hardened tier" ;; esac
case "$HOUT" in *"0 files"*) bad "hardened counters must not report 0 — priv_chmod must escalate too" ;; *) ok ;; esac
grep -q "chown -R root" "$SUDO_LOG" && ok || bad "hardened lock must chown the surface to root"
# THE regression guard for the two-command bypass: the kit ROOT must be a chown target, not just core/.
grep -qE "chown -R root .*(^| )$KIT2( |$)" "$SUDO_LOG" && ok \
  || bad "the kit root itself must be chowned — otherwise chmod u+w \$KIT + mv core aside bypasses the wall with no password"
grep -q "$KIT2/hooks" "$SUDO_LOG" && ok || bad "hooks/ is on the surface and must be chowned"
grep -q "$KIT2/SKILL.md" "$SUDO_LOG" && ok || bad "SKILL.md is on the surface and must be chowned"
# Ordering: the state write must come BEFORE the write bits are stripped.
[ "$(grep -n 'tee' "$SUDO_LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n 'chmod' "$SUDO_LOG" | head -1 | cut -d: -f1)" ] \
  && ok || bad "state must be written before the chmod sweep, or it lands in a read-only directory"
case "$HOUT" in *"renamed aside"*) ok ;; *) bad "the hardened message must state the parent-rename residual instead of claiming an absolute" ;; esac

# The no-invoking-user refusal (exit 78) is reachable with an `id` stub — it is not dead code.
cat > "$SHIM/id" <<'SH'
#!/bin/bash
[ "$1" = "-un" ] && { echo root; exit 0; }; exec /usr/bin/id "$@"
SH
chmod +x "$SHIM/id"
HEKTOR_FLAKYKIT_UNLOCK=1 PATH="$SHIM:$PATH" HEKTOR_FK_NO_SUDO=1 "$KIT2/core/lock-kit.sh" unlock >/dev/null 2>&1
[ "$?" -eq 78 ] && ok || bad "unlock must refuse with 78 when there is no invoking user to hand ownership back to"

echo "lock-tier-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/lock-tier-test.sh`
Expected: FAIL — `lock` produces no `DEGRADED` output and writes no `.lock-state`

- [ ] **Step 3: Implement the tier logic**

In `core/lock-kit.sh`, after the existing `KIT=` line add:

```bash
. "$HERE/_integrity.sh"
STATE="$KIT/core/.lock-state"
ME="$(id -un 2>/dev/null)"

# Can we escalate? HEKTOR_FK_NO_SUDO=1 forces the degraded path (used by the test suite, and by
# anyone who wants the old behaviour). `sudo -n true` succeeds only with a cached/passwordless
# credential, so a plain `command -v sudo` is not enough of a probe on its own — but a password
# PROMPT is exactly what we want when the user is present, so we probe for the binary and let the
# real call prompt.
have_sudo() { [ "${HEKTOR_FK_NO_SUDO:-0}" = "1" ] && return 1; command -v sudo >/dev/null 2>&1; }
write_state() { printf '{"tier":"%s","at":"%s"}\n' "$1" "$(date -u +%FT%TZ 2>/dev/null || echo '?')" > "$STATE" 2>/dev/null; }
```

Replace the `lock)` branch body with the following. **Order matters and is easy to get wrong:** the
state file must be written *before* the directories lose their write bit (you cannot create a file in
a read-only directory), and once `core/` is root-owned the invoking user cannot create it at all — so
the hardened path writes it through `sudo tee`.

First add a helper next to `surface_files`, because the chown target is the whole safety surface —
not just `core/`. `SKILL.md` carries the safety rules, and the relocated gate is the detector; both
belong to root or the wall has holes in it:

```bash
# Everything that must be root-owned in the hardened tier. `chown -R` handles core/ recursively;
# SKILL.md and the relocated gate are single files. The gate lives OUTSIDE $KIT by design (Task 5)
# so a rename of the kit dir cannot take it along — which is exactly why it is listed separately.
harden_targets() {
  printf '%s\n' "$KIT/core"
  [ -d "$KIT/hooks" ] && printf '%s\n' "$KIT/hooks"
  [ -f "$KIT/SKILL.md" ] && printf '%s\n' "$KIT/SKILL.md"
  local root; root="$(git -C "$KIT" rev-parse --show-toplevel 2>/dev/null)"
  if [ -n "$root" ] && [ -f "$root/.claude/hooks/flaky-kit-self-protection-gate.sh" ]; then
    printf '%s\n' "$root/.claude/hooks/flaky-kit-self-protection-gate.sh"
  fi
  # $KIT LAST and non-recursively-meaningful: it is listed so the kit ROOT DIRECTORY itself changes
  # owner. This is load-bearing, not tidiness. `rename()` is governed by the write+execute bits of
  # the PARENT directory, never by the target's own bits or ownership — so with $KIT owned by the
  # invoking user, `chmod u+w "$KIT"` (which succeeds, because that user owns it) followed by
  # `mv "$KIT/core" "$KIT/core.bak" && mkdir "$KIT/core"` swaps in an attacker-controlled core/
  # without touching one root-owned file and without a password. Chowning only core/ therefore
  # reduces the hardened tier to a two-command bypass. Root-owning $KIT closes it.
  #
  # What this still does NOT close, and the HARDENED message must not claim it does: $KIT's own
  # parent (.claude/skills/) has to stay user-owned, because every other skill installs there — so
  # $KIT itself can be renamed aside by the same trick one level up. That residual is the design's
  # accepted one and is what the relocated gate's out-of-tree expectation detects (Task 6).
  printf '%s\n' "$KIT"
  return 0
}
# In the hardened tier the surface belongs to root, so THIS user's chmod would fail — run it with
# the same privilege that did the chown, or the counters below report 0 and the summary line lies.
# Tier is passed in, not read from a global: under `set -u` a global $TIER is unbound in the unlock
# and status branches, so a future call site there would abort on an undefined variable.
priv_chmod() { local t="$1"; shift; if [ "$t" = hardened ]; then sudo chmod "$@"; else chmod "$@"; fi; }
```

Then replace the `lock)` branch body with the following. **Order matters and is easy to get wrong:**
the state file must be written *before* the directories lose their write bit (you cannot create a
file in a read-only directory), and once the surface is root-owned the invoking user cannot create it
at all — so the hardened path writes it through `sudo tee`.

```bash
    # 1. Escalate FIRST so we know which tier we actually achieved.
    #    The tier is derived from the OBSERVED filesystem, never from chown's exit code. `chown -R`
    #    over several targets exits non-zero if ANY of them failed but does not roll back the ones
    #    that succeeded, so a half-success would otherwise leave TIER=degraded while core/ is
    #    already root-owned — and every message and state write below would then be false.
    #    stderr is captured, not discarded: a mistyped password, an aborted prompt and a
    #    not-in-sudoers user all produce the same silent non-zero, and reporting all three as
    #    "sudo unavailable" is exactly the dishonest degradation this kit exists to stop.
    TIER=degraded
    if have_sudo; then
      sudo_err="$(harden_targets | tr '\n' '\0' | xargs -0 sudo chown -R root 2>&1 >/dev/null)"
      [ "$(integrity_owner_uid "$KIT/core")" = "0" ] && TIER=hardened
    fi
    if [ "$TIER" != hardened ] && [ -n "${sudo_err:-}" ]; then
      echo "lock-kit: escalation failed — sudo said: $sudo_err" >&2
    fi
    # 2. Record the tier while the directory is still writable by SOMEONE.
    if [ "$TIER" = hardened ]; then
      printf '{"tier":"hardened","at":"%s"}\n' "$(date -u +%FT%TZ 2>/dev/null || echo '?')" \
        | sudo tee "$STATE" >/dev/null
    else
      write_state degraded \
        || echo "lock-kit: WARNING could not record the tier in $STATE — 'status' will report from ownership alone" >&2
    fi
    # 3. Only now remove the write bits — files first, then dirs.
    n=0; while IFS= read -r f; do priv_chmod "$TIER" a-w "$f" 2>/dev/null && n=$((n+1)); done < <(surface_files)
    d=0; while IFS= read -r p; do priv_chmod "$TIER" a-w "$p" 2>/dev/null && d=$((d+1)); done < <(surface_dirs)
    if [ "$TIER" = hardened ]; then
      echo "lock-kit: HARDENED $n files + $d dirs — the safety surface, including the kit root, is owned by root. Reopening needs a password; no write path inside this kit can reverse it." >&2
      echo "lock-kit: residual (by design, not a gap): the kit DIRECTORY can still be renamed aside via its own parent, which must stay user-owned so other skills can install there. That is detected, not prevented — see the gate's out-of-tree expectation." >&2
      echo "lock-kit: to edit, run:  HEKTOR_FLAKYKIT_UNLOCK=1 $0 unlock" >&2
    else
      echo "lock-kit: DEGRADED — locked $n files + $d dirs read-only, but the surface is still owned by $ME." >&2
      echo "lock-kit: that means the SAME user (and therefore an agent running as them) can chmod it back." >&2
      echo "lock-kit: for the real wall, re-run where sudo is available and the escalation is accepted." >&2
    fi ;;
```

The `unlock` branch's `sudo chown -R "$ME"` must widen to the same target set — replace its single
`"$KIT/core"` argument with the same `harden_targets` sweep, or a hardened `SKILL.md` stays root-owned
after an unlock and the next edit to it fails confusingly.

Replace the `unlock)` branch body with:

```bash
    [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ] \
      || { echo "lock-kit: refusing unlock — set HEKTOR_FLAKYKIT_UNLOCK=1 (records intent in the audit log; the PASSWORD below is the actual consent)" >&2; exit 77; }
    [ -n "$ME" ] && [ "$ME" != root ] \
      || { echo "lock-kit: refusing unlock — no invoking user to return ownership to (running as a direct root shell?). Re-run as the user who owns the project." >&2; exit 78; }
    if [ "$(integrity_owner_uid "$KIT/core")" = "0" ]; then
      sudo chown -R "$ME" "$KIT/core" \
        || { echo "lock-kit: unlock aborted — chown back to $ME failed; the kit stays hardened" >&2; exit 77; }
    fi
    d=0; while IFS= read -r p; do chmod u+w "$p" && d=$((d+1)); done < <(surface_dirs)
    n=0; while IFS= read -r f; do chmod u+w "$f" && n=$((n+1)); done < <(surface_files)
    write_state unlocked
    echo "lock-kit: UNLOCKED $n files + $d dirs for $ME. Re-lock when done:  $0 lock" >&2 ;;
```

Append to the `status)` branch, after its two existing loops:

```bash
    echo "  tier: $(integrity_tier "$(integrity_owner_uid "$KIT/core")" "$(integrity_state "$KIT")")"
```

- [ ] **Step 4: Run the test**

Run: `bash core/tests/lock-tier-test.sh`
Expected: PASS, 19 passed 0 failed

- [ ] **Step 5: Confirm the whole suite is still green**

Run: `for t in core/tests/*.sh; do printf '%-30s ' "$(basename $t)"; bash "$t" 2>&1 | tail -1; done`
Expected: every line reports `0 failed`

- [ ] **Step 6: Commit**

```bash
chmod +x core/tests/lock-tier-test.sh
git add kits/flaky-triage-kit/core/lock-kit.sh kits/flaky-triage-kit/core/tests/lock-tier-test.sh
git commit -m "kit: hardened lock tier — root-owned core/, password-gated reopen

lock now chowns core/ to root when sudo is available and degrades loudly
when it is not; unlock escalates internally (never sudo -E, which sudoers'
env_reset refuses) and hands ownership back to the invoking user."
```

---

## Task 4: Wire the check into the core entrypoints

**Files:**
- Modify: `kits/flaky-triage-kit/core/{ingest,cluster,rerun,apply,compile,ledger,summary,gate,correlate,dom-capture,dom-on-failure,qagent,triage}.sh` — one sourced line plus one call each

**Interfaces:**
- Consumes: `integrity_tier` / `integrity_owner_uid` / `integrity_state` from Task 2.
- Produces: `integrity_guard <kit_root>` in `_integrity.sh` — the shared reporter every entrypoint calls.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/integrity-test.sh` before its final `echo`:

```bash
# --- integrity_report: the message + decision for each tier -----------------------
# Driven DIRECTLY with tier strings. The earlier draft went through integrity_guard and injected a
# fake uid via INTEGRITY_FAKE_UID; that override then existed in production code, where setting one
# environment variable silenced the guard entirely. The seam belongs at the function boundary, not
# in the environment — so the reporting half is tested here and the uid half is already covered by
# the integrity_tier cases above.
rep_out() { integrity_report "$1" 2>&1; }
rep_rc()  { integrity_report "$1" >/dev/null 2>&1; echo $?; }

[ -z "$(rep_out hardened)" ] && ok || bad "hardened must be silent"
[ "$(rep_rc hardened)" = 0 ] && ok || bad "hardened must return 0"
case "$(rep_out stale)" in *"treating as hardened"*) ok ;; *) bad "stale must say it is treating the tree as hardened and ask for a refresh" ;; esac
[ "$(rep_rc stale)" = 0 ] && ok || bad "stale must not block the run"
case "$(rep_out unlocked)" in *"maintenance"*) ok ;; *) bad "unlocked must remind the user to re-lock" ;; esac
[ "$(rep_rc unlocked)" = 0 ] && ok || bad "unlocked must not block the run"
case "$(rep_out degraded)" in *DEGRADED*) ok ;; *) bad "degraded must emit a one-line notice" ;; esac
[ "$(rep_rc degraded)" = 0 ] && ok || bad "degraded must not block the run"
case "$(rep_out unprotected)" in *UNPROTECTED*) ok ;; *) bad "unprotected must say lock never ran and the surface is writable" ;; esac
case "$(rep_out unprotected)" in *"read-only"*) bad "unprotected must NOT describe the surface as read-only — a fresh install is writable" ;; *) ok ;; esac
[ "$(rep_rc unprotected)" = 0 ] && ok || bad "unprotected must not block the run"
case "$(rep_out mismatch)" in *MISMATCH*) ok ;; *) bad "mismatch must be loud" ;; esac
[ "$(rep_rc mismatch)" = 76 ] && ok || bad "mismatch must return 76 so callers refuse"
# Nothing may reach stdout: four entrypoints emit a machine-read contract there.
for t in hardened stale unlocked degraded unprotected mismatch; do
  [ -z "$(integrity_report "$t" 2>/dev/null)" ] || bad "integrity_report must never write to stdout (tier: $t)"
done; ok
# The production path must carry no environment override.
grep -q 'INTEGRITY_FAKE_UID' "$HERE/../_integrity.sh" && bad "no environment override may remain in _integrity.sh — it silences the guard for anyone who can set a variable" || ok
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/integrity-test.sh`
Expected: FAIL — `integrity_guard: command not found`

- [ ] **Step 3: Add `integrity_guard` to `core/_integrity.sh`**

```bash
# integrity_report <tier> -> 0 to proceed, 76 to refuse. Prints to stderr, never stdout, so it can
# never contaminate a script whose stdout is a JSON contract (rerun, gate, ledger, summary).
#
# Split out from integrity_guard so the messaging/decision half is a PURE function of the tier
# string and can be driven directly by the test suite. An earlier draft kept them fused and let the
# tests inject a fake owner uid through an environment override — which handed anyone able to set a
# variable a silent bypass of this very check: forcing the uid to 0 turned a `mismatch` tree into
# `hardened` and the guard returned 0 without printing a word. A one-variable skeleton key to a
# control whose entire premise is that bypassing costs a password is not a test seam, it is a hole.
# The seam now runs through the function boundary instead of through the environment, so nothing in
# production reads an override at all.
#
# NOTE for whoever edits this comment: do not name the retired variable here. The test suite greps
# this whole file for that identifier to prove it never comes back, so writing it in a comment
# fails the suite against its own documentation. (Reproduced during implementation: 33/1.)
integrity_report() {
  local tier="${1:-}"
  case "$tier" in
    hardened) return 0 ;;
    stale)
      echo "integrity: core/ is root-owned but .lock-state disagrees — treating as hardened; re-run 'core/lock-kit.sh lock' to refresh the record" >&2
      return 0 ;;
    unlocked)
      echo "integrity: the kit is UNLOCKED (maintenance window open) — its safety surface is writable right now. Re-lock when done: core/lock-kit.sh lock" >&2
      return 0 ;;
    degraded)
      echo "integrity: DEGRADED tier — the surface is read-only but still owned by this user, so this account can reverse it with a single chmod. Harden with: core/lock-kit.sh lock (needs sudo)" >&2
      return 0 ;;
    unprotected)
      echo "integrity: UNPROTECTED — lock has never run here, so the safety surface is plainly writable by this user and by any agent running as them. Nothing is enforcing the kit's invariants. Protect it with: core/lock-kit.sh lock (needs sudo)" >&2
      return 0 ;;
    mismatch)
      echo "integrity: MISMATCH — this kit was locked at the hardened tier, but core/ is no longer root-owned." >&2
      echo "integrity: this is not the tree that was hardened. Refusing: nothing it produces — summary, verdict, cluster table — should be trusted." >&2
      echo "integrity: if you unlocked deliberately, run 'core/lock-kit.sh lock' to re-establish the tier." >&2
      return 76 ;;
  esac
  return 0
}

# integrity_guard <kit_root> -> 0 to proceed, 76 to refuse.
# The trivial composition: real uid + recorded state -> tier -> report. It reads NO environment
# override — the tier always comes from the filesystem. Each half is tested on its own
# (integrity_tier with synthetic uids, integrity_report with synthetic tiers), which is the same
# split already used elsewhere in this file, so nothing here needs a back door to be exercised.
integrity_guard() {
  local kit="${1:-}"
  integrity_report "$(integrity_tier "$(integrity_owner_uid "$kit/core")" "$(integrity_state "$kit")")"
}
```

The test block in Step 1 drives `integrity_report` directly with tier strings — `integrity_report hardened`, `integrity_report mismatch`, and so on — instead of setting a fake uid around `integrity_guard`. Cover `stale` too; the earlier draft omitted it.

- [ ] **Step 4: Run the test**

Run: `bash core/tests/integrity-test.sh`
Expected: PASS, 37 passed 0 failed

- [ ] **Step 5: Call it from every entrypoint**

**Only 8 of the 13 scripts define `HERE`.** Verified: `ingest`, `cluster`, `rerun`, `apply`,
`compile`, `dom-capture`, `dom-on-failure`, `triage` have a `HERE=` line; `ledger`, `summary`,
`gate`, `correlate`, `qagent` do **not**. Do not assume an anchor that is not there.

For the **8 that already define `HERE`**, add immediately after that line:

```bash
. "$HERE/_integrity.sh"; integrity_guard "$HERE/.." || exit 76
```

For the **5 that do not** (`ledger.sh`, `summary.sh`, `gate.sh`, `correlate.sh`, `qagent.sh`), add
both lines immediately after their `set -uo pipefail`:

```bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_integrity.sh"; integrity_guard "$HERE/.." || exit 76
```

Two placement rules that are not optional:

- **`rerun.sh`:** put the guard *after* the `RERUN_LIB_ONLY` early-return (currently line 70). That
  seam exists so `core/tests/rerun-test.sh` can source the aggregation functions without running the
  CLI body; a guard above it would fire against the source tree during unit tests.
- **`gate.sh` and `summary.sh`:** both write a contract to **stdout** (verifier JSON, the report).
  `integrity_guard` prints only to stderr by design, so this is safe — but keep the guard above the
  first line that writes stdout so a refusal happens before any partial output.

- [ ] **Step 6: Confirm the whole suite is still green**

Run: `for t in core/tests/*.sh; do printf '%-30s ' "$(basename $t)"; bash "$t" 2>&1 | tail -1; done`
Expected: every line reports `0 failed`

- [ ] **Step 7: Commit**

```bash
git add kits/flaky-triage-kit/core/
git commit -m "kit: entrypoints refuse to run against a tree that lost its tier

integrity_guard reports on stderr only, so a JSON contract on stdout stays
clean, and returns 76 on mismatch — a tree that was hardened and no longer
is produces nothing worth trusting."
```

---

## Task 5: Relocate the gate out of the shadowable tree

**Files:**
- Modify: `kits/flaky-triage-kit/install.sh:104` (the `C=` registration path) and the Cursor block
- Modify: `kits/flaky-triage-kit/adapters/claude/flaky-kit-self-protection-gate.sh` (`SURF_RE` line 84, `match_surface` lines 113-122)
- Modify: `kits/flaky-triage-kit/adapters/cursor/flaky-kit-self-protection-gate.sh` (same two constructs)
- Modify: **`kits/flaky-triage-kit/core/shell-guard.py`** (its own `SURF` regex — see below; an earlier
  draft of this plan omitted this file and the omission produced a live Bash-vector bypass)
- Modify: `kits/flaky-triage-kit/core/tests/self-protection-test.sh:50-64` (fixture layout)
- Modify: `kits/flaky-triage-kit/enforcement-codeowners.md:21-23`

**`shell-guard.py` carries its OWN surface pattern, and it is the one that decides.** The gates'
bash-level `SURF_RE`/`MUT_RE` grep is only the *degraded fallback* used when python3 or the script is
unavailable; the normal Bash-branch path shells out to `shell-guard.py`, whose `SURF` regex is
hardcoded separately. Updating the two gates without updating it leaves the primary engine matching
the gate's **old**, now-nonexistent location while the new one is unprotected — and no test notices,
because the fixture assertions exercise the Edit/Write path (bash `match_surface`), not the Bash
path. Replace the dead `hooks/\S*\.sh` alternative rather than adding alongside it, so the two
patterns cannot drift further apart:

```python
    else re.compile(r'\.claude/skills/hektor-flaky-triage/(core/|SKILL\.md)'
                     r'|\.claude/hooks/flaky-kit-self-protection-gate\.sh'
                     r'|\.cursor/hooks/(flaky-kit-self-protection-gate\.sh|lib/)'
                     r'|\.claude/hooks/lib/')
```

and add a Bash-branch assertion to the fixture proving a mutation of
`$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh` is DENIED, mirroring the existing `core/`
Bash cases. Verify directly, not only through the suite:
`printf '%s' "sed -i '' .claude/hooks/flaky-kit-self-protection-gate.sh" | HEKTOR_FK_CWD=/tmp python3 core/shell-guard.py; echo $?`
must print `0` (deny). Before the fix it prints `1`.

**Interfaces:**
- Produces: gate installed at `.claude/hooks/flaky-kit-self-protection-gate.sh`; the settings.json registration points there.
- The gate's own `_LIB` resolution (`$CLAUDE_PROJECT_DIR/.claude/hooks/lib/audit.sh`) is unchanged — it already resolves from the project root, not relatively.
- **`GUARD` resolution changes:** the gate currently finds `shell-guard.py` via `"$(dirname "${BASH_SOURCE[0]}")/../core"`. From `.claude/hooks/` that path no longer reaches the kit. It becomes `$CLAUDE_PROJECT_DIR/.claude/skills/hektor-flaky-triage/core/shell-guard.py`.

- [ ] **Step 1: Write the failing test**

In `core/tests/self-protection-test.sh`, change the fixture so the Claude gate lives at the new path:

```bash
cp "$KITSRC/adapters/claude/flaky-kit-self-protection-gate.sh" "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh"
chmod +x "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh"
```

and add these assertions near the existing surface checks:

```bash
assert_claude_edit_deny "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" "the relocated Claude gate protects itself at its new path"
assert_claude_edit_deny "$SKILL/core/apply.sh"                                  "kit core is still surface after the move"
assert_claude_edit_allow "$PROJ/.claude/hooks/observe.sh"                       "an unrelated pack hook is NOT surface"
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/self-protection-test.sh`
Expected: FAIL — the relocated gate path is not matched by `SURF_RE`/`match_surface`

- [ ] **Step 3: Update both gates' surface patterns**

In **both** gate scripts, replace the `SURF_RE` value with:

```bash
SURF_RE='\.claude/skills/hektor-flaky-triage/core/|\.claude/hooks/flaky-kit-self-protection-gate\.sh|\.cursor/hooks/(flaky-kit-self-protection-gate\.sh|lib/)|\.claude/hooks/lib/|\.claude/skills/hektor-flaky-triage/SKILL\.md'
```

and replace the `match_surface` `case` arms with:

```bash
    */.claude/skills/hektor-flaky-triage/core/*)          SURFACE="kit core (invariant logic + config)"; return 0 ;;
    */.claude/skills/hektor-flaky-triage/SKILL.md)        SURFACE="kit skill prompt"; return 0 ;;
    */.claude/hooks/flaky-kit-self-protection-gate.sh)    SURFACE="kit protection hook (Claude)"; return 0 ;;
    */.cursor/hooks/flaky-kit-self-protection-gate.sh)    SURFACE="kit protection hook (Cursor)"; return 0 ;;
    */.cursor/hooks/lib/*)                                SURFACE="kit protection hook lib (Cursor)"; return 0 ;;
    */.claude/hooks/lib/*)                                SURFACE="kit protection hook lib (Claude)"; return 0 ;;
    *) return 1 ;;
```

Note the removed arm: `*/.claude/skills/hektor-flaky-triage/hooks/*.sh` no longer exists as an install location.

- [ ] **Step 4: Fix the gate's `shell-guard.py` lookup**

In **both** gates, replace the `GUARD=` line with:

```bash
GUARD="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/.claude/skills/hektor-flaky-triage/core/shell-guard.py"
```

- [ ] **Step 5: Update the installer**

In `kits/flaky-triage-kit/install.sh`, change the Claude gate destination and registration:

```bash
  mkdir -p "$PROJ/.claude/hooks"
  cp "$HERE/adapters/claude/flaky-kit-self-protection-gate.sh" "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh"
  chmod +x "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" 2>/dev/null || true
  C='"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh"'
```

and delete the now-unused `mkdir -p "$SKILL_DIR/hooks"` from line 46 plus any `cp` into `$SKILL_DIR/hooks`.

- [ ] **Step 6: Update the CODEOWNERS runbook**

In `enforcement-codeowners.md`, replace the three kit paths with:

```
/.claude/skills/hektor-flaky-triage/core/    @qa-automation
/.claude/skills/hektor-flaky-triage/SKILL.md @qa-automation
/.claude/hooks/flaky-kit-self-protection-gate.sh @qa-automation
/docs/hektor/flaky-triage-kit/               @qa-automation
```

- [ ] **Step 7: Run the tests**

Run: `bash core/tests/self-protection-test.sh`
Expected: PASS, 69 passed 0 failed

- [ ] **Step 8: Prove it end-to-end on a throwaway install**

```bash
T="$(mktemp -d)"; (cd "$T" && git init -q)
./install.sh --project "$T" >/dev/null 2>&1
test -f "$T/.claude/hooks/flaky-kit-self-protection-gate.sh" && echo "gate at new path OK"
test ! -e "$T/.claude/skills/hektor-flaky-triage/hooks" && echo "old location gone OK"
jq -r '[.hooks.PreToolUse[].hooks[].command] | map(select(contains("flaky-kit"))) | .[]' "$T/.claude/settings.json"
rm -rf "$T"
```
Expected: both OK lines, and two registrations both pointing at `.claude/hooks/`

- [ ] **Step 9: Commit**

```bash
git add kits/flaky-triage-kit/
git commit -m "kit: move the self-protection gate out of the shadowable tree

The gate lived inside .claude/skills/hektor-flaky-triage/, so renaming that
directory removed the detector along with what it detects. It now installs to
.claude/hooks/. Surface patterns, the shell-guard lookup, the CODEOWNERS
runbook and the test fixture follow it."
```

---

## Task 6: Out-of-tree shadow detection

**Files:**
- Modify: `kits/flaky-triage-kit/core/lock-kit.sh` (write the expectation on a successful lock)
- Modify: `kits/flaky-triage-kit/adapters/claude/flaky-kit-self-protection-gate.sh` (read it, warn on regression)
- Modify: **`kits/flaky-triage-kit/adapters/cursor/flaky-kit-self-protection-gate.sh`** (the same check — an
  earlier draft of this plan listed only the Claude adapter, which left Cursor-driven sessions with no
  detection at all)
- Modify: `kits/flaky-triage-kit/core/tests/self-protection-test.sh` (assert the warning, **on both gates**)

**Both harnesses must carry the check.** `install.sh` installs a Cursor gate at
`.cursor/hooks/flaky-kit-self-protection-gate.sh`, and `lock` writes the expectation under
`.claude/hooks/` whenever that directory exists — which, in a dual-harness install, it does. Wiring
the check into the Claude gate alone means a Cursor session never reads the record and never warns,
so the one thing this task exists to provide — *something outside the kit notices* — is absent for
exactly the users who chose the other harness. The Cursor gate resolves the project root from its own
payload/`git rev-parse` rather than `CLAUDE_PROJECT_DIR`; use whatever that file already uses, and
keep the expectation path itself (`.claude/hooks/.flaky-kit-expect`) identical in both, since `lock`
writes exactly one record regardless of which harness reads it.

**Interfaces:**
- Consumes: `integrity_owner_uid` / `integrity_tier` from Task 2.
- Produces: `.claude/hooks/.flaky-kit-expect` — one line, the tier `lock` last achieved.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/self-protection-test.sh` before the final `echo`:

```bash
# --- shadow detection: the expectation lives OUTSIDE the kit tree ---
printf 'hardened\n' > "$PROJ/.claude/hooks/.flaky-kit-expect"
rm -rf "$SKILL"                                   # simulate the kit dir being renamed away
OUT="$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo hi"}}' "$PROJ" \
       | "$PROJ/.claude/hooks/flaky-kit-self-protection-gate.sh" 2>&1)"
case "$OUT" in *SHADOW*|*"no longer present"*) ok ;; *) bad "gate must notice the kit tree vanished while the expectation says hardened" ;; esac
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/self-protection-test.sh`
Expected: FAIL — the gate says nothing about the missing tree

- [ ] **Step 3: Write the expectation on a successful lock**

In `core/lock-kit.sh`, inside the `lock)` branch after `write_state`, add:

```bash
    # Mirror the tier OUTSIDE the kit tree so a rename of the kit dir can be spotted. Best effort:
    # a project without a .claude/hooks/ (Cursor-only, or the engine used standalone) is not an error.
    EXPECT_DIR="$(git -C "$KIT" rev-parse --show-toplevel 2>/dev/null)/.claude/hooks"
    [ -d "$EXPECT_DIR" ] && printf '%s\n' "$(integrity_state "$KIT")" > "$EXPECT_DIR/.flaky-kit-expect" 2>/dev/null || true
```

- [ ] **Step 4: Read it in the Claude gate**

In `adapters/claude/flaky-kit-self-protection-gate.sh`, immediately after `CWD=` is assigned:

```bash
# Shadow check: the kit tree can be renamed aside and replaced without touching a single root-owned
# file, because rename() is governed by the parent directory. We cannot PREVENT that from here — but
# we hold the expectation OUTSIDE the kit tree, so we can say so out loud.
_ROOT="${CLAUDE_PROJECT_DIR:-$CWD}"
_EXPECT="$_ROOT/.claude/hooks/.flaky-kit-expect"
if [ -r "$_EXPECT" ] && [ "$(cat "$_EXPECT" 2>/dev/null)" = "hardened" ] \
   && [ ! -d "$_ROOT/.claude/skills/hektor-flaky-triage/core" ]; then
  echo "flaky-kit gate: SHADOW WARNING — this project recorded a hardened flaky-triage kit, but the kit tree is no longer present at its expected path. It may have been renamed aside and replaced. Verify before trusting anything the kit reports." >&2
fi
```

- [ ] **Step 5: Run the test**

Run: `bash core/tests/self-protection-test.sh`
Expected: PASS, 70 passed 0 failed

- [ ] **Step 6: Commit**

```bash
git add kits/flaky-triage-kit/
git commit -m "kit: out-of-tree shadow detection

An in-tree check cannot tell a shadowed tree from a fresh install — the
expectation goes with the tree. lock now mirrors the tier into
.claude/hooks/.flaky-kit-expect and the gate warns when a project that
recorded a hardened kit no longer has one. Detection, not prevention."
```

---

## Task 7: Installer awareness

**Files:**
- Modify: `kits/flaky-triage-kit/install.sh` (before the `cp -R "$HERE/core/."`, and the closing summary)

**Interfaces:**
- Consumes: `lock-kit.sh status`'s `tier:` line from Task 3.

- [ ] **Step 1: Write the failing test**

Create `core/tests/install-guard-test.sh`:

```bash
#!/bin/bash
# core/tests/install-guard-test.sh — install.sh must refuse to cp over a hardened kit instead of
# emitting a wall of EACCES, and must tell the user how to harden a fresh install.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KITSRC="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

P="$TMP/proj"; mkdir -p "$P"; git -C "$P" init -q
OUT="$("$KITSRC/install.sh" --harness claude --project "$P" 2>&1)"
# Anchored to the NEW hint's own wording. An earlier draft matched only "lock-kit.sh lock", which a
# pre-existing closing line already contained — so the assertion passed against an installer with no
# hint at all. Proven by mutation: with the guard and hint stripped, that version still reported 2/3.
case "$OUT" in *"WITHOUT that step nothing is protected"*) ok ;; *) bad "a fresh install must say plainly that nothing is protected yet, not just print a command" ;; esac

# now pretend it is hardened and re-run: the installer must stop, not spew cp errors
printf '{"tier":"hardened","at":"x"}\n' > "$P/.claude/skills/hektor-flaky-triage/core/.lock-state"
OUT="$("$KITSRC/install.sh" --harness claude --project "$P" 2>&1)"; RC=$?
# Anchored to the refusal's own wording for the same reason — the old boilerplate also contains
# "unlock", so matching that alone could not distinguish "guard refused" from "guard absent and the
# usual closing text printed".
case "$OUT" in *"refusing to overwrite"*) ok ;; *) bad "re-installing over a hardened kit must print the refusal, not just any text containing 'unlock'" ;; esac
[ "$RC" -ne 0 ] && ok || bad "re-installing over a hardened kit must exit non-zero"

echo "install-guard-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash core/tests/install-guard-test.sh`
Expected: FAIL — the fresh install prints no hardening hint

- [ ] **Step 3: Implement the guard**

In `kits/flaky-triage-kit/install.sh`, immediately before `cp -R "$HERE/core/." "$SKILL_DIR/core/"`:

```bash
# Refuse to overwrite a hardened install. cp -R would hit EACCES on every root-owned file and bury
# the real message under a wall of errors — and that EACCES is the protection working, not a bug.
if [ -f "$SKILL_DIR/core/.lock-state" ] \
   && grep -q '"tier"[[:space:]]*:[[:space:]]*"hardened"' "$SKILL_DIR/core/.lock-state" 2>/dev/null; then
  echo "install: this project already has a HARDENED flaky-triage kit at $SKILL_DIR." >&2
  echo "install: refusing to overwrite it. To upgrade, unlock first:" >&2
  echo "install:   HEKTOR_FLAKYKIT_UNLOCK=1 $SKILL_DIR/core/lock-kit.sh unlock" >&2
  echo "install: then re-run this installer, and re-lock afterwards with 'core/lock-kit.sh lock'." >&2
  exit 75
fi
```

And in the closing message, after the existing "After install: edit …config.json" line:

```bash
echo "install: then HARDEN the kit so its safety surface cannot be edited from agent context:" >&2
echo "install:   $SKILL_DIR/core/lock-kit.sh lock          # asks for your password (chowns core/ to root)" >&2
echo "install: WITHOUT that step nothing is protected — a fresh install has no lock state and its files stay plainly writable by you, and therefore by any agent running as you. It is not read-only; 'degraded' (read-only but reversible with one chmod) is what you get on a machine where lock ran but sudo was unavailable." >&2
```

- [ ] **Step 4: Run the test**

Run: `bash core/tests/install-guard-test.sh`
Expected: PASS, 3 passed 0 failed

- [ ] **Step 5: Commit**

```bash
chmod +x core/tests/install-guard-test.sh
git add kits/flaky-triage-kit/install.sh kits/flaky-triage-kit/core/tests/install-guard-test.sh
git commit -m "kit: installer refuses to overwrite a hardened kit, prompts to harden a fresh one"
```

---

## Task 8: Correct the documentation that made the false claim

The spec exists because `lock-kit.sh` claimed a wall it did not have. Leaving that text in place would reproduce the problem.

**Files:**
- Modify: `kits/flaky-triage-kit/core/lock-kit.sh` — the header **and** the unlock-refusal message
- Modify: **`kits/flaky-triage-kit/adapters/cursor/flaky-kit-self-protection-gate.sh`** — it still calls
  `HEKTOR_FLAKYKIT_UNLOCK` "the human-consent flag", which is the exact phrase this whole plan retracts
- Modify: `kits/flaky-triage-kit/core/README.md` (module table + status)
- Modify: `kits/flaky-triage-kit/kernel.md` (P4 row, §12 register)
- Create: `docs/superpowers/plans/2026-07-29-flaky-kit-lock-manual-acceptance.md`

**Two live overclaims that a header-only edit misses.** Both were found by reading claims that were
not in any diff, which is this task's characteristic failure mode:

1. **The retraction must reach both harnesses.** `adapters/cursor/…:133` describes the env var as
   "the same human-consent flag as the Claude gate + lock-kit.sh". Correcting only the Claude side
   leaves the retracted claim shipping to Cursor users — the same one-harness asymmetry Task 6 had to
   fix for shadow detection.
2. **`lock-kit.sh` claims its own unlock is audited, and it is not.** The header and the refusal
   message at the `exit 77` both say the marker is "recorded in the audit log", but `hektor_audit`
   is called **zero** times in that file. The audit happens only when the *gate* intercepts an
   agent's Bash call; a human running `unlock` in a terminal is never recorded. State the condition
   or drop the claim — an unconditional sentence about auditing, inside the file being corrected for
   unconditional sentences, is the original mistake in miniature.

- [ ] **Step 1: Rewrite the `lock-kit.sh` header**

Replace the "WHY" block's consent claim. The two sentences that must go: `It is keyed to human consent: unlock requires HEKTOR_FLAKYKIT_UNLOCK=1` and the "out of scope" framing at lines 18-22. Replacement:

```
# TIERS. `lock` establishes the strongest tier it can:
#   hardened — core/** is owned by ROOT. chmod requires OWNERSHIP, so the agent (running as you)
#              cannot reverse it; reopening needs sudo, which needs a password only a human at the
#              keyboard can supply. THIS is human consent. HEKTOR_FLAKYKIT_UNLOCK is not consent —
#              it is an intent marker recorded in the audit log.
#   degraded — chmod a-w only, because sudo was unavailable or the escalation was refused. Honest
#              name: the surface IS read-only, but the same user — and therefore an agent running
#              as them — can chmod it back. Friction, not a wall.
#   unprotected — `lock` never ran here. Nothing is read-only; the surface is plainly writable. Do
#              NOT describe this state as "degraded": collapsing the two told fresh installs they
#              were protected when they were not — this file's own kind of mistake, pointed the
#              other way.
#
# The earlier version of this header called the chmod tier "a REAL wall" and its env-var unlock
# "keyed to human consent", and declared a shell-capable agent running as the file owner "out of
# scope". That agent is precisely what this kit constrains, and it defeated the lock with one
# documented command. Both claims are corrected rather than deleted, so the mistake stays legible.
#
# STILL NOT COVERED — the full list, because a partial one is how the last overclaim happened:
#   1. Shadowing. `mv` the kit dir aside and replace it. rename() is governed by the PARENT
#      directory, and $KIT's parent must stay user-writable so other skills can install there.
#      DETECTED via the gate's out-of-tree record, not prevented.
#   2. That record is itself deletable. Its directory stays user-owned (the pack installer writes
#      its own hooks there without sudo), so the same actor who renames the kit can erase the
#      expectation in the same breath. Chowning that directory WOULD close this; the decision not
#      to rests on the standing cost of routing every future pack-hook update through sudo, NOT on
#      any claim that it would not help. It would.
#   3. Social engineering a human into running the unlock.
#   4. Anything after the password is typed — keep the maintenance window short.
#   5. shell-guard.py honours HEKTOR_FK_SURFACE, which REPLACES its surface pattern wholesale; a
#      value matching nothing narrows the surface to nothing. Pre-existing, not introduced here.
```

- [ ] **Step 2: Add the new modules to `core/README.md`**

Add to the module table, after the `ledger` row:

```
| `_integrity` *(sourced)* | kit root → `hardened`/`unlocked`/`degraded`/`unprotected`/`mismatch`/`stale` | **P4** the lock tier is asserted at every entrypoint, not assumed; refuses (76) when protection is weaker than recorded |
| `lock-kit` | `lock`/`unlock`/`status` → OS-level tier on the safety surface | **P4** hardened = root-owned safety surface **including the kit root** (reopen needs a password); degrades to chmod-only and names the tier it actually reached |
```

- [ ] **Step 3: Update the kernel P4 row**

In `kernel.md`, replace the P4 Status cell text with:

```
**DONE++ (2026-07-29)** — the gate is friction + audit; the WALL is `core/lock-kit.sh lock` at the **hardened** tier: `core/**` owned by root, so `chmod` fails with EPERM for the agent and reopening needs a password. `HEKTOR_FLAKYKIT_UNLOCK` demoted from "consent" to an audit intent-marker (the prior claim was false and was demonstrated false in-session). `core/_integrity.sh` asserts the tier at every entrypoint and refuses on `mismatch`. Residual, explicitly not closed: **shadowing** (rename the kit dir — governed by the user-owned parent) is DETECTED via `.claude/hooks/.flaky-kit-expect`, not prevented; social engineering the human into running the unlock is out of scope.
```

- [ ] **Step 4: Write the manual acceptance checklist**

Create `docs/superpowers/plans/2026-07-29-flaky-kit-lock-manual-acceptance.md`:

```markdown
# Flaky-Kit Hardened Tier — Manual Acceptance

The privileged path cannot be automated: `chown root` needs a password and a test suite cannot type
one. Run this once on a machine with sudo, from the installed kit directory.

| # | Command | Expected |
|---|---|---|
| 1 | `core/lock-kit.sh lock` | prompts for a password; prints `HARDENED` |
| 2 | `core/lock-kit.sh status` | last line `tier: hardened` |
| 3 | `stat -f %Su core/apply.sh` | `root` |
| 4 | `printf x >> core/apply.sh` | `Permission denied` |
| 5 | `chmod u+w core/apply.sh` | `Operation not permitted` — **this is the asymmetry; it failed before this work** |
| 6 | `bash core/tests/gate-test.sh` | 26 passed — a hardened kit still runs normally |
| 7 | `HEKTOR_FLAKYKIT_UNLOCK=1 core/lock-kit.sh unlock` | prompts for a password; prints `UNLOCKED` |
| 8 | `core/summary.sh < /dev/null` | stderr carries the `UNLOCKED (maintenance window open)` reminder |
| 9 | `core/lock-kit.sh lock` then `sudo chown -R $(id -un) core` | simulates losing the tier |
| 10 | `core/summary.sh < /dev/null` | refuses with `MISMATCH`, exit 76 |
| 11 | `core/lock-kit.sh lock` | back to `hardened`; state and `.flaky-kit-expect` agree |
| 12 | `grep -c . docs/hektor/.hook-audit.log` | the unlock in step 7 is recorded, with secrets redacted |
```

- [ ] **Step 5: Run the full suite one final time**

Run: `for t in core/tests/*.sh; do printf '%-30s ' "$(basename $t)"; bash "$t" 2>&1 | tail -1; done`
Expected: 11 suites, every one `0 failed`

- [ ] **Step 6: Commit**

```bash
git add kits/flaky-triage-kit/ docs/superpowers/plans/2026-07-29-flaky-kit-lock-manual-acceptance.md
git commit -m "kit: correct the lock's own documentation + manual acceptance checklist

The spec exists because this header claimed a wall it did not have. The
claim is corrected rather than deleted so the mistake stays legible, and
the three things still not covered are named so they are not re-claimed."
```

---

## Self-Review

**Spec coverage:** §1 asymmetry → Task 3. §2 not-buys → Task 8 header + kernel row. §3 components → Tasks 2/3/5/7 (config overrides Task 1). §4 four states → Tasks 2/4. §5 flows incl. no-`sudo -E` → Task 3. §6 edge cases → Task 3 (degrade, `$ME` refusal), Task 2 (`stat` portability, missing state), Task 7 (upgrade). §7 testing → Tasks 2/3/7 + Task 8 checklist. §8 migration → Task 7's hint, no forced migration. §9 out of scope → Task 8. No gaps.

**Type/name consistency:** `integrity_owner_uid` / `integrity_state` / `integrity_tier` / `integrity_guard` are defined in Task 2 (first three) and Task 4 (`integrity_guard`) and used under those exact names in Tasks 3, 4, 6. `.lock-state` key is `tier` throughout. Exit code 76 = mismatch is used consistently in Task 4's test, implementation, and Task 8's checklist. `HEKTOR_FK_NO_SUDO` (Task 3) and `INTEGRITY_FAKE_UID` (Task 4) are the only test-only seams, both documented where defined.

**Ordering:** Task 1 is independent. Task 3 needs 2. Task 4 needs 2 and 3. Task 6 needs 5. Task 7 needs 3. Task 8 is last.
