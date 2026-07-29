# Flaky-Kit Hardened Tier — Manual Acceptance

The privileged path cannot be automated: `chown root` needs a password and a test suite cannot type
one. Run this once on a machine with sudo, from the installed kit directory, right after
`install.sh` — before step 1, the kit has never been locked.

| # | Command | Expected |
|---|---|---|
| 1 | `core/lock-kit.sh status` (before any lock) | last line `tier: unprotected` — a fresh install is NOT `degraded`; nothing is read-only yet, so calling it "degraded" would say the surface is read-only when it plainly is not (that collapse was the bug §2 of the design doc calls out) |
| 2 | `core/lock-kit.sh lock` | prompts for a password; prints `HARDENED` |
| 3 | `core/lock-kit.sh status` | last line `tier: hardened` |
| 4 | `stat -f %Su core/apply.sh` (GNU/Linux: `stat -c %U core/apply.sh`) | `root` |
| 5 | `printf x >> core/apply.sh` | `Permission denied` |
| 6 | `chmod u+w core/apply.sh` | `Operation not permitted` — **this is the asymmetry; it failed before this work** |
| 7 | `bash core/tests/gate-test.sh` | 26 passed — a hardened kit still runs normally |
| 8 | `HEKTOR_FLAKYKIT_UNLOCK=1 core/lock-kit.sh unlock` | prompts for a password; prints `UNLOCKED` |
| 9 | `core/summary.sh < /dev/null` | stderr carries the `UNLOCKED (maintenance window open)` reminder |
| 10 | `core/lock-kit.sh lock` then `sudo chown -R $(id -un) core` | simulates losing the tier |
| 11 | `core/summary.sh < /dev/null` | refuses with `MISMATCH`, exit 76 |
| 12 | `core/lock-kit.sh lock` | back to `hardened`; state and `.flaky-kit-expect` agree |

Note on the audit log: `docs/hektor/.hook-audit.log` is written by the PreToolUse gate
(`adapters/claude|cursor/flaky-kit-self-protection-gate.sh`) when it *allows* an agent's tool call
under `HEKTOR_FLAKYKIT_UNLOCK=1` — it is not written by `lock-kit.sh` itself. Steps 2/8/10/12 above
are typed directly at a terminal, never through that gate, so they leave no entry there; the same
commands issued through an agent's Bash tool would. This checklist verifies the OS-level tier
(`lock-kit.sh` / `_integrity.sh`), not the gate's audit trail — that path is already covered by
`core/tests/self-protection-test.sh`'s unlock-is-audited assertions.
