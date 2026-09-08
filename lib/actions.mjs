import { mkdir, writeFile, unlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { runGit, extractTicket, parseWorktreeList, baseBranch } from './git.mjs';
import { runInTerminal, openWith, openCursorWorkspace as openCursorWorkspaceDefault } from './terminal.mjs';
import { launchInteractive, runHeadless } from './agents.mjs';
import { provisionPack, writeProvisionRecord, readProvisionRecord, safeId, writesHookWiring, ensureExcluded } from './packs.mjs';
import { previewFinish, executeFinish, executeEject, finishCommands, dirtyMainRefusal, slug } from './finish.mjs';
import { readLandings } from './landed.mjs';
import { worktreePathFor } from './config.mjs';
import { resolveSessionScope, resolveCursorScope } from './session-scope.mjs';
import { addRepo, removeRepo, repoErrorMessage } from './repos.mjs';
import { selectCandidates, pruneCommands, pruneWorktrees, dirSizeBytes } from './prune.mjs';
import { createSummaryCache, jiraKey, submitBranchField, readBranchField } from './jira.mjs';
import { sprintJql, backlogJql, searchIssues, searchUsers, me, createTicketCache, fetchIssueDetail as fetchIssueDetailDefault } from './jira-search.mjs';
import { descriptionKey, resolveDescription, saveDescription, clearDescription } from './descriptions.mjs';
import { PRIORITY_COLORS, savePriority, clearPriority, priorityKey } from './priorities.mjs';
import { createSrpClient, boxLabel, loginSrp as loginSrpDefault } from './srp.mjs';
import { inferBranchPrefix as inferBranchPrefixDefault } from './branch-prefix.mjs';

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// The origin of a configured URL, or null if it doesn't parse. Shared by the
// /api/srp/token route below and server.mjs's OPTIONS preflight for it — the
// one path in forest that ever answers a cross-origin request, and only from
// this exact origin.
export function originOf(url) {
  try { return new URL(String(url)).origin; } catch { return null; }
}

// Why a unit could not be removed, in words a user can act on. `e.message`
// verbatim reaches an alert box as `ENOENT: no such file or directory, lstat
// '/var/folders/…'`, which names a syscall and a temp path and nothing the
// reader can do about either.
function removeFailureReason(e, kind, id) {
  if (e.code === 'EPERM' || e.code === 'EACCES') {
    // A hardened kit is root-owned; deleting it needs the password the user
    // holds. The kit's own installer refuses in these words.
    return `${id} is root-owned (hardened) — unlock it first, this changes nothing`;
  }
  if (e.code === 'ENOENT') return `${id} is already gone — nothing was left to remove`;
  if (e.code === 'ENOTDIR') return `${id} is not a ${kind} directory — nothing was removed`;
  return `${id} could not be removed (${e.code || 'error'}) — nothing was removed`;
}

// Human label for a worktree path, used as the Terminal tab title at launch:
// Layout-independent: the last segment is always the branch slug (or repo name for primary),
// and we extract the ticket from it. Works with any worktreeRoot configuration.
export function worktreeTitle(p) {
  const parts = String(p).split('/').filter(Boolean);
  const last = parts[parts.length - 1] || String(p);
  return extractTicket(last) || last;
}

// Can `/api/worktree/repair` actually fix a registered-but-missing hook?
//
// Repair replays `rec.selections` through `runSelections` and does nothing
// else, so it can only move `missing` if replaying those selections writes
// some hook wiring. This asks the pack source that question directly, with the
// same calls provisioning itself makes — see `writesHookWiring` in packs.mjs,
// which lives next to `provisionPack` so the two cannot drift apart.
//
// It used to be a pure record-SHAPE predicate: any non-empty `kits` array, or
// `hooks: true`, answered `true`. That never asked whether the named selection
// could write a registration, and two reachable states proved it wrong:
//   - the record still names another kit, one that ships only `kit.json` — no
//     install.sh, no hooks/, no settings fragment. Repair copies it and writes
//     no registration. `repairable: true`, `missing: 1`, forever.
//   - the record names a kit the pack no longer ships. `provisionPack` skips
//     it, so repair provisions `kits: []` — a literal no-op — and still said
//     `true`.
// In both, a single `exists()` refutes the claim. Asserting anyway was not
// conservatism about an unknown; it was asserting a possibility that had
// already been decided.
//
// `true` can still overshoot: once for a case that is genuinely undecidable,
// and again wherever refuting it would mean reading an artifact's content
// rather than its shape. A kit's `install.sh` is the undecidable one — the
// kit owns its own wiring and forest cannot know which files that installer
// writes. The hooks-dir and settings-fragment checks below go one step past
// `exists()` — `hasEntries` and `isParsableJson` refute an absent directory
// or a file that does not parse — but neither reads what is underneath: a
// `hooks/` directory holding only an empty subdirectory still has entries,
// and a settings fragment that parses but declares no hooks (`{}`,
// `{"hooks":{}}`, even a bare `7`) still parses. `writesHookWiring` answers
// "could this selection write wiring", not "will it" — narrowing that gap
// further is a deliberate, separate change, not this one.
//
// `packsDir` is required to answer this at all. Without it — no config, an
// unreadable packs root — the answer is `false`, and correctly so: a replay
// through that same packsDir would find nothing to provision either.
export async function repairableRecord(record, { packsDir } = {}) {
  const sels = Array.isArray(record?.selections) ? record.selections : [];
  for (const s of sels) {
    if (!s || typeof s !== 'object') continue;
    if (await writesHookWiring({
      packsDir, pack: s.pack, kits: Array.isArray(s.kits) ? s.kits : [], hooks: !!s.hooks,
    })) return true;
  }
  return false;
}

// Whether a launch may proceed. Injectable dependencies so the decision is
// testable without opening a Terminal window.
// A failure to resolve scope deliberately allows the launch: this guard exists
// to warn about missing gates, and must never become the reason forest cannot
// start a session.
export async function launchDecision({ path, force = false, packsDir, resolveScope = resolveSessionScope, readRecord = readProvisionRecord }) {
  if (force) return { launch: true };
  let scope;
  try { scope = await resolveScope(path); } catch { return { launch: true }; }
  if (!scope?.missing?.length) return { launch: true };
  const record = await readRecord(path).catch(() => null);
  return {
    launch: false,
    blocked: 'missing-hooks',
    missing: scope.missing.map((h) => ({ command: h.command, source: h.source })),
    repairable: await repairableRecord(record, { packsDir }),
  };
}

// Units the previous provision wrote that the incoming selection no longer
// names. Provisioning is additive, so a deselected unit stays on disk,
// registered and running, at whatever version it had — and because the launch
// route overwrites the record with the new selection, it also stops being
// visible to `/api/worktree/repair`, which re-provisions from `rec.selections`.
//
// Pure and synchronous on purpose: it compares two records and touches nothing.
// `launchDecision` answers a different question from different inputs (the
// worktree's current disk state), so the two stay separate.
export function orphanedUnits(previousRecord, selections = []) {
  const inv = previousRecord?.inventory;
  if (!inv) return [];
  const picked = (key) => new Set(selections.flatMap((s) => s?.[key] || []));
  const out = [];
  for (const [key, kind] of [['kits', 'kit'], ['skills', 'skill']]) {
    const still = picked(key);
    for (const id of inv[key] || []) {
      if (!still.has(id)) out.push({ kind, id, since: previousRecord.at });
    }
  }
  return out;
}

// The record as it must read once `units` are no longer on disk. Pure, and
// returns the two arguments `writeProvisionRecord` takes.
//
// Both halves have to drop the id or a removal is a one-way door:
//   - `inventory` — the orphan guard compares it against the incoming
//     selection, so leaving the id there re-blocks the next launch on a unit
//     that no longer exists, with Remove as the only offered remedy and
//     nothing left to remove.
//   - `selections` — `/api/worktree/repair` replays them, so leaving the id
//     there means the next repair silently reinstalls what the user just
//     asked to delete.
// A selection left naming nothing is dropped: it is exactly what /api/launch's
// own filter does with one, and repair refuses an empty list rather than
// replaying a no-op.
//
// `at` is carried through unchanged. A removal does not re-provision the
// units that survive it, so stamping a fresh one made their `since` read as
// the removal date — an orphan looking newer, and so safer, than it is, in
// the dialog that gates an irreversible action. `writeProvisionRecord` takes
// it as an optional argument; a second writer for the same file, kept in sync
// by hand, would have been the worse trade.
export function recordWithout(record, units = []) {
  const gone = (kind) => new Set(units.filter((u) => u && u.kind === kind).map((u) => u.id));
  const kits = gone('kit'), skills = gone('skill');
  const keep = (arr, drop) => (Array.isArray(arr) ? arr : []).filter((id) => !drop.has(id));
  const selections = (Array.isArray(record?.selections) ? record.selections : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      ...s,
      ...(Array.isArray(s.kits) ? { kits: keep(s.kits, kits) } : {}),
      ...(Array.isArray(s.skills) ? { skills: keep(s.skills, skills) } : {}),
    }))
    .filter((s) => s.kits?.length || s.skills?.length || s.hooks);
  const inv = record?.inventory;
  return {
    selections,
    // A record written before the inventory existed stays without one:
    // inventing an empty inventory here would claim provisioning produced
    // nothing, which is a different (and false) statement.
    inventory: inv ? { ...inv, kits: keep(inv.kits, kits), skills: keep(inv.skills, skills) } : null,
    at: typeof record?.at === 'string' ? record.at : null,
    // The Cursor axis is per-pack, not per-unit: removing a kit from .claude/
    // does not un-install .cursor/, so the record keeps saying it is there.
    cursor: record?.cursor ?? null,
  };
}

