# Flaky-Kit Lock — Real Privilege Asymmetry — Design

**Date:** 2026-07-29 · **Status:** approved for planning · **Owner:** Egecan Sen
**Applies to:** `kits/flaky-triage-kit` (`core/lock-kit.sh`, the self-protection gate, `config.json`)

`core/lock-kit.sh` calls itself "the REAL wall" and its unlock "keyed to human consent". Neither is
true today: the agent runs as the **owner** of the kit's files, and `chmod` requires ownership, not
write permission — so `chmod u+w` always succeeds and `HEKTOR_FLAKYKIT_UNLOCK=1` is just a string the
agent can type, documented in the kit's own header. There is no capability the human has and the
agent lacks. This design introduces one: **`core/**` becomes root-owned, so unlocking requires
`sudo`, which requires a password only a human at the keyboard can supply.**

Demonstrated live in-session: the agent unlocked the kit with a single command, and the unlock was
not even audited (the pack's `audit.sh` silently no-op'd). The lock did stop one real thing — a stale
installer's `cp -R` could not overwrite read-only files — which is why it degrades rather than
disappears.

## Decisions taken (with the user)

| Decision | Choice |
|---|---|
| Asymmetry mechanism | Root file ownership + password-gated `sudo`. `chflags uchg` rejected — **verified**: the owner can both set and clear it, so it grants no asymmetry. `schg` needs root anyway, and root ownership is simpler |
| `config.json` scope | **Inside** the wall. It carries `es.host_allowlist` and `source_roots` — an agent that can edit it defeats P3 (ES repoint = exfil) and I3 (`source_roots:/`) |
| Config friction | Add `HEKTOR_FK_DATA_CENTER` / `HEKTOR_FK_CHROME_VERSION` env overrides, following the `HEKTOR_FK_JAVA_HOME` precedent. Security fields stay deliberately non-overridable |
| Shadowing (rename the kit dir) | **Detect, do not prevent** — prevention is impossible without owning `.claude/skills/`, which other skills need |
| No sudo available | Fall back to today's `chmod`-only lock, print the tier explicitly, exit 0. Portability preserved; the user always knows which tier they are on |
| Install behaviour | `install.sh` never calls `sudo` itself — it prints the hardening command as the next step. Config is edited before locking, not after |

## 1. Why root ownership is the only real option here

`chmod` requires ownership. `rename()` requires write on the **parent**, not ownership of the target.
`sudo` on the target machine requires a password (verified: `sudo -n true` → "a password is required").
Those three facts define the whole design space. Root ownership converts every write path — the Edit
tool, a Bash redirect, `sed -i`, `eval`, `base64 … | bash`, a compiled helper — into `EPERM`,
enforced by the kernel rather than by string-matching. This is what the current gate's own header
admits it cannot do.

VCS-layer enforcement (CODEOWNERS + branch protection) is **not** an alternative: per
`enforcement-codeowners.md`, the kit installs into a gitignored `.claude/` with **0 tracked files**,
so that layer is inert in the real deployment.

## 2. What this does not buy

Stated here so it is never re-claimed:

1. **Shadowing.** `mv .claude/skills/hektor-flaky-triage /tmp/x && mkdir …` touches no root-owned
   file — rename is governed by the user-owned parent. Detected (§4), not prevented.
2. **Social engineering.** An injected agent can ask the user to run the `sudo` unlock. Out of scope.
3. **The unlock window.** After the password, there is no wall. Keep the window short; `lock` is part
   of the maintenance flow, not an afterthought.
4. **Audit storage.** The log still lives inside the agent's write scope. Unchanged by this work.

`HEKTOR_FLAKYKIT_UNLOCK` is redefined: no longer "consent" (the sudo password is), but an **intent
marker** recorded in the audit trail. The false claims at `lock-kit.sh:10` and `:18-22` are corrected
— the shell-capable agent running as owner moves from "out of scope" to in scope and addressed.

## 3. Components

