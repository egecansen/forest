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
