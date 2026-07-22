# Kit Presentation Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ledger.json` v2 the machine-readable ground truth of a triage run — titled clusters in six canonical buckets, verified pass counts, phase events, and a machine-enforced session-end rule — for every harness.

**Architecture:** Amend `kernel.md` in place (§5.1 bucket column, §7 I11, §8 v2 schema); extend `core/ledger.sh` with validated write subcommands + a `validate [--final]` gate; add the discipline to both adapters; upgrade the console's ledger watcher to a v2 consumer; refresh install/zip. v1 ledgers stay readable (consumers key on `version`).

**Tech Stack:** bash + jq (kit), TypeScript/vitest (console). No new dependencies anywhere.

**Spec:** `docs/superpowers/specs/2026-07-22-kit-presentation-contract-design.md`

## Global Constraints

- Kit surface is self-protected: prefix EVERY command that writes under `kits/flaky-triage-kit/` with `HEKTOR_FLAKYKIT_UNLOCK=1`, and bracket kit tasks with `kits/flaky-triage-kit/core/lock-kit.sh unlock` / `lock` (harmless when already unlocked).
- Canonical bucket enum (exact strings): `easy-fix selector vrt app-change infra likely-bug`.
- Cluster statuses (exact): `proposed selected applied green deferred flagged resolved-upstream`; terminal = `green deferred flagged resolved-upstream`; `validate --final` fails on any cluster in `selected` or `applied`.
- Phases (exact): `ingest confirm cluster pick fix verify report`.
- Caps: `title` ≤80 chars, `detail` ≤600 chars, cluster id `^[a-z0-9-]{1,40}$`, FQCN `^[A-Za-z_][A-Za-z0-9_.]*(#[A-Za-z0-9_]+)?$`, `passes ≤ runs`, both integers ≥0.
- I7: titles/details must never contain raw stack traces — enforced by discipline + length caps, not parsing.
- Commit messages: NO AI-attribution trailers (repo hook rejects them).
- Console: suites green (`npm --prefix server test`, `npm --prefix client test`, `npm run build`, `npx playwright test` from `apps/console`); live server on :8790 untouched.
- jq only in kit scripts (no python for ledger work); `set -uo pipefail`; untrusted values bound via `--arg`, never interpolated into filters.

## File Structure

```
kits/flaky-triage-kit/
├─ core/ledger.sh                 # MODIFY: + cluster-upsert, cluster-state, event, validate; init stamps version 2
├─ core/tests/ledger-test.sh      # NEW: plain-bash test suite (first kit test file)
├─ core/README.md                 # MODIFY: ledger contract row → v2
├─ kernel.md                      # MODIFY: §5.1 bucket column · §7 I11 row · §8 v2 schema
├─ adapters/claude/SKILL.md       # MODIFY: discipline block (3 rules) + Don'ts line
└─ adapters/cursor/hektor-flaky-triage.mdc  # MODIFY: same discipline block
apps/console/server/src/
├─ ledger-watcher.ts              # MODIFY: v2 consumer (create clusters, passes/runs, divergence, phase events)
├─ types.ts (+ client twin)       # MODIFY: Cluster gains divergent?: {fqcn, status}[]
├─ driver.ts / driver-prompt.ts   # MODIFY: HEKTOR_DISABLE_MCP acceptance switch
└─ __tests__/ledger-watcher-v2.test.ts  # NEW
apps/console/client/src/components/ClustersTab.tsx  # MODIFY: render divergent tests
kits/flaky-triage-kit.zip         # REGENERATED (Task 4)
```

---

### Task 1: `ledger.sh` v2 subcommands + validate + first kit test suite

**Files:**
- Modify: `kits/flaky-triage-kit/core/ledger.sh`
- Create: `kits/flaky-triage-kit/core/tests/ledger-test.sh` (chmod +x)