// Shared by /api/launch and /api/worktree/repair — both provision a list of
// pack selections and must journal any conflict identically. Previously each
// route ran its own copy of this loop and repair's copy silently dropped
// conflicts instead of journalling them (a repair that hit a hash conflict
// kept the old file, returned ok: true, and reported the same counts as
// before with no explanation).
export async function runSelections({ ctx, path, selections, mode, refresh = false }) {
  const out = { skills: [], kits: [], hooks: false, conflicts: [], notes: [] };
  for (const s of selections) {
    const r = await provisionPack({ packsDir: ctx.config.packsDir, pack: s.pack, skills: s.skills || [], kits: s.kits || [], hooks: !!s.hooks, worktreePath: path, refresh });
    out.skills.push(...r.skills);
    out.kits.push(...r.kits);
    out.conflicts.push(...r.conflicts);
    out.notes.push(...(r.notes || []));
    if (r.hooks) out.hooks = true;
  }
  for (const c of out.conflicts) {
    ctx.journal.add({ cmd: `collision: ${c.path} (${c.incoming} ≠ ${c.existing}) — kept existing`, cwd: path, mode });
  }
  // A kit that ran its own installer reports the outcome here, including a
  // failure. Provisioning that copies a kit and cannot wire it has to say so:
  // a silent success is exactly what left a worktree holding an inert kit.
  for (const n of out.notes) ctx.journal.add({ cmd: n, cwd: path, mode });
  return out;
}

// Locates a worktree in an already-built snapshot. The description routes are
// read-only with respect to git, so the cached snapshot is the right source:
// they must not each pay for a full walk of every repo.
export function findWorktree(snap, path) {
  for (const r of snap.repos) for (const w of r.worktrees) if (w.path === path) return w;
  return null;
}

// `launch` is injectable so the ordering in /api/launch can be tested without
// opening a real Terminal window. `resolveScope` is injectable so the
// missing-hooks guard can be tested without merging the real machine's
// ~/.claude/settings.json into the result.
// The two skills whose presence in a provisioned selection means "this is
// the Hektor pack" — the same list the Tickets modal's own
// mergeRequiredSkills() merges in (see public/tickets.js). Kept independently
// here (not imported — that module is browser-only) because this route must
// be correct on its own, not merely trust what the client claims.
const CURSOR_ADAPTER_SKILLS = ['hektor-multi-ticket', 'hektor-from-jira'];

// Which pack (by name, from an already-provisioned `selections` array) is
// "the Hektor pack" whose Cursor adapter should be wired — or null if
// neither required skill was actually provisioned (nothing to wire; the
// footer already told the user why, before they ever clicked Start).
function hektorAdapterPack(selections) {
  const entry = (selections || []).find((s) => Array.isArray(s.skills) && s.skills.some((id) => CURSOR_ADAPTER_SKILLS.includes(id)));
  return entry ? entry.pack : null;
}

// The command per agent, config-overridable (claudeCmd / cursorAgentCmd).
// Falls back per key so a ctx built without those keys — every route test —
// still names a command; the launcher refuses anything but these two keys.
function agentCmds(config = {}) {
  return { claude: config.claudeCmd || 'claude', cursor: config.cursorAgentCmd || 'cursor-agent' };
}

const AGENT_ERROR = "agent must be 'claude' or 'cursor'";
function requestedAgent(body) {
  return body.agent === undefined ? 'claude' : body.agent;
}

// Runs the pack's OWN installer against an already-provisioned worktree,
// wiring the Cursor harness (.cursor/rules/hektor.mdc + .cursor/hooks.json,
// whose adapter.sh shim runs the SAME unmodified .claude/hooks/*.sh gates —
// one source of truth for the gate logic, translated at the I/O boundary).
// Deliberately NOT hand-rolled here: the pack owns that translation, and a
// second copy of it in forest would drift the moment the pack's changed.
//
// Never throws: a missing install.sh or a non-zero exit is `{ error }`, the
// same "this specific thing didn't land, say so" contract as everything
// else in this file — the worktree itself still exists either way.
async function runCursorAdapterInstallDefault({ packsDir, pack, worktreePath, noKits = false }) {
  if (!safeId(pack)) return { error: `invalid pack id: ${pack}` };
  const installPath = join(packsDir, pack, 'install.sh');
  try { await stat(installPath); } catch {
    return { error: `${pack}/install.sh not found under ${packsDir} — the Cursor adapter (.cursor/rules, .cursor/hooks.json) was not wired` };
  }
  // --no-kits: forest provisions kits itself (runSelections) — letting the
  // pack's installer run every bundled kit again would double-install them.
  // The timeout is the hard stop for an installer that hangs on a prompt:
  // without one a launch would wait forever with nothing on screen.
  const args = ['--harness', 'cursor', '--project', worktreePath, ...(noKits ? ['--no-kits'] : [])];
  return new Promise((resolveInstall) => {
    execFile(installPath, args, { maxBuffer: 8 * 1024 * 1024, timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || '').trim().slice(0, 500) || 'no output';
        const how = err.killed ? ' (killed after 180s)' : err.code ? ` (exit ${err.code})` : '';
        resolveInstall({ error: `${pack}/install.sh --harness cursor failed${how}: ${detail}` });
        return;
      }
      resolveInstall({ ok: true, stdout: String(stdout || '').trim() });
    });
  });
}

// The number a ticket key ends in — "SHBDN-233021" -> "233021" — mapped onto
// the repo's inferred prefix to build the branch name. Null when the key
// has no trailing digits at all (a malformed key, not something to guess at).
function ticketNumber(key) {
  const m = String(key ?? '').match(/(\d+)$/);
  return m ? m[1] : null;
}

