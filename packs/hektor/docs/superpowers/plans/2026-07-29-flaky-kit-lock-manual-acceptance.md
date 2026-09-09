# Flaky-Kit Hardened Tier — Manual Acceptance

Only ONE thing here cannot be automated: making a path genuinely owned by uid 0, because `chown root`
needs a password and a test suite cannot type one. Everything *around* that is automated and must not
be re-described as manual — `core/tests/lock-tier-test.sh` drives the entire hardened branch
(target set, call order, counters, banner wording, the out-of-tree record, the chown-back, `sudo -k`)
under a PATH-shimmed `sudo`/`stat`, and `core/tests/integrity-test.sh` drives the tier decision and
every entrypoint's refusal. This checklist covers exactly the residue: that uid 0 really is uid 0, and
that the kernel enforces what the shims only simulated.

Run this once on a machine with sudo, from the installed kit directory, right after `install.sh` —
before step 1, the kit has never been locked.

| # | Command | Expected |
|---|---|---|
| 1 | `core/lock-kit.sh status` (before any lock) | last line `tier: unprotected` — a fresh install is NOT `degraded`; nothing is read-only yet, so calling it "degraded" would say the surface is read-only when it plainly is not (that collapse was the bug §2 of the design doc calls out). Every path line carries an `owner=` field, all showing your own user |
| 2 | `core/lock-kit.sh lock` | prompts for a password; prints `HARDENED` — **and not `HARDENED (PARTIAL)`**. If it says PARTIAL, or prints a `sudo said:` line, the chown only half-applied: read the owner column in step 3 to see which path was missed, then re-run |
| 3 | `core/lock-kit.sh status` | last line `tier: hardened`. `owner=root` on `core/`, on every file under it, on `SKILL.md`, **on the kit root (the `./` line)**, and on the out-of-tree gate/lib lines listed at the bottom. The kit-root check is the one that matters most: `rename()` is governed by the parent, so a user-owned kit root reduces the tier to a two-command bypass |
| 4 | `stat -f %Su core/apply.sh` (GNU/Linux: `stat -c %U core/apply.sh`) | `root` |
| 5 | `stat -f %Su .` from the kit root (GNU: `stat -c %U .`) | `root` — the kit DIRECTORY itself, not just its contents |
| 6 | `stat -f %Su ../../hooks/flaky-kit-self-protection-gate.sh ../../hooks/lib/audit.sh` and, if Cursor is installed, the two under `.cursor/hooks/` | `root` for each — the gates and audit libs are on the surface, and a Cursor user's only gate is one of them |
| 7 | From the project root: `git status --porcelain` and `ls -l adapters install.sh kernel.md README.md scripts` **in the kit SOURCE checkout** if you locked that rather than an install | nothing outside the declared surface changed owner. `chown -R` applies to every operand, so a single call listing the kit root would have rooted `adapters/`, `install.sh`, `kernel.md`, `README.md` and `scripts/` — all git-tracked. `lock` splits the call for exactly this reason; step 7 is how you confirm it |
| 8 | `cat ../../hooks/.flaky-kit-expect` | `hardened` — the out-of-tree record both gates' shadow check reads |
| 9 | `printf x >> core/apply.sh` | `Permission denied` |
| 10 | `chmod u+w core/apply.sh` | `Operation not permitted` — **this is the asymmetry; it failed before this work** |
| 11 | `sudo -n true; echo $?` | non-zero. `lock` ends with `sudo -k`, so the credential it just cached is gone. A zero here means the ~5-minute no-prompt reopen window that `lock` itself creates is still open, and "reopening needs a password" is false for its duration |
| 12 | `bash core/tests/gate-test.sh` | 26 passed — a hardened kit still runs normally |
| 13 | `HEKTOR_FLAKYKIT_UNLOCK=1 core/lock-kit.sh unlock` | prompts for a password; prints `UNLOCKED` |
| 14 | `cat ../../hooks/.flaky-kit-expect` | `unlocked` — `unlock` must refresh the record too. If it still says `hardened`, both gates will report every legitimate maintenance window as a shadowed kit, and a warning that fires on the normal path is a warning nobody reads |
| 15 | `core/lock-kit.sh status` | `owner=` is your user again on every surface path, including the out-of-tree ones — not just on `core/` |
| 16 | `core/summary.sh < /dev/null` | stderr carries the `UNLOCKED (maintenance window open)` reminder |
| 17 | `core/lock-kit.sh lock` then `sudo chown -R $(id -un) core` | simulates losing the tier |
| 18 | `core/summary.sh < /dev/null` | refuses with `MISMATCH`, exit 76 |
| 19 | Run any harness command (e.g. an agent Bash call) with the tree in that state | the gate prints `SHADOW WARNING … NOT root-owned`. This is the state a rename-and-replace leaves behind, and it was silent until the detector stopped testing mere presence |
| 20 | **Rename-and-replace, end to end:** `core/lock-kit.sh lock`, then from the skills dir `mv hektor-flaky-triage /tmp/aside && cp -R /tmp/aside hektor-flaky-triage && rm -f hektor-flaky-triage/core/.lock-state` | a harness command now prints `SHADOW WARNING`. The replacement tree looks entirely normal from the inside — this is why the record and the detector live outside it, and why the check asks about ownership rather than existence. Restore with `rm -rf hektor-flaky-triage && mv /tmp/aside hektor-flaky-triage` |
| 21 | `core/lock-kit.sh lock` | back to `hardened`; `.lock-state` and `.flaky-kit-expect` agree |

Note on the audit log: `docs/hektor/.hook-audit.log` is written by the PreToolUse gate
(`adapters/claude|cursor/flaky-kit-self-protection-gate.sh`) when it *allows* an agent's tool call
under `HEKTOR_FLAKYKIT_UNLOCK=1` — it is not written by `lock-kit.sh` itself. Steps 2/13/17/21 above
are typed directly at a terminal, never through that gate, so they leave no entry there; the same
commands issued through an agent's Bash tool would. This checklist verifies the OS-level tier
(`lock-kit.sh` / `_integrity.sh`), not the gate's audit trail — that path is already covered by
`core/tests/self-protection-test.sh`'s unlock-is-audited assertions.
