#!/usr/bin/env python3
# core/shell-guard.py — quote/subshell-aware "does this Bash command WRITE to the kit safety surface?"
#
# Ported from ECC's scripts/lib/shell-split.js + shell-substitution.js (MIT). A whole-string grep
# misses two things that matter for a self-protection gate:
#   1) false positives — a surface reference and a mutate verb in DIFFERENT segments of a compound
#      command (`cat core/config.json && echo hi > /tmp/x`) trip a naive grep but are not a surface write;
#   2) evasion — a write hidden by quoting (`s\ed -i core/x`, `'rm' core/x`), `$(...)`, backticks,
#      a `(subshell)`, or a `sh -c "..."` wrapper sails past a substring match (cf. GHSA-4v57-ph3x-gf55).
#
# stdin = the command string. exit 0  => some fragment both references the surface AND mutates it
# (the gate then denies);  exit 1 => allow. Patterns are python-flavored and kept in sync with the
# gate's bash-ERE prefilter (SURF_RE / MUT_RE in flaky-kit-self-protection-gate.sh).
import sys, re, os

# Protected surface = the kit's own files. PATH-INDEPENDENT: set HEKTOR_FK_SURFACE to the kit's install
# root and a kit installed ANYWHERE protects itself (the standalone gates do this). Unset → the in-repo
# default below, so the live .claude gates keep their exact behavior with no env set.
_SURF_ROOT = os.environ.get('HEKTOR_FK_SURFACE', '').strip().rstrip('/')
SURF = re.compile(re.escape(_SURF_ROOT)) if _SURF_ROOT \
    else re.compile(r'\.claude/skills/hektor-flaky-triage/(core/|hooks/\S*\.sh|SKILL\.md)')
# target-as-arg mutations: surface anywhere in the fragment is a write (conservative — `cp core/x /tmp`
# reads the surface, but copying kit files out is itself worth surfacing). REDIR is target-position-aware.
VERB  = re.compile(r'\bsed\s+-i\b|\b(?:tee|cp|mv|rm|chmod|chown|truncate|dd|install|ln)\b')
REDIR = re.compile(r'>>?')
# interpreter inline-code (`python3 -c`, `perl -e`, `node -e`, ...) can write a file via open()/print —
# invisible to verb/redirect matching. Flag conservatively when one touches the surface (read OR write).
# This is best-effort friction; the airtight wall for ALL writers (incl. compiled programs) is lock-kit.sh.
INTERP = re.compile(r'\b(?:python[0-9.]*|perl|ruby|node|deno|bun|php|osascript)\b')
INLINE = re.compile(r'(?:^|\s)-(?:c|e)\b')


def split_segments(s):
    """Split on && || ; & respecting quotes/escapes. Redirections (&>, >&, 2>&1) are NOT separators."""
    segs, cur, q = [], [], None
    i, n = 0, len(s)
    while i < n:
        ch = s[i]
        if q:
            if ch == '\\' and i + 1 < n:
                cur.append(ch + s[i + 1]); i += 2; continue
            if ch == q:
                q = None
            cur.append(ch); i += 1; continue
        if ch == '\\' and i + 1 < n:
            cur.append(ch + s[i + 1]); i += 2; continue
        if ch in ('"', "'"):
            q = ch; cur.append(ch); i += 1; continue
        nxt = s[i + 1] if i + 1 < n else ''
        prev = s[i - 1] if i > 0 else ''
        if ch == '&' and nxt == '&':
            segs.append(''.join(cur)); cur = []; i += 2; continue
        if ch == '|' and nxt == '|':
            segs.append(''.join(cur)); cur = []; i += 2; continue
        if ch == ';':
            segs.append(''.join(cur)); cur = []; i += 1; continue
        if ch == '&' and nxt != '&':
            if nxt == '>' or prev == '>':            # redirection, not a separator
                cur.append(ch); i += 1; continue
            segs.append(''.join(cur)); cur = []; i += 1; continue
        cur.append(ch); i += 1
    segs.append(''.join(cur))
    return [x for x in segs if x.strip()]


def _balanced_body(s, i):
    """Read a paren-balanced body starting just after an opening '(' at index i; return (body, end_index)."""
    depth, bS, bD, body, n = 1, False, False, [], len(s)
    while i < n and depth > 0:
        c = s[i]; p = s[i - 1] if i > 0 else ''
        if c == '\\' and not bS and i + 1 < n:
            body.append(s[i:i + 2]); i += 2; continue
        if c == "'" and not bD and p != '\\':
            bS = not bS
        elif c == '"' and not bS and p != '\\':
            bD = not bD
        elif not bS and not bD:
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    break
        body.append(c); i += 1
    return ''.join(body), i