**Interfaces:**
- Produces (later tasks + the console rely on these exact shapes):
  - `ledger.sh init <file>` → `{run:{version:2}, clusters:[], events:[]}`
  - `ledger.sh cluster-upsert <file> <id> [--title T] [--detail D] [--bucket B] [--tier N] [--signature S] [--fix-vs-bug F] [--tests csv-of-fqcns]` — creates with `status:"proposed"` or merges provided fields into existing; validates id/bucket/caps/FQCNs; exit 65 on validation failure with a one-line reason on stderr.
  - `ledger.sh cluster-state <file> <id> <status> [--passes N] [--runs N] [--test fqcn=red|green|skipped]…` — validates transition + counts; repeated `--test` sets per-test divergence entries; exit 65 invalid, 66 unknown id.
  - `ledger.sh event <file> <what> [--phase P] [--who W]` — appends `{who,what,when,phase?}` (`when` = ISO-8601 UTC; `who` defaults `$USER`).
  - `ledger.sh validate <file> [--final]` — exit 0 clean; exit 65 schema violation; with `--final` also exit 67 listing ids of clusters still `selected`/`applied`.
  - v2 cluster JSON keys: `id title detail signature tier bucket fixVsBug evidence tests status passes runs diffRef lineage greenProofScope`; `tests` = array of `{fqcn, status?}`.

- [ ] **Step 1: Write the failing test suite**

`kits/flaky-triage-kit/core/tests/ledger-test.sh` (complete file):

