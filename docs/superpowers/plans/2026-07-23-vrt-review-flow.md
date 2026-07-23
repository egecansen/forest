# VRT Review Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` tracking.

**Goal:** Carry each VRT failure's baseline-vs-regression URL through the ledger (v2 contract) to the console, which renders a per-test VRT review gallery on `vrt`-bucket clusters so the user reviews each diff in one click.

**Architecture:** The kit already extracts `vrt_url` per VRT failure during ingest (`core/ingest.sh:85`). Add a validated `ledger.sh cluster-vrt` subcommand that records it per test; the watcher-v2 reads it; ClustersTab renders link-cards. Consistent with the just-shipped Stage 2 presentation contract.

**Tech Stack:** bash+jq (kit), TypeScript/vitest/React (console). No new deps.

## Global Constraints

- Kit is currently LOCKED. Unlock/relock bracket: `HEKTOR_FLAKYKIT_UNLOCK=1 kits/flaky-triage-kit/core/lock-kit.sh unlock` … `lock`; prefix every kit write with `HEKTOR_FLAKYKIT_UNLOCK=1`.
- VRT URL validation: must match `^https://vrt-` (the exact prefix `ingest.sh` extracts) and contain no whitespace; cap 500 chars.
- ledger `tests[]` entry shape becomes `{ fqcn, status?, vrt? }`; `vrt` is the URL string.
- Console `Cluster` gains `vrt?: { fqcn: string; url: string }[]` (parallel to `divergent`), server + client types identical.
- Commit messages: NO AI-attribution trailers.
- Console suites green (`npm --prefix server test`, `npm --prefix client test`, `npm run build`, `npx playwright test` from apps/console); live :8790 untouched.
- ledger.sh: `set -uo pipefail`, jq only, untrusted values via `--arg`; bash 3.2 compatible.

---

### Task 1: Kit — `cluster-vrt` subcommand + kernel + adapters + repackage

**Files:** `kits/flaky-triage-kit/core/ledger.sh`, `core/tests/ledger-test.sh`, `kernel.md`, `adapters/claude/SKILL.md`, `adapters/cursor/hektor-flaky-triage.mdc`, `core/README.md`; regenerate `kits/flaky-triage-kit.zip`.

