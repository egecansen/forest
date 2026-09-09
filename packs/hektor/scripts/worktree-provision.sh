#!/bin/bash
# worktree-provision.sh — stand up a git worktree that is FULLY Hektor-active.
#
# A bare `git worktree add` produces a checkout where Hektor does NOT work: the
# whole harness lives in files git never carries. In sahibinden/web-test:
#   .claude/                 -> .gitignore:1
#   .cursor/                 -> .git/info/exclude (the Cursor rule + gates;
#                               a worktree without it is Cursor-blind — no
#                               rule routes a prompt, no gate fires)
#   CLAUDE.md METHODOLOGY.md -> .git/info/exclude (local-only)
#   docs/hektor/             -> .git/info/exclude
#   gradlew, gradle/         -> .gitignore  (so the worktree cannot even build)
#   auto-memory              -> ~/.claude/projects/<path-slug>/memory, and the
#                               worktree's path yields a DIFFERENT slug, so a
#                               session there starts with zero memories.
# This script closes all six gaps, in one idempotent pass.
#
# Why not forest's own pack provisioning: it is selective (you tick skills in the
# UI) and its copyTree refuses to overwrite a file whose content differs — so an
# updated skill never reaches an already-provisioned worktree. The pack's
# install.sh is the full-fidelity path: every skill, every hook, cp -R semantics.
#
# Usage:
#   worktree-provision.sh --ticket WEBT-254523 [options]
#   worktree-provision.sh --branch tech/WEBT-254523 [options]
#   worktree-provision.sh --verify-only --path ~/.forest/wt/web-test/tech-WEBT-254523
#
# Options:
#   --ticket <KEY>        ticket key; branch becomes tech/<KEY>
#   --branch <name>       explicit branch name (wins over --ticket)
#   --repo <dir>          any path inside the target repo (default: $PWD)
#   --base <ref>          base for the new branch (default: origin/master)
#   --worktree-root <dir> worktree parent (default: forest's config, else ~/.forest/wt)
#   --path <dir>          exact worktree path (wins over --worktree-root)
#   --harness <h>         all|claude|cursor|agents|both (default: all). Passed
#                         straight to install.sh. This USED to be hardcoded to
#                         `claude`, which is why provisioned worktrees had a
#                         working .claude/ and no .cursor/ at all.
#   --no-fetch            skip `git fetch origin`
#   --reuse               re-provision an existing worktree instead of failing
#   --verify-only         report what a worktree is missing; change nothing
#   --teardown            remove a worktree SAFELY (unlinks the memory symlink
#                         instead of recursing through it); keeps the branch
#
# Exit codes: 0 ok · 64 usage · 65 git/worktree failure · 66 missing path
#             67 provisioning incomplete (verification failed)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PACK="$(cd "$HERE/.." && pwd)"          # SKLS/hektor
TICKET=""; BRANCH=""; REPO_HINT="$PWD"; BASE="origin/master"
WT_ROOT=""; WT_PATH=""; DO_FETCH=1; REUSE=0; VERIFY_ONLY=0; TEARDOWN=0
HARNESS="all"

die() { echo "provision: $1" >&2; exit "${2:-64}"; }
say() { echo "provision: $1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ticket)        TICKET="${2:-}"; shift 2 ;;
    --branch)        BRANCH="${2:-}"; shift 2 ;;
    --repo)          REPO_HINT="${2:-}"; shift 2 ;;
    --base)          BASE="${2:-}"; shift 2 ;;
    --worktree-root) WT_ROOT="${2:-}"; shift 2 ;;
    --path)          WT_PATH="${2:-}"; shift 2 ;;
    --harness)       HARNESS="${2:-}"; shift 2 ;;
    --no-fetch)      DO_FETCH=0; shift ;;
    --reuse)         REUSE=1; shift ;;
    --verify-only)   VERIFY_ONLY=1; shift ;;
    --teardown)      TEARDOWN=1; shift ;;
    -h|--help)       sed -n '2,46p' "$0"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

case "$HARNESS" in
  all|claude|cursor|agents|both) ;;
  *) die "--harness must be all|claude|cursor|agents|both (got: $HARNESS)" ;;
esac
# Which harnesses this run is expected to produce — read by verify() so a
# --harness claude run is not failed for the .cursor/ it never asked for.
case "$HARNESS" in all|cursor|both) WANT_CURSOR=1 ;; *) WANT_CURSOR=0 ;; esac