export function createActionHandler({
  launch = launchInteractive, resolveScope = resolveSessionScope,
  submitBranch = submitBranchField, readBranch = readBranchField,
  searchTickets = searchIssues, searchPeople = searchUsers, whoami = me,
  srpClient = createSrpClient, loginSrp = loginSrpDefault,
  inferBranchPrefix = inferBranchPrefixDefault,
  openCursorWorkspace = openCursorWorkspaceDefault,
  runCursorAdapterInstall = runCursorAdapterInstallDefault,
  fetchIssueDetail = fetchIssueDetailDefault,
} = {}) {
  // One cache per handler, so summaries survive between drawer opens but no
  // module-level state leaks across tests.
  const summaries = createSummaryCache();
  // One cache per handler, like `summaries` above: survives modal opens, never
  // leaks between tests.
  const tickets = createTicketCache();

  // Which of `names` (pack ids) can be wired for Cursor at all: the pack must
  // ship its own install.sh. Packs without one are skipped silently — there
  // is nothing to run, and a launch must not fail over a pack that never
  // offered a Cursor axis.
  async function packsWithInstaller(packsDir, names) {
    if (!packsDir) return [];
    const out = [];
    for (const pack of [...new Set(names)]) {
      if (!safeId(pack)) continue;
      try { await stat(join(packsDir, pack, 'install.sh')); out.push(pack); } catch { /* no installer: nothing to wire */ }
    }
    return out;
  }

  // The Cursor axis of a provisioned worktree: each pack's OWN install.sh
  // (--harness cursor --no-kits) writes .cursor/ whole — skills, agents,
  // rules, hooks and hooks.json. Shared by /api/launch (agent: cursor),
  // /api/worktree/repair and the ticket-worktrees route so all three
  // journal, record and exclude identically. Never throws — a throwing
  // runner or an unwritable record is journalled, never propagated. Returns
  // the packs that landed and the first error; a partial result is still
  // recorded so repair replays what did work.
  async function wireCursorAxis({ ctx, path, packs, mode, label }) {
    const wired = [];
    let error = null;
    for (const pack of packs) {
      let install;
      try {
        install = await runCursorAdapterInstall({ packsDir: ctx.config.packsDir, pack, worktreePath: path, noKits: true });
      } catch (e) {
        // The default runner converts every failure to { error }; an
        // injected one may not. Same outcome either way: reported, not thrown.
        install = { error: `${pack}/install.sh threw: ${e?.message || e}` };
      }
      if (install.error) {
        error ??= install.error;
        ctx.journal.add({ cmd: `cursor adapter NOT wired for ${label}: ${install.error}`, cwd: path, mode });
      } else {
        wired.push(pack);
        ctx.journal.add({ cmd: `cursor adapter wired for ${label} (${pack}/install.sh --harness cursor --no-kits → .cursor/)`, cwd: path, mode });
      }
    }
    if (wired.length) {
      // The gates landed; what follows is bookkeeping. A failure here is a
      // WARNING, not `error` — the toast must not claim gates that are on
      // disk were not wired. Repair's .cursor/hooks.json backfill still finds
      // an unrecorded axis.
      try {
        const rec = await readProvisionRecord(path);
        if (rec && Array.isArray(rec.selections)) {
          // Union with what was recorded before: a pack whose replay failed is
          // still installed under .cursor/ at its old version, and the next
          // repair must keep trying it rather than forget it.
          const prior = Array.isArray(rec.cursor?.packs) ? rec.cursor.packs : [];
          const packsNow = [...new Set([...prior, ...wired])];
          await writeProvisionRecord(path, rec.selections, rec.inventory ?? null, rec.at ?? null, { packs: packsNow, at: new Date().toISOString() });
        }
      } catch (e) {
        ctx.journal.add({ cmd: `WARNING: Cursor axis wired but not recorded in ${label} (${e?.message || e}) — make .claude/.forest-provision.json writable; until then ↻ falls back to the .cursor/hooks.json backfill`, cwd: path, mode });
      }
      // install.sh's own .gitignore block covers docs/hektor/ only, never
      // .cursor/ — without this the whole harness shows up as untracked.
      const excluded = await ensureExcluded(path, { checkPath: '.cursor/hooks.json', pattern: '/.cursor/' });
      if (!excluded) ctx.journal.add({ cmd: `WARNING: .cursor/ is not git-excluded in ${label} — the Cursor harness will show up in git status`, cwd: path, mode });
    }
    return { wired, error };
  }

  // The bookmarklet's credential (Task 9), set by POST /api/srp/token and
  // read by srpFor() below. Per-handler like `summaries`/`tickets` above,
  // deliberately NOT a module-level variable — module state would leak the
  // token across tests and across concurrent handlers. Memory only: never
  // written to config.json (the user's file), never journalled by value,
  // never returned in a response body.
  let runtimeSrp = null; // { refreshToken, accessToken } | null
  // One SRP client per handler, for the same reason and one more: the access
  // token it mints lives INSIDE the client, so a client rebuilt per request
  // pays a POST /auth/refresh on every box load and every reserve, and
  // srp.mjs's shared-mint machinery — which exists because those two calls
  // race in the same tick — can never fire. `createActionHandler()` is called
  // once in server.mjs, so "one per handler" is the spec's "held in memory for
  // the server's lifetime".
  //
  // Keyed on the config it was built from rather than memoised blindly: the
  // client closes over baseUrl/refreshToken/username at construction, so a
  // config that changed under it (a fresh token pasted into config.json, a
  // test handing the same handler a different ctx, a runtime token the
  // bookmarklet just delivered) must produce a new client instead of a memo
  // holding the credential the user just replaced.
  let srp = null;
  let srpKey = null;
  function srpFor(config) {
    // The runtime token outranks config.srpRefreshToken — once the
    // bookmarklet has run it is the fresher credential — and falls back to
    // config when no bookmarklet has run yet, so an existing config.json
    // setup keeps working unchanged. The runtime access token rides along
    // ONLY when the runtime refresh token is the one actually in use: the
    // two always arrive paired from the same POST /api/srp/token call, and
    // pairing them here lets the client start from that access token instead
    // of paying SRP's mint round trip on the very next request. It is part
    // of the memo key (not just the refresh token) so reconnecting with an
    // unchanged refresh token but a fresh access token — SRP's access token
    // can rotate independently — still rebuilds the client instead of going
    // on serving the one built from the first connect.
    const useRuntime = Boolean(runtimeSrp && runtimeSrp.refreshToken);
    const refreshToken = useRuntime ? runtimeSrp.refreshToken : config.srpRefreshToken;
    const accessToken = useRuntime ? runtimeSrp.accessToken : null;
    const key = JSON.stringify([config.srpBaseUrl, refreshToken, config.srpUsername || '', accessToken || '']);
    if (!srp || srpKey !== key) {
      srp = srpClient({
        baseUrl: config.srpBaseUrl, refreshToken, username: config.srpUsername, accessToken,
      });
      srpKey = key;
    }
    return srp;
  }

  function sendJson(res, obj, code = 200) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  // Run a git command either in the terminal (guided) or in-process (auto).
  async function dispatchGit({ cwd, args, mode, ctx }) {
    const command = `git ${args.map(shQuote).join(' ')}`;
    ctx.journal.add({ cmd: command, cwd, mode });
    if (mode === 'guided') {
      runInTerminal({ command, cwd, app: ctx.config.terminalApp });
      return { mode, command };
    }
    const out = await runGit(cwd, args);
    ctx.broadcast('worktrees', await ctx.snapshot());
    return { mode, command, output: out };
  }

  // baseBranch resolves internally and never throws for a git-level miss, but
  // a spawn-level failure (a machine out of process slots, git gone) would —
  // and that must not turn worktree creation into a 500 it never used to be.
  async function safeBaseBranch(repoPath) {
    try { return await baseBranch(repoPath); } catch { return 'HEAD'; }
  }

  // Shared by /api/worktree/create and /api/tickets/worktrees — both build a
  // worktree the same way; a second copy of this path-and-args construction
  // would drift the moment one changed. Returns the computed path alongside
  // dispatchGit's own result so a caller that needs the path (the bulk
  // ticket route does; the single-worktree route does not) has it without
  // recomputing worktreePathFor a second time.
  async function createWorktreeAt({ repoPath, branch, base, newBranch, mode, ctx }) {
    const wtPath = worktreePathFor({
      worktreeRoot: ctx.config.worktreeRoot,
      repoPath,
      branchSlug: slug(branch),
    });
    await mkdir(dirname(wtPath), { recursive: true });
    // A new branch is cut from the repo's base branch, NOT from the primary
    // checkout's HEAD. Defaulting to HEAD silently inherits whatever branch
    // the primary happened to have out at that moment: two ticket worktrees
    // created while the primary sat on an unrelated feature branch each
    // carried that branch's unmerged commit, and one was pushed with it — the
    // other ticket's changes showed up in its PR diff. An explicitly named
    // base still wins; 'HEAD' survives only as baseBranch's own last resort,
    // for a repo where neither origin/HEAD nor main/master resolves.
    const startPoint = base || await safeBaseBranch(repoPath);
    const args = newBranch
      ? ['worktree', 'add', '-b', branch, wtPath, startPoint]
      : ['worktree', 'add', wtPath, branch];
    const result = await dispatchGit({ cwd: repoPath, args, mode, ctx });
    return { wtPath, result };
  }

  // The per-ticket markdown brief (round: "start working immediately,
  // without crawling around" — the ticket's own context on screen, no Jira
  // round trip needed to read it). Never blocks or fails the ticket it's
  // for: a brief that can't be written, or a Jira fetch that fails, is a
  // per-ticket note (`briefError` / a degraded description line), same
  // treatment as a Cursor-adapter failure — the worktree itself is
  // unaffected either way.
  //
  // Written to docs/hektor/tickets/<KEY>.md — the Hektor invariant that only
  // production files live in a worktree's tracked tree, plans and briefs go
  // to docs/hektor/ — and excluded via ensureExcluded() (packs.mjs) so it
  // never shows up as untracked in `git status`. Verified afterwards with a
  // status check scoped to the brief's OWN path, not the whole worktree: an
  // ALREADY-EXISTING worktree may legitimately already be dirty from the
  // user's own prior work, and that must not be misattributed to this brief.
  async function writeTicketBrief({ worktreePath, ticket, boxes, prompt, ctx }) {
    const jiraBase = String(ctx.config.jiraBaseUrl || '').replace(/\/+$/, '');
    const jiraUrl = jiraBase ? `${jiraBase}/browse/${ticket}` : null;
    const detail = await fetchIssueDetail(ticket, {
      baseUrl: ctx.config.jiraBaseUrl, token: ctx.config.jiraToken, email: ctx.config.jiraEmail,
    });
    const summary = !detail.error && detail.summary ? detail.summary : '';
    const description = !detail.error && detail.description ? String(detail.description).trim() : '';
    const relPath = join('docs', 'hektor', 'tickets', `${ticket}.md`);
    const absPath = join(worktreePath, relPath);
    const content = [
      `# ${ticket}${summary ? `: ${summary}` : ''}`,
      '',
      jiraUrl ? `Jira: ${jiraUrl}` : null,
      '',
      '## Description',
      '',
      description || 'description unavailable',
      '',
      '## Testbox(es)',
      '',
      (boxes && boxes.length) ? boxes.join(', ') : '(none)',
      '',
      '## Session line',
      '',
      '```',
      prompt || '',
      '```',
      '',
      // A living document, not just a snapshot: this is what the per-ticket
      // Cursor rule (writeTicketRule, below) tells the agent to keep current
      // — a small closed vocabulary for Status (so forest could parse it
      // later without guessing at free text, see this round's report), and
      // a checklist that mirrors the arc the Hektor skills actually follow
      // (hektor-from-jira / hektor-multi-ticket): read the ticket and its
      // linked tickets, distil scenarios, write tests, run them on the
      // reserved box, summarise the result.
      '## Progress',
      '',
      'Status: not started',
      '<!-- one of: not started | in progress | blocked | ready for review -->',
      '',
      '- [ ] Ticket + linked tickets read',
      '- [ ] Scenarios distilled',
      '- [ ] Tests written',
      '- [ ] Run on the reserved box',
      '- [ ] Result summarised',
      '',
      '## Notes',
      '',
    ].filter((line) => line !== null).join('\n');
    try {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content);
    } catch (e) {
      return { error: `could not write brief for ${ticket}: ${e.message || e}` };
    }
    await ensureExcluded(worktreePath, { checkPath: relPath, pattern: '/docs/hektor/' });
    let dirty = false;
    try {
      const status = await runGit(worktreePath, ['status', '--porcelain', '--', relPath]);
      dirty = Boolean(status.trim());
    } catch { dirty = true; } // could not verify — treat conservatively, not silently clean
    return { path: absPath, dirty };
  }

  // Delivers the brief without anyone pasting it: Cursor applies every
  // .cursor/rules/*.mdc with alwaysApply:true to every chat opened in that
  // workspace folder, so a per-worktree rule puts the ticket in context the
  // moment the agent initialises — no clipboard, nothing the user has to do.
  //
  // A POINTER only, not a second copy: the pack's own hektor.mdc already
  // routes to the Hektor skills, and restating that methodology here would
  // drift the moment one changed without the other. This names the ticket,
  // sends the agent to the brief, and reminds it to keep the brief's own
  // Progress section current — nothing about HOW to do the work.
  //
  // Exclusion is NOT written here: .cursor/ is already excluded via the
  // repo's shared .git/info/exclude (handled elsewhere — the pack's own
  // install, or the repo's pre-existing setup — not this route's job to
  // duplicate). What this DOES do is verify that holds, the same shape as
  // writeTicketBrief's own check: a shared exclude someone edited is not a
  // guarantee, so a dirty result here still gets a journalled WARNING
  // instead of silently trusting it.
  async function writeTicketRule({ worktreePath, ticket, branch, boxes }) {
    const boxLine = (boxes && boxes.length) ? boxes.join(', ') : '(none reserved)';
    const relPath = join('.cursor', 'rules', `ticket-${ticket}.mdc`);
    const absPath = join(worktreePath, relPath);
    const content = [
      '---',
      `description: Ticket ${ticket} — read docs/hektor/tickets/${ticket}.md before doing anything in this worktree`,
      'alwaysApply: true',
      '---',
      '',
      `# ${ticket}`,
      '',
      `This worktree exists for **${ticket}** on branch \`${branch}\`. Read`,
      `\`docs/hektor/tickets/${ticket}.md\` before doing anything else — it has the`,
      'ticket\'s description, the reserved testbox(es), and the exact session line.',
      '',
      `- Reserved testbox(es): ${boxLine}`,
      '- Work only in this worktree — never the primary checkout.',
      '- Keep the brief\'s `## Progress` section current as you go: update',
      '  `Status:` and check off steps as they finish.',
      '',
    ].join('\n');
    try {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content);
    } catch (e) {
      return { error: `could not write Cursor rule for ${ticket}: ${e.message || e}` };
    }
    let dirty = false;
    try {
      const status = await runGit(worktreePath, ['status', '--porcelain', '--', relPath]);
      dirty = Boolean(status.trim());
    } catch { dirty = true; }
    return { path: absPath, dirty };
  }

  // One ticket's worktree, for /api/tickets/worktrees below. Always runs as
  // if mode were 'auto': opening N Terminal windows to run N git commands
  // (what 'guided' mode does) would contradict the whole point of this
  // route — the server creates quietly, then opens ONE Cursor window. Never
  // throws to its caller — every failure mode becomes `{ ticket, error }` so
  // one ticket failing does not abort the rest.
  async function ensureTicketWorktree({ repoPath, ticket, prefix, selections, boxes, prompt, ctx }) {
    const num = ticketNumber(ticket);
    if (!num) return { ticket, error: `${ticket} has no trailing number to map onto the inferred branch prefix` };
    const branch = `${prefix}${num}`;
    let wtPath, existed;
    try {
      const list = parseWorktreeList(await runGit(repoPath, ['worktree', 'list', '--porcelain']));
      // An existing branch/worktree for this ticket is NOT an error — the
      // user gets a window on what is already there rather than a failure
      // for something that isn't actually wrong.
      const already = list.find((w) => w.branch === branch);
      if (already) {
        wtPath = already.path;
        existed = true;
      } else {
        const branchExists = await runGit(repoPath, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]).then(() => true, () => false);
        ({ wtPath } = await createWorktreeAt({ repoPath, branch, base: undefined, newBranch: !branchExists, mode: 'auto', ctx }));
        existed = false;
      }
    } catch (e) {
      return { ticket, error: `${branch}: ${e.message || e}` };
    }

    const out = { ticket, branch, path: wtPath, existed };
    if (selections && selections.length) {
      // Same helper /api/launch uses, same record write — so
      // /api/worktree/repair and the orphaned-units guard see these
      // worktrees exactly as if they had been provisioned through a normal
      // launch, not through a second, divergent code path.
      try {
        const provisioned = await runSelections({ ctx, path: wtPath, selections, mode: 'auto' });
        await writeProvisionRecord(wtPath, selections, { kits: provisioned.kits, skills: provisioned.skills });
      } catch (e) {
        ctx.journal.add({ cmd: `provision failed for ${branch}: ${e.message || e}`, cwd: wtPath, mode: 'auto' });
      }

      const packName = hektorAdapterPack(selections);
      if (packName) {
        const { error } = await wireCursorAxis({ ctx, path: wtPath, packs: [packName], mode: 'auto', label: branch });
        if (error) out.cursorAdapterError = error;
      }
    }

    // Brief-writing is unconditional — independent of whether any pack was
    // selected at all: it's about the ticket's own context, not Hektor's.
    const brief = await writeTicketBrief({ worktreePath: wtPath, ticket, boxes, prompt, ctx });
    if (brief.error) {
      out.briefError = brief.error;
      ctx.journal.add({ cmd: `brief not written for ${branch}: ${brief.error}`, cwd: wtPath, mode: 'auto' });
    } else {
      out.briefPath = brief.path;
      if (brief.dirty) {
        ctx.journal.add({ cmd: `WARNING: docs/hektor/tickets/${ticket}.md is not excluded from git status in ${wtPath} — check .git/info/exclude`, cwd: wtPath, mode: 'auto' });
      }
    }

    const rule = await writeTicketRule({ worktreePath: wtPath, ticket, branch, boxes });
    if (rule.error) {
      out.ruleError = rule.error;
      ctx.journal.add({ cmd: `Cursor rule not written for ${branch}: ${rule.error}`, cwd: wtPath, mode: 'auto' });
    } else {
      out.rulePath = rule.path;
      if (rule.dirty) {
        ctx.journal.add({ cmd: `WARNING: .cursor/rules/ticket-${ticket}.mdc is not excluded from git status in ${wtPath} — check .git/info/exclude`, cwd: wtPath, mode: 'auto' });
      }
    }
    return out;
  }

  return async function handleAction(req, res, ctx, readBody) {
    const url = req.url.split('?')[0];
    const body = await readBody(req);
    const mode = body.mode ?? ctx.config.defaultMode;

    try {
      if (url === '/api/worktree/create') {
        const { repoPath, branch, base, newBranch } = body;
        const { result } = await createWorktreeAt({ repoPath, branch, base, newBranch, mode, ctx });
        return sendJson(res, result);
      }

      // One Cursor worktree-and-branch per ticket key, a brief written into
      // each, then one Cursor window on the worktrees (never the primary —
      // see openCursorWorkspace in terminal.mjs) with each brief opened as
      // its own tab. `selections` is already the FULL merged selection
      // (required Hektor skills included) computed client-side by
      // tickets.js's mergeRequiredSkills — this route provisions exactly
      // what it is handed, the same contract /api/launch has. `boxes` and
      // `prompt` are the same box list and composed session line the
      // client already shows and copies to the clipboard — passed through
      // so each ticket's brief can quote them exactly.
      if (url === '/api/tickets/worktrees') {
        const { repoPath, tickets = [], selections = [], boxes = [], prompt = '' } = body;
        const prefix = await inferBranchPrefix(repoPath);
        if (!prefix) {
          // Must not silently invent one: a guessed prefix could create
          // SHBDN-… branches in a repo that has only ever used tech/WEBT-….
          return sendJson(res, { error: `could not infer a branch prefix for ${repoPath}` }, 400);
        }
        const results = [];
        for (const ticket of tickets) {
          // eslint-disable-next-line no-await-in-loop -- one ticket at a
          // time on purpose: each may run git + provisioning + an
          // install.sh subprocess, and none of that should race another
          // ticket's writes into the same repo's .git/worktrees metadata.
          results.push(await ensureTicketWorktree({ repoPath, ticket, prefix, selections, boxes, prompt, ctx }));
        }
        // Named by ticket key — reads far better in Cursor's file tree than
        // the branch-slugged directory name — and built from EVERY ticket
        // that has a path, created just now or already existing: the user
        // wants to manage all of them from one window, not just the new ones.
        const opened = results.filter((r) => r.path).map((r) => ({ path: r.path, name: r.ticket }));
        const briefPaths = results.filter((r) => r.briefPath).map((r) => r.briefPath);
        if (opened.length) {
          // Fire-and-forget: opening the Cursor window must not hold the
          // HTTP response, and a window failing to open does not undo the
          // worktrees — the per-ticket results already say what exists on
          // disk. Journalled so a silent failure here (the whole reason this
          // step exists as a separate try) still leaves something to read.
          openCursorWorkspace({
            primaryPath: repoPath, worktrees: opened, worktreeRoot: ctx.config.worktreeRoot, briefPaths, openEditorCmd: ctx.config.openEditorCmd,
          })
            .then((r) => {
              if (!r.cli) {
                ctx.journal.add({ cmd: `Cursor CLI not found — opened only the primary checkout (${repoPath}); ${opened.length} worktree(s) and ${briefPaths.length} brief(s) were NOT opened`, cwd: repoPath, mode: 'auto' });
              } else if (!r.ok) {
                ctx.journal.add({ cmd: `Cursor did not launch (workspace file written at ${r.workspaceFile}, but the open call itself failed)`, cwd: repoPath, mode: 'auto' });
              } else {
                ctx.journal.add({ cmd: `Cursor workspace opened: ${r.workspaceFile} (${r.foldersAdded} worktree folder(s), ${r.briefsOpened} brief(s) opened as tabs)`, cwd: repoPath, mode: 'auto' });
              }
            })
            .catch((e) => ctx.journal.add({ cmd: `Cursor window did not open: ${e.message || e}`, cwd: repoPath, mode: 'auto' }));
        }
        return sendJson(res, { ok: true, results });
      }

      if (url === '/api/worktree/remove') {
        const { repoPath, path, force, isPrimary } = body;
        if (isPrimary) return sendJson(res, { error: 'refusing to remove primary worktree' }, 400);
        const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
        return sendJson(res, await dispatchGit({ cwd: repoPath, args, mode, ctx }));
      }

      if (url === '/api/worktree/apply-diff') {
        const { sourcePath, targetPath } = body;
        if (!sourcePath || !targetPath || sourcePath === targetPath) {
          return sendJson(res, { error: 'pick a different target worktree' }, 400);
        }
        const cmd = `git -C ${shQuote(sourcePath)} diff HEAD | git -C ${shQuote(targetPath)} apply --3way`;
        ctx.journal.add({ cmd, cwd: targetPath, mode });
        if (mode === 'guided') {
          runInTerminal({ command: cmd, cwd: targetPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command: cmd });
        }
        const patch = await runGit(sourcePath, ['diff', 'HEAD']);
        if (!patch.trim()) return sendJson(res, { error: 'no uncommitted (tracked) changes to move' }, 400);
        const tmp = join(tmpdir(), `forest-patch-${Date.now()}.patch`);
        await writeFile(tmp, patch);
        try {
          const out = await runGit(targetPath, ['apply', '--3way', tmp]);
          ctx.broadcast('worktrees', await ctx.snapshot());
          return sendJson(res, { mode, command: cmd, output: out || 'applied' });
        } finally {
          await unlink(tmp).catch(() => {});
        }
      }

      if (url === '/api/worktree/finish-preview') {
        const { repoPath, path } = body;
        return sendJson(res, await previewFinish({ repoPath, path }));
      }

      if (url === '/api/worktree/finish') {
        const { repoPath, path, targetBranch, remove = true, isPrimary } = body;
        if (isPrimary) return sendJson(res, { error: 'refusing to finish the primary worktree' }, 400);
        if (mode === 'guided') {
          const preview = await previewFinish({ repoPath, path });
          const tb = targetBranch || preview.targetBranch;
          if (!tb) return sendJson(res, { error: `cannot resolve a target branch for ${preview.worktreeName}` }, 400);
          const refusal = dirtyMainRefusal(preview, tb);
          if (refusal) return sendJson(res, { error: refusal }, 400);
          const command = finishCommands({ repoPath, path, targetBranch: tb, remove, preview }).join(' && ');
          ctx.journal.add({ cmd: command, cwd: repoPath, mode });
          runInTerminal({ command, cwd: repoPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }
        const result = await executeFinish({
          repoPath, path, targetBranch, remove,
          onStep: (s) => ctx.journal.add({ cmd: s.cmd, cwd: s.cwd, mode }),
        });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, ...result });
      }

      if (url === '/api/worktree/eject') {
        const { repoPath } = body;
        if (mode === 'guided') {
          const entries = await readLandings(repoPath);
          const entry = entries[entries.length - 1];
          if (!entry) return sendJson(res, { error: 'nothing to eject — no recorded landing' }, 400);
          if (!entry.previousBranch) return sendJson(res, { error: 'recorded landing has no previous branch (primary was detached at finish time)' }, 400);
          const command = [
            `git -C ${shQuote(repoPath)} switch ${shQuote(entry.previousBranch)}`,
            `git -C ${shQuote(repoPath)} worktree add ${shQuote(entry.path)} ${shQuote(entry.branch)}`,
          ].join(' && ');
          ctx.journal.add({ cmd: command, cwd: repoPath, mode });
          runInTerminal({ command, cwd: repoPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }
        const result = await executeEject({
          repoPath, onStep: (s) => ctx.journal.add({ cmd: s.cmd, cwd: s.cwd, mode }),
        });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, ...result });
      }

      // ---- description: read / save / reset ----
      // Read-only POSTs, like /api/worktree/scope below: the payload is a path,
      // and keeping all three together keeps the worktree lookup in one place.

      if (url === '/api/description' || url === '/api/description/reset') {
        const { path } = body;
        const w = findWorktree(await ctx.cachedSnapshot(), path);
        if (!w) return sendJson(res, { error: 'unknown worktree' }, 404);
        // Reset drops the override first, so the resolve below returns the
        // freshly composed text and the drawer needs no second round trip.
        if (url === '/api/description/reset') await clearDescription(w.repoPath, descriptionKey(w));
        const d = await resolveDescription({ worktree: w, config: ctx.config, cache: summaries });
        return sendJson(res, { ok: true, ...d });
      }

      if (url === '/api/description/save') {
        const { path, text } = body;
        const w = findWorktree(await ctx.cachedSnapshot(), path);
        if (!w) return sendJson(res, { error: 'unknown worktree' }, 404);
        await saveDescription(w.repoPath, descriptionKey(w), text);
        return sendJson(res, { ok: true });
      }

      // Writes the branch name into the ticket's branch field (the drawer's
      // "Branch → Jira" button). Journalled only when Jira actually changed.
      if (url === '/api/jira/submit-branch') {
        const { path, force } = body;
        const w = findWorktree(await ctx.cachedSnapshot(), path);
        if (!w) return sendJson(res, { error: 'unknown worktree' }, 404);
        if (!w.branch || !w.ticket) return sendJson(res, { error: 'this worktree has no ticket branch to submit' }, 400);
        const key = jiraKey(w.ticket, ctx.config.jiraProjectKey);
        const r = await submitBranch(key, w.branch, {
          baseUrl: ctx.config.jiraBaseUrl, token: ctx.config.jiraToken, email: ctx.config.jiraEmail,
          fieldId: ctx.config.jiraBranchFieldId, force: Boolean(force),
        });
        if (r.ok && !r.already) ctx.journal.add({ cmd: `jira: set Git Branch Name on ${key} → ${w.branch}`, cwd: w.repoPath, mode });
        return sendJson(res, { key, branch: w.branch, ...r });
      }

      // Read-only: what does the ticket's branch field hold right now? The
      // drawer uses a null value to highlight the Branch → Jira button.
      if (url === '/api/jira/branch-field') {
        const { path } = body;
        const w = findWorktree(await ctx.cachedSnapshot(), path);
        if (!w) return sendJson(res, { error: 'unknown worktree' }, 404);
        if (!w.ticket) return sendJson(res, { error: 'this worktree has no ticket' }, 400);
        const key = jiraKey(w.ticket, ctx.config.jiraProjectKey);
        const r = await readBranch(key, {
          baseUrl: ctx.config.jiraBaseUrl, token: ctx.config.jiraToken, email: ctx.config.jiraEmail,
          fieldId: ctx.config.jiraBranchFieldId,
        });
        if (r.error) return sendJson(res, { key, ...r });
        return sendJson(res, { ok: true, key, value: r.value });
      }

      // The Tickets modal's list. Two scopes, two JQLs, never merged: "current
      // sprint" has to keep meaning the active-sprint set.
      if (url === '/api/jira/tickets') {
        const { scope = 'sprint', assignee, refresh = false } = body;
        if (scope !== 'sprint' && scope !== 'backlog') return sendJson(res, { error: `unknown scope: ${scope}` }, 400);
        const user = String(assignee ?? '').trim();
        if (!user) return sendJson(res, { error: 'pick a person to list tickets for' }, 400);
        const jql = scope === 'sprint' ? sprintJql(user) : backlogJql(user);
        const opts = { baseUrl: ctx.config.jiraBaseUrl, token: ctx.config.jiraToken, email: ctx.config.jiraEmail };
        const r = await tickets.get(`${scope}:${user}`, () => searchTickets(jql, opts), { force: Boolean(refresh) });
        if (r.error) return sendJson(res, { error: r.error });
        return sendJson(res, { ok: true, scope, jql, ...r });
      }

      // The person picker. An empty query is "who am I" — the modal's first
      // paint — and must not spend a user search on it.
      if (url === '/api/jira/people') {
        const q = String(body.q ?? '').trim();
        const opts = { baseUrl: ctx.config.jiraBaseUrl, token: ctx.config.jiraToken, email: ctx.config.jiraEmail };
        if (!q) {
          const r = await whoami(opts);
          if (r.error) return sendJson(res, { error: r.error });
          return sendJson(res, { ok: true, me: r, people: [r] });
        }
        const r = await searchPeople(q, opts);
        if (r.error) return sendJson(res, { error: r.error });
        return sendJson(res, { ok: true, people: r.people });
      }

      // The login form (Task 9, round 3) — now the PRIMARY way to connect
      // SRP, with the bookmarklet as the alternative for people who would
      // rather not type a password here. Unlike /api/srp/token below, this
      // route needs no Origin check of its own: it is called from forest's
      // OWN page (the Connect panel, same origin as this server), exactly
      // like every other D.api(...) call in tickets.js, and it inherits the
      // same protection every other JSON route already has — a cross-origin
      // page cannot reach it either, because readBody aside, the client
      // sends `content-type: application/json`, which is not CORS-simple and
      // forces a preflight that nothing here answers (see server.mjs). No
      // new exposure, so no new CORS handling.
      if (url === '/api/srp/login') {
        const username = String(body.username ?? '').trim();
        // Checked for blankness via a local trim, but the value actually
        // sent to SRP below is NOT trimmed — a password's leading/trailing
        // whitespace, however unusual, is the user's to send unmangled.
        const password = String(body.password ?? '');
        if (!username || !password.trim()) {
          return sendJson(res, { error: 'enter both a username and a password' }, 400);
        }
        // The password lives here, as this call's own argument, for exactly
        // as long as this await takes — one JSON.stringify'd body, over
        // whatever scheme srpBaseUrl specifies (https in a real deployment).
        // It is never assigned to anything longer-lived than this route's
        // own stack frame: not `runtimeSrp`, not the journal entry below,
        // not the response. Once loginSrp() returns, nothing in this
        // process still references it.
        const r = await loginSrp({ baseUrl: ctx.config.srpBaseUrl, username, password });
        if (r.error) return sendJson(res, { error: r.error });
        // Same store, same invalidation the bookmarklet route below relies
        // on: srpFor()'s memo key includes the refresh AND access token, so
        // assigning here is what makes the next call rebuild the client.
        runtimeSrp = { refreshToken: r.refreshToken, accessToken: r.accessToken };
        ctx.journal.add({ cmd: `srp: connected as ${username}`, cwd: ctx.forestRoot, mode });
        return sendJson(res, { ok: true, source: 'login', username });
      }

      // The bookmarklet's landing pad (Task 9). SRP's credential lives in
      // localStorage on SRP's OWN origin — unreachable to any other page —
      // so the only way it reaches forest is a page running there POSTing it
      // here. The Origin check below IS the security boundary, not the CORS
      // headers: a text/plain POST is CORS-simple, so the browser sends it
      // regardless of what this route answers, and without the check any
      // page the user happens to have open could plant a token here.
      if (url === '/api/srp/token') {
        const expectedOrigin = originOf(ctx.config.srpBaseUrl);
        const reqOrigin = (req.headers && req.headers.origin) || '';
        if (!expectedOrigin || reqOrigin !== expectedOrigin) {
          return sendJson(res, { error: 'refused: this request did not come from the configured SRP origin' }, 403);
        }
        // The origin is verified past this point, so every response below
        // echoes it back: without Access-Control-Allow-Origin here the
        // bookmarklet's own fetch() would reject with a CORS error even on
        // success — a simple POST is CORS-simple to SEND, not to READ.
        const respond = (obj, code = 200) => {
          res.writeHead(code, { 'content-type': 'application/json', 'Access-Control-Allow-Origin': reqOrigin });
          res.end(JSON.stringify(obj));
        };
        const refreshToken = String(body.refreshToken ?? '').trim();
        if (!refreshToken) {
          return respond({ error: 'no SRP refresh token in the request — log in to SRP in that tab, then click the bookmarklet again' }, 400);
        }
        // Stored by value only in memory — see the `runtimeSrp` declaration
        // above. Never logged, never journalled, never echoed back.
        runtimeSrp = { refreshToken, accessToken: body.accessToken ? String(body.accessToken) : null };
        ctx.journal.add({ cmd: 'srp: connected via bookmarklet', cwd: ctx.forestRoot, mode });
        return respond({ ok: true, source: 'browser' });
      }

      // The Tickets modal's box list. This route never fails: a box list is
      // not worth breaking a ticket picker over, so every SRP problem
      // degrades to config.testboxes with the reason attached.
      if (url === '/api/srp/boxes') {
        const fallback = {
          ok: true, source: 'config',
          // Through the same normaliser as an SRP record, so `x161` in
          // config.json reaches the prompt as `x:161` — the form the skills
          // want — instead of depending on which of the two paths the modal
          // happened to take. An entry boxLabel cannot read at all is dropped
          // rather than rendered as a blank checkbox, matching
          // listReservations().
          boxes: (ctx.config.testboxes || [])
            .map((testbox) => ({ box: boxLabel({ testbox }) }))
            .filter((b) => b.box),
        };
        // A runtime token from the bookmarklet counts as configured too —
        // the whole point of Task 9 is that config.srpRefreshToken no longer
        // has to hold anything.
        const hasToken = Boolean((runtimeSrp && runtimeSrp.refreshToken) || ctx.config.srpRefreshToken);
        if (!ctx.config.srpBaseUrl || !hasToken) {
          return sendJson(res, { ...fallback, reason: 'connect SRP (click the bookmarklet) or set srpBaseUrl/srpRefreshToken in config.json to read your reservations' });
        }
        // The "never fails" promise has to hold locally, not just because
        // lib/srp.mjs happens to behave: a throw from constructing the
        // client, or from awaiting listReservations() (a malformed body, a
        // bug three calls away), must degrade the same way an { error }
        // return does, not escape to the router's shared catch-all as a 500.
        try {
          const r = await srpFor(ctx.config).listReservations();
          if (r.error) return sendJson(res, { ...fallback, reason: r.error });
          return sendJson(res, { ok: true, source: 'srp', boxes: r.boxes });
        } catch (e) {
          return sendJson(res, { ...fallback, reason: e.message || String(e) });
        }
      }

      if (url === '/api/srp/reserve') {
        const description = String(body.description ?? '').trim();
        const expectedEndDate = String(body.expectedEndDate ?? '').trim();
        if (!description) return sendJson(res, { error: 'a reservation needs a description' }, 400);
        if (!expectedEndDate) return sendJson(res, { error: 'a reservation needs an end date' }, 400);
        const client = srpFor(ctx.config);
        ctx.journal.add({ cmd: `srp: reserve a box for ${description}`, cwd: ctx.forestRoot, mode });
        const r = await client.reserve({ description, expectedEndDate, expectedState: Number(body.expectedState ?? 5) });
        if (r.error) return sendJson(res, { error: r.error });
        if (r.queued) return sendJson(res, { ok: true, queued: true, message: r.message });
        return sendJson(res, { ok: true });
      }

      // A color label whose meaning belongs to the user; the deck renders it,
      // nothing acts on it. Empty priority clears. Broadcasts a fresh snapshot
      // so every open deck recolors immediately.
      if (url === '/api/worktree/priority') {
        const { path, priority } = body;
        const w = findWorktree(await ctx.cachedSnapshot(), path);
        if (!w) return sendJson(res, { error: 'unknown worktree' }, 404);
        if (priority && !PRIORITY_COLORS.includes(priority)) {
          return sendJson(res, { error: `priority must be one of ${PRIORITY_COLORS.join(', ')} (or empty to clear)` }, 400);
        }
        if (priority) await savePriority(w.repoPath, priorityKey(w), priority);
        else await clearPriority(w.repoPath, priorityKey(w));
        // Echo into the cached snapshot and broadcast that — a full rebuild
        // walks every repo and takes seconds, which made every swatch click
        // (and every request queued behind it) crawl. The periodic loop
        // re-stamps from disk anyway.
        w.priority = priority || null;
        ctx.broadcast('worktrees', await ctx.cachedSnapshot());
        return sendJson(res, { ok: true, priority: priority || null });
      }

      if (url === '/api/worktree/scope') {
        const { path } = body;
        const s = await resolveSessionScope(path);
        const cs = await resolveCursorScope(path);
        return sendJson(res, {
          active: s.active.length,
          inline: s.inline.length,
          sources: s.sources,
          missing: s.missing.map((h) => ({ command: h.command, source: h.source, file: h.file })),
          // The Cursor axis, for the picker's Cursor CLI mode. `file: null`
          // means there is no .cursor/hooks.json at all — Start installs it.
          cursor: { active: cs.active.length, missing: cs.missing.map((h) => ({ event: h.event, command: h.command, file: h.file })), file: cs.file },
        });
      }

      if (url === '/api/worktree/repair') {
        const { path } = body;
        const rec = await readProvisionRecord(path);
        if (!rec || !Array.isArray(rec.selections) || !rec.selections.length) {
          return sendJson(res, { error: 'no provision record' }, 409);
        }
        // refresh: a repair replay means "bring this worktree up to date with
        // the current pack sources" — stale vendored copies are updated, not
        // reported as conflicts on every click (same-run cross-kit collisions
        // still are; see copyTree's overwrite contract).
        const provisioned = await runSelections({ ctx, path, selections: rec.selections, mode, refresh: true });
        // The Cursor axis replays from the record's own `cursor.packs`. A
        // worktree wired before that slot existed has a .cursor/hooks.json
        // and no record of it: replay every recorded pack that ships an
        // install.sh, and the record write inside wireCursorAxis backfills
        // the slot for next time.
        let cursorPacks = Array.isArray(rec.cursor?.packs) ? rec.cursor.packs.filter((p) => safeId(p)) : [];
        if (!cursorPacks.length && await stat(join(path, '.cursor', 'hooks.json')).then(() => true, () => false)) {
          cursorPacks = await packsWithInstaller(ctx.config.packsDir, rec.selections.map((s) => s.pack));
        }
        let cursor = null;
        if (cursorPacks.length) {
          const w = await wireCursorAxis({ ctx, path, packs: cursorPacks, mode, label: worktreeTitle(path) });
          cursor = { wired: w.wired.length, ...(w.error ? { error: w.error } : {}) };
        }
        const scope = await resolveSessionScope(path);
        ctx.journal.add({
          cmd: `repair: re-provisioned ${provisioned.kits.length} kit(s); missing ${scope.missing.length}`
            + (cursor ? `; cursor axis: ${cursor.wired}/${cursorPacks.length} pack(s) re-wired` : ''),
          cwd: path, mode,
        });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { ok: true, provisioned, scope: { active: scope.active.length, missing: scope.missing.length }, cursor });
      }

      if (url === '/api/worktree/remove-units') {
        const { path, units = [] } = body;
        const removed = [], refused = [], gone = [];
        for (const u of units) {
          const kind = u && typeof u === 'object' ? u.kind : undefined;
          const id = u && typeof u === 'object' ? u.id : undefined;
          // A bad kind, a bad id, or a unit that isn't even an object all mean
          // the same thing to the caller: nothing happened. Say so — silently
          // dropping it left the caller with no signal at all.
          if (!u || typeof u !== 'object' || (kind !== 'kit' && kind !== 'skill') || !safeId(id)) {
            refused.push({ kind, id: id !== undefined ? String(id) : String(u), reason: 'invalid unit', stillListed: true });
            continue;
          }
          const base = resolve(join(path, '.claude', kind === 'kit' ? 'kits' : 'skills'));
          const dir = resolve(join(base, id));
          // A regression guard, not a live filter: safeId already forbids '/',
          // '.' and '..', so nothing that reaches here can land anywhere but
          // one level under base — this branch is unreachable while safeId is
          // intact, and that is the point. safeId is shared with three other,
          // non-destructive call sites (provisionPack's pack/skill/kit ids),
          // where a loosened character class costs a skipped copy; here it
          // costs an `rm -rf` outside .claude/. This delete must not depend
          // solely on a helper it does not own. Symlinks need no handling of
          // their own: fs.rm does not dereference, so a symlinked <id> unlinks
          // the link and never walks into its target.
          if (dirname(dir) !== base) {
            refused.push({ kind, id, reason: 'invalid unit', stillListed: true });
            continue;
          }
          try {
            await rm(dir, { recursive: true, force: false });
            removed.push(`${kind}:${id}`);
            gone.push({ kind, id });
            ctx.journal.add({ cmd: `removed ${kind} ${id} from .claude/`, cwd: path, mode });
          } catch (e) {
            // The two refusal kinds have opposite record consequences, and
            // treating them alike is what left Remove a one-way door even
            // after the record started being rewritten:
            //
            //   ENOENT — the unit is not on disk. Nothing was removed because
            //     there was nothing there; the record is simply wrong to list
            //     it. Drop it as if removed, or the guard re-blocks forever on
            //     a unit whose only offered remedy is a removal with nothing
            //     left to remove.
            //   EPERM/EACCES — the files really ARE still there, still
            //     registered, still executing. Staying listed is CORRECT.
            //     Dropping it would hide a running unit from the one guard
            //     that can see it.
            //
            // Anything else (ENOTDIR, an unrecognised code) keeps the id too:
            // forest does not know what is on disk, and the guard is the
            // conservative place to be wrong.
            const droppable = e.code === 'ENOENT';
            if (droppable) gone.push({ kind, id });
            // `stillListed` is the fact this route owns: forest did NOT drop
            // this id from the provision record. The client turns it into
            // "the next launch blocks on it again", which is what the user
            // needs to hear instead of "this guard is clear".
            refused.push({ kind, id, reason: removeFailureReason(e, kind, id), stillListed: !droppable });
            ctx.journal.add({ cmd: `remove refused: ${kind} ${id} — ${e.message || e}`, cwd: path, mode });
          }
        }
        // The record is what the next launch compares against and what repair
        // replays. Leaving it naming a unit that is no longer on disk is what
        // made Remove a one-way door: the guard re-blocked on the removed unit
        // forever, offering a removal with nothing left to remove. `gone` is
        // every unit that is now absent — deleted here, or already absent when
        // this route looked (see the ENOENT branch above) — not merely every
        // unit this route deleted.
        if (gone.length) {
          try {
            const rec = await readProvisionRecord(path);
            if (rec) {
              const next = recordWithout(rec, gone);
              // `next.at`: the surviving units were not re-provisioned, so
              // their `since` must not read as the removal date.
              await writeProvisionRecord(path, next.selections, next.inventory, next.at, next.cursor);
              ctx.journal.add({ cmd: `provision record no longer lists ${gone.map((g) => `${g.kind} ${g.id}`).join(', ')}`, cwd: path, mode });
            }
          } catch (e) {
            // Best-effort by necessity: the files are already gone, and
            // answering "remove failed" here would be a lie. Say it loudly
            // where it can be read instead of swallowing it.
            ctx.journal.add({ cmd: `WARNING: could not update the provision record after removal — the next launch will still block on ${gone.map((g) => g.id).join(', ')} (${e.message || e})`, cwd: path, mode });
            // The write above did not happen, so the record still lists every
            // id in `gone` — deleted from disk or not. `stillListed` is the
            // one field the client trusts to decide whether the guard is
            // clear (see the comment on the `refused.push` above); it must
            // not stay wired to whether the `rm` succeeded once the record
            // write that was supposed to follow it has thrown. Flip back to
            // `true` whatever this loop already marked `false` (the ENOENT
            // case, which assumed this write would succeed), and add an entry
            // for ids that were never in `refused` at all — a clean `rm` with
            // no record consequence yet — so the client does not read a clean
            // sweep that did not happen and recurse straight back into the
            // guard it just hit. This is the one-way loop the branch that
            // introduced Remove was written to close; a failed record write
            // is the rarer trigger that reopened it.
            for (const g of gone) {
              // Matched on `{ kind, id }`, not `id` alone: a kit and a skill
              // can share an id, and an id-only lookup would find the WRONG
              // unit's refused entry and mark it `stillListed` again — while
              // the other one, whose record write genuinely failed, never
              // gets an entry at all and the user is never told about it.
              const already = refused.find((r) => r.kind === g.kind && r.id === g.id);
              if (already) { already.stillListed = true; continue; }
              refused.push({
                kind: g.kind,
                id: g.id,
                reason: `${g.id} was deleted from disk, but forest's record could not be updated — the next launch may still block on it`,
                stillListed: true,
              });
            }
          }
        }
        return sendJson(res, { ok: true, removed, refused });
      }

      if (url === '/api/git') {
        const { path, action, message } = body;
        const map = { fetch: ['fetch'], pull: ['pull'], push: ['push'], commit: ['commit', '-am', message || 'wip'] };
        const args = map[action];
        if (!args) return sendJson(res, { error: 'unknown git action' }, 400);
        return sendJson(res, await dispatchGit({ cwd: path, args, mode, ctx }));
      }

      if (url === '/api/fetch-all') {
        const snap = await ctx.snapshot();
        const repoPaths = snap.repos.map((r) => r.repoPath);
        const command = repoPaths.map((p) => `git -C ${shQuote(p)} fetch`).join('; ');
        ctx.journal.add({ cmd: command, mode });
        if (mode === 'guided') {
          runInTerminal({ command, cwd: ctx.config.roots[0], app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }
        for (const p of repoPaths) { try { await runGit(p, ['fetch']); } catch { /* skip */ } }
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, command });
      }

      if (url === '/api/repos/add') {
        const { path } = body;
        const r = await addRepo(ctx.forestRoot, path);
        if (!r.ok) return sendJson(res, { error: repoErrorMessage(r.reason, r) }, 400);
        ctx.setRepoList(r.repos);
        ctx.journal.add({ cmd: `repo added: ${path}`, cwd: ctx.forestRoot, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { ok: true, repos: r.repos });
      }

      if (url === '/api/repos/remove') {
        const { path } = body;
        const r = await removeRepo(ctx.forestRoot, path);
        if (!r.ok) return sendJson(res, { error: repoErrorMessage(r.reason) }, 400);
        ctx.setRepoList(r.repos);
        ctx.journal.add({ cmd: `repo removed from the list (nothing deleted): ${path}`, cwd: ctx.forestRoot, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { ok: true, repos: r.repos });
      }

      if (url === '/api/repo/prune-preview') {
        const { repoPath } = body;
        // Read-only: the cached snapshot is enough, and a fresh build costs
        // seconds. /api/repo/prune below re-reads a FRESH one before deleting,
        // so a stale preview cannot turn into a wrong deletion.
        const snap = await (ctx.cachedSnapshot ?? ctx.snapshot)();
        const repo = snap.repos.find((r) => r.repoPath === repoPath);
        if (!repo) return sendJson(res, { error: 'unknown repo' }, 404);
        const { candidates, kept } = selectCandidates(repo.worktrees, { staleDays: ctx.config.staleDays });
        const withSizes = await Promise.all(candidates.map(async (w) => ({
          path: w.path,
          branch: w.branch,
          detached: w.detached,
          ageDays: w.ageDays,
          sizeBytes: await dirSizeBytes(w.path),
        })));
        return sendJson(res, { candidates: withSizes, kept });
      }

      if (url === '/api/repo/prune') {
        const { repoPath, paths = [] } = body;
        if (!paths.length) return sendJson(res, { error: 'nothing selected' }, 400);
        const snap = await ctx.snapshot();
        const repo = snap.repos.find((r) => r.repoPath === repoPath);
        if (!repo) return sendJson(res, { error: 'unknown repo' }, 404);
        const staleDays = ctx.config.staleDays;

        if (mode === 'guided') {
          // Re-select from the fresh snapshot so the terminal never gets a
          // command for something that stopped qualifying.
          const { candidates } = selectCandidates(repo.worktrees, { staleDays });
          const targets = candidates.filter((w) => paths.includes(w.path));
          if (!targets.length) return sendJson(res, { error: 'nothing left to prune' }, 400);
          const command = pruneCommands({ repoPath, targets }).join(' && ');
          ctx.journal.add({ cmd: command, cwd: repoPath, mode });
          runInTerminal({ command, cwd: repoPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }

        const result = await pruneWorktrees({
          repoPath, paths, worktrees: repo.worktrees, staleDays,
          onStep: (s) => ctx.journal.add({ cmd: s.cmd, cwd: s.cwd, mode }),
        });
        for (const f of result.failed) ctx.journal.add({ cmd: `prune failed (${f.step}): ${f.path} — ${f.error}`, cwd: repoPath, mode });
        for (const s of result.skipped) ctx.journal.add({ cmd: `prune skipped: ${s.path} (${s.reason})`, cwd: repoPath, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, ...result });
      }

      if (url === '/api/launch') {
        const { path, selections = [] } = body;
        // Validated before anything is read or written — a 400 must mutate
        // nothing, exactly like the orphan block below. Absent means Claude:
        // the shape every pre-existing caller sends.
        const agent = requestedAgent(body);
        if (agent !== 'claude' && agent !== 'cursor') return sendJson(res, { error: AGENT_ERROR }, 400);
        const sel = selections.filter((s) => s && s.pack && ((s.skills?.length) || (s.kits?.length) || s.hooks));

        // Read AND enforce before provisioning touches anything: a blocked
        // call must mutate nothing — no disk, no record — so a retry with the
        // identical selection blocks identically instead of silently
        // launching one call later. (Reading late enough to compare against
        // an already-rewritten record was Task 3's original bug; returning
        // late enough for that same rewrite to happen anyway, even while
        // blocking, was the same bug one step over.) missing-hooks cannot be
        // checked here — provisioning may be what installs the gate — so it
        // no longer outranks orphaned-units: a missing gate is only knowable
        // after provisioning runs, and provisioning must not run while an
        // orphan is unresolved. A user who hits both sees orphaned-units
        // first, resolves it, and meets missing-hooks on the next launch.
        const previous = await readProvisionRecord(path).catch(() => null);
        const orphaned = orphanedUnits(previous, sel);
        if (orphaned.length && !body.force) {
          const names = orphaned.map((o) => o.id).join(', ');
          ctx.journal.add({ cmd: `launch blocked: ${orphaned.length} provisioned unit(s) no longer selected (${names})`, cwd: path, mode });
          return sendJson(res, {
            ok: false, blocked: 'orphaned-units', orphaned,
            // Constant, and provably so: /api/worktree/repair replays
            // `rec.selections` and never touches the incoming selection — which
            // is the half of the comparison that makes these units orphans. A
            // repair run therefore leaves this block exactly where it stands,
            // however full the record is. `repairableRecord` is not consulted
            // because the question it answers ("can repair rewrite a missing
            // registration?") is not the question here.
            repairable: false,
          });
        }

        let provisioned = null;
        if (sel.length) {
          try {
            provisioned = await runSelections({ ctx, path, selections: sel, mode });
            await writeProvisionRecord(path, sel, { kits: provisioned.kits, skills: provisioned.skills });
            const n = provisioned.skills.length, k = provisioned.kits.length;
            ctx.journal.add({ cmd: `provision: ${n} skill(s)${k ? `, ${k} kit(s)` : ''}${provisioned.hooks ? ', gates' : ''} → .claude/`, cwd: path, mode });
          } catch (e) {
            return sendJson(res, { error: `provision failed: ${e}` }, 500);
          }
        }

        // The Cursor axis: cursor-agent reads .cursor/ only, and nothing
        // above writes there. Each selected pack that ships an install.sh is
        // installed whole (the checkboxes shape .claude/ only). Gated on
        // sel.length like provisioning: an empty selection wires nothing.
        // Non-blocking — the error rides the response and the journal, and
        // the window still opens: the user asked for a session, not a gate.
        let cursorAdapter = null;
        if (agent === 'cursor' && sel.length) {
          const packs = await packsWithInstaller(ctx.config.packsDir, sel.map((s) => s.pack));
          if (packs.length) {
            const w = await wireCursorAxis({ ctx, path, packs, mode, label: worktreeTitle(path) });
            if (w.error) cursorAdapter = { error: w.error };
          } else {
            // A selection of packs that never offered a Cursor axis is fine;
            // a misconfigured packsDir looks identical from here. One line
            // makes the difference diagnosable from the journal.
            ctx.journal.add({ cmd: `no pack in the selection ships an install.sh — nothing wired under .cursor/ for ${worktreeTitle(path)}`, cwd: path, mode });
          }
        }

        // Claude only: launchDecision reads settings.json hook registrations,
        // which cursor-agent never loads — blocking a Cursor launch on a
        // missing Claude gate would be a gate that guards nothing.
        if (agent === 'claude') {
          const decision = await launchDecision({ path, force: !!body.force, packsDir: ctx.config.packsDir, resolveScope });
          if (!decision.launch) {
            ctx.journal.add({ cmd: `launch blocked: ${decision.missing.length} hook script(s) registered but missing`, cwd: path, mode });
            return sendJson(res, { ok: false, ...decision, provisioned });
          }
        }

        // Left undefined (never coerced to '') when absent: `launch` is a test
        // double in `actions.test.mjs`, and the no-prompt case asserts the
        // launcher sees `prompt: undefined` — byte-identical to the call
        // before this feature existed.
        const prompt = body.prompt ? String(body.prompt) : undefined;
        const cmds = agentCmds(ctx.config);
        const r = await launch({ worktreePath: path, agent, cmds, app: ctx.config.terminalApp, title: worktreeTitle(path), prompt });
        // Journalled AFTER launch returns, and keyed on what actually
        // happened rather than what was asked for: a focused (already-alive)
        // session never receives the prompt, so a bare command line is the
        // truth for it — journalling the quoted prompt there would record a
        // delivery that never occurred.
        ctx.journal.add({
          cmd: prompt && r?.action === 'launched' ? `${cmds[agent]} ${shQuote(prompt)}` : cmds[agent],
          cwd: path, mode: 'guided',
        });
        // Same shape for both agents so the client reports them identically;
        // for Cursor the "source" is the one file the registrations live in.
        let scope;
        if (agent === 'cursor') {
          const cs = await resolveCursorScope(path);
          scope = { active: cs.active.length, missing: cs.missing.map((h) => ({ command: h.command, source: cs.file })) };
          if (cs.missing.length) ctx.journal.add({ cmd: `scope: ${cs.missing.length} Cursor gate script(s) registered but missing`, cwd: path, mode });
        } else {
          // The injected resolver, like `launchDecision` above: the
          // module-level one made a route test read the developer's real
          // ~/.claude/settings.json.
          const s = await resolveScope(path);
          scope = { active: s.active.length, missing: s.missing.map((h) => ({ command: h.command, source: h.source })) };
          if (s.missing.length) ctx.journal.add({ cmd: `scope: ${s.missing.length} hook script(s) registered but missing`, cwd: path, mode });
        }
        // A focused (already-alive) session never receives the prompt — it
        // was not delivered, and the response must say so. `agent` is the
        // launcher's answer: on focus it is whatever the lock says is
        // running, which may not be what was asked for.
        return r && r.ok
          ? sendJson(res, {
            ok: true, action: r.action, agent: r.agent || agent, provisioned,
            promptSent: Boolean(prompt) && r.action === 'launched',
            scope,
            ...(cursorAdapter ? { cursorAdapter } : {}),
          })
          : sendJson(res, { error: (r && r.error) || 'failed to open Terminal' }, 500);
      }

      if (url === '/api/open') {
        const { path, target } = body;
        ctx.journal.add({ cmd: `open ${shQuote(path)} (${target})`, cwd: path, mode: 'guided' });
        openWith({ path, target, openEditorCmd: ctx.config.openEditorCmd, app: ctx.config.terminalApp });
        return sendJson(res, { ok: true });
      }

      if (url === '/api/task') {
        const { path, prompt } = body;
        const agent = requestedAgent(body);
        if (agent !== 'claude' && agent !== 'cursor') return sendJson(res, { error: AGENT_ERROR }, 400);
        const cmds = agentCmds(ctx.config);
        if (mode === 'guided') {
          // Stay fluent: open a terminal so the user runs the agent themselves.
          ctx.journal.add({ cmd: cmds[agent], cwd: path, mode: 'guided' });
          launch({ worktreePath: path, agent, cmds, app: ctx.config.terminalApp, title: worktreeTitle(path) });
          return sendJson(res, { mode: 'guided', agent });
        }
        // Headless stays Claude-only: `claude -p` is the streaming contract
        // the drawer renders; cursor-agent's print mode is not wired here.
        ctx.journal.add({ cmd: `${cmds.claude} -p ${shQuote(prompt)}`, cwd: path, mode: 'auto' });
        runHeadless({
          worktreePath: path, prompt, registry: ctx.registry, claudeCmd: cmds.claude,
          onOutput: (chunk) => ctx.broadcast('task', { path, chunk }),
          onDone: (code) => ctx.broadcast('task', { path, done: true, code }),
        });
        return sendJson(res, { mode: 'auto', started: true });
      }

      return sendJson(res, { error: 'unknown action' }, 404);
    } catch (e) {
      return sendJson(res, { error: String(e) }, 500);
    }
  };
}
