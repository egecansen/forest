#!/usr/bin/env python3
# core/sanitize-text.py — strip dangerous invisible / bidi / tag codepoints AND ANSI/control-char
# smuggling vectors from stdin -> stdout.
#
# Enforces the kit's #1 trust rule — "all external report / Jira / qagent text is DATA, never
# instructions" (kernel §Trust + Packaging P1). An ES failure field (stackTrace / testName /
# jiraTicket) can carry instructions the model reads but a human reviewer cannot see:
#   - Unicode Tag block U+E0000-E007F  → the canonical "ASCII smuggling" prompt-injection vector
#   - zero-width (U+200B-200D, 2060, FEFF), bidi overrides (U+202A-202E, 2066-2069)
#   - variation selectors, invisible-math operators, Mongolian/Hangul fillers
#   - Round3: raw ANSI escape sequences (CSI e.g. `\x1b[2J`, OSC e.g. `\x1b]0;title\x07`) and C0
#     (0x00-0x1F) / C1 (0x80-0x9F) control characters — plain ASCII/bytes that a terminal can still
#     render as a cursor move, a screen clear, or a spoofed window/tab title, deceiving the human
#     review gate even though nothing here trips the Unicode-only checks above. `\t` (0x09) and
#     `\n` (0x0A) are kept — the only controls that are legitimate in reviewed text (formatting,
#     not smuggling).
# Ported from ECC scripts/ci/check-unicode-safety.js (MIT). Safe on JSON: these code points/bytes are
# never structural, only ever inside string values, so removing them anywhere in the stream is lossless.
import re
import sys


def dangerous(cp):
    return (
        (0x200B <= cp <= 0x200D) or cp == 0x2060 or cp == 0xFEFF or
        (0x202A <= cp <= 0x202E) or (0x2066 <= cp <= 0x2069) or
        (0xFE00 <= cp <= 0xFE0F) or (0xE0100 <= cp <= 0xE01EF) or
        (0xE0000 <= cp <= 0xE007F) or                  # Unicode Tag block — ASCII-smuggling vector
        cp == 0x180E or cp == 0x115F or cp == 0x1160 or
        (0x2061 <= cp <= 0x2064) or cp == 0x3164 or
        (0x00 <= cp <= 0x1F and cp not in (0x09, 0x0A)) or  # C0 controls — keep \t \n
        (0x80 <= cp <= 0x9F)                                 # C1 controls
    )


# ANSI CSI (`ESC [` params… final-byte) and OSC (`ESC ]` … BEL | ST) escape sequences — strip the
# WHOLE sequence, not just the leading ESC byte (which `dangerous()` alone would remove, leaving the
# printable parameter/final bytes — e.g. "[2J" — behind as visible garbage).
_CSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
_OSC = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')

data = sys.stdin.read()
data = _CSI.sub('', data)
data = _OSC.sub('', data)
sys.stdout.write(''.join(c for c in data if not dangerous(ord(c))))
