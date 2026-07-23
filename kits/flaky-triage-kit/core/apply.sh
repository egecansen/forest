#!/bin/bash
# core/apply.sh — apply a fix to the WORKING TREE (git-tracked), show the diff.
#
# Enforces: I3 (clean tree; confined to source_roots; git-reversible) · I8 (NEVER commit) · I10 (rev-pin)
# Contract: stdin JSON {file, old, new} → literal-replace unique `old`→`new` in `file`, print `git diff`.
#           Refuses if file ∉ source_roots, the tree is dirty (unless APPLY_ALLOW_DIRTY=1), or `old` not unique.
#           Round1 hardening: every configured source_root is itself validated to resolve UNDER the
#           repo (an absolute or ../-escaping root in config.json must never confine anything — that
#           would turn apply into arbitrary-file overwrite); the clean-tree check treats a git ERROR
#           (e.g. an out-of-repo pathspec) as UNSAFE, never as clean-by-default.
#           Round2 Fix A: REPO resolution itself is now fail-closed. `set -uo pipefail` (no `-e`)
#           means a failing `git -C "$HERE" rev-parse --show-toplevel` was never checked — REPO
#           silently became "", and BOTH Round1 gates above then rebase onto the CALLER's cwd
#           (os.path.realpath("") == cwd; `git -C "" status` == cwd), i.e. full arbitrary-file
#           overwrite. REPO is now required to be a non-empty, absolute, existing directory —
#           anything else exits 78 before either gate runs.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; CFG="$HERE/config.json"
for t in jq git python3; do command -v "$t" >/dev/null || { echo "apply: $t required" >&2; exit 69; }; done
REPO="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)"; REPO_RC=$?   # repo from the script's own dir, not the caller's cwd
# Fail CLOSED here, before ANY confinement/clean-tree logic runs — see Round2 Fix A note above.
case "$REPO" in
  /*) [ -d "$REPO" ] || REPO="" ;;   # must resolve to an existing, absolute directory
  *)  REPO="" ;;                     # empty, or (shouldn't happen, but defense-in-depth) non-absolute
esac
if [ "$REPO_RC" -ne 0 ] || [ -z "$REPO" ]; then
  echo "apply: cannot resolve the enclosing git repo for $HERE (git rev-parse rc=$REPO_RC) — refusing rather than silently falling back to the caller's cwd" >&2
  exit 78
fi

REQ="$(cat)"
FILE="$(jq -r '.file // empty' <<<"$REQ")"; OLD="$(jq -r '.old // empty' <<<"$REQ")"; NEW="$(jq -r '.new // ""' <<<"$REQ")"
[ -n "$FILE" ] && [ -n "$OLD" ] || { echo "apply: need stdin JSON {file, old, new}" >&2; exit 64; }

case "$FILE" in /*) abs="$FILE";; *) abs="$REPO/$FILE";; esac
[ -f "$abs" ] || { echo "apply: no such file: $FILE" >&2; exit 66; }
# I3 (V-2): canonicalize BEFORE confinement. A string `startswith` on a raw path is
# ../-bypassable — web-ui-test/src/test/java/../../../../etc/shadow passes the prefix test
# yet resolves outside source_roots. realpath() collapses .. and symlinks first.
abs="$(REPO="$REPO" CFG="$CFG" python3 - "$abs" <<'PY'
import os,sys,json
t=os.path.realpath(sys.argv[1])
repo=os.path.realpath(os.environ["REPO"])
raw_roots=(json.load(open(os.environ["CFG"])).get("source_roots") or [])
roots=[]
for r in raw_roots:
    # I3 (Round1): validate the ROOT ITSELF resolves under repo before trusting it for confinement.
    # os.path.join(repo, r) silently DISCARDS repo when r is absolute — so an absolute (or
    # ../-escaping) source_root in config.json must be rejected here, not just matched against.
    cand = os.path.realpath(os.path.join(repo, r))
    if not (cand == repo or cand.startswith(repo + os.sep)):
        sys.stderr.write("I3: configured source_root escapes repo (post-canonicalize): %r -> %s\n" % (r, cand))
        sys.exit(77)
    roots.append(cand)
if not any(t==r or t.startswith(r+os.sep) for r in roots):
    sys.stderr.write("I3: target outside source_roots (post-canonicalize): %s\n"%t); sys.exit(77)
print(t)
PY
)" || exit $?
rel="${abs#$REPO/}"
# I3: clean tree — don't tangle with WIP. A git ERROR (e.g. an out-of-repo pathspec, corrupt
# state) must read as UNSAFE, never clean-by-default: check the exit code AND capture stderr,
# not just an empty stdout (the original bug: `fatal: ... is outside repository` on stderr with
# an unchecked exit code left `-n "$(...)"` false → treated as clean).
if [ "${APPLY_ALLOW_DIRTY:-0}" != "1" ]; then
  gs_out="$(git -C "$REPO" status --porcelain -- "$abs" 2>&1)"; gs_rc=$?
  if [ "$gs_rc" -ne 0 ] || [ -n "$gs_out" ]; then
    echo "I3: $rel not confirmed clean (git status rc=$gs_rc) — refusing (set APPLY_ALLOW_DIRTY=1 to override): $gs_out" >&2
    exit 75
  fi
fi
REV="$(git -C "$REPO" rev-parse --short HEAD)"   # I10: pin

OLD="$OLD" NEW="$NEW" python3 - "$abs" <<'PY' || exit $?
import os,sys
p=sys.argv[1]; s=open(p).read(); old=os.environ["OLD"]
c=s.count(old)
if c!=1:
    sys.stderr.write("apply: 'old' must match exactly once (found %d)\n"%c); sys.exit(65)
open(p,"w").write(s.replace(old,os.environ["NEW"],1))
PY

echo "apply: edited $rel at rev $REV — kit does NOT commit (I8); review the diff + commit yourself:" >&2
git -C "$REPO" --no-pager diff -- "$abs"
