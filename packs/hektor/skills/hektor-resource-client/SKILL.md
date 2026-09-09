---
name: hektor-resource-client
description: >
  Use when a web-test needs a REST/API test-data helper (*ResourceClient method,
  HTTP POST/GET, wizard/client/API fixture), when the published JAR has no
  matching method, when about to write a *Client or AbstractService subclass
  under web-ui-test, or when authoring/editing *ResourceClient.java / AbName.java
  in test-data-client. Triggers on "add a resource client", "new ResourceClient",
  "test-data-client", "TDC", "tech/TDC-", "the JAR has no method".
paths: "test-data-client/**/*.java, **/*ResourceClient.java, **/AbName.java"
---

# Hektor resource-client — test-data-client handoff + rules

REST test-data helpers live in the **test-data-client** sibling repo, not in
web-test. web-test only **injects** them (`@AutowiredBean` / fields on
`AbstractTestDataResource`).

Negative example (never repeat): `tech/WEBT-255458` wrote
`PromotionWizardClient extends AbstractService` under
`web-ui-test/.../util/doping/` so the test could proceed. The method belonged
on `DopingResourceClient` in test-data-client. `pr-rules-gate` now DENIES that
shape.

---

## Reuse first — do not invent a client

Before creating a branch or a method, search the **sibling source** (not the
published JAR — it lags):

```bash
# $TDC is the test-data-client primary (see Locate below)
grep -r "getClassifiedPromotionWizard\|wizard/Promotion\|addDopingToBasket" \
  "$TDC/src/main/java" --include='*.java'
```

Also read `AbstractTestDataResource` on the web-test side for an already-injected
bean (`dopingResourceClient`, `userResourceClient`, …).

- **A matching method exists** → use it. No `tech/TDC-*` branch, no new class,
  no wrapper under `web-ui-test/`. Return `status: reused`.
- **A close method exists** (same endpoint, wrong payload) → **extend that
  `*ResourceClient`** on `tech/TDC-<n>`. Do not add a parallel class.
- **Nothing matches** → provision `tech/TDC-<n>`, add the method/class there.

| Excuse | Reality |
|---|---|
| "The JAR has no method" | Search `$TDC/src`, not `javap` on the SNAPSHOT JAR. |
| "TDC isn't this worktree" | Provision `tech/TDC-<n>` and write there. |
| "I'll add a util so we can proceed" | That is WEBT-255458. Stop. |
| "A wrapper in web.util is faster" | `pr-rules-gate` denies `extends AbstractService` in `web-ui-test/`. |
| "It's just one POST" | One POST still belongs on the existing `*ResourceClient`. |

---

## Locate the sibling + branch

Ticket number is the digits of the web-test ticket (`WEBT-255458` /
`SHBDN-255458` → `255458`). Branch: **`tech/TDC-<n>`**.

```bash
PRIMARY="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
ROOT="$(dirname "$PRIMARY")"          # forest checkout root (…/sahibinden/repo)
TDC="$ROOT/test-data-client"
PACK="$ROOT/APPS/forest/packs/hektor"
[ -d "$TDC" ] || { echo "test-data-client primary missing under $ROOT"; exit 1; }
```

If `$TDC` is missing, read forest `config.json` `roots[]` and look for
`test-data-client` under each. Do not invent a path.

```bash
"$PACK/scripts/worktree-provision.sh" \
  --branch tech/TDC-<n> --repo "$TDC" --reuse
```

Do **not** overwrite the Jira **Git Branch Name** field if it already holds
`tech/WEBT-<n>` — that field belongs to the web-test branch.

---

## Author in test-data-client

1. Mirror the closest existing `*ResourceClient` (same package
   `com.sahibinden.client.aider`, same `clients.*` / `Host` style).
2. Prefer **adding a method** to the domain client (`DopingResourceClient`,
   `ClassifiedResourceClient`, …) over a new class.
