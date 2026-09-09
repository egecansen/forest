#!/bin/bash
# RED/GREEN check: web-test must not grow TDC/DAO helpers in-repo.
# Negative example: tech/WEBT-255458 wrote PromotionWizardClient in web-ui-test.
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

expect_deny() {
  local name="$1" payload="$2"
  local out
  out="$(run_gate "$payload")"
  if printf '%s' "$out" | grep -q '"permission"[[:space:]]*:[[:space:]]*"deny"'; then
    ok "$name"
  else
    bad "$name — expected deny, got: ${out:-<empty>}"
  fi
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

WIZARD='package com.sahibinden.web.util.doping;
import com.sahibinden.client.AbstractService;
import org.springframework.stereotype.Component;
@Component
public class PromotionWizardClient extends AbstractService {
  public void postPromotionProduct() {}
}'

DAO_IMPL='package com.dao.classified;
import com.dao.AbstractDAO;
import org.springframework.stereotype.Component;
@Component
public class ClassifiedDAOImpl extends AbstractDAO implements ClassifiedDAO {
  public void selectFoo() {}
}'

TEST='package com.sahibinden.web.ui.website.doping;
public class PurchasePromotionTest {
  public void testHappyPath() { assert true; }
}'

TDC='package com.sahibinden.client.aider;
import org.springframework.stereotype.Component;
@Component
public class DopingResourceClient extends AbstractService {
  public void addDopingToBasket() {}
}'

expect_deny "WEBT-255458 shape: AbstractService client under web-ui-test" "$(cat <<EOF
{"hook_event_name":"preToolUse","tool_input":{"file_path":"/r/web-test/web-ui-test/src/main/java/com/sahibinden/web/util/doping/PromotionWizardClient.java","content":$(printf '%s' "$WIZARD" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}}
EOF
)"

expect_deny "DAO impl under web-ui-test" "$(cat <<EOF
{"hook_event_name":"preToolUse","tool_input":{"file_path":"/r/web-test/web-ui-test/src/main/java/com/sahibinden/web/util/ClassifiedDAOImpl.java","content":$(printf '%s' "$DAO_IMPL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}}
EOF
)"

expect_allow "ordinary *Test.java in web-ui-test" "$(cat <<EOF
{"hook_event_name":"preToolUse","tool_input":{"file_path":"/r/web-test/web-ui-test/src/test/java/com/sahibinden/web/ui/website/doping/PurchasePromotionTest.java","content":$(printf '%s' "$TEST" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}}
EOF
)"

expect_allow "ResourceClient in test-data-client (correct repo)" "$(cat <<EOF
{"hook_event_name":"preToolUse","tool_input":{"file_path":"/r/test-data-client/src/main/java/com/sahibinden/client/aider/DopingResourceClient.java","content":$(printf '%s' "$TDC" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}}
EOF
)"

if [ "$fail" -ne 0 ]; then
  echo "pr-rules-sibling-deny-test: FAIL"
  exit 1
fi
echo "pr-rules-sibling-deny-test: PASS"
exit 0