def extract_command_subs(s):
    """Bodies of $(...) and `...`; single-quotes are literal. Recurses into nested substitutions."""
    out, inS, inD, i, n = [], False, False, 0, len(s)
    while i < n:
        ch = s[i]; prev = s[i - 1] if i > 0 else ''
        if ch == '\\' and not inS:
            i += 2; continue
        if ch == "'" and not inD and prev != '\\':
            inS = not inS; i += 1; continue
        if ch == '"' and not inS and prev != '\\':
            inD = not inD; i += 1; continue
        if inS:
            i += 1; continue
        if ch == '`':
            i += 1; body = []
            while i < n and s[i] != '`':
                if s[i] == '\\' and i + 1 < n:
                    body.append(s[i:i + 2]); i += 2; continue
                body.append(s[i]); i += 1
            b = ''.join(body)
            if b.strip():
                out.append(b); out.extend(extract_command_subs(b))
            i += 1; continue
        if ch == '$' and i + 1 < n and s[i + 1] == '(':
            b, i = _balanced_body(s, i + 2)
            if b.strip():
                out.append(b); out.extend(extract_command_subs(b))
            i += 1; continue
        i += 1
    return out


def extract_subshells(s):
    """Bodies of plain (...) subshells (skip $(...) and backtick spans). Recurses."""
    out, inS, inD, i, n = [], False, False, 0, len(s)
    while i < n:
        ch = s[i]; prev = s[i - 1] if i > 0 else ''
        if ch == '\\' and not inS:
            i += 2; continue
        if ch == "'" and not inD and prev != '\\':
            inS = not inS; i += 1; continue
        if ch == '"' and not inS and prev != '\\':
            inD = not inD; i += 1; continue
        if inS or inD:
            i += 1; continue
        if ch == '$' and i + 1 < n and s[i + 1] == '(':       # skip command-sub span
            _b, i = _balanced_body(s, i + 2); i += 1; continue
        if ch == '`':                                          # skip backtick span
            i += 1
            while i < n and s[i] != '`':
                i += 2 if s[i] == '\\' else 1
            i += 1; continue
        if ch == '(':
            b, i = _balanced_body(s, i + 1)
            if b.strip():
                out.append(b); out.extend(extract_subshells(b))
            i += 1; continue
        i += 1
    return out


def dequote(seg):
    """Strip quotes + backslash escapes so `s\\ed`->`sed`, `'rm'`->`rm`, and expose `sh -c "rm core/x"` bodies."""
    out, i, n = [], 0, len(seg)
    while i < n:
        ch = seg[i]
        if ch == '\\' and i + 1 < n:
            out.append(seg[i + 1]); i += 2; continue
        if ch == "'":
            i += 1
            while i < n and seg[i] != "'":
                out.append(seg[i]); i += 1
            i += 1; continue
        if ch == '"':
            i += 1
            while i < n and seg[i] != '"':
                if seg[i] == '\\' and i + 1 < n:
                    out.append(seg[i + 1]); i += 2; continue
                out.append(seg[i]); i += 1
            i += 1; continue
        out.append(ch); i += 1
    return ''.join(out)


def fragments(cmd):
    frags = list(split_segments(cmd))
    for body in extract_command_subs(cmd) + extract_subshells(cmd):
        frags.extend(split_segments(body))
    return frags


def is_surface_write(frag):
    dq = dequote(frag)                                   # dequoted catches s\ed / 'rm' / sh -c "..."
    if not (SURF.search(frag) or SURF.search(dq)):
        return False
    if VERB.search(dq):                                  # rm/sed -i/chmod/...: surface as any arg counts
        return True
    if INTERP.search(dq) and INLINE.search(dq):          # python3 -c / perl -e / ... touching the surface
        return True
    for src in (dq, frag):                               # >/>>: surface must be the TARGET (right of the op),
        for m in REDIR.finditer(src):                    # so `cat core/x > /tmp/y` (read, redirect elsewhere) is allowed
            if SURF.search(src[m.end():m.end() + 200]):
                return True
    return False


def main():
    cmd = sys.stdin.read()
    for f in fragments(cmd):
        if is_surface_write(f):
            sys.exit(0)                                  # surface write -> gate denies
    sys.exit(1)                                          # allow


main()
