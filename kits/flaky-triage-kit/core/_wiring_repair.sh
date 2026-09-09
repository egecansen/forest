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
  [ -n "$_WR_LOCKDIR" ] && { rm -rf "$_WR_LOCKDIR" 2>/dev/null || true; _WR_LOCKDIR=""; }
  eval "exec ${_WR_LOCKFD}>&-" 2>/dev/null || true
  return 0
}

# _wr_lock <file> -> 0 if held, 1 if not. Mirrors core/ledger.sh's discipline (flock where present,
# portable mkdir spinlock otherwise) with two deliberate differences from ledger.sh:
#
# 1. ledger.sh DIES on timeout; this RETURNS. A lost lock means one entrypoint skips a repair the
#    next one will retry, and must not take the caller down with it.
#
# 2. ledger.sh releases via `trap 'ledger_unlock' EXIT INT TERM` — and this file MUST NOT do that.
#    _wiring_repair.sh is sourced by thirteen entrypoints through _integrity.sh; an EXIT trap
#    installed here would clobber whatever EXIT trap the sourcing entrypoint already set for its
#    OWN cleanup, the moment this file is sourced — not even at lock time. So a killed holder (a
#    Ctrl-C mid-`_wr_register`) cannot be recovered by trap. It is recovered the same way
#    core/_lock.sh's gradle_lock_acquire steals a dead gradle lock instead: the holder writes its
#    own pid into the lock directory right after acquiring it, and a contender steals the lock the
#    moment that pid is provably dead, or — a directory left by a holder that crashed BETWEEN mkdir
#    and writing its pid — once it has sat long enough that no live acquire is still in flight.
#    Proven necessary by measurement, not assumed: a pre-existing `.lock.d` with no recovery logic
#    cost every subsequent call the full timeout (~15s, see below) forever, on an otherwise healthy
#    fixture — the exact "must never wedge a caller" violation this file exists to prevent.
#
# The two thresholds below are counted in ITERATIONS, and an iteration costs more than its `sleep`:
# a `cat`, a `kill -0`, a `[ -e ]` and the loop's own `mkdir` attempt all land on top of the 0.05s.
# The wall-clock figures quoted are measured on macOS bash 3.2, not derived from the sleep alone —
# an earlier version of these comments quoted the arithmetic (2s and 10s) and was out by ~1.6x.
_wr_lock() {
  local target="${1:-}" waited=0 p
  [ -n "$target" ] || return 1
  if command -v flock >/dev/null 2>&1; then
    eval "exec ${_WR_LOCKFD}>\"\$target.lock\"" 2>/dev/null || return 1
    flock -w 10 "$_WR_LOCKFD" 2>/dev/null || return 1
    return 0
  fi
  until mkdir "$target.lock.d" 2>/dev/null; do
    p="$(cat "$target.lock.d/pid" 2>/dev/null || true)"          # steal if the holder is dead…
    if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then
      rm -rf "$target.lock.d" 2>/dev/null; continue
    fi
    if [ ! -e "$target.lock.d/pid" ] && [ "$waited" -ge 40 ]; then  # …or pidless + stale (~3.2s)
      rm -rf "$target.lock.d" 2>/dev/null; continue
    fi
    waited=$((waited + 1))
    [ "$waited" -ge 200 ] && return 1      # ~15.5s cap (200 iterations, not 200 * 0.05s)
    sleep 0.05
  done
  echo "$$" > "$target.lock.d/pid" 2>/dev/null || true
  _WR_LOCKDIR="$target.lock.d"
  return 0
}

# _wr_register_cursor <hooks-file> <command> -> 0 when the merge landed AND changed the document,
# 2 when it landed and changed nothing (already registered), 1 when it did not land. Cursor's
# spelling of the same three slots; the SAME three-outcome contract as `_wr_register` above and
# `_wr_register_stop` below, for the same reason — see `_wr_register`'s header.
#
# The `|| rc=1` on the `mv` is not decoration either: without it a failed rename returned 0 through
# the fall-through at the bottom, so a merge that never reached disk was announced as one that did —
# `_wr_register` has always guarded that and this function had not.
_wr_register_cursor() {
  local s="$1" c="$2" t rc=0
  t="$(mktemp)" || return 1
  if jq --arg c "$c" '
    .hooks //= {} |
    .hooks.beforeShellExecution //= [] |
    (if any(.hooks.beforeShellExecution[]?; .command==$c) then . else .hooks.beforeShellExecution += [{command:$c, timeout:10}] end) |
    .hooks.preToolUse //= [] |
    (if any(.hooks.preToolUse[]?; .command==$c) then . else .hooks.preToolUse += [{command:$c, timeout:10}] end)
  ' "$s" > "$t" 2>/dev/null && [ -s "$t" ]; then
    jq -e --slurpfile a "$s" '. == $a[0]' "$t" >/dev/null 2>&1 && rc=2
    mv "$t" "$s" || rc=1
  else
    rm -f "$t"
    rc=1
  fi
  return "$rc"
}