command -v jq >/dev/null || die "jq is required" 64
[ -f "$PACK/install.sh" ] || die "pack installer not found at $PACK/install.sh" 66

# ---------------------------------------------------------------------------
# Validate every value that reaches `git` as a positional argument. A value
# beginning with '-' is parsed by git as an OPTION, not a name: `--ticket
# '--upload-pack=…'` reaches `git worktree add -b <here>` and git answers
# "error: unknown option" — i.e. it was option-parsed. Verified. Ticket keys and
# refs arrive from a Jira summary or a chat message, so neither is trusted
# input; reject the hostile shapes rather than quoting harder.
# ---------------------------------------------------------------------------
# A whitelist, not a blacklist: anything outside [A-Za-z0-9._/-] is rejected,
# which covers whitespace, quotes, $ ` ; & | globs and every other metacharacter
# in one rule instead of an ever-growing list of forbidden shapes.
safe_ref() {             # $1=value $2=flag name
  [ -n "$1" ] || return 0
  case "$1" in
    -*)                    die "$2 may not start with '-' — git parses that as an option: $1" ;;
    *..*)                  die "$2 may not contain '..': $1" ;;
    *[!A-Za-z0-9._/-]*)    die "$2 may only contain letters, digits and . _ - / — got: $1" ;;
  esac
}
safe_ref "$TICKET" --ticket
safe_ref "$BRANCH" --branch
safe_ref "$BASE"   --base
case "$TICKET" in ''|*[A-Za-z0-9]*) ;; *) die "--ticket must contain an alphanumeric: $TICKET" ;; esac

# ---------------------------------------------------------------------------
# Resolve the PRIMARY worktree — the only checkout that holds the local-only
# harness files. `git worktree list --porcelain` always lists it first, so this
# works whether the script is invoked from the primary or from another worktree.
# ---------------------------------------------------------------------------
[ -d "$REPO_HINT" ] || die "no such dir: $REPO_HINT" 66
PRIMARY="$(git -C "$REPO_HINT" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')"
[ -n "$PRIMARY" ] || die "$REPO_HINT is not inside a git repo" 65
REPO_NAME="$(basename "$PRIMARY")"

# Branch name: explicit --branch wins, else tech/<TICKET>.
if [ -z "$BRANCH" ] && [ -n "$TICKET" ]; then BRANCH="tech/$TICKET"; fi
if [ -z "$BRANCH" ] && [ "$VERIFY_ONLY" -eq 0 ]; then die "need --ticket or --branch"; fi

# Worktree path: mirror forest's layout — <worktreeRoot>/<repoName>/<branchSlug>
# (lib/config.mjs worktreePathFor + lib/finish.mjs slug), so forest lists and
# manages what this script creates with no extra registration step.
if [ -z "$WT_ROOT" ]; then
  FOREST_CFG=""
  if command -v forest >/dev/null; then
    FOREST_BIN="$(readlink "$(command -v forest)" 2>/dev/null || command -v forest)"
    case "$FOREST_BIN" in /*) ;; *) FOREST_BIN="$(cd "$(dirname "$(command -v forest)")" && cd "$(dirname "$FOREST_BIN")" && pwd)/$(basename "$FOREST_BIN")" ;; esac
    FOREST_CFG="$(cd "$(dirname "$FOREST_BIN")/.." 2>/dev/null && pwd)/config.json"
  fi
  if [ -n "$FOREST_CFG" ] && [ -f "$FOREST_CFG" ]; then
    WT_ROOT="$(jq -r '.worktreeRoot // empty' "$FOREST_CFG")"
  fi
  [ -n "$WT_ROOT" ] || WT_ROOT="$HOME/.forest/wt"
fi
BRANCH_SLUG="$(printf '%s' "$BRANCH" | sed 's/[^A-Za-z0-9._-][^A-Za-z0-9._-]*/-/g')"
[ -n "$WT_PATH" ] || WT_PATH="$WT_ROOT/$REPO_NAME/$BRANCH_SLUG"

# Claude Code names a project dir after the absolute path with every single
# non-alphanumeric character replaced by '-' (so `.forest` becomes `-forest`,
# yielding the '--' runs you see under ~/.claude/projects). Verified against
# the existing worktree entries there.
claude_slug() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }

# ---------------------------------------------------------------------------
# Local-only harness assets. Left column is the path relative to the repo root;
# absent entries are skipped silently (not every repo has every file).
# ---------------------------------------------------------------------------
HARNESS_FILES=(CLAUDE.md METHODOLOGY.md AGENTS.md .mcp.json .mcp.local.json .env .env.local)
BUILD_FILES=(gradlew gradlew.bat gradle web-ui-test/gradlew web-ui-test/gradlew.bat web-ui-test/gradle)