```bash
#!/bin/bash
# First test suite for core/ledger.sh (v2 contract). Plain bash asserts, no framework.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER="$HERE/../ledger.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
F="$TMP/ledger.json"
pass=0; fail=0
ok()   { pass=$((pass+1)); }
bad()  { fail=$((fail+1)); echo "FAIL: $1" >&2; }
# expect <expected-exit> <desc> -- cmd...
expect() { local want="$1" desc="$2"; shift 3
  "$@" >/dev/null 2>&1; local got=$?
  [ "$got" -eq "$want" ] && ok || bad "$desc (want exit $want, got $got)"; }

# --- init stamps version 2
"$LEDGER" init "$F" 2>/dev/null
[ "$(jq -r '.run.version' "$F")" = "2" ] && ok || bad "init stamps run.version=2"

# --- upsert: create + validation
expect 0  "valid upsert creates proposed" -- "$LEDGER" cluster-upsert "$F" c1-selectors \
  --title "Relocated selectors" --detail "blog anchor moved" --bucket selector \
  --tests "com.x.FooTest#a,com.x.BarTest"
[ "$(jq -r '.clusters[0].status' "$F")" = "proposed" ] && ok || bad "created status proposed"
[ "$(jq -r '.clusters[0].tests[0].fqcn' "$F")" = "com.x.FooTest#a" ] && ok || bad "tests are {fqcn} objects"
expect 65 "bad bucket rejected"      -- "$LEDGER" cluster-upsert "$F" c2 --bucket banana
expect 65 "bad id rejected"          -- "$LEDGER" cluster-upsert "$F" "C2 UPPER" --bucket vrt
expect 65 "overlong title rejected"  -- "$LEDGER" cluster-upsert "$F" c2 --bucket vrt --title "$(printf 'x%.0s' {1..81})"
expect 65 "bad fqcn rejected"        -- "$LEDGER" cluster-upsert "$F" c2 --bucket vrt --tests 'rm -rf /'
expect 0  "upsert merges (idempotent)" -- "$LEDGER" cluster-upsert "$F" c1-selectors --title "Relocated selectors v2"
[ "$(jq '.clusters | length' "$F")" = "1" ] && ok || bad "merge did not duplicate"

# --- state transitions
expect 0  "proposed→selected"        -- "$LEDGER" cluster-state "$F" c1-selectors selected
expect 0  "selected→applied+counts"  -- "$LEDGER" cluster-state "$F" c1-selectors applied --passes 1 --runs 3
expect 65 "passes>runs rejected"     -- "$LEDGER" cluster-state "$F" c1-selectors applied --passes 4 --runs 3
expect 0  "applied→applied count update" -- "$LEDGER" cluster-state "$F" c1-selectors applied --passes 2 --runs 3
expect 0  "per-test divergence"      -- "$LEDGER" cluster-state "$F" c1-selectors applied --test "com.x.FooTest#a=green"
[ "$(jq -r '.clusters[0].tests[0].status' "$F")" = "green" ] && ok || bad "divergence recorded"
expect 65 "applied→proposed rejected"    -- "$LEDGER" cluster-state "$F" c1-selectors proposed
expect 66 "unknown id rejected"          -- "$LEDGER" cluster-state "$F" nope green
expect 0  "applied→green"                -- "$LEDGER" cluster-state "$F" c1-selectors green
expect 65 "terminal→selected rejected"   -- "$LEDGER" cluster-state "$F" c1-selectors selected

# --- events
expect 0  "phase event"  -- "$LEDGER" event "$F" phase-enter --phase verify
expect 65 "bad phase"    -- "$LEDGER" event "$F" phase-enter --phase warp
[ "$(jq -r '.events[-1].phase' "$F")" = "verify" ] && ok || bad "event phase recorded"

# --- validate
expect 0  "validate clean"           -- "$LEDGER" validate "$F"
expect 0  "validate --final clean"   -- "$LEDGER" validate "$F" --final
"$LEDGER" cluster-upsert "$F" c9 --bucket infra --title t >/dev/null 2>&1
"$LEDGER" cluster-state  "$F" c9 selected >/dev/null 2>&1
expect 67 "--final fails on selected"  -- "$LEDGER" validate "$F" --final
expect 0  "plain validate still clean" -- "$LEDGER" validate "$F"

# --- v1 tolerance
jq -n '{run:{}, clusters:[{id:"old"}], events:[]}' > "$TMP/v1.json"
expect 0 "v1 file passes validate" -- "$LEDGER" validate "$TMP/v1.json"

echo "ledger-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

- [ ] **Step 2: Run it — must fail** (subcommands don't exist yet):

Run: `HEKTOR_FLAKYKIT_UNLOCK=1 bash kits/flaky-triage-kit/core/tests/ledger-test.sh`
Expected: many FAILs / non-zero exit (unknown cmd → exit 64).

- [ ] **Step 3: Implement `ledger.sh` v2** — replace the file body with (keeps init/get/set verbatim, adds the rest):

```bash
#!/bin/bash
# core/ledger.sh — run-state I/O (resumable, auditable). v2: presentation contract (kernel §8).
#
# Enforces: I5 — callers re-derive "already applied" from SOURCE, never trust this ledger for a safety decision.
#           I11 — `validate --final` is the machine gate: no session ends with selected/applied clusters.
# Writes: route ALL mutations through cluster-upsert / cluster-state / event (kernel P2). `set` remains
# for exotic repairs only. Untrusted values bind via --arg (jq-injection discipline).
set -uo pipefail
command -v jq >/dev/null || { echo "ledger: jq required" >&2; exit 69; }
CMD="${1:-}"; FILE="${2:-}"
[ -n "$CMD" ] && [ -n "$FILE" ] || { echo "usage: ledger.sh init|get|set|cluster-upsert|cluster-state|event|validate <file> [...]" >&2; exit 64; }

BUCKETS="easy-fix selector vrt app-change infra likely-bug"
PHASES="ingest confirm cluster pick fix verify report"
TERMINAL="green deferred flagged resolved-upstream"
FQCN_RE='^[A-Za-z_][A-Za-z0-9_.]*(#[A-Za-z0-9_]+)?$'
ID_RE='^[a-z0-9-]{1,40}$'

die() { echo "ledger: $1" >&2; exit "${2:-65}"; }
has_word() { case " $1 " in *" $2 "*) return 0;; *) return 1;; esac; }
jset() { local flt="$1"; shift; local tmp; tmp="$(mktemp)"; jq "$@" "$flt" "$FILE" > "$tmp" && mv "$tmp" "$FILE"; }

