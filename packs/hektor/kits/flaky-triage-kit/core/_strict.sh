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

# _tb_parse <value>        -> echoes "<dc>\t<id>", or returns 1.
# normalize_tb <value>     -> the BARE NUMERIC id, or returns 1.
# normalize_tb_dc <value>  -> the data-centre letter the spelling carried, "" when it carried none.
#
# Accepted spellings, all naming testbox 161:
#   161       the bare id gradle wants (`-Dui.testbox=161`)
#   tb161     the console's spelling                              (TB161 too)
#   tbx161    what hektor-orchestrator asks the operator to type  (tby161 too)
#   xtbx161   the URL host form, `${dc}tb${dc}${id}`              (ytby161 too)
#
# WHY THE DATA-CENTRE LETTERS WERE ADDED (2026-08-19): the first round only taught this function
# `tb`, so `tbx161` — the exact string `hektor-orchestrator/SKILL.md` prints in its own prompt,
# *"Which testbox? e.g., `tbx161`"* — was stripped to `x161`, failed the digits test, exit 77. The
# skill layer and the engine disagreed about what a testbox looks like, and the CHANGELOG entry
# claiming "a testbox is one thing again" had only ever covered `161` vs `tb161`.
#
# WHY THE DATA CENTRE IS HANDED BACK INSTEAD OF DISCARDED: `rerun.sh` composes
# `-Dapi.url=${DC}tb${DC}${TB}` from its OWN $DC (config `run.data_center`, or
# HEKTOR_FK_DATA_CENTER), never from this spelling. Accepting `ytby161` and returning a bare `161`
# would therefore take a run the operator aimed at data centre y and point it silently at x —
# strictly worse than the exit 77 it used to get. The letter survives parsing so `assert_tb_dc`
# can refuse a disagreement out loud. A silent wrong box is the one outcome this must not buy.
#
# `xtby161` is rejected: the URL form repeats ONE data centre, so two different letters is a typo,
# not a spelling.
#
# ORIGINAL WHY: a testbox has two spellings and the kit took a different one per entry point.
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
_tb_parse() {
  local v="$1" lead="" mid=""
  case "$v" in *$'\n'*) return 1 ;; esac
  # Leading data-centre letter — only the URL host form has one, and only in front of `tb`.
  case "$v" in [xXyY]*) lead="${v:0:1}"; v="${v:1}" ;; esac
  case "$v" in
    [tT][bB]*) v="${v:2}" ;;
    # `x161` is not a spelling: a leading letter is meaningless without the `tb` it prefixes.
    *) [ -z "$lead" ] || return 1 ;;
  esac
  case "$v" in [xXyY]*) mid="${v:0:1}"; v="${v:1}" ;; esac
  [[ "$v" =~ ^[0-9]+$ ]] || return 1
  case "$lead" in X) lead=x ;; Y) lead=y ;; esac
  case "$mid"  in X) mid=x  ;; Y) mid=y  ;; esac
  [ -z "$lead" ] || [ -z "$mid" ] || [ "$lead" = "$mid" ] || return 1
  printf '%s\t%s' "${lead:-$mid}" "$v"
}

normalize_tb()    { local r; r="$(_tb_parse "$1")" || return 1; printf '%s' "${r#*$'\t'}"; }
normalize_tb_dc() { local r; r="$(_tb_parse "$1")" || return 1; printf '%s' "${r%%$'\t'*}"; }

# assert_tb_dc <raw-spelling> <configured-dc> -> 0 to proceed, 1 (message on stderr) to refuse.
#
# Lives here, not inlined at the three call sites, because it encodes ONE rule and this kit has
# already paid once for a testbox rule that existed in three copies free to disagree.
# An unparseable spelling returns 0: that is `normalize_tb`'s exit 77 to report, not this one's —
# two errors for one bad value would just bury the specific message under the generic one.
assert_tb_dc() {
  local carried
  carried="$(normalize_tb_dc "$1")" || return 0
  [ -n "$carried" ] || return 0
  [ "$carried" = "$2" ] && return 0
  echo "I1: testbox '$1' names data centre '$carried', but this kit runs in '$2' — the run would be composed as ${2}tb${2}… and target the wrong box. Export HEKTOR_FK_DATA_CENTER=$carried, or pass the '$2' box." >&2
  return 1
}