# Keep provisioned files invisible to git — local exclude only, never .gitignore.
ensure_excluded() {
  local pattern="$1" ex cur
  git -C "$WT_PATH" check-ignore -q "${pattern#/}" 2>/dev/null && return 0
  ex="$(git -C "$WT_PATH" rev-parse --git-path info/exclude 2>/dev/null)" || return 0
  case "$ex" in /*) ;; *) ex="$WT_PATH/$ex" ;; esac
  cur=""; [ -f "$ex" ] && cur="$(cat "$ex")"
  printf '%s' "$cur" | grep -qxF "$pattern" && return 0
  mkdir -p "$(dirname "$ex")"
  { [ -n "$cur" ] && [ "${cur: -1}" != $'\n' ] && printf '\n'; printf '%s\n' "$pattern"; } >> "$ex"
}

# ---------------------------------------------------------------------------
# Verification — the same checks whether we just provisioned or only inspected.
# Prints one PASS/FAIL line per gap so a caller can grep the report.
# ---------------------------------------------------------------------------
verify() {
  local fails=0 n_skills n_hooks mem
  echo "--- verify: $WT_PATH"
  n_skills="$(find "$WT_PATH/.claude/skills" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  n_hooks="$(find "$WT_PATH/.claude/hooks" -maxdepth 1 -name '*.sh' 2>/dev/null | wc -l | tr -d ' ')"
  local want_skills want_hooks
  want_skills="$(find "$PACK/skills" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  want_hooks="$(find "$PACK/hooks" -maxdepth 1 -name '*.sh' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$n_skills" -ge "$want_skills" ]; then echo "PASS skills   $n_skills/$want_skills"
  else echo "FAIL skills   $n_skills/$want_skills"; fails=$((fails+1)); fi
  if [ "$n_hooks" -ge "$want_hooks" ]; then echo "PASS hooks    $n_hooks/$want_hooks"
  else echo "FAIL hooks    $n_hooks/$want_hooks"; fails=$((fails+1)); fi
  # Registered hooks must all exist on disk, or every tool call errors with 127.
  local registered missing=0 cmd
  registered="$(jq -r '[.hooks[]?[]?.hooks[]?.command] | .[]' "$WT_PATH/.claude/settings.json" 2>/dev/null)"
  if [ -n "$registered" ]; then
    while IFS= read -r cmd; do
      [ -n "$cmd" ] || continue
      cmd="${cmd//\$CLAUDE_PROJECT_DIR/$WT_PATH}"
      # Registered commands are shell-quoted ("…/gate.sh") so a path with spaces
      # survives; drop the quotes before touching the filesystem, then fall back
      # to the first token for a command that carries arguments.
      cmd="${cmd//\"/}"
      [ -x "$cmd" ] || [ -x "${cmd%% *}" ] || missing=$((missing+1))
    done <<< "$registered"
  fi
  if [ "$missing" -eq 0 ]; then echo "PASS hookreg  every registered hook script present"
  else echo "FAIL hookreg  $missing registered hook script(s) missing"; fails=$((fails+1)); fi
  for f in "${HARNESS_FILES[@]}"; do
    [ -e "$PRIMARY/$f" ] || continue
    if [ -e "$WT_PATH/$f" ]; then echo "PASS file     $f"
    else echo "FAIL file     $f"; fails=$((fails+1)); fi
  done
  for f in "${BUILD_FILES[@]}"; do
    [ -e "$PRIMARY/$f" ] || continue
    if [ -e "$WT_PATH/$f" ]; then echo "PASS build    $f"
    else echo "FAIL build    $f"; fails=$((fails+1)); fi
  done
  mem="$HOME/.claude/projects/$(claude_slug "$WT_PATH")/memory"
  if [ -d "$mem" ]; then
    echo "PASS memory   $(find "$mem/" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ') entries via $mem"
  else echo "FAIL memory   no memory dir at $mem"; fails=$((fails+1)); fi
  if [ -d "$WT_PATH/docs/hektor" ]; then echo "PASS docs     docs/hektor/"
  else echo "FAIL docs     docs/hektor/ absent"; fails=$((fails+1)); fi
  # Cursor axis. Checked only when this run asked for Cursor, so a deliberate
  # `--harness claude` worktree is not failed for a .cursor/ it never wanted.
  # A rule file alone is not enough: without hooks.json nothing is registered,
  # and without the vendored compat shim every gate exits 0 silently.
  #
  # The shim ships under two names across pack versions: it was vendored as
  # cursor-compat.sh, and the later refactor that folded the adapters/ tree into
  # hooks/ renamed it cursor.sh. Accept EITHER — pinning the old name alone made
  # a correctly-wired Cursor worktree report "Cursor cannot route or gate here",
  # which is worse than not checking, because it sends you fixing what is not broken.
  if [ "$WANT_CURSOR" -eq 1 ]; then
    local c_missing=0 cf
    for cf in .cursor/hooks.json; do
      [ -e "$WT_PATH/$cf" ] || c_missing=$((c_missing+1))
    done
    [ -e "$WT_PATH/.cursor/hooks/lib/cursor.sh" ] \
      || [ -e "$WT_PATH/.cursor/hooks/lib/cursor-compat.sh" ] \
      || c_missing=$((c_missing+1))
    local n_rules
    n_rules="$(find "$WT_PATH/.cursor/rules" -maxdepth 1 -name '*.mdc' 2>/dev/null | wc -l | tr -d ' ')"
    [ "$n_rules" -gt 0 ] || c_missing=$((c_missing+1))
    if [ "$c_missing" -eq 0 ]; then echo "PASS cursor   $n_rules rule(s) + hooks.json + compat shim"
    else echo "FAIL cursor   $c_missing of 3 Cursor essentials missing (rules/*.mdc, hooks.json, hooks/lib/cursor.sh or cursor-compat.sh) — Cursor cannot route or gate here"; fails=$((fails+1)); fi
  fi
  echo "--- verify: $fails failure(s)"
  return "$fails"
}

if [ "$VERIFY_ONLY" -eq 1 ]; then
  [ -d "$WT_PATH" ] || die "no worktree at $WT_PATH" 66
  verify; [ $? -eq 0 ] || exit 67
  exit 0
fi

# ---------------------------------------------------------------------------
# Teardown. This exists because the obvious hand-rolled cleanup is DESTRUCTIVE:
# `rm -rf ~/.claude/projects/<wt-slug>/memory/` — a trailing slash on a symlink
# makes BSD rm operate on the TARGET, so it empties the primary's shared memory
# dir and leaves the symlink in place looking healthy. Verified on this machine
# (1 file -> 0 files, link intact). Always unlink, never recurse through.
# The branch is NOT deleted — that is the user's call; the command is printed.
# ---------------------------------------------------------------------------
if [ "$TEARDOWN" -eq 1 ]; then
  [ -d "$WT_PATH" ] || die "no worktree at $WT_PATH" 66
  WT_PROJ="$HOME/.claude/projects/$(claude_slug "$WT_PATH")"
  if [ -L "$WT_PROJ/memory" ]; then
    rm "$WT_PROJ/memory"                       # unlink ONLY — no trailing slash, no -r
    say "unlinked the memory symlink (primary's memories untouched)"
  elif [ -d "$WT_PROJ/memory" ]; then
    say "WARNING: $WT_PROJ/memory is a real directory, not a link — left in place"
  fi
  BR="$(git -C "$WT_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  git -C "$PRIMARY" worktree remove --force "$WT_PATH" || die "worktree remove failed" 65
  rmdir "$WT_PROJ" 2>/dev/null
  say "worktree removed: $WT_PATH"
  if [ -n "$BR" ] && [ "$BR" != "HEAD" ]; then
    echo
    say "the branch is kept. Delete it yourself when you're done with it:"
    echo "    git -C $PRIMARY branch -D $BR"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 1) The worktree itself.
# ---------------------------------------------------------------------------
if [ -d "$WT_PATH" ]; then
  [ "$REUSE" -eq 1 ] || die "worktree already exists: $WT_PATH (pass --reuse to re-provision)" 65
  say "reusing existing worktree $WT_PATH"
else
  [ "$DO_FETCH" -eq 1 ] && git -C "$PRIMARY" fetch origin --quiet
  mkdir -p "$(dirname "$WT_PATH")"
  # --no-track is deliberate: this repo sets push.default=upstream, so a branch
  # tracking origin/master makes a bare `git push` target protected master.
  if git -C "$PRIMARY" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    say "branch $BRANCH already exists — checking it out into the worktree"
    git -C "$PRIMARY" worktree add "$WT_PATH" "$BRANCH" || die "worktree add failed" 65
  else
    git -C "$PRIMARY" worktree add --no-track -b "$BRANCH" "$WT_PATH" "$BASE" || die "worktree add failed" 65
  fi
  say "worktree $BRANCH -> $WT_PATH (base $BASE)"
fi

# ---------------------------------------------------------------------------
# 2) The FULL Hektor pack: skills + hooks + schemas + the gate settings.
# ---------------------------------------------------------------------------
# install.sh §5 delegates to every kit's own installer, so this single call
# covers skills/ hooks/ schemas/ the gate settings AND each kit (which
# self-configures its run.workdir against this worktree). Don't drive the kit
# installers again here — that path re-ran them and doubled the output.
pack_log="$(mktemp)"
if ! "$PACK/install.sh" --harness "$HARNESS" --project "$WT_PATH" > "$pack_log" 2>&1; then
  sed -n '$p' "$pack_log" >&2; rm -f "$pack_log"; die "pack install failed" 65
fi
say "pack installed --harness $HARNESS ($(grep -c "^install: kit .* installed" "$pack_log") kit(s), gates on)"
grep -E "^install: WARN" "$pack_log" >&2
rm -f "$pack_log"
ensure_excluded "/.claude/"
[ "$WANT_CURSOR" -eq 1 ] && ensure_excluded "/.cursor/"

# ---------------------------------------------------------------------------
# 3) Local-only harness + build files that git never carries.
# ---------------------------------------------------------------------------
copied=()
for f in "${HARNESS_FILES[@]}" "${BUILD_FILES[@]}"; do
  [ -e "$PRIMARY/$f" ] || continue
  [ -e "$WT_PATH/$f" ] && continue
  mkdir -p "$(dirname "$WT_PATH/$f")"
  cp -R "$PRIMARY/$f" "$WT_PATH/$f" && copied+=("$f")
  ensure_excluded "/$f"
done
[ "${#copied[@]}" -gt 0 ] && say "copied from primary: ${copied[*]}"
mkdir -p "$WT_PATH/docs/hektor"
ensure_excluded "/docs/hektor/"

# ---------------------------------------------------------------------------
# 4) Auto-memory. The worktree's path yields its own ~/.claude/projects/<slug>/,
#    so without this a session there starts with none of the hard-won facts.
#    A symlink (not a copy) keeps ONE source of truth across every worktree.
# ---------------------------------------------------------------------------
PRIMARY_MEM="$HOME/.claude/projects/$(claude_slug "$PRIMARY")/memory"
WT_PROJ="$HOME/.claude/projects/$(claude_slug "$WT_PATH")"
if [ -d "$PRIMARY_MEM" ]; then
  mkdir -p "$WT_PROJ"
  if [ -L "$WT_PROJ/memory" ]; then
    say "memory symlink already present"
  elif [ -d "$WT_PROJ/memory" ]; then
    say "WARNING: $WT_PROJ/memory is a real dir — left alone, memory NOT shared"
  else
    ln -s "$PRIMARY_MEM" "$WT_PROJ/memory" && say "memory -> $PRIMARY_MEM"
  fi
else
  say "WARNING: primary has no memory dir at $PRIMARY_MEM — nothing to share"
fi

# ---------------------------------------------------------------------------
# 5) Provision record, so forest's Repair button replays the FULL pack rather
#    than whatever subset happened to be ticked in the UI.
# ---------------------------------------------------------------------------
PACK_ID="$(jq -r '.pack // "hektor"' "$PACK/catalog.json" 2>/dev/null || echo hektor)"
mkdir -p "$WT_PATH/.claude"
jq -n --arg pack "$PACK_ID" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson skills "$(jq '[.skillsets[].id]' "$PACK/catalog.json")" \
  --argjson kits "$(jq '[.kits[].id]' "$PACK/catalog.json")" \
  '{at: $at, selections: [{pack: $pack, skills: $skills, kits: $kits, hooks: true}]}' \
  > "$WT_PATH/.claude/.forest-provision.json"
say "provision record written (full pack, gates on)"

# Where this worktree's harness came from. install.sh copies skills/ hooks/
# schemas/ but NOT the pack's scripts/, so a session inside the worktree has no
# other way to find worktree-provision.sh again (for the next ticket, or to
# re-verify). Self-describing beats guessing at a machine-specific path.
printf '%s\n' "$PACK" > "$WT_PATH/.claude/.hektor-pack-origin"

verify; rc=$?
echo
say "ready: cd $WT_PATH"
[ "$rc" -eq 0 ] || exit 67
