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
#
# Round2 re-review (still heuristic, NOT a hard wall — same honest framing as above):
#   the cd-chain tracking above only ever walked the command's TOP-LEVEL segments — a `cd` INSIDE a
#   `$(...)`/`(...)` body (`(cd core && sed -i '' config.json)`, `x=$(cd core && sed -i '' config.json)`,
#   `cd core && (sed -i '' config.json)`) was invisible to it, because (a) `split_segments()` didn't
#   treat those spans as atomic, so a `&&` inside one could fracture the OUTER top-level chain, and
#   (b) the bodies extracted from them were re-checked against the ORIGINAL ambient cwd with no
#   cd-tracking of their own at all. Fixed by making `split_segments()` copy `$(...)`/`` `...` ``/`(...)`
#   spans through verbatim (their internal &&/||/;/& belong to the SUBSHELL's own chain, not the
#   outer one) and by `scan()` — a recursive version of the old top-level walk — that tracks `cd`
#   within every subshell/command-sub body too, seeded with the RUNNING cwd from whatever `cd`s
#   preceded it in the parent chain (a subshell inherits the shell's cwd at the point it's launched;
#   a `cd` inside one never escapes back out — both match real Bash semantics). Recursion is bounded
#   (MAX_SUBSHELL_DEPTH) so a pathological input can't blow the stack. Also folded in here: the gate
#   scripts (+ their vendored libs) themselves are now part of SURF (see below) — a prior re-review
#   found `.cursor/hooks/` and `.claude/hooks/lib/` sat outside the protected surface entirely, so
#   editing one gate/lib was invisible to the OTHER harness's own self-protection gate.
#
# Round 3 (LAST Bash-gate round — see honest framing below) — the Round2-rereview REWRITE ITSELF
# introduced two bypasses, both closed here:
#   1) (CRITICAL) `scan()`'s MAX_SUBSHELL_DEPTH bound FAILED OPEN: hitting it returned `False`
#      (allow), so `(((((((((cd core && sed -i '' config.json)))))))))` (9+ levels deep — one past
#      the bound) sailed through undetected instead of tripping the "can't recurse further" guard.
#      A security bound must fail CLOSED: an anomalously deep nest is itself suspicious (real triage
#      commands are 0-2 levels deep — see `core/tests/self-protection-test.sh`'s controls), so
#      exceeding it now DENIES rather than silently allowing. This is intentionally coarse — it also
#      denies a benign 9-deep `(((((((( echo hi ))))))))`, accepted as the cost of failing closed.
#   2) (IMPORTANT) `{ ...; }` brace groups were untracked: `split_segments()` had no handling for
#      `{`/`}` at all, so `{ cd core && sed -i '' config.json; }` fractured into `"{ cd core"` (which
#      doesn't match `CD_RE`, so the `cd` was silently dropped) and `" sed -i '' config.json"` (checked
#      against the STALE cwd, no surface hit). Fixed by treating a whitespace-bounded `{`/`}` — real
#      Bash's own grammar for the reserved word (must be its own token, `{` followed by a blank,
#      `}` preceded by one) — as a bare segment delimiter in `split_segments()`, the same way `;` is:
#      a brace group does NOT fork a subshell, so its `cd` correctly persists into segments AFTER the
#      closing `}` too, by simply flowing through the SAME top-level cd-tracking chain `scan()` already
#      walks (no new recursion/depth needed). `${VAR}` and brace-expansion (`{a,b}`, `{1..5}`) are
#      never mistaken for a group — bash never puts a blank right after a real word-forming `{` in
#      those forms, which is exactly the guard used here.
#
# Honest framing (repeated here deliberately — this is the LAST round that chases shell constructs):
#   this module is BEST-EFFORT defense-in-depth against NATURAL/accidental and simple adversarial
#   surface writes. It is NOT, and cannot be made, complete against a shell-capable agent that really
#   wants to bypass it — `base64 ... | bash`, `eval "$x"`, process substitution, exotic quoting, a
#   compiled writer, or any construct that doesn't reduce to a literal, parseable Bash command string
#   all bypass by construction, no matter how much more string-analysis is layered on. Past this
#   round, further hardening does NOT mean chasing more shell constructs here — the REAL wall, at
#   the **hardened** tier, is `core/lock-kit.sh lock` chown'ing core/** (and the kit root) to root,
#   unaffected by any of the above; below hardened it degrades to a directory-level chmod-only bit,
#   which is friction, not a wall (a same-user chmod reverses it). Do not read completeness into
#   anything below.
import sys, re, os