# _wr_register_stop <settings-file> <command> -> 0 when the merge landed AND changed the document,
# 2 when it landed and changed nothing (already registered), 1 when it did not land.
#
# Same shape as _wr_register above, adapted for a single Stop-event slot with no matcher concept
# (Stop fires once, on end-of-session, not per-tool) — and the SAME shape install.sh itself writes
# when it first ships the delivery gate, so an install and a repair cannot disagree about it.
#
# THREE outcomes, not two, and the third is the whole point: a merge succeeding is not a repair
# happening. This used to return 0 for an idempotent no-op, so `did_s` was set unconditionally and
# the caller announced "REPAIRED — the Claude delivery gate registration has been rewritten." on a
# fixture whose Stop registration was untouched and correct. Measured at the `unprotected` tier with
# the gate FILE deleted and the registration intact: `dangling` before, that line printed, `dangling`
# after — a repair announced over a state that never converged, on every entrypoint, forever. It is
# the same misattribution class the per-control flag split closed one function over, arriving through
# a different door. This function was the first of the three to be given the test; the residual wave
# gave the same one to `_wr_register` and `_wr_register_cursor`, so all three now answer the same
# question and the flags they feed all mean the same thing.
#
# "Changed" is decided by comparing the merged document to the source AS JSON (`. == $a[0]`), not by
# re-asking "was it registered?" with a second copy of the merge's own predicate. Two spellings of
# one rule is what this file keeps retracting; and a byte comparison would be wrong in the other
# direction — jq reformats, so a hand-indented settings file would read as changed when nothing was
# added. Semantic equality answers the property exactly: this merge only ever APPENDS the Stop entry
# (`.hooks //= {}` and `.hooks.Stop //= []` can only fire when Stop was absent, in which case the
# append fires too), so document-changed and registration-added are the same fact.
_wr_register_stop() {
  local s="$1" c="$2" t rc=0
  t="$(mktemp)" || return 1
  if jq --arg c "$c" '
    .hooks //= {} | .hooks.stop //= [] |
    (if any(.hooks.stop[]?; .command==$c) then .
     else .hooks.stop += [{command:$c, timeout:20, loop_limit:1}] end)' "$s" > "$t" 2>/dev/null && [ -s "$t" ]; then
    jq -e --slurpfile a "$s" '. == $a[0]' "$t" >/dev/null 2>&1 && rc=2
    mv "$t" "$s" || rc=1
  else
    rm -f "$t"; rc=1
  fi
  return "$rc"
}