**Interfaces produced:**
- `ledger.sh cluster-vrt <file> <id> <fqcn> <url>` — validates id exists (exit 66 unknown), fqcn shape (exit 65), url `^https://vrt-\S+$` ≤500 (exit 65); sets `.clusters[id].tests[fqcn].vrt = url`, creating the test entry if absent (mirrors `cluster-state --test`'s upsert-or-set). `validate` schema additionally rejects any `tests[].vrt` not matching the URL rule.

- [ ] **Step 1: Unlock, then add failing tests** to `core/tests/ledger-test.sh` (before the final summary line):

```bash
# --- cluster-vrt
"$LEDGER" cluster-upsert "$F" c-vrt --bucket vrt --title "VRT drift" --tests "com.x.VrtTest#a" >/dev/null 2>&1
expect 0  "valid vrt url set"        -- "$LEDGER" cluster-vrt "$F" c-vrt com.x.VrtTest#a "https://vrt-test.example/compare/123"
[ "$(jq -r '.clusters[]|select(.id=="c-vrt")|.tests[0].vrt' "$F")" = "https://vrt-test.example/compare/123" ] && ok || bad "vrt url recorded"
expect 65 "non-vrt url rejected"     -- "$LEDGER" cluster-vrt "$F" c-vrt com.x.VrtTest#a "https://evil.example/x"
expect 65 "url with space rejected"  -- "$LEDGER" cluster-vrt "$F" c-vrt com.x.VrtTest#a "https://vrt-x.example/a b"
expect 66 "unknown cluster rejected" -- "$LEDGER" cluster-vrt "$F" nope com.x.VrtTest#a "https://vrt-x.example/a"
expect 0  "vrt creates missing test entry" -- "$LEDGER" cluster-vrt "$F" c-vrt com.x.NewTest "https://vrt-x.example/9"
[ "$(jq -r '.clusters[]|select(.id=="c-vrt")|.tests|length' "$F")" = "2" ] && ok || bad "vrt added new test entry"
# validate catches a hand-corrupted vrt url
jq '.clusters[0].tests[0].vrt="http://not-vrt"' "$F" > "$TMP/bad.json"
expect 65 "validate rejects bad tests[].vrt" -- "$LEDGER" validate "$TMP/bad.json"
```

Run RED: `HEKTOR_FLAKYKIT_UNLOCK=1 bash kits/flaky-triage-kit/core/tests/ledger-test.sh` — new cases fail (unknown cmd).

- [ ] **Step 2: Implement `cluster-vrt`** in `ledger.sh` (add a case; define `VRT_RE='^https://vrt-[^[:space:]]+$'` near the other REs; cap check `[ ${#URL} -le 500 ]`; reuse `FQCN_RE`, the `die` codes, and the tests-upsert jq idiom from `cluster-state --test`):

```bash
  cluster-vrt)
    ID="${3:-}"; FQ="${4:-}"; URL="${5:-}"
    [ -n "$ID" ] && [ -n "$FQ" ] && [ -n "$URL" ] || die "cluster-vrt: need <id> <fqcn> <url>" 64
    jq -e --arg id "$ID" 'any(.clusters[]; .id==$id)' "$FILE" >/dev/null || die "unknown cluster id: $ID" 66
    [[ "$FQ"  =~ $FQCN_RE ]] || die "invalid fqcn: $FQ"
    [ ${#URL} -le 500 ] || die "vrt url >500 chars"
    [[ "$URL" =~ $VRT_RE ]] || die "invalid vrt url (must be ^https://vrt- , no whitespace): $URL"
    jset '.clusters |= map(if .id==$id then
            .tests |= (map(if .fqcn==$fq then .vrt=$url else . end)
                       + (if any(.[]; .fqcn==$fq) then [] else [{fqcn:$fq, vrt:$url}] end))
          else . end)' \
      --arg id "$ID" --arg fq "$FQ" --arg url "$URL" ;;
```

Extend `validate`'s cluster jq check to also flag bad vrt: add to the `select(...)` disjunction `or (any(.tests[]?; has("vrt") and (.vrt|test("^https://vrt-[^\\s]+$")|not)))`. Add `cluster-vrt` to the usage string.

- [ ] **Step 3: Run GREEN** — full suite 0 failed; `bash -n` clean.
- [ ] **Step 4: kernel §8** — tests[] entry becomes `tests[ {fqcn, status?, vrt?} ]`; add a line under the schema: `vrt = baseline-vs-regression URL for a VRT failure (ingest's vrt_url tag), set via ledger.sh cluster-vrt.`
- [ ] **Step 5: Adapters** — in both SKILL.md and the .mdc loop step 3 (progress recording), append: `For vrt-bucket clusters, record each failing test's vrt_url (ingest tags it) via core/ledger.sh cluster-vrt <id> <fqcn> <url> so the console can surface the baseline-vs-regression review.`
- [ ] **Step 6: README** ledger row: append `· cluster-vrt` to the subcommand list.
- [ ] **Step 7:** reinstall (`kits/flaky-triage-kit/hektor-triage-kit install --project /Users/egecan.sen/sahibinden/repo/web-test`), verify installed test suite runs green, regenerate zip (`cd kits && rm -f flaky-triage-kit.zip && zip -rq flaky-triage-kit.zip flaky-triage-kit -x '*.DS_Store' -x '*/.achilles/*' -x '*/.git/*'`), re-lock (`core/lock-kit.sh lock`).
- [ ] **Step 8: Commit** (README + kit files; zip untracked): `kit: ledger cluster-vrt — per-test baseline-vs-regression URLs`

---

### Task 2: Console — VRT data through watcher + review gallery

**Files:** `apps/console/server/src/types.ts` + `client/src/types.ts` (Cluster gains `vrt?`), `server/src/ledger-watcher.ts`, `server/src/__tests__/ledger-watcher-v2.test.ts`, `client/src/components/ClustersTab.tsx`, `client/src/__tests__/clusters-tab.test.tsx`, minor `global.css`.

**Interfaces consumed:** ledger `tests[].vrt` (Task 1).

- [ ] **Step 1: Types** — add `vrt?: { fqcn: string; url: string }[]` to `Cluster` in BOTH server and client `types.ts` (identical text, next to `divergent`).
- [ ] **Step 2: Watcher failing test** — extend the v2 fixture: give `c1-selectors`… no — add a `vrt`-bucket cluster whose `tests` include `{fqcn:'com.x.VrtTest', vrt:'https://vrt-x.example/compare/9'}`. Assert the created cluster carries `vrt: [{fqcn:'com.x.VrtTest', url:'https://vrt-x.example/compare/9'}]`, and that a re-parse with unchanged vrt emits no update (diff includes vrt). RED first.
- [ ] **Step 3: Watcher impl** — in `buildDesiredClusterV2`, populate `vrt` from ledger `tests[]` entries that have a `vrt` field (`{fqcn, url: t.vrt}`), `undefined` when none. Extend `diffClusterV2` to compare `vrt` (fqcn-sorted, like tests/divergent).
- [ ] **Step 4: ClustersTab failing test** — a `vrt`-bucket cluster with `vrt` entries, expanded, renders a "VRT REVIEW" section: one card per entry with the test name (mono) and an `open baseline-vs-regression ↗` link (`href` = url, `target=_blank`, `rel=noreferrer`). RTL asserts the link href + test name. RED first.
- [ ] **Step 5: ClustersTab impl** — in the expanded row, when `cluster.bucket === 'vrt'` and `cluster.vrt?.length`, render the VRT-review section (eyebrow `VRT REVIEW`, cards with test name + the open link). Add `.vrt-review`/`.vrt-card` styles in global.css using existing tokens, both themes. (Link-cards, not embedded images — the VRT image-URL pattern is unknown; embedding is a deferred follow-up noted here.)
- [ ] **Step 6:** full server+client suites + build + e2e green.
- [ ] **Step 7: Commit** — `console: VRT review gallery on vrt-bucket clusters`

---

## Self-review notes

- Coverage: kit subcommand+validate+kernel+adapters+repackage (T1), console types+watcher+UI (T2). VRT URL validation identical string (`^https://vrt-…`) in kit write, kit validate, and (implicitly trusted thereafter) console.
- Deferred: embedded baseline/actual/diff thumbnails — needs the VRT tool's image-URL pattern; link-cards ship now.
- Type consistency: `vrt?: {fqcn,url}[]` identical server/client; ledger field is `tests[].vrt` (URL string) → console maps to `{fqcn,url}`.
