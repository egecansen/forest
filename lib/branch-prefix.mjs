// lib/branch-prefix.mjs — infers a repo's ticket-branch prefix (e.g.
// "tech/WEBT-") from its own branch history, so forest never needs to be
// TOLD "this repo uses tech/WEBT-" — it reads what the repo already does.
//
// Nothing throws: `git` is injected — `(cwd, args) => Promise<string>`, the
// exact shape of runGit() in ./git.mjs — so tests drive this with fixture
// for-each-ref output, never a real repository, and a failing git call
// degrades to "no usable sample" the same as finding zero ticket-shaped
// branch names. When the sample doesn't support a confident answer this
// returns null rather than guessing: a caller that invents a prefix would
// silently create SHBDN-… branches in a repo that has only ever used
// tech/WEBT-…, which is worse than refusing outright.

import { runGit } from './git.mjs';

// Everything before a branch name's trailing run of digits, or null if the
// name doesn't end in digits at all, or if there is nothing before them (a
// bare number, e.g. "123", is not a usable prefix — there is no separator
// to infer).
//
// Non-greedy on purpose: `/^(.*)(\d+)$/` (greedy) backtracks from the END
// and finds the FIRST match with the SMALLEST possible digit run — on
// "tech/WEBT-233021" that greedily captures "...23302" / "1", not the whole
// trailing run. `/^(.*?)(\d+)$/` (non-greedy) grows the prefix group one
// character at a time until the remainder is entirely digits, which is
// exactly the maximal trailing digit run.
const TRAILING_DIGITS = /^(.*?)(\d+)$/;

export function prefixCandidate(branchName) {
  const name = String(branchName ?? '').trim();
  if (!name) return null;
  const m = name.match(TRAILING_DIGITS);
  return m && m[1] ? m[1] : null;
}

// `refs`: [{ name, committedAt }] — committedAt an ISO-ish string, or ''/null
// when unknown. -> the dominant prefix, or null if no branch name yields a
// candidate at all.
//
// Dominance is decided in three steps, in this order:
//   1. count       — the candidate that appears on the most branches wins;
//   2. recency     — among candidates tied on count, the one whose OWN most
//                     recently committed branch is more recent wins. This is
//                     "cheap" here: one extra %(committerdate) token on the
//                     same for-each-ref call that already reads the names,
//                     not a second git invocation — so it is always applied,
//                     never skipped for cost;
//   3. alphabetical — any remaining tie (identical count AND identical
//                     latest commit date) is broken by sorting the prefix
//                     string itself, so the answer is deterministic rather
//                     than depending on git's own ref enumeration order.
export function dominantPrefix(refs) {
  const byPrefix = new Map(); // prefix -> { count, latest }
  for (const ref of refs || []) {
    const candidate = prefixCandidate(ref && ref.name);
    if (!candidate) continue;
    const entry = byPrefix.get(candidate) || { count: 0, latest: '' };
    entry.count += 1;
    const at = (ref && ref.committedAt) || '';
    if (at > entry.latest) entry.latest = at;
    byPrefix.set(candidate, entry);
  }
  if (!byPrefix.size) return null;
  const ranked = [...byPrefix.entries()].sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    if (b[1].latest !== a[1].latest) return b[1].latest < a[1].latest ? -1 : 1;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return ranked[0][0];
}

// Reads the repo's own local branches AND remote-tracking branches, one
// for-each-ref call covering both refs/heads and refs/remotes, and infers
// the dominant prefix from the union.
//
// Deduped by LOGICAL branch name (the remote name — origin/, upstream/,
// whatever — is stripped off a remote-tracking ref) so a branch that exists
// both locally and on the remote counts as ONE vote, not two: otherwise a
// repo whose branches happen to be pushed would silently outweigh one whose
// aren't, which has nothing to do with which prefix is actually dominant.
// When the same logical name appears from both refs/heads and
// refs/remotes with different commit dates (a local branch ahead of what
// was last pushed, or vice versa), the more recent of the two is kept.
export async function inferBranchPrefix(repoPath, git = runGit) {
  let out = '';
  try {
    out = await git(repoPath, ['for-each-ref', 'refs/heads', 'refs/remotes', '--format=%(refname)\t%(committerdate:iso-strict)']);
  } catch {
    return null; // a git failure (bare repo, no commits yet, …) is "no usable sample", not a throw
  }
  const byName = new Map(); // logical name -> committedAt
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    const [full, committedAt] = line.split('\t');
    let name;
    if (full.startsWith('refs/heads/')) {
      name = full.slice('refs/heads/'.length);
    } else if (full.startsWith('refs/remotes/')) {
      // "origin/tech/WEBT-1" -> "tech/WEBT-1"; "origin/HEAD" -> "HEAD",
      // filtered out below along with any other symbolic-ref noise.
      name = full.slice('refs/remotes/'.length).replace(/^[^/]+\//, '');
    } else {
      continue;
    }
    if (!name || name === 'HEAD') continue;
    const prev = byName.get(name);
    const at = committedAt || '';
    if (prev === undefined || at > prev) byName.set(name, at);
  }
  const refs = [...byName.entries()].map(([name, committedAt]) => ({ name, committedAt }));
  return dominantPrefix(refs);
}
