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
# stdin = the command string. env HEKTOR_FK_CWD (optional) = the Bash tool call's actual working
# directory (the hook's `.cwd`) — used ONLY to canonicalize relative/dot/symlink path references
# (Round2, item 2/3 below); absent it, canonicalization still works for any `cd` chain fully
# contained in the command, just not one anchored to the real ambient cwd. exit 0 => some fragment
# both references the surface AND mutates it (the gate then denies); exit 1 => allow. Patterns are
# python-flavored and kept in sync with the gate's bash-ERE prefilter (SURF_RE / MUT_RE in
# flaky-kit-self-protection-gate.sh).
#
# Round2 — path canonicalization + cwd tracking (still heuristic, NOT a hard wall; see module intro):
#   a literal-substring SURF match is bypassed by `./` noise, a `../` reversal, a symlink whose OWN
#   path doesn't mention the surface but resolves onto it, a bare cwd-relative reference, or a
#   `cd <dir> &&`/`cd <dir>;` prefix that changes what a later bare reference in the SAME command
#   means. `resolve_path()` below canonicalizes a token against a tracked base directory
#   (os.path.realpath — same realpath-first discipline as core/apply.sh's I3 fix: it resolves
#   whatever prefix of the path already exists on disk, incl. symlinks, and normalizes the rest
#   lexically, so a not-yet-created Write target still canonicalizes correctly); `main()` walks the
#   command's top-level segments in order, updating a tracked "current directory" on every bare
#   `cd <dir>` so a later segment's relative references resolve against where the command chain
#   actually put us, not just their own literal text.
import sys, re, os

# Protected surface = the kit's own files. PATH-INDEPENDENT: set HEKTOR_FK_SURFACE to the kit's install
# root and a kit installed ANYWHERE protects itself (the standalone gates do this). Unset → the in-repo
# default below, so the live .claude gates keep their exact behavior with no env set.
_SURF_ROOT = os.environ.get('HEKTOR_FK_SURFACE', '').strip().rstrip('/')
SURF = re.compile(re.escape(_SURF_ROOT)) if _SURF_ROOT \
    else re.compile(r'\.claude/skills/hektor-flaky-triage/(core/|hooks/\S*\.sh|SKILL\.md)')
# target-as-arg mutations: surface anywhere in the fragment is a write (conservative — `cp core/x /tmp`
# reads the surface, but copying kit files out is itself worth surfacing). REDIR is target-position-aware.
# Round2: added rsync/patch (file-clobbering copiers) and the git subcommands that can silently
# overwrite a tracked file from another ref/stash/patch (checkout/restore/reset — HEAD or index reset;
# apply/stash — replay a patch; clean — delete untracked files, incl. a not-yet-committed new surface file).
VERB  = re.compile(r'\bsed\s+-i\b|\b(?:tee|cp|mv|rm|chmod|chown|truncate|dd|install|ln|rsync|patch)\b'
                    r'|\bgit\s+(?:checkout|apply|restore|stash|reset|clean)\b')
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


def _abs_dir(base):
    """Best-effort absolute form of a tracked base directory; empty/relative -> anchor on the
    guard PROCESS's own cwd (the closest available approximation when HEKTOR_FK_CWD is unset)."""
    if not base:
        return os.getcwd()
    return base if os.path.isabs(base) else os.path.normpath(os.path.join(os.getcwd(), base))


def resolve_path(tok, base):
    """Canonicalize `tok` (possibly relative, possibly `.`/`..`-noisy, possibly a symlink) against
    `base`. Never raises; the target need not exist on disk — os.path.realpath resolves symlinks in
    whatever prefix already exists and lexically normalizes the rest, so a not-yet-created Write/
    new-file target still canonicalizes correctly. Falls back to a pure lexical normpath, then to
    the raw token, on any error (still a heuristic gate, not a hard wall — see module docstring)."""
    if not tok:
        return tok
    try:
        p = tok if os.path.isabs(tok) else os.path.join(_abs_dir(base), tok)
        return os.path.realpath(p)
    except Exception:
        try:
            return os.path.normpath(tok)
        except Exception:
            return tok


def fragments(cmd):
    frags = list(split_segments(cmd))
    for body in extract_command_subs(cmd) + extract_subshells(cmd):
        frags.extend(split_segments(body))
    return frags


CD_RE = re.compile(r'^cd\s+(\S+)\s*$')


def is_surface_write(frag, base=None):
    dq = dequote(frag)                                   # dequoted catches s\ed / 'rm' / sh -c "..."
    surf_hit = bool(SURF.search(frag) or SURF.search(dq))
    if not surf_hit:
        # Round2 canonicalization pass: a `./`, `../`, symlink-aliased, or bare cwd-relative token
        # can land on the surface with no literal substring match at all — resolve each non-flag
        # whitespace token against `base` (the tracked cwd) and re-check.
        for tok in dq.split():
            if tok.startswith('-'):
                continue
            if SURF.search(resolve_path(tok, base)):
                surf_hit = True
                break
    if not surf_hit:
        return False
    if VERB.search(dq):                                  # rm/sed -i/chmod/git checkout/rsync/...: surface as any arg counts
        return True
    if INTERP.search(dq) and INLINE.search(dq):          # python3 -c / perl -e / ... touching the surface
        return True
    for src in (dq, frag):                               # >/>>: surface must be the TARGET (right of the op),
        for m in REDIR.finditer(src):                    # so `cat core/x > /tmp/y` (read, redirect elsewhere) is allowed
            tail = src[m.end():m.end() + 200]
            if SURF.search(tail):
                return True
            tail_tok = tail.split()[0] if tail.split() else ''
            if tail_tok and SURF.search(resolve_path(tail_tok, base)):
                return True
    return False


def main():
    cmd = sys.stdin.read()
    base = os.environ.get('HEKTOR_FK_CWD', '').strip() or None
    # Round2 item 3: walk the TOP-LEVEL segments in order, tracking cwd across a leading/chained
    # `cd <dir> &&` / `cd <dir>;` — closes `cd core && sed -i '' config.json` (cwd-blindness): a
    # pure `cd` segment updates the tracked dir instead of being checked itself; every later
    # segment's relative references resolve against wherever the chain actually put us.
    cur = base
    for seg in split_segments(cmd):
        m = CD_RE.match(dequote(seg).strip())
        if m:
            cur = resolve_path(m.group(1), cur)
            continue
        if is_surface_write(seg, cur):
            sys.exit(0)                                  # surface write -> gate denies
    # command-substitution / subshell bodies run in their own subshell cwd — anchor each on the
    # ORIGINAL base (not the outer chain's `cur`), not the outer command's accumulated cd chain.
    for body in extract_command_subs(cmd) + extract_subshells(cmd):
        for seg in split_segments(body):
            if is_surface_write(seg, base):
                sys.exit(0)
    sys.exit(1)                                          # allow


main()
