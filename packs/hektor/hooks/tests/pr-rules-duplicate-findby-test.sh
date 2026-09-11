#!/bin/bash
# Same CSS on a different UI layout is NOT a duplicate (Yepy detail vs PG detail).
# The gate must allow declaring bankTransferInfo on YepyOperationDetailLayout
# even when MoneyInSafeOperationDetailLayout already has that selector.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/../pr-rules-gate.sh"
fail=0
ok()  { printf '  [ok]  %s\n' "$1"; }
bad() { printf '  [FAIL] %s\n' "$1"; fail=1; }

run_gate() {
  local payload="$1"
  HEKTOR_CURSOR_HOOKS=on HEKTOR_PR_RULES_GATE=on HEKTOR_HOOK_PROFILE=strict \
    printf '%s' "$payload" | bash "$GATE" 2>/dev/null || true
}

expect_allow() {
  local name="$1" payload="$2"
  local out
  out="$(run_gate "$payload")"
  if [ -z "$out" ] || printf '%s' "$out" | grep -q '"permission"[[:space:]]*:[[:space:]]*"allow"'; then
    ok "$name"
  else
    bad "$name — expected allow, got: $out"
  fi
}

json_content() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/hektor-dup-findby.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
git -C "$TMP" init -q
mkdir -p "$TMP/web-ui-test/src/main/java/com/sahibinden/web/client/website/layout/moneyinsafe"
mkdir -p "$TMP/web-ui-test/src/main/java/com/sahibinden/web/client/website/layout/myaccount/standard/shoppingoperations/yepy"

cat > "$TMP/web-ui-test/src/main/java/com/sahibinden/web/client/website/layout/moneyinsafe/MoneyInSafeOperationDetailLayout.java" <<'EOF'
package com.sahibinden.web.client.website.layout.moneyinsafe;
import org.openqa.selenium.support.FindBy;
import org.openqa.selenium.WebElement;
public class MoneyInSafeOperationDetailLayout {
  @FindBy(css = "efes-paris-pg-transaction-summary .description")
  private WebElement bankTransferInfo;
}
EOF

YEPY='package com.sahibinden.web.client.website.layout.myaccount.standard.shoppingoperations.yepy;
import org.openqa.selenium.support.FindBy;
import org.openqa.selenium.WebElement;
public class YepyOperationDetailLayout {
  @FindBy(css = "efes-paris-pg-transaction-summary .description")
  private WebElement bankTransferInfo;
}'

payload() {
  local path="$1" content="$2"
  cat <<EOF
{"hook_event_name":"preToolUse","cwd":$(printf '%s' "$TMP" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),"workspace_roots":[$(printf '%s' "$TMP" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')],"tool_input":{"file_path":$(printf '%s' "$path" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),"content":$content}}
EOF
}

YEPY_PATH="$TMP/web-ui-test/src/main/java/com/sahibinden/web/client/website/layout/myaccount/standard/shoppingoperations/yepy/YepyOperationDetailLayout.java"

expect_allow "same css on a different UI layout is not a duplicate @FindBy" "$(payload "$YEPY_PATH" "$(printf '%s' "$YEPY" | json_content)")"

if [ "$fail" -ne 0 ]; then
  echo "pr-rules-duplicate-findby-test: FAIL"
  exit 1
fi
echo "pr-rules-duplicate-findby-test: PASS"
exit 0
