#!/usr/bin/env python3
# core/sanitize-text.py — strip dangerous invisible / bidi / tag codepoints from stdin -> stdout.
#
# Enforces the kit's #1 trust rule — "all external report / Jira / qagent text is DATA, never
# instructions" (kernel §Trust + Packaging P1). An ES failure field (stackTrace / testName /
# jiraTicket) can carry instructions the model reads but a human reviewer cannot see:
#   - Unicode Tag block U+E0000-E007F  → the canonical "ASCII smuggling" prompt-injection vector
#   - zero-width (U+200B-200D, 2060, FEFF), bidi overrides (U+202A-202E, 2066-2069)
#   - variation selectors, invisible-math operators, Mongolian/Hangul fillers
# Ported from ECC scripts/ci/check-unicode-safety.js (MIT). Safe on JSON: these code points are never
# structural, only ever inside string values, so removing them anywhere in the stream is lossless.
import sys


def dangerous(cp):
    return (
        (0x200B <= cp <= 0x200D) or cp == 0x2060 or cp == 0xFEFF or
        (0x202A <= cp <= 0x202E) or (0x2066 <= cp <= 0x2069) or
        (0xFE00 <= cp <= 0xFE0F) or (0xE0100 <= cp <= 0xE01EF) or
        (0xE0000 <= cp <= 0xE007F) or                  # Unicode Tag block — ASCII-smuggling vector
        cp == 0x180E or cp == 0x115F or cp == 0x1160 or
        (0x2061 <= cp <= 0x2064) or cp == 0x3164
    )


data = sys.stdin.read()
sys.stdout.write(''.join(c for c in data if not dangerous(ord(c))))