# _wr_restore_gate <kit_root> <dest-dir> <want_stop> -> 0. Narrates; never fails.
#
# TWO gate files, not one. `install.sh` has always vendored a restore source for the delivery gate
# (`core/gate-src/claude/flaky-kit-delivery-gate.sh`) and `install-guard-test.sh` has always asserted
# it exists — and nothing ever read it. The presence test below returned early whenever the
# SELF-PROTECTION gate was there, which is the case in the only state that matters: the delivery gate
# deleted on its own. Measured at the `unprotected` tier with that file gone and its registration
# intact, `dangling` before the repair and `dangling` after it, on every entrypoint, forever — and at
# `hardened` that same non-converging state is rc 76 from all thirteen entrypoints with a
# password-priced remedy. Each gate now gets its own presence test, its own `-s` source check and its
# own narration line; the audit lib is handled once, after both, because they share one on-disk copy.
#
# `$want_stop` is the 4th argument and the caller's own `ws` — the `stop` capability the install
# recorded. Without it, an install that predates the delivery gate (no source vendored, no
# registration, nothing wrong) would be told on every `dangling` repair that its delivery gate cannot
# be restored: noise about a control it never had. That is the same no-brick rule `_wiring_want`
# encodes, applied to the narration rather than to the verdict. It is a LIVE slot, not a dead one —
# the residual the three-argument signature was cut down to avoid was two arguments nothing read.
#
# It knows NOTHING about tiers, deliberately. It used to carry its own `hardened|stale` arm that
# refused to restore, as defence in depth for a hypothetical direct caller — and there is none: the
# whole file is `_wr`-private and `wiring_repair` below is the only thing that calls it. Once that
# function grew its own guard (every refusing tier writes nothing at all), the arm here became
# unreachable, and its only remaining effect was to make two tests in
# `core/tests/integrity-test.sh` pass on the OUTER guard's message while claiming to test this one.
# Two conditions expressing one rule is the exact "split one property across two conditions" defect
# this kit has already retracted twice. The rule lives in `wiring_repair` alone; the tier is not this
# function's business, so it is no longer this function's parameter.
#
# `$root` went with it: it was never referenced at all. A five-parameter signature with two dead
# slots is an invitation to a mis-ordered call, and the caller already computes `$dest` from `$root`.
_wr_restore_gate() {
  local kit="$1" dest="$2" want_stop="${3:-0}" src did=0
  # SEPARATE statement, not a sixth word on the `local` above. Bash declares every name in a `local`
  # list as unset BEFORE assigning any of them, so `local kit="$1" src="$kit/..."` reads `$kit` while
  # it is still unset and dies under `set -u` — "kit: unbound variable". The previous five-parameter
  # version had exactly that shape and never showed it, because its only caller is `wiring_repair`,
  # whose own `kit` local was visible here through dynamic scoping. The first direct call this file
  # has ever had (added with the signature above) is what surfaced it.
  src="$kit/core/gate-src"
  # --- the self-protection gate ---------------------------------------------------------------
  # The gate is already there. `dangling` is a verdict over the whole project, so a
  # project whose Claude gate is missing and whose Cursor gate is fine reaches this function twice;
  # without this line the healthy one is overwritten and announced as "restored", which is a repair
  # claimed for a control that was never broken — the same misattribution the per-control `did_s`
  # and `did_u` split exists to prevent, one function over. It is an `elif` chain rather than the
  # early `return` it used to be, because the delivery-gate arm below has to be reached whether or
  # not this file was missing — that early return IS the defect I1 names.
  #
  # `-s`, not `-r`. A zero-byte source is readable, and restoring it installs an empty gate that
  # allows everything — while `_wiring_one` below the root-owned tiers tests only `[ -f ]`, so the
  # answer flips from a loud, repairable `dangling` to a silent `wired`. A self-protection gate that
  # passes every check and enforces nothing is worse than a missing one. The merge path already
  # guards this class with `[ -s "$t" ]`.
  if [ -e "$dest/flaky-kit-self-protection-gate.sh" ]; then
    :
  elif [ ! -s "$src/flaky-kit-self-protection-gate.sh" ]; then
    echo "integrity: cannot restore the self-protection gate — no usable restore source at $src." >&2
  elif ! mkdir -p "$dest/lib" 2>/dev/null; then
    echo "integrity: cannot restore the self-protection gate — $dest is not creatable." >&2
  elif ! cp "$src/flaky-kit-self-protection-gate.sh" "$dest/flaky-kit-self-protection-gate.sh" 2>/dev/null; then
    echo "integrity: cannot restore the self-protection gate — writing $dest failed." >&2
  else
    chmod +x "$dest/flaky-kit-self-protection-gate.sh" 2>/dev/null || true
    did=1
    echo "integrity: restored the self-protection gate from the engine's copy." >&2
  fi

  # --- the delivery gate, where the install recorded the capability ------------------------------
  # Its own presence test and its own source check, for the reason the header states: the two files
  # go missing independently, and the state that matters is exactly the one the shared early return
  # could not see. `-s` for the same reason as above, with a sharper edge — a zero-byte delivery gate
  # exits 0 on every Stop, so I11 stops being enforced while `_wiring_one`'s `[ -f ]` reads `wired`.
  #
  # ONE condition, `$want_stop`, and nothing else. The
  # delivery gate is a Claude control, but the caller's Cursor arm passes a literal 0 for exactly that
  # reason, so a second test here would express the same rule twice — the shape
  # this file has already retracted twice, and the shape that leaves one of the two conditions dead
  # and untestable. The decision stays on the capability alone, so a call made with
  # the wrong one says what it did instead of quietly saying "claude".
  if [ "$want_stop" = 1 ]; then
    if [ -e "$dest/flaky-kit-delivery-gate.sh" ]; then
      :
    elif [ ! -s "$src/flaky-kit-delivery-gate.sh" ]; then
      echo "integrity: cannot restore the delivery gate — no usable restore source at $src." >&2
    elif ! mkdir -p "$dest/lib" 2>/dev/null; then
      echo "integrity: cannot restore the delivery gate — $dest is not creatable." >&2
    elif ! cp "$src/flaky-kit-delivery-gate.sh" "$dest/flaky-kit-delivery-gate.sh" 2>/dev/null; then
      echo "integrity: cannot restore the delivery gate — writing $dest failed." >&2
    else
      chmod +x "$dest/flaky-kit-delivery-gate.sh" 2>/dev/null || true
      did=1
      echo "integrity: restored the delivery gate from the engine's copy." >&2
    fi
  fi

  # --- the audit lib: ONCE, and only if something was actually restored --------------------------
  # Both gates resolve `lib/audit.sh` beside themselves, so there is one copy per destination and it
  # is not per-gate work. Running it only on a real restore is what keeps a project whose gates are
  # both present from being told about its audit lib on every entrypoint.
  #
  # The messages say "the restored $harness hook", not "the self-protection gate": when only the DELIVERY
  # gate was restored, naming the self-protection gate here would be the same misattribution I2 fixed
  # one file over. The phrase "still runs, unaudited" is what the assertions match, and it is true of
  # whichever hook was restored.
  #
  # Three outcomes, not two. `[ -s ]` alone collapsed a PRESENT-BUT-ZERO-BYTE audit.sh into the
  # "no source at all" case: it took neither the copy nor the warning, and the clean "restored the
  # gate" line then announced a full restore for a degraded one. Same `-r`-vs-`-s` shape as the
  # gate script above, with the opposite resolution: an empty gate must not be installed AND must be
  # loud, while an empty audit lib must not be installed and must be loud — copying it would be worse
  # than leaving it absent, because the adapter's gate stubs `hektor_audit(){ :; }` only when the lib
  # is MISSING, and a present-but-empty one gets sourced and defines nothing. A genuinely absent
  # source stays silent: that is the stub's designed-for case, not a degradation.
  [ "$did" = 1 ] || return 0
  if [ -e "$src/lib/audit.sh" ] && [ ! -s "$src/lib/audit.sh" ]; then
    echo "integrity: the audit lib beside the restored $harness hook has a zero-byte source — not copied; the gate still runs, unaudited." >&2
  elif [ -s "$src/lib/audit.sh" ] && ! cp "$src/lib/audit.sh" "$dest/lib/audit.sh" 2>/dev/null; then
    echo "integrity: the audit lib beside the restored $harness hook did not copy — the gate still runs, unaudited." >&2
  fi
  return 0
}

