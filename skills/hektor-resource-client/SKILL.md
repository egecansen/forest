---
name: hektor-resource-client
description: >
  The framework-rules kernel for sahibinden/test-data-client — the sibling repo
  that holds the `*ResourceClient` classes web-test injects with
  `@AutowiredBean`. Use BEFORE writing or editing any `*ResourceClient.java`,
  `AbName.java`, or other test-data-client file. Captures the PR reviewer's
  test-data-client rule set (extends AbstractService, @Component, clients.* URL
  shape, AbName enum casing, @Slf4j / log placeholders) so generated code passes
  the automated review. Triggers on "add a resource client", "new ResourceClient",
  "test-data-client", "AbName enum", or any request to author/modify code in that
  repo. Sibling of hektor-conventions (which owns web-test); consult that for the
  test-side rules.
paths: "test-data-client/**/*.java, **/*ResourceClient.java, **/AbName.java"
---

# Hektor resource-client conventions — test-data-client rules

This skill is a reference, not a workflow. Load it when you are about to write
or edit code in the **test-data-client** repo — the module that exposes REST
data helpers to the web-test suite via `*ResourceClient` beans (injected on the
test side with `@AutowiredBean`, e.g. `UserResourceClient`).

The same PR reviewer that polices `web-test` (see `hektor-conventions`) runs a
**separate rule set** on this repo. Everything below maps 1:1 to a reviewer
rule; the severity tag is what the bot leaves on the PR (`BLOCKER` → Needs
Work; `WARNING` → inline comment, non-blocking).

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

- **`extends AbstractService`.** A `*ResourceClient` class that doesn't extend
  `AbstractService` is BLOCKED — the base wires the `clients` accessor, the
  HTTP plumbing, and error handling. `[PR-reviewer: BLOCKER, Katman 1a]`
- **`@Component` on every new `*ResourceClient` class.** Without it Spring
  won't register the bean and the `@AutowiredBean` injection on the test side
  fails. A newly added `*ResourceClient` missing `@Component` is BLOCKED.
  `[PR-reviewer: BLOCKER, Katman 1b]`
- **`@Slf4j`** on the class **if** it calls `log.*`. A class that uses `log.…`
  without the `@Slf4j` annotation is flagged. `[PR-reviewer: WARNING, Katman 1b]`
- **Method names are `camelCase`** — no snake_case or PascalCase.
  `[PR-reviewer: WARNING, Katman 1a]`
- **No unused imports** in the diff. `[PR-reviewer: WARNING, Katman 1b]`

---

## `clients.*` URL rules

Every REST path passed to a `clients.<x>()...(...)` call is checked:

```java
// ✅ correct
clients.userClient().get("/users/" + id, UserModel.class);

// ❌ BLOCKER — must start with "/"
clients.userClient().get("users/" + id, UserModel.class);

// ❌ BLOCKER — double slash "//" in the path
clients.userClient().get("/users//" + id, UserModel.class);
```

Rules:

- **The URL string must start with `/`.** A `clients.*(...)` path that doesn't
  begin with a leading slash is BLOCKED. `[PR-reviewer: BLOCKER, Katman 1a]`
- **No `//` (double slash) anywhere in the path.** Usually the result of
  concatenating a segment that already carries a trailing/leading slash — build
  the path so exactly one `/` joins each segment. `[PR-reviewer: BLOCKER,
  Katman 1a]`

When you build a path from variables, join segments deliberately (a single
`/` between parts, no trailing slash before a concatenated `"/" + id`) rather
than gluing pre-slashed fragments.

---

## `AbName.java` enum casing

The A/B experiment name enum in `AbName.java` is a canonical registry. Every
value must be `SCREAMING_SNAKE_CASE`:

```java
// ✅ correct
NEW_SEARCH_LAYOUT("new-search-layout"),
VEHICLE_PRO_INFOBOX("vehicle-pro-infobox"),

// ❌ BLOCKER — not SCREAMING_SNAKE_CASE
newSearchLayout("new-search-layout"),
Vehicle_Pro_Infobox("vehicle-pro-infobox"),
```

Rule:

- **A value added to `AbName.java` must be `SCREAMING_SNAKE_CASE`** (uppercase
  letters, digits, and `_` only). Anything else is BLOCKED. `[PR-reviewer:
  BLOCKER, Katman 1a]`

The string argument (the wire name, usually kebab-case) is not constrained —
only the Java enum constant identifier.

---

## Logging

```java
// ✅ correct — {} placeholders, lazy evaluation
log.info("Reserved user {} for segment {}", userId, segment);

// ❌ WARNING — String concatenation with "+"
log.info("Reserved user " + userId + " for segment " + segment);
```

Rules:

- **Use `{}` placeholders, never string `+` concatenation** inside a `log.*`
  call. `[PR-reviewer: WARNING, Katman 1a]`
- The class must carry **`@Slf4j`** (see above) for `log` to resolve.

---

## Red flags — refuse to commit code that does any of these

1. A `*ResourceClient` class that does **not** `extends AbstractService`.
   **(BLOCKER)**
2. A newly added `*ResourceClient` class without `@Component`. **(BLOCKER)**
3. A `clients.*(...)` URL that doesn't start with `/`. **(BLOCKER)**
4. A `clients.*(...)` URL containing `//`. **(BLOCKER)**
5. An `AbName.java` enum value that isn't `SCREAMING_SNAKE_CASE`. **(BLOCKER)**
6. `log.*` used in a class without `@Slf4j`. **(WARNING)**
7. String `+` concatenation inside a `log.*` call instead of `{}` placeholders.
   **(WARNING)**
8. A method name that isn't `camelCase`. **(WARNING)**
9. An unused import left in the diff. **(WARNING)**

Items 1–5 are reviewer BLOCKERs — refuse to commit code that trips one. Items
6–9 are WARNINGs: the bot leaves an inline comment but doesn't block the merge;
fix them in the same pass. The `pr-rules-gate.sh` hook scans your working tree
at write-time and enforces the same list.

---

## Pointers

- `hektor-conventions` — the sibling kernel for the **web-test** repo (the
  test-side rules; injecting these clients via `@AutowiredBean`).
- `AbstractService` — the base class every `*ResourceClient` extends; source of
  the `clients` accessor.
- `AbName.java` — the canonical A/B experiment-name enum.
- `.cursor/hooks/pr-rules-gate.sh` — the local diff-scanner (kill switch
  `HEKTOR_PR_RULES_GATE=off`).
