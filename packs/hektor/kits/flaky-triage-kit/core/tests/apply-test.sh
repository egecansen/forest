#!/bin/bash
# core/tests/apply-test.sh — first test suite for core/apply.sh's source_root confinement
# (Round1 hardening: I3). Plain bash asserts, no framework (mirrors ledger-test.sh's style).
#
# Runs entirely against /tmp git-repo FIXTURES — never the live kit dir. Each fixture copies the
# real apply.sh into a synthetic "<repo>/core/apply.sh" so apply.sh's own `$HERE`/`$REPO`
# resolution (git -C "$HERE" rev-parse --show-toplevel) lands on the fixture repo, not this kit.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY="$HERE/../apply.sh"
INTEGRITY="$HERE/../_integrity.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

git_init() { # $1=dir
  git -C "$1" init -q
  git -C "$1" config user.email test@example.com
  git -C "$1" config user.name  "apply-test"
}

# --- scenario (a): an absolute, out-of-repo source_root must NOT confine anything — apply must
#     refuse (exit 77) rather than overwrite the out-of-repo target.
REPO_A="$WORK/repo-a"; mkdir -p "$REPO_A/core"
git_init "$REPO_A"
cp "$APPLY" "$REPO_A/core/apply.sh"; chmod +x "$REPO_A/core/apply.sh"
cp "$INTEGRITY" "$REPO_A/core/_integrity.sh"
OUTSIDE_A="$WORK/outside-a"; mkdir -p "$OUTSIDE_A"
printf 'TOP SECRET ORIGINAL\n' > "$OUTSIDE_A/secret.txt"
jq -n --arg r "$OUTSIDE_A" '{source_roots:[$r]}' > "$REPO_A/core/config.json"
printf 'x\n' > "$REPO_A/dummy.txt"; git -C "$REPO_A" add -A; git -C "$REPO_A" commit -qm init >/dev/null

REQ_A="$(jq -n --arg f "$OUTSIDE_A/secret.txt" --arg o "TOP SECRET ORIGINAL" --arg n "PWNED" '{file:$f,old:$o,new:$n}')"
OUT_A="$(printf '%s' "$REQ_A" | "$REPO_A/core/apply.sh" 2>&1)"; RC_A=$?

[ "$RC_A" -eq 77 ] && ok || bad "absolute out-of-repo source_root refused with exit 77 (got $RC_A: $OUT_A)"
[ "$(cat "$OUTSIDE_A/secret.txt")" = "TOP SECRET ORIGINAL" ] && ok || bad "out-of-repo target file left UNCHANGED (no overwrite)"

# --- scenario (b): a normal, in-repo relative source_root on a clean tree must still apply.
REPO_B="$WORK/repo-b"; mkdir -p "$REPO_B/core" "$REPO_B/src"
git_init "$REPO_B"
cp "$APPLY" "$REPO_B/core/apply.sh"; chmod +x "$REPO_B/core/apply.sh"
cp "$INTEGRITY" "$REPO_B/core/_integrity.sh"
printf 'hello world\n' > "$REPO_B/src/Foo.txt"
jq -n '{source_roots:["src"]}' > "$REPO_B/core/config.json"
git -C "$REPO_B" add -A; git -C "$REPO_B" commit -qm init >/dev/null

REQ_B="$(jq -n --arg f "src/Foo.txt" --arg o "hello" --arg n "goodbye" '{file:$f,old:$o,new:$n}')"
OUT_B="$(printf '%s' "$REQ_B" | "$REPO_B/core/apply.sh" 2>&1)"; RC_B=$?

[ "$RC_B" -eq 0 ] && ok || bad "normal in-repo source_root on clean tree still applies (got $RC_B: $OUT_B)"
[ "$(cat "$REPO_B/src/Foo.txt")" = "goodbye world" ] && ok || bad "in-repo target file correctly edited"

