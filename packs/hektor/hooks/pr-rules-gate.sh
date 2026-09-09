#!/bin/bash
# pr-rules-gate.sh — local mirror of the PR reviewer's deterministic (Katman 1a)
#                    rule scan, run at write-time on the working tree.
#
# Events  : preToolUse   -> DENY on a reviewer BLOCKER
#           postToolUse  -> advisory note on reviewer WARNINGs
# State   : none (scans only the content this call adds)
# Env     : HEKTOR_PR_RULES_GATE=off   advisory bypass (document the authorisation)
#
# Why
# ---
# The team's PR reviewer runs a regex pass (Katman 1a) over newly added lines and
# marks the PR "Needs Work" on any BLOCKER. This gate runs the same deterministic
# checks against the lines *this* write adds, so a violation is caught at
# authoring time instead of on the PR. Two repos are covered:
#   - web-ui-test/       (web-test)      : *Page.java / *Layout.java / *Test.java
#   - test-data-client/  (resource data) : *ResourceClient.java / AbName.java
# Detection is by path substring, with a filename fallback.
#
# Why two events
# --------------
# Cursor's `preToolUse` verdict can deny a write but carries no channel for
# advisory text; `postToolUse` carries `additional_context` but runs after the
# write landed. So the gate is registered on both and reads
# `.hook_event_name` to pick its half: BLOCKERs veto the write up front,
# WARNINGs come back as a note once it is on disk. One script, no duplicated
# rule logic. A WARNING-only file is never blocked — matching the reviewer,
# which leaves those as inline comments.
#
# Coverage: the full deterministic Katman 1a set (see the rule sections below),
# plus two file-wide Katman 1b checks that are cheap to do reliably — unused
# import (both repos) and a magic-number-repeated-3+-times heuristic (web-test).
# The remaining Katman 1b rules and all Katman 2 (Gemini semantic) rules stay as
# skill guidance (hektor-conventions, hektor-resource-client), since they need
# whole-suite or semantic analysis a shell scan can't do without false positives.
#
# Scope: only NEW content is scanned, so it mirrors the reviewer's diff-based
# pass and never re-flags pre-existing code. Class-context checks (class-name
# suffix, extends, @Component) are best-effort: they only fire when the class
# declaration is itself part of the added text.
#
# Fail-open like every Hektor gate: missing jq / unrecognised payload -> allow.
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

[ "${HEKTOR_PR_RULES_GATE:-on}" = "off" ] && { hektor_audit "pr-rules-gate bypassed (HEKTOR_PR_RULES_GATE=off)"; exit 0; }
hektor_gate_init pr-rules-gate "minimal,standard,strict"   # hard blocker: all profiles

EVENT="$(hektor_event)"

TARGET="$(hektor_file_path)"
[ -n "$TARGET" ] || exit 0
case "$TARGET" in *.java) ;; *) exit 0 ;; esac
BASENAME="${TARGET##*/}"

# The content this call introduces (the "diff" — mirrors the reviewer's Katman 1a).
# hektor_added_text covers every form Cursor delivers it in: whole-file content,
# a code_edit fragment, a search/replace new_string, or afterFileEdit's edits[].
ADDED="$(hektor_added_text)"
[ -n "$ADDED" ] || exit 0

# Full proposed file content, for the whole-file (Katman 1b) checks. A whole-file
# write is already the whole file; a partial edit is reconstructed from disk with
# a literal index()-based replace (NOT awk sub(), which is ERE and can
# mis-reconstruct). If it can't be rebuilt, PROPOSED stays empty and the
# whole-file checks are skipped — better to miss one than to false-flag on
# partial context.
PROPOSED=""
OLD="$(hektor_old_string)"
if [ -z "$OLD" ]; then
  PROPOSED="$ADDED"