# Protected surface = the kit's own files, PLUS the self-protection gate scripts (both harnesses)
# and their vendored libs — the audit found `.cursor/hooks/*` and `.claude/hooks/lib/*` sat outside
# the surface entirely, so a session in one harness could freely disable the OTHER harness's gate
# (or its own gate's audit lib). Kept precise: only the gate filenames + their lib/ dirs, not the
# whole `.cursor/`/`.claude/hooks/` trees (which hold plenty of unrelated, legitimately-editable
# files). PATH-INDEPENDENT: set HEKTOR_FK_SURFACE to the kit's install root and a kit installed
# ANYWHERE protects itself (the standalone gates do this) — that override intentionally does NOT
# also add the gate-script patterns below (a caller setting it owns its own root's scope). Unset →
# the in-repo default below, so the live .claude/.cursor gates keep their exact behavior with no
# env set.
_SURF_ROOT = os.environ.get('HEKTOR_FK_SURFACE', '').strip().rstrip('/')
SURF = re.compile(re.escape(_SURF_ROOT)) if _SURF_ROOT \
    else re.compile(r'\.claude/skills/hektor-flaky-triage/(core/|SKILL\.md)'
                     r'|\.claude/hooks/flaky-kit-self-protection-gate\.sh'
                     r'|\.cursor/hooks/(flaky-kit-self-protection-gate\.sh|lib/)'
                     r'|\.claude/hooks/lib/')
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
    """Split on && || ; & respecting quotes/escapes. Redirections (&>, >&, 2>&1) are NOT separators.
    Round2-rereview: `$(...)`, `` `...` ``, and `(...)` spans are copied through VERBATIM (not
    walked char-by-char for separator purposes) — their internal &&/||/;/& belong to the subshell's
    OWN chain, not the outer one; splitting through them (the old behavior) could fracture a
    `(cd core && sed -i '' config.json)` into two unrelated-looking top-level segments, hiding the
    cd from the segment that used it. `scan()` below recurses into these spans itself via
    `immediate_bodies()`, tracking their own cd-chain from the RUNNING outer cwd.

    Round 3: `{`/`}` brace GROUPS are the opposite of a subshell — `{ cmd; }` does NOT fork, so a
    `cd` inside it persists into whatever comes after the closing `}` in the SAME chain. That means
    a brace group must NOT be copied through verbatim like `(...)`/`$(...)` (which WOULD hide its
    `cd` from the rest of the chain, backwards from real Bash semantics) — instead a whitespace-
    bounded `{`/`}` is treated as a bare, content-free delimiter (like `;`), so `cd core` inside one
    becomes an ordinary top-level segment `scan()` already cd-tracks, and the segments before/inside/
    after the group all share one flat, ordered chain. Guarded to bash's own grammar for the reserved
    word (`{` must be its own token followed by a blank; `}` must be preceded by one) so `${VAR}`
    param-expansion and brace-expansion (`{a,b}`, `{1..5}`) — which never have that blank — are left
    untouched as literal text."""
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
        if ch == '`':                                          # backtick span: copy through verbatim
            j = i + 1
            while j < n and s[j] != '`':
                j += 2 if s[j] == '\\' else 1
            j = min(j + 1, n)
            cur.append(s[i:j]); i = j; continue
        if ch == '$' and i + 1 < n and s[i + 1] == '(':        # $(...) span: copy through verbatim
            _b, end = _balanced_body(s, i + 2)
            j = min(end + 1, n)
            cur.append(s[i:j]); i = j; continue
        if ch == '(':                                           # (...) span: copy through verbatim
            _b, end = _balanced_body(s, i + 1)
            j = min(end + 1, n)
            cur.append(s[i:j]); i = j; continue
        if ch == '{' and s[i - 1:i] in ('', ' ', '\t', ';', '&', '|') and s[i + 1:i + 2] in (' ', '\t'):
            segs.append(''.join(cur)); cur = []; i += 1; continue   # brace-group open: bare delimiter
        if ch == '}' and s[i - 1:i] in (' ', '\t') and s[i + 1:i + 2] in ('', ' ', '\t', ';', '&', '|', ')'):
            segs.append(''.join(cur)); cur = []; i += 1; continue   # brace-group close: bare delimiter
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