# --- scenario (c): defense-in-depth — even if the source_root confinement gate were bypassed,
#     the clean-tree check must independently refuse an out-of-repo target (git errors on a
#     pathspec outside the repo) rather than fail open. Prove it with a copy of the FIXED
#     apply.sh with ONLY the confinement `if` neutralized (test-only; never touches the real file).
REPO_C="$WORK/repo-c"; mkdir -p "$REPO_C/core"
git_init "$REPO_C"
cp "$APPLY" "$REPO_C/core/apply.sh"
cp "$INTEGRITY" "$REPO_C/core/_integrity.sh"
sed -i '' 's/if not (cand == repo or cand.startswith(repo + os.sep)):/if False:  # TEST-ONLY: confinement neutralized to isolate-test the clean-tree gate/' "$REPO_C/core/apply.sh"
grep -q 'TEST-ONLY: confinement neutralized' "$REPO_C/core/apply.sh" && ok || bad "fixture sed patch applied (sanity)"
chmod +x "$REPO_C/core/apply.sh"
OUTSIDE_C="$WORK/outside-c"; mkdir -p "$OUTSIDE_C"
printf 'TOP SECRET C\n' > "$OUTSIDE_C/secret2.txt"
jq -n --arg r "$OUTSIDE_C" '{source_roots:[$r]}' > "$REPO_C/core/config.json"
printf 'x\n' > "$REPO_C/dummy.txt"; git -C "$REPO_C" add -A; git -C "$REPO_C" commit -qm init >/dev/null

REQ_C="$(jq -n --arg f "$OUTSIDE_C/secret2.txt" --arg o "TOP SECRET C" --arg n "PWNED2" '{file:$f,old:$o,new:$n}')"
OUT_C="$(printf '%s' "$REQ_C" | "$REPO_C/core/apply.sh" 2>&1)"; RC_C=$?

[ "$RC_C" -eq 75 ] && ok || bad "clean-tree gate independently refuses an out-of-repo target on git error (got $RC_C: $OUT_C)"
[ "$(cat "$OUTSIDE_C/secret2.txt")" = "TOP SECRET C" ] && ok || bad "scenario (c) target file left UNCHANGED (defense-in-depth held)"

# --- scenario (d) (Fix A): apply.sh's OWN dir has NO enclosing git repo at all — `git -C "$HERE"
#     rev-parse --show-toplevel` errors. Without an explicit exit-code check, REPO becomes "" and
#     BOTH downstream gates silently rebase onto the CALLER's cwd instead
#     (os.path.realpath("") == cwd; `git -C "" status` == cwd) — reproduced as a full arbitrary-file
#     overwrite: apply.sh must instead FAIL CLOSED (exit 78) before any confinement/clean-tree logic
#     runs, leaving the decoy cwd repo's target file byte-for-byte unchanged.
NONREPO_D="$WORK/nonrepo-d"; mkdir -p "$NONREPO_D/core"
cp "$APPLY" "$NONREPO_D/core/apply.sh"; chmod +x "$NONREPO_D/core/apply.sh"
cp "$INTEGRITY" "$NONREPO_D/core/_integrity.sh"
# deliberately NO `git init` anywhere above $NONREPO_D/core — $HERE has no enclosing .git at all
# (WORK lives under mktemp -d, outside any repo, so this holds).
jq -n '{source_roots:["src"]}' > "$NONREPO_D/core/config.json"

DECOY_D="$WORK/decoy-d"; mkdir -p "$DECOY_D/src"
git_init "$DECOY_D"
printf 'DECOY ORIGINAL\n' > "$DECOY_D/src/Target.txt"
git -C "$DECOY_D" add -A; git -C "$DECOY_D" commit -qm init >/dev/null

REQ_D="$(jq -n --arg f "$DECOY_D/src/Target.txt" --arg o "DECOY ORIGINAL" --arg n "PWNED-VIA-CWD" '{file:$f,old:$o,new:$n}')"
OUT_D="$(cd "$DECOY_D" && printf '%s' "$REQ_D" | "$NONREPO_D/core/apply.sh" 2>&1)"; RC_D=$?

[ "$RC_D" -eq 78 ] && ok || bad "apply.sh with no enclosing repo fails closed with exit 78 (got $RC_D: $OUT_D)"
[ "$(cat "$DECOY_D/src/Target.txt")" = "DECOY ORIGINAL" ] && ok || bad "decoy cwd repo's target file left UNCHANGED (no silent cwd fallback)"

echo "apply-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