elif [ -f "$TARGET" ]; then
  NEW="$(hektor_new_string)"
  # Pass OLD/NEW through the environment (ENVIRON[]), not `-v` — `-v` rejects a
  # literal newline in the value on BSD/macOS awk, which would silently
  # fail-open on any multi-line edit.
  PROPOSED=$(_o="$OLD" _n="$NEW" awk '
    BEGIN { RS="\0"; o=ENVIRON["_o"]; n=ENVIRON["_n"] }
    {
      rest=$0; out="";
      if (o == "") { printf "%s", rest; next }
      while ((p=index(rest,o)) > 0) {
        out = out substr(rest,1,p-1) n;
        rest = substr(rest, p+length(o));
      }
      printf "%s", out rest;
    }
  ' "$TARGET" 2>/dev/null || echo "")
fi

# ---- repo / file-type detection --------------------------------------------
IS_WEBTEST=0; IS_TDC=0
case "$TARGET" in
  */web-ui-test/*)      IS_WEBTEST=1 ;;
  */test-data-client/*) IS_TDC=1 ;;
esac
if [ "$IS_WEBTEST" = 0 ] && [ "$IS_TDC" = 0 ]; then
  case "$BASENAME" in
    *Test.java|*Page.java|*Layout.java) IS_WEBTEST=1 ;;
    *ResourceClient.java|AbName.java)   IS_TDC=1 ;;
    *) exit 0 ;;
  esac
fi
IS_TEST=0; IS_LAYOUT=0; IS_ABNAME=0
case "$BASENAME" in *Test.java)   IS_TEST=1 ;; esac
case "$BASENAME" in *Layout.java) IS_LAYOUT=1 ;; esac
case "$BASENAME" in AbName.java)  IS_ABNAME=1 ;; esac

# ---- finding accumulators ---------------------------------------------------
BLOCKERS=""
WARNINGS=""
add_b() { BLOCKERS="${BLOCKERS}
  • $1"; }
add_w() { WARNINGS="${WARNINGS}
  • $1"; }

# first_hit PATTERN -> prints "lineno:matched line" of the first match (or "")
first_hit() { printf '%s\n' "$ADDED" | grep -nE "$1" 2>/dev/null | head -1; }

# scan SEV PATTERN MESSAGE  (SEV = B|W)
scan() {
  local sev="$1" pat="$2" msg="$3" hit
  hit=$(first_hit "$pat")
  [ -n "$hit" ] || return 0
  if [ "$sev" = B ]; then add_b "$msg
      ↳ $hit"; else add_w "$msg
      ↳ $hit"; fi
}

CAMEL_METHOD='(public|private|protected)[[:space:]]+([A-Za-z0-9_]+(<[^>]*>)?(\[\])?[[:space:]]+)+([A-Za-z0-9]*_[A-Za-z0-9_]*|[A-Z][A-Za-z0-9_]*)[[:space:]]*\('

# ============================================================================
# web-test rules
# ============================================================================
if [ "$IS_WEBTEST" = 1 ]; then

  # BLOCKER — instantiating a Page/Layout instead of DI.
  scan B '(^|[^A-Za-z0-9_])new[[:space:]]+[A-Z][A-Za-z0-9_]*(Page|Layout)[[:space:]]*\(' \
    "new …Page()/…Layout() — use @AutowiredBean / @Layout / appContext.getBean(...), never new. [BLOCKER]"

  # BLOCKER — XPath expression inside a non-xpath @FindBy(...).
  scan B '@FindBy\([[:space:]]*(css|id|name|className|tagName|linkText|partialLinkText)[[:space:]]*=[[:space:]]*"\.{0,2}/' \
    "XPath expression inside a non-xpath @FindBy(...) — use @FindBy(xpath=…) or a real CSS/id selector. [BLOCKER]"
  scan B '@FindBy\([[:space:]]*(css|id|name|className|tagName|linkText|partialLinkText)[^)]*=[^)]*\[@' \
    "XPath predicate ([@attr]) inside a non-xpath @FindBy(...) — use CSS attribute syntax [attr=…] or @FindBy(xpath=…). [BLOCKER]"

  # BLOCKER — raw driver / shadow-root reach-through.
  if [ "$IS_TEST" = 1 ] || [ "$IS_LAYOUT" = 1 ]; then
    scan B '\.getRemoteWebDriver\(\)|\.getShadowRoot\(\)' \
      "browser.getRemoteWebDriver() / getShadowRoot() — forbidden in *Test.java and *Layout.java; use the framework element APIs. [BLOCKER]"
  fi
  if [ "$IS_TEST" = 1 ]; then
    scan B 'browser\.findElement\([[:space:]]*By\.' \
      "browser.findElement(By.…) inside a test — move the selector to a layout @FindBy and drive through a generated method. [BLOCKER]"
  fi

  # BLOCKER — @ScheduledDisable without a reason parameter.
  SD=$(printf '%s\n' "$ADDED" | grep -nE '@ScheduledDisable([^A-Za-z0-9_]|$)' 2>/dev/null | grep -v 'reason' | head -1)
  [ -n "$SD" ] && add_b "@ScheduledDisable without a mandatory reason parameter. [BLOCKER]
      ↳ $SD"

  # BLOCKER — @PageLayout class whose name doesn't end in Layout / LayoutBase.
  if printf '%s' "$ADDED" | grep -qE '@PageLayout([^A-Za-z0-9_]|$)'; then
    CN=$(printf '%s\n' "$ADDED" | grep -oE 'class[[:space:]]+[A-Za-z0-9_]+' | head -1 | sed -E 's/class[[:space:]]+//')
    if [ -n "$CN" ]; then
      case "$CN" in
        *Layout|*LayoutBase) ;;
        *) add_b "@PageLayout class \"$CN\" must end in Layout (or LayoutBase). [BLOCKER]" ;;
      esac
    fi
  fi

  # WARNING — Layout-typed local variable in a test.
  if [ "$IS_TEST" = 1 ]; then
    scan W '(^|[^A-Za-z0-9_])[A-Z][A-Za-z0-9_]*Layout[[:space:]]+[a-z][A-Za-z0-9_]*[[:space:]]*[=;]' \
      "Layout-typed variable in a test — chain straight off the page instead of storing the layout. [WARNING]"
    scan W '=[[:space:]]*[^;]*\.get[A-Za-z0-9_]*Layout\(\)[[:space:]]*;' \
      "getXxxLayout() result assigned to a variable — chain off page.getXxxLayout()… directly. [WARNING]"
  fi

  # WARNING — hardcoded URL inside @FindBy.
  scan W '@FindBy\([^)]*"[^"]*https?://' \
    "Hardcoded URL inside @FindBy — selectors must not embed a URL. [WARNING]"

  # WARNING — List<WebElement> stream().map(getText).
  scan W '\.stream\(\)[^;]*getText|getText[^;]*\.stream\(\)' \
    "stream().map(getText) over a List<WebElement> — use @GenerateMethods(getListText=true) and the generated getListText…(). [WARNING]"

  # WARNING — checkVisualRegression* nested inside assertx(...).
  scan W 'assertx\([^;]*checkVisualRegression' \
    "checkVisualRegression* nested inside assertx(...) — move it to its own VRT chain. [WARNING]"

  # WARNING — commented-out code.
  scan W '^[[:space:]]*//[[:space:]]*.*;[[:space:]]*$|^[[:space:]]*//[[:space:]]*@[A-Za-z]|^[[:space:]]*//[[:space:]]*(public|private|protected|return|assert|import)[[:space:]]' \
    "Commented-out code left in the diff — remove it. [WARNING]"

  # WARNING — method name not camelCase.
  scan W "$CAMEL_METHOD" \
    "Method name is not camelCase (snake_case / PascalCase). [WARNING]"
fi

# ============================================================================
# test-data-client rules
# ============================================================================
if [ "$IS_TDC" = 1 ]; then

  # Does the added text declare a *ResourceClient class?
  RC_CLASS=$(printf '%s\n' "$ADDED" | grep -oE 'class[[:space:]]+[A-Za-z0-9_]*ResourceClient' | head -1)
  if [ -n "$RC_CLASS" ]; then
    # BLOCKER — must extend AbstractService.
    printf '%s' "$ADDED" | grep -qE 'extends[[:space:]]+AbstractService' \
      || add_b "$RC_CLASS must extend AbstractService. [BLOCKER]"
    # BLOCKER — must be annotated @Component.
    printf '%s' "$ADDED" | grep -qE '@Component([^A-Za-z0-9_]|$)' \
      || add_b "$RC_CLASS is missing @Component. [BLOCKER]"
  fi

  # BLOCKER — clients.* URL that doesn't start with "/".
  scan B 'clients\.[A-Za-z0-9_().]*\.(get|post|put|delete|patch|head|options)\([[:space:]]*"[^/"]' \
    "clients.* URL must start with \"/\". [BLOCKER]"

  # BLOCKER — clients.* URL containing "//" (excluding protocol lines).
  DS=$(printf '%s\n' "$ADDED" | grep -nE 'clients\.[A-Za-z0-9_().]*\.(get|post|put|delete|patch|head|options)\([[:space:]]*"[^"]*//' 2>/dev/null | grep -v '://' | head -1)
  [ -n "$DS" ] && add_b "clients.* URL contains a double slash \"//\". [BLOCKER]
      ↳ $DS"

  # BLOCKER — AbName enum value not SCREAMING_SNAKE_CASE.
  if [ "$IS_ABNAME" = 1 ]; then
    scan B '^[[:space:]]*[A-Za-z0-9_]*[a-z][A-Za-z0-9_]*[[:space:]]*\([[:space:]]*"' \
      "AbName enum value is not SCREAMING_SNAKE_CASE. [BLOCKER]"
    scan B '^[[:space:]]*[A-Za-z0-9_]*[a-z][A-Za-z0-9_]*[[:space:]]*[,;][[:space:]]*$' \
      "AbName enum value is not SCREAMING_SNAKE_CASE. [BLOCKER]"
  fi

  # WARNING — log.* string concatenation.
  scan W '\blog\.(info|debug|warn|error|trace|fatal)\([^;]*"[^;]*\+' \
    "log.* uses string + concatenation — use {} placeholders. [WARNING]"

  # WARNING — log.* used in a class body without @Slf4j.
  if printf '%s' "$ADDED" | grep -qE 'class[[:space:]]+[A-Za-z0-9_]+' \
     && printf '%s' "$ADDED" | grep -qE '\blog\.(info|debug|warn|error|trace|fatal)\(' \
     && ! printf '%s' "$ADDED" | grep -qE '@Slf4j([^A-Za-z0-9_]|$)'; then
    add_w "log.* used but the class is not annotated @Slf4j. [WARNING]"
  fi

  # WARNING — method name not camelCase.
  scan W "$CAMEL_METHOD" \
    "Method name is not camelCase (snake_case / PascalCase). [WARNING]"
fi

# ============================================================================
# whole-file checks (Katman 1b subset) — need the full proposed file, and only
# report a trigger that is part of THIS write's added lines (mirrors "yeni
# eklenen"). Skipped when PROPOSED couldn't be reconstructed.
# ============================================================================
if [ -n "$PROPOSED" ]; then

  # WARNING — newly added import that is never used (both repos).
  # Body = every non-import line; an import is "used" if its simple name appears
  # there as a whole word. Wildcard imports are unverifiable -> skipped.
  BODY=$(printf '%s\n' "$PROPOSED" | grep -vE '^[[:space:]]*import[[:space:]]')
  while IFS= read -r imp; do
    [ -n "$imp" ] || continue
    case "$imp" in *'*'*) continue ;; esac   # wildcard import
    SIMPLE=$(printf '%s' "$imp" | sed -E 's/^[[:space:]]*import[[:space:]]+(static[[:space:]]+)?//; s/[[:space:]]*;.*$//; s/.*\.//; s/[[:space:]]//g')
    case "$SIMPLE" in ""|"*") continue ;; esac
    if ! printf '%s' "$BODY" | grep -qE "(^|[^A-Za-z0-9_.])${SIMPLE}([^A-Za-z0-9_]|$)"; then
      add_w "Unused import \"${SIMPLE}\" — remove it. [WARNING]"
    fi
  done <<EOF