def immediate_bodies(s):
    """Immediate (depth-1 only) bodies of $(...), `...`, and (...) in s. Deliberately NON-recursive:
    `scan()` below recurses into whatever this returns itself, threading the RUNNING cwd at each
    level (a plain flatten-everything extractor, like Round2's, can't do that — by the time you've
    flattened a nested body out of its parent, you've lost which cwd it should have started from).
    Single-quotes suppress expansion entirely (skipped outright); double-quotes still allow $(...)/
    backtick expansion (bash semantics) but make a bare '(' just literal text, not a subshell."""
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
                out.append(b)
            i += 1; continue
        if ch == '$' and i + 1 < n and s[i + 1] == '(':
            b, i = _balanced_body(s, i + 2)
            if b.strip():
                out.append(b)
            i += 1; continue
        if inD:                                                # bare '(' inside "..." is literal text
            i += 1; continue
        if ch == '(':
            b, i = _balanced_body(s, i + 1)
            if b.strip():
                out.append(b)
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


# Round2-rereview: bounds the recursion into nested $(...)/`...`/(...) bodies — a pathological
# input (deeply nested parens) can't blow the stack. Real-world nesting is 1-2 levels deep; this
# is generous headroom, not a tuned limit.
MAX_SUBSHELL_DEPTH = 8


def scan(cmd, cwd, depth=0):
    """Walk cmd's top-level segments (bounded correctly now that split_segments() treats
    $(...)/`...`/(...) as atomic — see its docstring), tracking a `cd`-updated cwd across them
    exactly like the original top-level loop did, and recursing into every subshell/command-sub
    body found in EACH segment with that RUNNING cwd as its start (a `cd` earlier in the parent
    chain is inherited by a subshell launched after it — matches real Bash semantics; a `cd` INSIDE
    a subshell/command-sub never escapes back out, so it does NOT affect the cwd `scan()` returns
    to the caller — there is no return value at all, only True/False). Returns True (deny) if any
    segment/body at any depth is a surface write.

    Round 3: the depth guard below used to `return False` (allow) once nesting exceeded
    MAX_SUBSHELL_DEPTH — a security bound that FAILED OPEN, so wrapping a real surface write in one
    more layer of parens than the bound (`(((((((((cd core && sed -i '' config.json)))))))))`, 9
    deep) sailed straight past detection instead of tripping it. Fixed to fail CLOSED: exceeding the
    bound now denies (`True`), the same as finding an actual surface write. An anomalously deep nest
    is itself suspicious — real triage commands run 0-2 levels deep (see the self-protection-test
    controls) — so this intentionally also denies a benign 9-deep no-op nest; accepted as the cost
    of not silently allowing past the bound."""
    if depth > MAX_SUBSHELL_DEPTH:
        return True                  # excess nesting depth: fail CLOSED (deny), not open — see above
    cur = cwd
    for seg in split_segments(cmd):
        m = CD_RE.match(dequote(seg).strip())
        if m:
            cur = resolve_path(m.group(1), cur)
            continue
        if is_surface_write(seg, cur):
            return True                                  # surface write -> gate denies
        for body in immediate_bodies(seg):
            if scan(body, cur, depth + 1):
                return True
    return False


def main():
    cmd = sys.stdin.read()
    base = os.environ.get('HEKTOR_FK_CWD', '').strip() or None
    if not base:
        # Round2-rereview item 3: previously this degraded to os.getcwd() (the guard PROCESS's own
        # ambient cwd, almost certainly NOT the Bash tool call's real cwd) with no signal at all —
        # a silent precision loss in a security gate. Same allow/deny floor as before (this is
        # observability only): resolve_path()/_abs_dir() still fall back to os.getcwd() exactly as
        # they did pre-Round2-rereview; only the stderr note is new.
        print('shell-guard: cwd unavailable — cd-tracking degraded', file=sys.stderr)
    sys.exit(0 if scan(cmd, base) else 1)                 # 0 = surface write (deny); 1 = allow


main()
