// lib/oplock.mjs — operation-level lock for Finish/Eject.
//
// Two concurrent finishes (or a finish and an eject) on the same repo can
// interleave git mutations against the shared working tree/index (a
// `switch` landing mid another operation's `merge`), so the bodies of
// executeFinish/executeEject serialize through this per-repoPath queue.
//
// This is a SEPARATE namespace from lib/landed.mjs's ledger lock — its own
// Map, not shared. executeFinish/executeEject call recordLanding/popLanding
// internally, which acquire the ledger lock; nesting that acquisition
// inside this lock is safe only because the two locks are backed by
// distinct queues (no shared Map => no circular wait). Do not repoint this
// at landed.mjs's queues, and do not import landed.mjs's queue here.
const queues = new Map();

export function withOpLock(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next);
  // Both-branches observer (see lib/landed.mjs withRepoLock for why not
  // next.finally(cb)): avoids an unobserved derived promise rejecting
  // unhandled when a locked fn throws.
  const cleanup = () => { if (queues.get(key) === next) queues.delete(key); };
  next.then(cleanup, cleanup);
  return next;
}
