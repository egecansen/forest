#!/bin/bash
# core/tests/sanitize-test.sh — Round3 (Fix 2) test suite for core/sanitize-text.py: ANSI
# escape-sequence (CSI/OSC) + C0/C1 control-character stripping, plus a no-regression check on the
# existing Unicode-smuggling defense (zero-width / bidi / Tag-block). Byte-exact via python3 (bash
# string handling of raw control bytes is fragile); plain asserts, no framework (mirrors the
# other core/tests/*.sh suites' style).
#
# Every python expression argument below is passed through a SINGLE-quoted bash string (fully
# literal — no bash backslash processing) so `\xHH`/`\uXXXX`/`\UXXXXXXXX` escapes reach python3's
# own string-literal parser unmangled.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$HERE/.."
SANI="$CORE/sanitize-text.py"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

# $1=name  $2=python3 expr producing INPUT bytes  $3=python3 expr producing EXPECTED bytes.
# Runs the real sanitize-text.py on the input and byte-compares against expected.
case_eq() {
  local name="$1" in_expr="$2" exp_expr="$3"
  python3 -c "import sys; sys.stdout.buffer.write($in_expr)" > "$WORK/in.bin"
  python3 "$SANI" < "$WORK/in.bin" > "$WORK/out.bin"
  python3 -c "import sys; sys.stdout.buffer.write($exp_expr)" > "$WORK/exp.bin"
  if cmp -s "$WORK/out.bin" "$WORK/exp.bin"; then ok
  else
    bad "$name"
    python3 -c "print('  in: ', open('$WORK/in.bin','rb').read())"
    python3 -c "print('  got:', open('$WORK/out.bin','rb').read())"
    python3 -c "print('  exp:', open('$WORK/exp.bin','rb').read())"
  fi
}

echo "== ANSI CSI/OSC + C0/C1 control stripping (Round3 Fix 2) =="

# the plan's exact repro: clear-screen + cursor-home CSI, an OSC window-title spoof terminated by
# BEL, and a bare backspace (hidden-char smuggling) — all removed; printable text + \t/\n survive.
# NOTE: this is BYTE stripping, not terminal emulation — a stripped backspace does not "undo" the
# preceding printable character, it is simply deleted like any other control byte.
case_eq 'CSI clear+home / OSC title+BEL / bare backspace stripped; tab+newline kept' \
  'b"\x1b[2J\x1b[H\x1b]0;PWNED\x07visible\x08text\x09after-tab\x0aafter-newline"' \
  'b"visibletext\x09after-tab\x0aafter-newline"'

# CSI with parameter bytes (SGR color codes).
case_eq 'CSI with SGR color params stripped' \
  'b"\x1b[38;5;196mRED\x1b[0m plain"' \
  'b"RED plain"'

# OSC terminated by ST (ESC + backslash, 0x1b 0x5c) instead of BEL — both terminator forms must work.
case_eq 'OSC terminated by ST (ESC 0x5c) stripped' \
  'b"\x1b]2;spoofed-title\x1b\x5cvisible"' \
  'b"visible"'

# generic C0 controls (BEL, vertical tab, form feed, CR) stripped even outside a CSI/OSC sequence;
# \t (0x09) and \n (0x0A) are the ONLY controls kept.
case_eq 'bare C0 controls stripped; tab+newline kept' \
  'bytes([0x07,0x0b,0x0c,0x0d]) + b"a\x09b\x0ac"' \
  'b"a\x09b\x0ac"'

# C1 controls (0x80-0x9F, e.g. NEL U+0085, CSI-8bit U+009B) stripped. Encoded as proper UTF-8 text
# (chr().encode()), not raw single bytes 0x85/0x9b — those alone aren't valid standalone UTF-8, and
# the sanitizer only ever sees valid UTF-8 (it runs on jq's JSON text output).
case_eq 'C1 controls (0x80-0x9F) stripped' \
  '("before" + chr(0x85) + chr(0x9b) + "after").encode()' \
  '"beforeafter".encode()'