# transition <from> <to> → 0 ok / 1 reject. Same-status updates allowed for count/test refreshes.
transition_ok() {
  local from="$1" to="$2"
  [ "$from" = "$to" ] && { has_word "$TERMINAL" "$from" && return 1 || return 0; }
  has_word "$TERMINAL" "$from" && return 1
  case "$from:$to" in
    proposed:selected|proposed:deferred|proposed:resolved-upstream) return 0;;
    selected:applied|selected:deferred|selected:flagged|selected:resolved-upstream) return 0;;
    applied:green|applied:flagged|applied:deferred|applied:resolved-upstream) return 0;;
    *) return 1;;
  esac
}

case "$CMD" in
  init) jq -n '{run:{version:2}, clusters:[], events:[]}' > "$FILE"; echo "ledger: initialized $FILE (v2)" >&2 ;;
  get)  jq -r "${3:-.}" "$FILE" ;;
  set)  flt="${3:?ledger set: need a jq filter}"; shift 3
        tmp="$(mktemp)"; jq "$@" "$flt" "$FILE" > "$tmp" && mv "$tmp" "$FILE" ;;

  cluster-upsert)
    ID="${3:-}"; [ -n "$ID" ] || die "cluster-upsert: need <id>" 64; shift 3
    printf '%s' "$ID" | grep -qE "$ID_RE" || die "invalid cluster id: $ID"
    ARGS=(); TESTS_CSV=""
    while [ $# -gt 0 ]; do case "$1" in
      --title)      [ ${#2} -le 80 ]  || die "title >80 chars";  ARGS+=(--arg title "$2");  shift 2;;
      --detail)     [ ${#2} -le 600 ] || die "detail >600 chars"; ARGS+=(--arg detail "$2"); shift 2;;
      --bucket)     has_word "$BUCKETS" "$2" || die "invalid bucket: $2"; ARGS+=(--arg bucket "$2"); shift 2;;
      --tier)       printf '%s' "$2" | grep -qE '^[1-4]$' || die "tier must be 1-4"; ARGS+=(--arg tier "$2"); shift 2;;
      --signature)  ARGS+=(--arg signature "$2"); shift 2;;
      --fix-vs-bug) ARGS+=(--arg fixVsBug "$2"); shift 2;;
      --tests)      TESTS_CSV="$2"; shift 2;;
      *) die "cluster-upsert: unknown flag $1" 64;;
    esac; done
    TESTS_JSON="[]"
    if [ -n "$TESTS_CSV" ]; then
      IFS=',' read -ra FQ <<< "$TESTS_CSV"
      for f in "${FQ[@]}"; do printf '%s' "$f" | grep -qE "$FQCN_RE" || die "invalid fqcn: $f"; done
      TESTS_JSON="$(printf '%s\n' "${FQ[@]}" | jq -R '{fqcn:.}' | jq -s '.')"
    fi
    jset '
      (if any(.clusters[]; .id==$id) then . else .clusters += [{id:$id, status:"proposed", tests:[]}] end)
      | .clusters |= map(if .id==$id then
          . + ($ARGS.named | with_entries(select(.key != "id")))
          + (if ($tests | length) > 0 then {tests:$tests} else {} end)
        else . end)' \
      --arg id "$ID" --argjson tests "$TESTS_JSON" "${ARGS[@]}" ;;

  cluster-state)
    ID="${3:-}"; TO="${4:-}"; [ -n "$ID" ] && [ -n "$TO" ] || die "cluster-state: need <id> <status>" 64; shift 4
    has_word "proposed selected applied $TERMINAL" "$TO" || die "invalid status: $TO"
    FROM="$(jq -r --arg id "$ID" '.clusters[] | select(.id==$id) | .status // empty' "$FILE")"
    [ -n "$FROM" ] || die "unknown cluster id: $ID" 66
    transition_ok "$FROM" "$TO" || die "invalid transition: $FROM → $TO"
    PASSES=""; RUNS=""; TESTUPS=()
    while [ $# -gt 0 ]; do case "$1" in
      --passes) printf '%s' "$2" | grep -qE '^[0-9]+$' || die "passes must be integer"; PASSES="$2"; shift 2;;
      --runs)   printf '%s' "$2" | grep -qE '^[0-9]+$' || die "runs must be integer";   RUNS="$2";   shift 2;;
      --test)   fq="${2%%=*}"; st="${2#*=}"
                printf '%s' "$fq" | grep -qE "$FQCN_RE" || die "invalid fqcn: $fq"
                has_word "red green skipped" "$st" || die "invalid test status: $st"
                TESTUPS+=("$fq=$st"); shift 2;;
      *) die "cluster-state: unknown flag $1" 64;;
    esac; done
    if [ -n "$PASSES" ] && [ -n "$RUNS" ]; then [ "$PASSES" -le "$RUNS" ] || die "passes > runs"; fi
    jset '.clusters |= map(if .id==$id then .status=$to
            | (if $passes != "" then .passes=($passes|tonumber) else . end)
            | (if $runs   != "" then .runs=($runs|tonumber)     else . end)
          else . end)' \
      --arg id "$ID" --arg to "$TO" --arg passes "${PASSES}" --arg runs "${RUNS}"
    for up in ${TESTUPS[@]+"${TESTUPS[@]}"}; do
      jset '.clusters |= map(if .id==$id then
              .tests |= (map(if .fqcn==$fq then .status=$st else . end)
                         + (if any(.[]; .fqcn==$fq) then [] else [{fqcn:$fq, status:$st}] end))
            else . end)' \
        --arg id "$ID" --arg fq "${up%%=*}" --arg st "${up#*=}"
    done ;;

  event)
    WHAT="${3:-}"; [ -n "$WHAT" ] || die "event: need <what>" 64; shift 3
    PHASE=""; WHO="${USER:-unknown}"
    while [ $# -gt 0 ]; do case "$1" in
      --phase) has_word "$PHASES" "$2" || die "invalid phase: $2"; PHASE="$2"; shift 2;;
      --who)   WHO="$2"; shift 2;;
      *) die "event: unknown flag $1" 64;;
    esac; done
    jset '.events += [{who:$who, what:$what, when:$when}
                      + (if $phase != "" then {phase:$phase} else {} end)]' \
      --arg who "$WHO" --arg what "$WHAT" --arg when "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg phase "$PHASE" ;;

  validate)
    MODE="${3:-}"
    jq -e 'type=="object" and (.clusters|type=="array") and (.events|type=="array")' "$FILE" >/dev/null \
      || die "not a ledger: missing clusters/events arrays"
    BAD="$(jq -r '[.clusters[] | select(
        (.id? // "" | test("'"$ID_RE"'") | not) or
        ((.status? // "proposed") as $s | ["proposed","selected","applied","green","deferred","flagged","resolved-upstream"] | index($s) | not) or
        ((.title? // "" | length) > 80) or ((.detail? // "" | length) > 600) or
        (has("passes") and has("runs") and .passes > .runs)
      ) | .id // "?"] | join(",")' "$FILE")"
    [ -z "$BAD" ] || die "schema violations in clusters: $BAD"
    if [ "$MODE" = "--final" ]; then
      OPEN="$(jq -r '[.clusters[] | select(.status=="selected" or .status=="applied") | .id] | join(",")' "$FILE")"
      [ -z "$OPEN" ] || { echo "ledger: NOT FINAL — non-terminal selected/applied clusters: $OPEN" >&2; exit 67; }
    fi
    echo "ledger: valid${MODE:+ ($MODE)}" >&2 ;;

  *) echo "ledger: unknown cmd '$CMD'" >&2; exit 64 ;;
esac
# I5 reminder: before apply, check the fix's presence in CURRENT source — not this ledger. P7: integrity/locking for shared use.
```

- [ ] **Step 4: Run the suite to green**

Run: `HEKTOR_FLAKYKIT_UNLOCK=1 bash kits/flaky-triage-kit/core/tests/ledger-test.sh`
Expected: `ledger-test: N passed, 0 failed`, exit 0. Also `chmod +x` both files.

- [ ] **Step 5: Commit** — `git add kits/flaky-triage-kit/core/ledger.sh kits/flaky-triage-kit/core/tests/ledger-test.sh && git commit -m "kit: ledger v2 — validated cluster/event subcommands + validate gate + first test suite"`

---

### Task 2: kernel.md amendments (§5.1 bucket column · §7 I11 · §8 v2)

**Files:**
- Modify: `kits/flaky-triage-kit/kernel.md` (§5.1 table, §7 table, §8 block)

**Interfaces:**
- Consumes: Task 1's exact enums/caps (must match verbatim).
- Produces: the normative spec text Tasks 3/5 cite.

- [ ] **Step 1: §5.1 — add a `Bucket` column** to the signatures table with these mappings (append `| Bucket |` header cell and per-row values): passes on re-run → `infra` · broken box → `infra` · OneTrust intercept → `easy-fix` · VRT exception → `vrt` · generated/hard-coded id selector → `selector` · filter-value-by-text → `infra` · IndexOutOfBounds empty list → `easy-fix` · app contract violation → `likely-bug` · testbox-data assumption → `app-change`. Under the table add: `**Canonical presentation buckets (closed enum):** easy-fix · selector · vrt · app-change · infra · likely-bug — every cluster carries exactly one (§8).`

- [ ] **Step 2: §7 — append invariant row:**

```
| **I11** | **A session may not end while any cluster is `selected`/`applied`** — run `core/ledger.sh validate --final <ledger>` before the convergence summary; non-zero exit means the run is NOT done (collect verdicts; never background the green-proof and quit) | premature completion / unverified "fixed" claims |
```

- [ ] **Step 3: §8 — replace the schema block** with the v2 block from the spec (run gains `version: 2`; cluster gains `title` ≤80 / `detail` ≤600 / closed `bucket` / `tests[{fqcn,status?}]` / `passes,runs`; event gains `phase?` with the 7-value enum + the consumer-mapping note; add: `All writes go through ledger.sh subcommands (cluster-upsert / cluster-state / event) — hand-edited JSON violates P2. v1 files (no version) remain readable.`)

- [ ] **Step 4: Commit** — `git add kits/flaky-triage-kit/kernel.md && git commit -m "kit: kernel v2 — canonical buckets, I11 session-end gate, ledger presentation schema"`

---

### Task 3: Adapter discipline (SKILL.md + cursor .mdc)

**Files:**
- Modify: `kits/flaky-triage-kit/adapters/claude/SKILL.md`
- Modify: `kits/flaky-triage-kit/adapters/cursor/hektor-flaky-triage.mdc`

**Interfaces:** Consumes Task 1 subcommands + Task 2 I11. Both adapters get the same canonical wording.

- [ ] **Step 1: In SKILL.md's "The loop"**, amend step 2 (after "re-group it into meaning buckets"): add — `Publish as you go: after the mechanical cut, upsert provisional clusters (core/ledger.sh cluster-upsert — short titles fine); refine title/detail/bucket via the same command before presenting. The table you present IS the ledger's clusters — never two divergent copies.` Amend step 3 (after the green-proof sentence): add — `Record progress with core/ledger.sh cluster-state (selected → applied --passes/--runs → green|flagged), and phase transitions with core/ledger.sh event phase-enter --phase <p>.`

- [ ] **Step 2: In SKILL.md's "Don'ts (hard)"** add to the list: `end the session while ledger.sh validate --final fails (a selected/applied cluster without a verdict — wait for the reruns, never background-and-quit)`. Add the same three additions (publish-as-you-go, cluster-state/event recording, the validate-final Don't) to the cursor `.mdc`'s equivalent loop/don'ts sections, phrased identically.

- [ ] **Step 3: Commit** — `git add kits/flaky-triage-kit/adapters && git commit -m "kit: adapters — ledger publish/progress discipline + I11 session-end don't"`

---

### Task 4: core/README.md row, reinstall, zip, re-lock

**Files:**
- Modify: `kits/flaky-triage-kit/core/README.md` (ledger row in the contract table)
- Regenerate: `kits/flaky-triage-kit.zip`

- [ ] **Step 1:** Update the ledger row: `| ledger | read/write run state via validated subcommands (v2: cluster-upsert/cluster-state/event/validate) | I5 re-derive from source · I11 validate --final gates session end |`. Also add under Status: `core/tests/ledger-test.sh — run with bash core/tests/ledger-test.sh`.
- [ ] **Step 2:** Reinstall into web-test (idempotent; copies the updated engine + SKILL): `kits/flaky-triage-kit/hektor-triage-kit install --project /Users/egecan.sen/sahibinden/repo/web-test` — then verify: `bash /Users/egecan.sen/sahibinden/repo/web-test/.claude/skills/hektor-flaky-triage/core/tests/ledger-test.sh` passes and `grep -q "validate --final" /Users/egecan.sen/sahibinden/repo/web-test/.claude/skills/hektor-flaky-triage/SKILL.md`.
- [ ] **Step 3:** Regenerate the zip: `cd kits && rm -f flaky-triage-kit.zip && zip -rq flaky-triage-kit.zip flaky-triage-kit -x '*.DS_Store' -x '*/.achilles/*' && cd -`. Re-lock: `kits/flaky-triage-kit/core/lock-kit.sh lock`.
- [ ] **Step 4:** Commit README (zip stays untracked as before): `git add kits/flaky-triage-kit/core/README.md && git commit -m "kit: README — ledger v2 contract row + test pointer"`

---

### Task 5: Console watcher v2 consumer (+ divergence in UI)

**Files:**
- Modify: `apps/console/server/src/ledger-watcher.ts`
- Modify: `apps/console/server/src/types.ts` + `apps/console/client/src/types.ts` (Cluster gains `divergent?: { fqcn: string; status: 'red' | 'green' | 'skipped' }[]`)
- Modify: `apps/console/client/src/components/ClustersTab.tsx` (expanded row lists divergent tests with their status tint)
- Create: `apps/console/server/src/__tests__/ledger-watcher-v2.test.ts`

**Interfaces:**
- Consumes: v2 ledger JSON (Task 1 shapes), existing `Run.setClusters/updateCluster/setPhase`.
- Produces: v2 behavior — the watcher may CREATE clusters from the ledger; `divergent` populated from `tests[].status`; phases driven forward-only from the latest `phase-enter` event (`confirm`→console `cluster`; others map 1:1); v1 files keep exactly today's behavior (regression suite untouched).

- [ ] **Step 1: Failing tests** (`ledger-watcher-v2.test.ts`) — fixture:

```ts
const V2 = {
  run: { version: 2 },
  clusters: [
    { id: 'c1-selectors', title: 'Relocated selectors', detail: 'blog anchor moved to href/blog',
      bucket: 'selector', status: 'applied', passes: 2, runs: 3,
      tests: [{ fqcn: 'com.x.FooTest#a', status: 'green' }, { fqcn: 'com.x.BarTest' }] },
    { id: 'c2-vrt', title: 'VRT drift', bucket: 'vrt', status: 'proposed',
      tests: [{ fqcn: 'com.x.VrtTest' }] },
  ],
  events: [
    { who: 'u', what: 'phase-enter', when: '2026-07-22T10:00:00Z', phase: 'confirm' },
    { who: 'u', what: 'phase-enter', when: '2026-07-22T10:05:00Z', phase: 'verify' },
  ],
};
```

Tests: (a) empty `run.snapshot.clusters` + V2 file → watcher CREATES both clusters (`setClusters`) with title/bucket/state `verifying` (applied+counts) & `proposed`, passes/runs, divergent `[{fqcn:'com.x.FooTest#a', status:'green'}]`; (b) subsequent tick with same content → zero further calls; (c) status change in file → single `updateCluster`; (d) phase events drive `setPhase` forward-only to `verify` (and never regress on re-read); (e) a v1 fixture (no `version`) → NO cluster creation (existing guarded behavior — reuse an existing v1 fixture to assert unchanged path). RED first.

- [ ] **Step 2: Implement** — in the watcher: detect `ledger?.run?.version === 2`; v2 path builds the full desired `Cluster[]` (map status: proposed→proposed, selected→picked, applied→ (passes/runs present ? verifying : fixing), green→green, flagged→app-bug, deferred→skipped, resolved-upstream→green; `divergent` from tests with `status`; `tests` = fqcn list) and diffs: if the snapshot lacks any ledger cluster id → `setClusters(desired)` (full authoritative replace); else per-cluster diff → `updateCluster`. Phase events: track last applied phase index; map (`ingest`→ingest, `confirm`|`cluster`→cluster, `pick`→pick, `fix`→fix, `verify`→verify, `report`→report); apply via `run.setPhase` marking earlier phases done (forward-only — never regress; reuse the driver's exported forward-only helper or a local equivalent). v1 path byte-identical to today.

- [ ] **Step 3:** ClustersTab expanded view: under the test list, divergent entries render their status chip (`green`/`red`/`skipped` tints). RTL test.

- [ ] **Step 4:** Full console suites + build + e2e green.

- [ ] **Step 5: Commit** — `git add apps/console && git commit -m "console: ledger watcher v2 — authoritative clusters, divergence, phase events"`

---

### Task 6: MCP-disable acceptance switch + acceptance protocol

**Files:**
- Modify: `apps/console/server/src/driver.ts` (+ `driver-prompt.ts`)
- Modify: `apps/console/README.md` (acceptance section)
- Test: extend `apps/console/server/src/__tests__/driver.test.ts`

**Interfaces:** Consumes Task 5. Produces: env `HEKTOR_DISABLE_MCP=1` → `startDriver` omits `mcpServers` entirely and `buildPrompt` gains a boolean `opts.mcpAvailable` (default true); when false, the two `mcp__hektor-console__*` instruction bullets are omitted (the AskUserQuestion + ledger discipline lines remain).

- [ ] **Step 1: Failing tests** — `buildPrompt(cfg, {resume:false, mcpAvailable:false})` contains no `mcp__hektor-console` mention but still contains `AskUserQuestion`; driver test with env set (vi.stubEnv) asserts the options passed to the queryFn have no `mcpServers` key.
- [ ] **Step 2: Implement** (read env once at `startDriver` call time, not module load). 
- [ ] **Step 3:** README acceptance section: run one real triage with `HEKTOR_DISABLE_MCP=1 PORT=8790 npm start`; pass criteria: clusters appear (from ledger within ~2s of the agent's upserts), pick works, chips progress to verdicts, `validate --final` passes before the summary, Report tab complete. 
- [ ] **Step 4:** Suites green; commit — `git add apps/console && git commit -m "console: HEKTOR_DISABLE_MCP acceptance switch"`

---

## Self-review notes (applied)

- Spec coverage: §1→T1+T2, §2→T1, §3→T3, §4→T5, §5→T2/T3/T4 (unlock bracketing in Global Constraints; zip+reinstall T4), §6→T1 (kit tests) + T5 (v2 fixtures) + T6 (acceptance). No gaps.
- Type consistency: bucket/status/phase enums identical across T1 code, T2 spec text, T5 mapping; `tests[{fqcn,status?}]` consistent; exit codes 64/65/66/67/69 disjoint.
- Deliberate simplifications: `cluster-upsert` builds field patches via `$ARGS.named` (jq's named-args object) — implementers should verify their jq ≥1.6 supports it (macOS default does); `--tests` REPLACES the test list on upsert (documented by test `tests are {fqcn} objects` + merge case keeps prior list when flag absent).
