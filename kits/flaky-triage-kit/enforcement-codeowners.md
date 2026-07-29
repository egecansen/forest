# Flaky-Triage Kit — VCS-layer enforcement (CODEOWNERS + branch protection)

> **Status in THIS repo: INERT (forward-looking).** `web-test/.gitignore` ignores `.claude/`, and
> `docs/hektor/` is in `.git/info/exclude`. The kit therefore has **0 git-tracked files** — it never
> appears in a Bitbucket pull request, so CODEOWNERS and branch permissions have nothing to gate here.
> This runbook activates **only** when the kit is committed to a tracked repository (e.g. published from
> the SKLS staging tree into a shared repo). Until then the live walls are:
> 1. `hooks/flaky-kit-self-protection-gate.sh` — PreToolUse gate (deny **is** honored by the current CLI;
>    see kernel §14 META). Now also matches Bash writes.
> 2. `core/lock-kit.sh lock` — an OS read-only bit on the surface, at the **hardened** tier root-owned
>    (reopening needs a password, not just `HEKTOR_FLAKYKIT_UNLOCK=1`, which is an audit
>    intent-marker, not consent); degrades to a chmod-only bit the same user can reverse when `sudo`
>    is unavailable.

## When the kit lives in a tracked repo

### 1. CODEOWNERS

Bitbucket Data Center reads `CODEOWNERS` from the repo root, `.bitbucket/`, or `docs/`
(GitHub: root or `.github/`). Add the kit's safety surface:

```
# CODEOWNERS — flaky-triage kit safety surface. Replace @qa-automation with the real team/handle (TODO).
/.claude/skills/hektor-flaky-triage/core/    @qa-automation
/.claude/skills/hektor-flaky-triage/SKILL.md @qa-automation
/.claude/hooks/flaky-kit-self-protection-gate.sh @qa-automation
/docs/hektor/flaky-triage-kit/               @qa-automation
```

(If publishing the kit standalone, rewrite the paths to wherever `core/`, `hooks/`, `SKILL.md`, and the
kernel land in that repo.)

### 2. Bitbucket Server / Data Center branch protection

Repository settings → **Branch permissions** on the default branch (`master`):

- **Prevent changes without a pull request** (no direct pushes).
- **Require approvals** ≥ 1 (≥ 2 for the safety surface if your edition supports per-path checks).
- Enable the **Code Owners** merge check (Bitbucket DC 8.8+) so a change touching a CODEOWNERS path
  requires approval from a listed owner.
- Add the kit owners as **Default reviewers** for changes under the kit paths (covers editions without
  per-path Code-Owners merge checks).

GitHub equivalent: Settings → Branches → branch protection rule → *Require a pull request before merging*
+ *Require review from Code Owners*.

### 3. CI token (when the kit runs unattended — kernel §11)

Least-privilege: **no** protected-branch push, **no** Jira write. The kit's contract is advisory
(open a PR, never merge); server-side branch protection above is the real guarantee, not the
bypassable in-process gate.

## Why VCS-layer protection matters even though the gate works

The PreToolUse gate and `lock-kit.sh` protect the **local working copy** an agent runs against. They do
nothing for a change pushed from a different machine, a CI job, or a human bypassing the agent. Once the
kit is version-controlled, CODEOWNERS + branch protection is the only layer that gates *merges* — the
point where a weakened kit would become everyone's kit.