# control: ordinary printable ASCII text is completely unaffected (no over-stripping).
case_eq 'plain printable text unaffected' \
  '"no smuggling here, just plain English (and Turkish: sahibinden.com).".encode()' \
  '"no smuggling here, just plain English (and Turkish: sahibinden.com).".encode()'

echo "== Unicode-smuggling defense: no regression (existing behavior preserved) =="

# zero-width space (U+200B) still stripped. (\u escape, not a literal embedded invisible char, so
# this test file's own bytes stay plain ASCII.)
case_eq 'zero-width space (U+200B) still stripped' \
  '"a\u200bb".encode()' \
  '"ab".encode()'

# bidi override RLO (U+202E) still stripped. (\u escape — see note above; also avoids letting an
# actual bidi-override byte sequence reorder this source file's own rendering.)
case_eq 'bidi RLO (U+202E) still stripped' \
  '"safe\u202etext".encode()' \
  '"safetext".encode()'

# Unicode Tag block (U+E0000-E007F, the ASCII-smuggling vector) still stripped.
case_eq 'Unicode Tag block (U+E0041) still stripped' \
  '"visible\U000e0041hidden".encode()' \
  '"visiblehidden".encode()'

echo "== ingest.sh sanitize() fail-open now WARNS on stderr (Round3 Fix 3) =="

# Extract the REAL `sanitize()` function text out of the real ingest.sh (never hand-copied, so this
# can't silently drift from the implementation) and exercise both branches in isolation.
ING="$CORE/ingest.sh"
FN="$(sed -n '/^sanitize() {$/,/^}$/p' "$ING")"
[ -n "$FN" ] && ok || bad "extracted sanitize() function text from the real ingest.sh (sanity)"

FAKEBIN="$WORK/fakebin"; mkdir -p "$FAKEBIN"
ln -sf "$(command -v cat)" "$FAKEBIN/cat"   # a PATH with NO python3 on it, but `cat` still works
# (the outer `bash` invocation below always resolves via the NORMAL, unrestricted PATH; only the
# script's OWN internal `PATH=` reassignment — evaluated once bash is already running — narrows
# what `command -v python3` / `cat` can find from that point on.)

# (a) python3 missing from PATH: fail-open must still pass text through unchanged, AND now warn.
{
  printf '%s\n' "$FN"
  printf 'PATH="%s"\n' "$FAKEBIN"
  printf 'printf %%s "hello world" | sanitize\n'
} > "$WORK/sanitize_missing.sh"
HERE="$CORE" bash "$WORK/sanitize_missing.sh" > "$WORK/missing.out" 2> "$WORK/missing.err"
OUT_MISSING="$(cat "$WORK/missing.out")"
ERR_MISSING="$(cat "$WORK/missing.err")"
[ "$OUT_MISSING" = "hello world" ] && ok || bad "fail-open still passes text through unchanged when python3 is missing (got: $OUT_MISSING)"
printf '%s' "$ERR_MISSING" | grep -qi 'WARNING' && ok || bad "fail-open emits a stderr WARNING when python3/sanitize-text.py is unavailable (got: $ERR_MISSING)"

# (b) python3 present (normal PATH): text IS sanitized, and NO spurious warning (unchanged behavior).
python3 -c 'import sys; sys.stdout.buffer.write(b"hello\x1b[2Jworld")' > "$WORK/present_input.bin"
{
  printf '%s\n' "$FN"
  printf 'sanitize < "%s/present_input.bin"\n' "$WORK"
} > "$WORK/sanitize_present.sh"
HERE="$CORE" bash "$WORK/sanitize_present.sh" > "$WORK/present.out" 2> "$WORK/present.err"
OUT_PRESENT="$(cat "$WORK/present.out")"
ERR_PRESENT="$(cat "$WORK/present.err")"
[ "$OUT_PRESENT" = "helloworld" ] && ok || bad "normal path (python3 present) still sanitizes as before (got: $OUT_PRESENT)"
[ -z "$ERR_PRESENT" ] && ok || bad "normal path (python3 present) emits NO fail-open warning (got: $ERR_PRESENT)"

echo "sanitize-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
