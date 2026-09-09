---
name: hektor-security-zap
description: >
  Drive security probes via the framework's @ZapSecurityTest + OWASP ZAP
  client (zapClientApiVersion in build.gradle.kts) to lock the surface
  against XSS, SQL-shape input drift, sensitive-data exposure, and the
  KVKK-protected fields the team tracks. Use only for authorized
  security testing on staging or pre-prod — never against production
  without explicit authorisation from the security team. Triggers on
  "security probe <flow>", "ZAP this", "sensitive-data audit", or when
  hektor-orchestrator routes a security-zap entry.
---

# Hektor security ZAP

The framework integrates with OWASP ZAP via `zapClientApiVersion =
"1.12.0"` (declared in `build.gradle.kts`) and ships a
`@ZapSecurityTest` annotation. The existing security tests under
`web-ui-test/src/test/java/com/sahibinden/web/ui/security/` are the
reference shape.

This skill is **only** for authorised testing. Refuse if the user has
not explicitly named the authorisation source (security team approval,
formal pen-test engagement, internal compliance audit).

---

## Authorisation gate

Before any probe:

> "Security probes can flag IDS, exhaust rate limits, and trigger SOC
> escalation. Please confirm:
> (a) the target environment is staging or pre-prod (NOT production
> unless explicitly authorised),
> (b) the security or platform team is aware,
> (c) you have authorisation to run probes against this surface.
>
> Quote the authorisation source."

Wait for an explicit answer. Do not proceed on inferred authorisation.

---

## When to add a security test

| Add | Don't add |
|---|---|
| Sensitive-data exposure on personal-account pages | Generic OWASP top-10 sweep with no scope |
| KVKK-protected field rendering after logout | Production-only paths |
| New payment endpoint exposed | Endpoints already covered by another test class |
| Customer-message body XSS reflection | Random fuzzing without product context |

The existing `security/sensitivedata/` directory shows the team's
preferred pattern: focused tests on specific fields and surfaces, not
broad scanners.

---

## Procedure

### 1. Scope

Identify:
- **Target surface** — a specific page / API endpoint / form.
- **Threat class** — XSS, SQL-shape, IDOR, sensitive-data leak, broken
  auth, KVKK boundary.
- **Authorisation** — the verbatim quote from §"Authorisation gate".

### 2. Test class

Mirror an existing `security/` test. Skeleton:

```java
package com.sahibinden.web.ui.security.sensitivedata;

@Tags({
    @Tag(MainTag.SERIAL),
    @Tag(MainTag.SECURITY),
    @Tag(MainTag.KVKK),
    @Tag(Kure.INDIVIDUAL),
    @Tag(IndividualDomain.MY_ACCOUNT)
})
@Slf4j
public class MyAccountSensitiveDataExposureTest extends TestDataResource {

  @AutowiredBean private MyAccountPage myAccountPage;

  @ZapSecurityTest
  @Description("My Account does not expose national-ID after logout")
  public void testNationalIdNotExposedAfterLogout() {
    User u = userResourceClient.createIndividualUser();
    myAccountPage.loginAs(u);
    // KVKK-protected national-ID is displayed when logged in
    String displayedId = myAccountPage.getProfileLayout().getTextNationalId();
    assertEquals(maskedShape(u.getNationalId()), displayedId);

    myAccountPage.logout();

    // After logout, the surface must not contain the national-ID literal
    String pageSource = browser.getPageSource();
    assertFalse(pageSource.contains(u.getNationalId()),
        "National-ID present in DOM after logout");
  }
}
```

Rules:
- `@Tag(MainTag.SECURITY)` — the CI security job picks it up.
- Add `@Tag(MainTag.KVKK)` when the probe is about KVKK-protected
  fields.
- `@Tag(MainTag.SERIAL)` is usually right — security probes mutate
  tenant state.
- Use the `UserResourceClient` to mint a throwaway user; never use
  customer accounts.

### 3. ZAP integration

For probes that need active ZAP scanning, the framework exposes the ZAP
client via the existing infrastructure (see `web-ui-test/src/main/java/
com/sahibinden/web/zap/`). Read that package's existing usage before
inventing a new ZAP-driver shape.

Common ZAP probe shape:
1. Start a ZAP context targeting the user flow.
2. Drive the flow via the Page/Layout pattern.
3. After the flow completes, query ZAP for alerts above
   `riskCode >= MEDIUM`.
4. Assert zero alerts; fail with the ZAP report URL in the message.

### 4. Findings

Findings go into `docs/hektor/security-findings.md`:

```markdown
<!-- hektor:security-findings -->
# Security Findings — sahibinden web-test

## 2026-05-21 — National-ID exposed in DOM after logout
**Severity:** HIGH (KVKK boundary violation)
**Surface:** /mhesabim (MyAccountPage)
**Threat class:** sensitive-data exposure
**Authorised by:** <verbatim quote from §"Authorisation gate">
**Reproduction:** MyAccountSensitiveDataExposureTest#testNationalIdNotExposedAfterLogout
**Status:** test landed RED; bug filed WEBT-251300; KVKK team notified
```

Critical findings (KVKK, payment, auth) escalate **immediately** to the
user — not via the report at end of run.

---

## Refusal cases

- No authorisation quoted. Refuse.
- Target is production without explicit prod-authorisation. Refuse.
- Caller asks for a "general scan" with no scope. Refuse; ask for the
  specific surface and threat class.
- ZAP misconfigured / unavailable. Surface the infra issue; don't patch
  around by silently degrading to a lighter probe.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-security-zap",
    "status": "probe-clean | findings-emitted | unauthorised | infra-blocked",
    "next-action": "advance or escalate"
  },
  "scope": "myaccount/sensitivedata",
  "threat-class": "sensitive-data-exposure",
  "authorisation": "<verbatim quote>",
  "tests-added": 1,
  "findings": [
    {
      "severity": "HIGH",
      "description": "National-ID exposed in DOM after logout",
      "test": "MyAccountSensitiveDataExposureTest#testNationalIdNotExposedAfterLogout",
      "bug-filed": "WEBT-251300"
    }
  ],
  "ledger-path": "docs/hektor/security-findings.md",
  "summary": "1 KVKK-boundary finding (HIGH); test landed RED; bug WEBT-251300 filed."
}
```
