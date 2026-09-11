// lib/finish.mjs — the Finish algorithm (spec: docs/superpowers/specs/2026-07-23-finish-worktree-design.md)
import { basename } from 'node:path';
import { runGit, parseStatus } from './git.mjs';
import { recordLanding, popLanding } from './landed.mjs';
import { withOpLock } from './oplock.mjs';

export const slug = (b) => b.replace(/[^A-Za-z0-9._-]+/g, '-');
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function tryGit(cwd, args) {
  try { return { ok: true, out: await runGit(cwd, args) }; }
  catch (e) { return { ok: false, err: e }; }
}

// Same-named branch for a detached worktree: the local branch whose slug
// equals the worktree dir name.
async function sameNamedBranch(repoPath, worktreeName) {
  const out = await runGit(repoPath, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']);
  return out.split('\n').filter(Boolean).find((b) => slug(b) === worktreeName) ?? null;
}

export async function previewFinish({ repoPath, path }) {
  const worktreeName = basename(path);
  const branchRaw = (await runGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const detached = branchRaw === 'HEAD';
  const branch = detached ? null : branchRaw;
  const head = (await runGit(path, ['rev-parse', 'HEAD'])).trim();
  const status = parseStatus(await runGit(path, ['status', '--porcelain']));
  const mainRaw = (await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const mainBranch = mainRaw === 'HEAD' ? null : mainRaw;
  // Tracked changes only. Untracked files ride across a switch too, but build
  // output and IDE droppings would then make a repo permanently un-finishable,
  // and those are nobody's landed work. What mixed two tickets on 2026-08-24
  // was staged/modified tracked files.
  const mainStatus = await runGit(repoPath, ['status', '--porcelain']);
  const mainDirtyFiles = mainStatus.split('\n').filter((l) => l && !l.startsWith('??'));
  const nameMismatch = !!branch && slug(branch) !== worktreeName;
  const targetBranch = detached ? await sameNamedBranch(repoPath, worktreeName) : branch;
  return {
    worktreeName, branch, detached, head,
    dirty: status.dirty, dirtyCount: status.changed,
    targetBranch, nameMismatch,
    candidates: nameMismatch ? [branch, worktreeName] : [],
    mainBranch,
    mainDirty: mainDirtyFiles.length > 0,
    mainDirtyCount: mainDirtyFiles.length,
    relanding: !!targetBranch && targetBranch === mainBranch,
    mergeInProgress: (await tryGit(repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok,
  };
}

// Finish moves the main checkout onto the branch being landed, and (since
// 2026-09-11) moves it back afterwards — see step 8. Step 4 below
// used to rely on `git switch` refusing to do that while the main checkout was
// dirty — but switch only refuses when it would OVERWRITE those changes.
// Anything that does not collide with the target tree is carried across
// silently, which is how one landing's still-uncommitted work ended up on the
// next ticket's branch (incident 2026-08-24: two Finishes 34 minutes apart,
// the second inheriting the first's popped stash). Returns the refusal message,
// or null when there is nothing to refuse — no switch means nothing can mix.
export function dirtyMainRefusal(preview, targetBranch) {
  if (!preview.mainDirty || preview.mainBranch === targetBranch) return null;
  return `the main checkout has ${preview.mainDirtyCount} uncommitted file(s); finishing ${preview.worktreeName} would switch it to ${targetBranch} and carry them onto that branch — commit or stash them first`;
}

// Guided mode: the linear happy-path sequence. Joined with ' && ' by the
// caller, so any failing step (incl. a merge conflict) stops the chain and
// leaves the user at their terminal to resolve — consistent with guided
// philosophy. Strings are pre-quoted per runInTerminal's contract.
export function finishCommands({ repoPath, path, targetBranch, remove, preview }) {
  const cmds = [];
  if (preview.branch && preview.branch !== targetBranch) {
    cmds.push(`git -C ${shQuote(path)} branch -m ${shQuote(preview.branch)} ${shQuote(targetBranch)}`);
  }
  if (preview.dirty) {
    cmds.push(`git -C ${shQuote(path)} stash push -u -m ${shQuote(`forest-finish ${preview.worktreeName}`)}`);
  }
  if (!preview.detached) cmds.push(`git -C ${shQuote(path)} switch --detach`);
  if (preview.mainBranch !== targetBranch) cmds.push(`git -C ${shQuote(repoPath)} switch ${shQuote(targetBranch)}`);
  cmds.push(`git -C ${shQuote(repoPath)} merge --no-edit ${preview.head}`);
  // The pop must precede removal in the chain: it returns the user's carried
  // work, and a failing `worktree remove` must never stop that from happening.
  if (preview.dirty) cmds.push(`git -C ${shQuote(repoPath)} stash pop`);
  if (remove) {
    cmds.push(`git -C ${shQuote(repoPath)} merge-base --is-ancestor ${preview.head} HEAD`);
    cmds.push(`git -C ${shQuote(repoPath)} update-ref refs/forest/landed/${preview.worktreeName} ${preview.head}`);
    cmds.push(`git -C ${shQuote(repoPath)} worktree remove ${shQuote(path)}`);
  }
  // Return (step 8): only when the main checkout was actually switched and is
  // not now holding carried changes — those need the landed branch checked out.
  if (preview.mainBranch && preview.mainBranch !== targetBranch && !preview.dirty) {
    cmds.push(`git -C ${shQuote(repoPath)} switch ${shQuote(preview.mainBranch)}`);
  }
  return cmds;
}

// Wrapped in the operation lock (keyed by repoPath): serializes concurrent
// Finish/Eject calls against the same repo so their git mutations never
// interleave (see docs/superpowers/specs/2026-07-23-finish-worktree-design.md).
export async function executeFinish({ repoPath, path, targetBranch, remove = true, onStep = () => {} }) {
  return withOpLock(repoPath, async () => {
    const git = async (cwd, args, { allowFail = false } = {}) => {
      onStep({ cmd: `git ${args.join(' ')}`, cwd });
      const r = await tryGit(cwd, args);
      if (!r.ok && !allowFail) throw r.err;
      return r;
    };

    const p = await previewFinish({ repoPath, path });
    if (p.mergeInProgress) throw new Error('main checkout has a merge in progress — resolve it first, then Finish again');
    targetBranch = targetBranch || p.targetBranch;
    if (!targetBranch) throw new Error(`cannot resolve a target branch for ${p.worktreeName}`);
    // Before step 1 on purpose: nothing has been renamed, stashed or moved yet,
    // so refusing here leaves the worktree and the main checkout exactly as the
    // user left them.
    const refusal = dirtyMainRefusal(p, targetBranch);
    if (refusal) throw new Error(refusal);

    const result = {
      targetBranch, previousBranch: p.mainBranch,
      landed: false, merged: 'none', conflict: false,
      removed: false, stashed: false, stashPopped: false,
      returned: false, returnedTo: null,
    };
    const stashMsg = `forest-finish ${p.worktreeName}`;

    // 1. naming (spec step 1) — rename only when an explicit different name was chosen
    if (p.branch && p.branch !== targetBranch) await git(path, ['branch', '-m', p.branch, targetBranch]);
    // 2. stash carry
    if (p.dirty) { await git(path, ['stash', 'push', '-u', '-m', stashMsg]); result.stashed = true; }
    // 3. free the branch
    if (!p.detached) await git(path, ['switch', '--detach']);
    // 4. land — git-native dirty-main policy: a refusing `switch` throws and aborts loudly
    if (p.mainBranch !== targetBranch) {
      const exists = (await tryGit(repoPath, ['rev-parse', '-q', '--verify', `refs/heads/${targetBranch}`])).ok;
      await git(repoPath, exists ? ['switch', targetBranch] : ['switch', '-c', targetBranch, p.head]);
    }
    result.landed = true;
    // 5. combine
    const merge = await git(repoPath, ['merge', '--no-edit', p.head], { allowFail: true });
    if (!merge.ok) {
      const unmerged = (await tryGit(repoPath, ['ls-files', '-u']));
      if (unmerged.ok && unmerged.out.trim()) { result.conflict = true; return result; } // stash + worktree kept
      throw merge.err;
    }
    result.merged = /Already up to date/i.test(merge.out) ? 'up-to-date' : 'merged';
    // 6. pop the carried stash — ours by message, also from an earlier conflicted
    // run. This runs BEFORE removal: the step that returns the user's work must
    // never be downstream of a cleanup step that can fail (incident 2026-07-29 —
    // a worktree left half-removable by a kit's read-only self-lock threw out of
    // `worktree remove`, and the stash pop after it never ran, stranding 27
    // modified + 49 untracked files).
    const list = (await tryGit(repoPath, ['stash', 'list'])).out ?? '';
    const line = list.split('\n').find((l) => l.endsWith(`: ${stashMsg}`));
    if (line) {
      const ref = line.slice(0, line.indexOf(':'));
      const pop = await git(repoPath, ['stash', 'pop', ref], { allowFail: true });
      result.stashPopped = pop.ok;
      if (!pop.ok) result.stashConflict = true; // git keeps the stash entry on pop conflict
    }
    // 7. remove, behind the ancestor guard
    // Ancestor guard: backstop for concurrent HEAD moves (e.g. the user switches
    // branches in the IDE mid-finish). Unreachable via the sequential flow — a
    // completed merge always makes p.head an ancestor of HEAD.
    if (remove) {
      const safe = (await tryGit(repoPath, ['merge-base', '--is-ancestor', p.head, 'HEAD'])).ok;
      if (!safe) {
        result.removeSkipped = `worktree commits not yet reachable from ${targetBranch}`;
      } else if (result.stashConflict) {
        // The worktree is the user's fallback copy while the pop is unresolved —
        // cleanup must not run until that conflict is dealt with.
        result.removeSkipped = 'stash pop conflicted — worktree kept for recovery';
      } else {
        await git(repoPath, ['update-ref', `refs/forest/landed/${p.worktreeName}`, p.head]);
        result.safetyRef = `refs/forest/landed/${p.worktreeName}`;
        // Non-fatal: the landing and the pop have already succeeded by now, and
        // removal can fail for reasons unrelated to safety (permissions, a lock,
        // a busy directory). Never throw here — report it instead.
        const removal = await git(repoPath, ['worktree', 'remove', path], { allowFail: true });
        if (removal.ok) {
          result.removed = true;
          // recordLanding writes the ledger entry Eject uses to recreate the
          // worktree; writing it while the directory still exists would leave
          // Eject unable to do its job (`git worktree add` onto an existing
          // path fails), so it only happens once removal actually succeeded.
          await recordLanding(repoPath, {
            worktreeName: p.worktreeName, branch: targetBranch,
            previousBranch: p.mainBranch, path, head: p.head, ts: Date.now(),
          });
        } else {
          result.removeError = removal.err.message;
          // The `git()` helper already journalled the attempt before running it;
          // without this, a failed removal reads identically to a successful one
          // in the journal — the only record of the failure is this in-memory result.
          onStep({ cmd: `worktree remove failed: ${result.removeError}`, cwd: repoPath });
        }
      }
    }
    // 8. return — put the main checkout back on the branch it was on. A
    // landing used to END with the primary parked on the ticket branch (the
    // original design brought the branch to the IDE already open on the
    // primary); with Cursor opening worktrees directly, that only made every
    // finished ticket's files show up in the project and the primary drift
    // off master. Skipped, with the reason reported, when the primary is
    // holding the worktree's carried changes — a switch would carry them onto
    // the previous branch (incident 2026-08-24 in reverse) — or when there is
    // nothing to return to. A refused switch is reported, not thrown: the
    // landing has already succeeded by now.
    if (p.mainBranch === targetBranch) {
      // step 4 switched nothing, so there is nowhere to go back to
    } else if (!p.mainBranch) {
      result.stayReason = `main checkout was detached before the landing — kept on ${targetBranch}`;
    } else if (p.dirty) {
      result.stayReason = `main checkout kept on ${targetBranch}: it holds ${p.dirtyCount} carried uncommitted file(s)`;
    } else if (result.removeSkipped) {
      result.stayReason = `main checkout kept on ${targetBranch}: ${result.removeSkipped}`;
    } else {
      const back = await git(repoPath, ['switch', p.mainBranch], { allowFail: true });
      if (back.ok) { result.returned = true; result.returnedTo = p.mainBranch; }
      else result.stayReason = `switch back to ${p.mainBranch} failed: ${back.err.message}`;
    }
    return result;
  });
}

// Eject: the reverse of Finish. Pops the last ledger entry, switches main
// back to the branch it was on before landing, and recreates the worktree
// at its old path holding the landed branch. Any failure re-pushes the
// popped entry so the ledger reflects reality.
export async function executeEject({ repoPath, onStep = () => {} }) {
  return withOpLock(repoPath, async () => {
    const git = async (cwd, args) => {
      onStep({ cmd: `git ${args.join(' ')}`, cwd });
      return runGit(cwd, args);
    };
    const entry = await popLanding(repoPath);
    if (!entry) throw new Error('nothing to eject — no recorded landing');
    if (entry.previousBranch === entry.branch) {
      // Conflict-resume-style landing: main was already on this branch when
      // it was finished (finish's step 4 is a no-op when mainBranch ===
      // targetBranch), so there is no "previous branch" to switch back to
      // and no old worktree state to recreate. Restore the entry — popping
      // it would otherwise silently drop it from the ledger — and refuse.
      await recordLanding(repoPath, entry);
      throw new Error(`nothing to eject — the main checkout was already on ${entry.branch} when it was finished`);
    }
    try {
      if (!entry.previousBranch) throw new Error('no previous branch recorded');
      await git(repoPath, ['switch', entry.previousBranch]); // git-native abort on refusal
      await git(repoPath, ['worktree', 'add', entry.path, entry.branch]);
    } catch (e) {
      try {
        await recordLanding(repoPath, entry); // restore the ledger entry on any failure
      } catch (restoreErr) {
        // Double failure: the original error AND the ledger restore both failed.
        // Rethrowing either alone would silently lose the popped entry, so fold
        // both messages plus the full entry into one Error the caller can act on.
        throw new Error(
          `eject failed: ${e.message}; ledger restore ALSO failed: ${restoreErr.message}. `
          + `Lost entry (recover manually, safety ref refs/forest/landed/${entry.worktreeName}): ${JSON.stringify(entry)}`
        );
      }
      throw e;
    }
    // Eject succeeded: the safety ref's job (insurance against a bad worktree
    // remove) is done, so drop it. Allow-fail — a failed delete (e.g. ref
    // already absent, or a stale lock) must not fail the eject itself.
    await tryGit(repoPath, ['update-ref', '-d', `refs/forest/landed/${entry.worktreeName}`]);
    return { branch: entry.branch, previousBranch: entry.previousBranch, path: entry.path };
  });
}
