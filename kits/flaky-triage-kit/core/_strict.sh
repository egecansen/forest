#!/bin/bash
# core/_strict.sh — shared WHOLE-STRING shape matcher for I1 input-validation checks.
#
# WHY (Round3 — grep-newline anchor-asymmetry): `printf '%s' "$v" | grep -qE '^PATTERN$'` is
# LINE-oriented, not string-oriented — `grep -q` exits 0 if ANY line of a multi-line value matches
# the anchored pattern, because grep's `^`/`$` anchor to each line's boundaries, not the start/end
# of the whole stream. A value with an embedded newline (e.g. "ok123\n$(touch /tmp/pwned)") sails
# straight through `grep -qE '^[0-9A-Za-z._:+-]+$'` because line 1 ("ok123") alone satisfies the
# anchors, even though the FULL value plainly does not match the intended shape. Bash's own
# `[[ $v =~ ^PATTERN$ ]]` anchors `^`/`$` to the start/end of the ENTIRE string (no REG_NEWLINE),
# so routing validation through it — instead of through grep — closes this bypass class in one
# place rather than re-fixing it ad hoc at every call site.
#
# strict_match <value> <ere>
#   Returns 0 iff (a) <value> contains NO newline, AND (b) <value> matches <ere> anchored to the
#   WHOLE string (start-to-end). Returns 1 otherwise. The newline pre-check is defense-in-depth on
#   top of (b) — kept explicit/independent so the reject reason stays obvious even if a future ERE
#   were sloppy enough to admit a literal newline itself.
#
# bash 3.2 compatibility note: the ERE is interpolated UNQUOTED into the `[[ =~ ]]` test. Since
# bash 3.2, quoting any part of the regex operand (e.g. `[[ $v =~ "^$ere$" ]]`) forces that quoted
# portion to be matched LITERALLY instead of as a pattern — a well-known portability trap. Keeping
# the pattern in a plain, unquoted variable expansion is what keeps the ERE metacharacters live.
strict_match() {
  local value="$1" ere="$2"
  case "$value" in *$'\n'*) return 1 ;; esac
  [[ "$value" =~ ^$ere$ ]]
}

# normalize_tb <value>
#   Echoes the BARE NUMERIC testbox id, or returns 1. Accepts `161` and `tb161`/`TB161` alike.
#
# WHY: a testbox has two spellings and the kit took a different one per entry point.
# `ingest.sh --testbox` accepts `[0-9A-Za-z._-]+` because ES holds the prefixed form; `rerun.sh`,
# `dom-capture.sh` and `dom-on-failure.sh` demanded `^[0-9]+$` because gradle wants the bare id
# (`-Dui.testbox=<n>`, and `-Dapi.url` composes the `tb` itself — a prefixed value would build
# `tbtb161`). So the testbox a caller had just ingested successfully was rejected with exit 77 by
# the very next call, and every driver had to know which script wanted which spelling. Nothing
# documented that. Callers now hand either spelling to any entry point; the engine normalises once,
# here, and the drivers stop translating.
#
# It also closes the last of the grep-newline holes this file exists for: those three checks were
# still `printf … | grep -qE '^[0-9]+$'`, which passes any value whose FIRST LINE is digits,
# however the rest of it reads. `[[ =~ ]]` after an explicit newline reject anchors the whole string.
normalize_tb() {
  local v="$1"
  case "$v" in *$'\n'*) return 1 ;; esac
  case "$v" in [tT][bB]*) v="${v#[tT][bB]}" ;; esac
  [[ "$v" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$v"
}