3. A new class: `extends AbstractService`, `@Component`, `@Slf4j` if it logs.
4. Every `clients.*` URL starts with `/` and contains no `//`.
5. `mvn -q -DskipTests install` in the TDC worktree so `mavenLocal()` wins.
6. **Do not commit. Do not push. Do not publish to Artifactory.**

If the class is new, add an `@AutowiredBean` field on web-test
`AbstractTestDataResource` (injection site — that web-test edit is allowed).
A new method on an existing client needs no field change.

Then return to the web-test worktree and call the method. Next `gradle test`
must include `--refresh-dependencies`.

---

## The ResourceClient pattern

```java
@Component
@Slf4j
public class UserResourceClient extends AbstractService {

  public UserModel createIndividualUser(String segment) {
    log.info("Creating individual user for segment {}", segment);
    return clients.userClient()
        .post("/users/individual", buildRequest(segment), UserModel.class);
  }
}
```

Rules:

- **`extends AbstractService`.** `[PR-reviewer: BLOCKER, Katman 1a]`
- **`@Component` on every new `*ResourceClient` class.** `[PR-reviewer: BLOCKER, Katman 1b]`
- **`@Slf4j`** if the class calls `log.*`. `[PR-reviewer: WARNING, Katman 1b]`
- **Method names are `camelCase`.** `[PR-reviewer: WARNING, Katman 1a]`
- **No unused imports.** `[PR-reviewer: WARNING, Katman 1b]`

---

## `clients.*` URL rules

```java
// ✅
clients.userClient().get("/users/" + id, UserModel.class);
// ❌ BLOCKER — must start with "/"
clients.userClient().get("users/" + id, UserModel.class);
// ❌ BLOCKER — double slash
clients.userClient().get("/users//" + id, UserModel.class);
```

- URL string must start with `/`. `[PR-reviewer: BLOCKER, Katman 1a]`
- No `//` anywhere in the path. `[PR-reviewer: BLOCKER, Katman 1a]`

---

## `AbName.java` enum casing

New values must be `SCREAMING_SNAKE_CASE`. `[PR-reviewer: BLOCKER, Katman 1a]`

---

## Logging

Use `{}` placeholders, never string `+` inside `log.*`. `[PR-reviewer: WARNING]`

---

## Red flags

1. `*ResourceClient` that does not `extends AbstractService`. **(BLOCKER)**
2. New `*ResourceClient` without `@Component`. **(BLOCKER)**
3. `clients.*(...)` URL that doesn't start with `/`. **(BLOCKER)**
4. `clients.*(...)` URL containing `//`. **(BLOCKER)**
5. `AbName.java` value that isn't `SCREAMING_SNAKE_CASE`. **(BLOCKER)**
6. A REST helper (`extends AbstractService`, `*ResourceClient`, raw HTTP client)
   written under `web-ui-test/`. **(BLOCKER)** — stop and start this skill over.
7. `log.*` without `@Slf4j`. **(WARNING)**
8. String `+` inside `log.*`. **(WARNING)**
9. Non-`camelCase` method name / unused import. **(WARNING)**

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-resource-client",
    "status": "reused | authored",
    "next-action": "resume web-test composition"
  },
  "ticket-number": "255458",
  "branch": "tech/TDC-255458",
  "client": "com.sahibinden.client.aider.DopingResourceClient",
  "methods": ["postPromotionProduct"],
  "artifact": "com.sahibinden:test-data-client (mavenLocal SNAPSHOT)",
  "files-ready-for-user-to-commit": [],
  "summary": "Reused getClassifiedPromotionWizard; added postPromotionProduct on TDC-255458."
}
```

`status: reused` → `branch` may be empty. Never `git commit`.

---

## Pointers

- `hektor-test-dao` — the same handoff for SQL / `*DAO` (branch `tech/DAO-<n>`).
- `hektor-conventions` — web-test injection (`@AutowiredBean`, `AbstractTestDataResource`).
- `hektor-test-composer` §2b — calls this skill when a helper is missing.