# wiring_repair <kit_root> <tier> <wiring> -> narrates to stderr, always returns 0.
wiring_repair() {
  local kit="${1:-}" tier="${2:-}" wiring="${3:-}" root wu ws s rcu rcs did_u=0 did_s=0
  case "$wiring" in
    unregistered|partial|dangling) : ;;
    *) return 0 ;;                      # wired, absent, foreign: nothing to do or nothing that is ours
  esac

  # EVERY TIER THAT REFUSES WRITES NOTHING AT ALL — not the registration, not the gate file. A write
  # here would be read as `wired` by the very next entrypoint (the guard recomputes from disk every
  # call), so the tier would stop refusing while this session's harness still has no gate loaded. One
  # call would refuse and every call after it would proceed unprotected, which is the silent loss this
  # axis exists to catch. The refusal is worth more than the repair: a registration this session
  # cannot use buys nothing while destroying the only signal that anything is wrong.
  #
  # `mismatch` is on this list for the same reason and was missed once, because the rule was first
  # phrased "where the tree is root-owned" — which reaches `hardened` and `stale` but not the one tier
  # whose whole meaning is that the record CLAIMS a root ownership the tree does not have. Measured
  # there, the repair copied the gate script out of a tree the same run declares untrustworthy
  # ("this is not the tree that was hardened … nothing it produces should be trusted") into the path
  # that is the kit's own protection hook, and flipped the axis from `dangling` to `wired`. The run is
  # refused anyway, so the write bought nothing. What it cost is real: `harden_targets`
  # (core/lock-kit.sh) picks up .cursor/hooks/flaky-kit-self-protection-gate.sh only when that file
  # already exists, so a re-lock used to leave the path empty and the kit went on refusing until
  # someone reinstalled — with the file planted, the re-lock chowns it to root and `_wiring_one`'s
  # ownership identity test accepts it. A signal that used to survive the printed remedy no longer
  # does. No attacker gains a capability here (at `mismatch` they already own the tree); there is
  # simply no upside to set against the loss. See §4 of the design spec.
  #
  # The message is deliberately about the TIER refusing, not about root ownership: two of these three
  # trees are root-owned and one is exactly the tree that is not, and one sentence has to be true of
  # all three. It is also textually distinct from `_wr_restore_gate`'s messages, so a test that means
  # to assert one of them cannot be satisfied by the other — which is how the restore's own dead tier
  # arm went unnoticed.
  case "$tier" in
    hardened|stale|mismatch)
      echo "integrity: not repairing — this tier refuses the run, and a repair would silence that refusal on the very next entrypoint (the guard recomputes from disk every call) without arming anything in this session. Repair it by hand: unlock if the tree is root-owned, re-run the kit installer against this project, then core/lock-kit.sh lock." >&2
      return 0 ;;
  esac

  root="$(integrity_project_root "$kit")"
  [ -n "$root" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  set -- $(_wiring_want "$kit" "$root")
  wu="${1:-0}"; ws="${2:-0}"

  if [ "$wu" = 1 ]; then
    [ "$wiring" = dangling ] && _wr_restore_gate "$kit" "$root/.cursor/hooks" "$ws"
    s="$root/.cursor/hooks.json"
    mkdir -p "$(dirname "$s")" 2>/dev/null
    [ -e "$s" ] || echo '{"version":1,"hooks":{}}' > "$s" 2>/dev/null
    if [ -w "$s" ] && jq -e . "$s" >/dev/null 2>&1; then
      if _wr_lock "$s"; then
        # THREE outcomes, and `did_u` is set on exactly one of them — the merge landed AND the
        # document changed — because the line it prints ("the registration has been rewritten") is a
        # claim about a state change, and on an idempotent no-op no state changed.
        _wr_register_cursor "$s" '.cursor/hooks/flaky-kit-self-protection-gate.sh' && rcu=0 || rcu=$?
        case "$rcu" in
          0) did_u=1 ;;
          2) : ;;   # already registered: nothing was repaired, so nothing is announced
          *) echo "integrity: the self-protection gate registration merge failed — $s was not repaired." >&2 ;;
        esac
        # The delivery gate rides the SAME lock already held on this file, but tracks its OWN `did_s`
        # flag rather than reusing `did_u`. They are two independent controls on one file: the two
        # merges touch different keys (`.hooks.preToolUse`/`.hooks.beforeShellExecution` vs
        # `.hooks.stop`), so one can error while the other lands. Sharing a flag would let a
        # succeeding stop merge announce "the gate registration has been rewritten" over a
        # self-protection gate that is still unregistered.
        #
        # Gated on `ws`, the capability the record actually requires — an install that predates the
        # delivery gate (no `stop` token in core/.harness) must not gain a stop registration it never
        # asked for; that is the same no-brick rule `_wiring_want` encodes.
        if [ "$ws" = 1 ]; then
          _wr_register_stop "$s" '.cursor/hooks/flaky-kit-delivery-gate.sh' && rcs=0 || rcs=$?
          case "$rcs" in
            0) did_s=1 ;;
            2) : ;;
            *) echo "integrity: the delivery gate registration merge failed — $s was not repaired." >&2 ;;
          esac
        fi
        _wr_unlock
      else
        echo "integrity: could not lock $s to repair the registration; the next entrypoint will retry." >&2
      fi
    else
      echo "integrity: cannot repair the registration — $s is unwritable or not parseable JSON." >&2
    fi
  fi

  [ "$did_u" = 1 ] && echo "integrity: REPAIRED — the self-protection gate registration has been rewritten." >&2
  [ "$did_s" = 1 ] && echo "integrity: REPAIRED — the delivery gate registration has been rewritten." >&2
  return 0
}