$(printf '%s\n' "$ADDED" | grep -E '^[[:space:]]*import[[:space:]]')
EOF

  # WARNING — a magic number repeated 3+ times in the file (web-test only).
  # Exempt: 0 / 1, `static final` declaration lines, and @FindBy selector lines
  # (indices / the reserved 999 placeholder legitimately recur there). Only
  # numeric literals not glued to an identifier are counted.
  if [ "$IS_WEBTEST" = 1 ]; then
    CANDS=$(printf '%s\n' "$ADDED" | grep -vE 'static[[:space:]]+final|@FindBy' \
              | grep -oE '(^|[^A-Za-z0-9_.])[0-9]+(\.[0-9]+)?' 2>/dev/null \
              | grep -oE '[0-9]+(\.[0-9]+)?' | grep -vxE '0|1' | sort -u)
    REPORTED=0
    for num in $CANDS; do
      [ "$REPORTED" -ge 3 ] && break
      esc=$(printf '%s' "$num" | sed 's/\./\\./g')
      cnt=$(printf '%s\n' "$PROPOSED" | grep -vE 'static[[:space:]]+final|@FindBy' \
              | grep -oE '(^|[^A-Za-z0-9_.])[0-9]+(\.[0-9]+)?' 2>/dev/null \
              | grep -oE '[0-9]+(\.[0-9]+)?' | grep -cxE "$esc")
      if [ "${cnt:-0}" -ge 3 ]; then
        add_w "Magic number ${num} appears ${cnt}× in the file — extract a \`static final\` constant. [WARNING]"
        REPORTED=$((REPORTED + 1))
      fi
    done
  fi
