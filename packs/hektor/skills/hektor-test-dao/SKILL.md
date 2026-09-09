---
name: hektor-test-dao
description: >
  Use when a web-test needs a SQL/DB helper (*DAO method, classifiedDAO /
  promotionsDAO query, raw SQL in a test), when the published sahibinden-dao
  JAR has no matching method, when about to write a *DAO / AbstractDAO subclass
  under web-ui-test, or when authoring/editing *DAO.java / *DAOImpl.java in
  test-dao. Triggers on "add a DAO", "new DAO method", "test-dao", "tech/DAO-",
  "ClassifiedDAO".
paths: "test-dao/**/*.java, **/*DAO.java, **/*DAOImpl.java"
---

# Hektor test-dao — SQL helper handoff + rules

SQL test-data helpers live in the **test-dao** sibling repo (`sahibinden-dao`),
not in web-test. web-test only **injects** them (`@AutowiredBean` fields on
`AbstractTestDataResource`: `classifiedDAO`, `promotionsDAO`, …).

Same failure mode as TDC: do not write a DAO (or raw JDBC) under `web-ui-test/`
so the test can proceed. `pr-rules-gate` DENIES `extends AbstractDAO` and
`*DAO.java` / `*DAOImpl.java` in `web-ui-test/`.

---

## Reuse first — do not invent a DAO

Before creating a branch or a method, search the **sibling source** (not the
published JAR):

```bash
grep -r "getExpireClassifiedVehicleCategoryOneYearsOld\|updateAuctionsCargoPrecurrencyArea" \
  "$DAO/src/main/java" --include='*DAO.java' --include='*DAOImpl.java'
```

Also read `AbstractTestDataResource` for an already-injected DAO field.

- **A matching method exists** → call it (`classifiedDAO.getExpireClassified…()`).
  No `tech/DAO-*` branch. Return `status: reused`.
- **A close method exists** → **extend that DAO interface + impl** on
  `tech/DAO-<n>`. Do not add a parallel DAO.
- **Nothing matches** → provision `tech/DAO-<n>`, add interface method + impl.

| Excuse | Reality |
|---|---|
| "The JAR has no method" | Search `$DAO/src`, not `javap`. |
| "DAO isn't this worktree" | Provision `tech/DAO-<n>` and write there. |
| "I'll inline the SQL in the test" | SQL belongs in `*DAOImpl`. Stop. |
| "A helper on the test class is faster" | Test classes are method-only; DAO methods go in test-dao. |

---

## Locate the sibling + branch

Ticket number is the digits of the web-test ticket (`WEBT-255458` /
`SHBDN-255458` → `255458`). Branch: **`tech/DAO-<n>`** (existing remote
prefix; not `TDAO`).

```bash
PRIMARY="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
ROOT="$(dirname "$PRIMARY")"
DAO="$ROOT/test-dao"
PACK="$ROOT/APPS/forest/packs/hektor"
[ -d "$DAO" ] || { echo "test-dao primary missing under $ROOT"; exit 1; }
```

If `$DAO` is missing, read forest `config.json` `roots[]`. Do not invent a path.

```bash
"$PACK/scripts/worktree-provision.sh" \
  --branch tech/DAO-<n> --repo "$DAO" --reuse
```

Do **not** overwrite the Jira **Git Branch Name** field if it already holds
`tech/WEBT-<n>`.

---

## Author in test-dao

Mirror the closest neighbour (`ClassifiedDAO` / `ClassifiedDAOImpl`).

```java
package com.dao.classified;

import com.dao.AbstractDAO;
import org.springframework.stereotype.Component;

@Component
public class ClassifiedDAOImpl extends AbstractDAO implements ClassifiedDAO {

  public Long getExpireClassifiedVehicleCategoryOneYearsOld() {
    String sql = "SELECT id FROM auctions WHERE … limit 1";
    return shbdn.queryForObject(sql, Long.class);
  }
}
```

Rules:

- Interface `FooDAO` in `com.dao.<area>`; impl `FooDAOImpl extends AbstractDAO
  implements FooDAO`.
- **`@Component` on the impl** (Spring must register it for `@AutowiredBean`).
- Use the existing `JdbcTemplate` fields from `AbstractDAO` (`shbdn`, `london`,
  `co`, …) — never open a new connection.
- Match the neighbour's SQL style (`shbdn.queryForObject` / `queryForList` /
  `execute` / `update`).
- Method names `camelCase`. No unused imports.

Then:

1. `mvn -q -DskipTests install` in the DAO worktree so `mavenLocal()` wins.
2. **Do not commit. Do not push. Do not publish to Artifactory.**
3. If the DAO class is new, add `@AutowiredBean protected FooDAO fooDAO` on
   web-test `AbstractTestDataResource` (injection site — that web-test edit is
   allowed). A new method on an existing DAO needs no field change.
4. Return to web-test; next `gradle test` includes `--refresh-dependencies`.

---

## Red flags

1. `*DAOImpl` that does not `extends AbstractDAO`. **(BLOCKER)**
2. New `*DAOImpl` without `@Component`. **(BLOCKER)**
3. A DAO / `extends AbstractDAO` / raw JDBC written under `web-ui-test/`.
   **(BLOCKER)** — stop and start this skill over.
4. SQL concatenated into a `*Test.java` method. **(BLOCKER)**
5. Unused import / non-`camelCase` method. **(WARNING)**

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-test-dao",
    "status": "reused | authored",
    "next-action": "resume web-test composition"
  },
  "ticket-number": "255458",
  "branch": "tech/DAO-255458",
  "dao": "com.dao.classified.ClassifiedDAO",
  "methods": ["getExpireClassifiedMotorcycleCategory"],
  "artifact": "com.sahibinden:sahibinden-dao (mavenLocal SNAPSHOT)",
  "files-ready-for-user-to-commit": [],
  "summary": "Reused getExpireClassifiedVehicleCategoryOneYearsOld."
}
```

`status: reused` → `branch` may be empty. Never `git commit`.

---

## Pointers

- `hektor-resource-client` — the same handoff for REST / `*ResourceClient`
  (branch `tech/TDC-<n>`).
- `hektor-conventions` — web-test injection via `AbstractTestDataResource`.
- `hektor-test-composer` §2b — calls this skill when a SQL helper is missing.