| Component | State | Responsibility |
|---|---|---|
| `core/lock-kit.sh` | extended | `lock` attempts hardened (root) then degrades; `unlock` requires sudo; `status` reports per-path tier |
| `core/.lock-state` | **new** | Records the tier the kit was locked at. Root-owned when hardened, so it cannot be forged inside a legitimate tree |
| `core/_integrity.sh` | **new** | Sourced helper (`_lock.sh` / `_strict.sh` pattern). Compares real ownership against `.lock-state` |
| self-protection gate | **relocated** | Installs to `.claude/hooks/` instead of `.claude/skills/hektor-flaky-triage/hooks/`, so shadowing the kit dir does not take the detector with it. Records the expected tier in `.claude/hooks/.flaky-kit-expect` — outside the shadowable tree, written by `lock` and **refreshed by `unlock`** (2026-07-30: without the refresh, the tier check in §4's amendment would report every maintenance window as a shadow). `install.sh` also removes the pre-relocation in-tree copy and its stale `settings.json` registration, or an upgraded project ends up with two gates |
| `config.json` | small addition | The two missing env overrides |
| `install.sh` | small addition | Detects a hardened install (so an upgrade prints "unlock first" rather than a wall of `cp` `EACCES` errors); prints the hardening command |

## 4. Runtime states

Every `core/` entrypoint sources `_integrity.sh` — one `stat` plus one small read.

| State | Meaning | Behaviour |
|---|---|---|
| `hardened` | root-owned, expectation agrees | proceed silently |
| `unlocked` | maintenance window left open | **loud** reminder to re-lock |
| `degraded` | chmod-only, expectation agrees | one-line notice, proceed |
| `mismatch` | was hardened, no longer is | **refuse** |

`mismatch` refuses in read-only scripts too: it means this is not the tree that was hardened, so
nothing it produces — summary, verdict, cluster table — should be trusted.

**The in-tree check cannot detect shadowing.** A shadowed tree is indistinguishable from a fresh
un-hardened install to a check whose expectation lives in that same tree. That is exactly why the
gate sits outside it and keeps its own record: the in-tree check catches **accidents** (an upgrade
that dropped ownership, a kit installed but never hardened), the out-of-tree gate catches the
**deliberate** case. Two different jobs; the spec keeps them separate rather than claiming one
mechanism does both.

> **Amendment, 2026-07-30 — this section asserted a detection the implementation did not deliver.**
> The out-of-tree check as first built fired only when the kit's `core/` was **absent**, so it caught a
> rename that left a hole behind and was completely silent on a rename-**and**-replace — the case its
> own warning text described, and the deliberate case this section credits it with. Under the branch's
> governing rule (a claim the mechanism does not deliver is a defect equal to a broken mechanism) that
> made this paragraph, `core/lock-kit.sh`'s residual list, `kernel.md`'s P4 row and both gates' comments
> untrue at once. Fixed by testing the kit's **protection** rather than its **presence**: the condition
> is now "recorded `hardened` **and** (`core/` missing **or** `core/` not owned by uid 0)", because a
> replacement tree cannot be root-owned without the password the hardened tier is built on. Its
> prerequisite: `unlock` now writes `unlocked` to the record, for the same reason `lock` writes
> `hardened` — otherwise every legitimate maintenance window would read as a shadow. The cost of that,
> stated rather than left to be discovered: while the record says `unlocked` the check is silent, which
> is correct, because during a maintenance window there is no protection left to have lost.

## 5. Flows

```
install (no sudo) → autoconfig → user edits config → core/lock-kit.sh lock
                                                        └→ sudo chown root + chmod a-w + state{hardened}

maintenance: HEKTOR_FLAKYKIT_UNLOCK=1 core/lock-kit.sh unlock
             └→ audit (redacted) + sudo chown $USER + chmod u+w + state{unlocked}
             → edit → core/lock-kit.sh lock
```

**The script runs as the user and escalates internally** — it is never invoked *through* `sudo`.
This matters: `sudo -E` would be the obvious way to carry `HEKTOR_FLAKYKIT_UNLOCK` across the
privilege boundary, but sudoers defaults to `env_reset` and refuses `-E` without an explicit
`SETENV` tag, so that invocation would fail on a default-configured machine. Reading the env var
before escalating avoids the boundary entirely, keeps the command shape people already know, and
narrows the privileged surface to a single `chown`.

`unlock` hands ownership back to the invoking user (`id -un`, not `$SUDO_USER`, since sudo is now
internal) so editing flows without further prompts and `lock` / `unlock` stay symmetric. If the
script is nonetheless run as a direct root shell with no invoking user to return ownership to, it
**refuses** rather than guessing who should own the tree.

## 6. Edge cases

| Case | Decision |
|---|---|
| sudo absent or password cancelled | degrade to chmod, print the tier, **exit 0** — an approved outcome, not a failure |
| macOS vs Linux | `stat -f %u` vs `stat -c %u`; follow the existing `uname` branching in `audit.sh` |
| chown interrupted → mixed ownership | `lock` is idempotent and re-runnable; `status` reports per path, never a single "locked" |
| upgrade over a hardened kit | `cp -R` hits `EACCES` — the protection working. Installer detects and instructs, instead of spewing errors |
| `.lock-state` missing but tree is root-owned | infer `hardened`, warn that state is missing |

## 7. Testing

Only ONE step of the privileged path cannot be automated: making a path genuinely owned by uid 0,
because `chown root` needs a password. **Amendment, 2026-07-30:** the original wording here —
"the privileged path cannot be automated" — was too broad and was used to justify leaving the branch
that decides *what* becomes root-owned untested, which is how its first version shipped a two-command
bypass. A PATH-shimmed `sudo` (logs argv, no-ops `chown`) plus a PATH-shimmed `stat` (reports the
ownership a successful chown would have left) drive the whole hardened branch as an unprivileged user:
the target set, the call order and split, the counters, the banner's derived claims, the out-of-tree
record, the chown-back and `sudo -k` are all covered by `core/tests/lock-tier-test.sh`. The kit already
solves this shape with `rerun.sh`'s `RERUN_LIB_ONLY=1` seam, and this follows it:

- **`core/tests/integrity-test.sh` (new)** — the tier decision is factored into a pure function and
  driven with synthetic ownership/state inputs, covering all four states. No sudo.
- **`core/tests/self-protection-test.sh`** — extended for the relocated gate (its 66 asserts build a
  fake tree whose layout changes).
- **Manual acceptance checklist** — the privileged path, run once, documented. Explicitly not in the
  automated suite, because it cannot be.

## 8. Migration

Existing installs are user-owned + chmod-locked → they report `degraded` and print the hardening
command. **Nothing breaks and no migration is forced**; hardening is opt-in per machine and
recommended in install output.

## 9. Out of scope

Jenkins / unattended runs (kernel §11 already defers these) · *preventing* shadowing · social
engineering the user into running sudo · an audit store outside the agent's write scope.