fi

# ============================================================================
# emit
# ============================================================================
[ -z "$BLOCKERS" ] && [ -z "$WARNINGS" ] && exit 0

# --- preToolUse: veto the write on a BLOCKER --------------------------------
if [ -n "$BLOCKERS" ] && [ "$EVENT" != "postToolUse" ]; then
  REASON="[BLOCKED — Hektor pr-rules-gate] This write trips the PR reviewer's BLOCKER rules (Katman 1a).

Target: ${TARGET}

BLOCKERs (the reviewer marks the PR \"Needs Work\"):${BLOCKERS}"
  if [ -n "$WARNINGS" ]; then
    REASON="${REASON}

WARNINGs (inline comment on the PR — fix in the same pass):${WARNINGS}"
  fi
  REASON="${REASON}

Fix the BLOCKERs before this file is written. See hektor-conventions /
hektor-resource-client for the rule and the correct pattern.

Override (only if the user explicitly authorised it, e.g. a knowingly-XPath
locator): prefix the command's environment with HEKTOR_PR_RULES_GATE=off."
  hektor_deny "$REASON"
  exit 0
fi

# --- postToolUse: WARNINGs come back as a note ------------------------------
if [ "$EVENT" = "postToolUse" ] && [ -n "$WARNINGS" ]; then
  hektor_context "[WARN — Hektor pr-rules-gate] ${TARGET} trips PR reviewer WARNING rules (inline comment, non-blocking):${WARNINGS}

These don't block the write or the merge, but the reviewer leaves an inline
comment. Fix them in this pass unless there's a documented reason."
fi
exit 0
