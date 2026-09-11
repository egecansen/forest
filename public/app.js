import { initTickets, openTickets, closeTickets } from './tickets.js';
import { loadAgent, saveAgent, agentLabel, scopeLine, startLabel, launchToast, repairToast } from './agent-choice.js';

const $ = (s) => document.querySelector(s);
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const state = { config: null, snapshot: { repos: [] }, filter: '', mode: 'guided', taskBuf: {}, packs: [] };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

async function api(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch (e) {
    toast(`Error: ${e.message}`);
    return {};
  }
}

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('forest-mode', mode);
  const b = $('#mode-toggle');
  b.textContent = mode === 'auto' ? 'Auto' : 'Guided';
  b.className = mode === 'auto' ? 'mode-auto' : 'mode-guided';
}

// theme — boot script in index.html sets the initial data-theme (incl. OS default);
// here we only sync the toggle glyph and persist on explicit user action.
function syncThemeButton() {
  const t = document.documentElement.dataset.theme || 'light';
  const b = $('#theme-toggle');
  b.textContent = t === 'dark' ? '☀' : '☾';
  b.title = t === 'dark' ? 'Switch to light' : 'Switch to dark';
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('forest-theme', next);
  syncThemeButton();
}

function statusBadge(w) {
  if (w.stale || w.merged) return `<span class="badge b-stale">${w.merged ? 'merged' : 'stale'}</span>`;
  if (w.status.dirty) return `<span class="badge b-changed">${w.status.changed} changed</span>`;
  return `<span class="badge b-clean">clean</span>`;
}
function gateBadge(w) {
  const s = w.scope;
  if (!s || (!s.active && !s.missing)) return '';
  return s.missing
    ? `<span class="badge b-stale" title="hook scripts registered but absent — the gates are not running">gates ${s.active} · missing ${s.missing}</span>`
    : `<span class="badge b-clean" title="every registered hook resolves to a file">gates ${s.active}</span>`;
}
// Maps the closed vocabulary a ticket brief's `Status:` line can carry (see
// lib/ticket-status.mjs) to a badge color. The ticket key goes in the title
// only — the branch already shows the number, so the badge itself stays just
// the status word.
const TICKET_STATUS_CLASS = {
  'not started': 'b-tk-not-started',
  'in progress': 'b-tk-in-progress',
  blocked: 'b-tk-blocked',
  'ready for review': 'b-tk-ready',
};
function ticketBadge(w) {
  const t = w.ticketStatus;
  if (!t || !t.status) return '';
  const cls = TICKET_STATUS_CLASS[t.status];
  if (!cls) return '';
  return `<span class="badge ${cls}" title="${esc(t.key)}">${esc(t.status)}</span>`;
}
function agentCell(a) {
  const cls = a.state === 'running' ? 'run' : a.state === 'idle' ? 'idle' : 'unknown';
  const label = a.state === 'running' ? (a.kind || 'agent') : a.state;
  return `<span><span class="dot ${cls}"></span>${label}</span>`;
}
function ageCell(w) { return w.ageDays == null ? '—' : w.ageDays === 0 ? 'today' : `${w.ageDays}d`; }
function sizeCell(w) { return w.sizeBytes == null ? '—' : `${(w.sizeBytes / 1e9).toFixed(1)}G`; }
// Plain text, deliberately not a link: clicking anywhere on a row opens that
// worktree's drawer, and a branch name that navigated to Jira instead made the
// widest click target in the row the one that left the app. The ticket link
// lives in the drawer's description, where it is asked for rather than hit by
// accident.
function branchCell(w) {
  const dot = w.priority ? `<span class="prio-dot prio-${w.priority}"></span>` : '';
  return `${dot}${esc(w.branch) || '(detached)'}`;
}

function matches(w, repo) {
  const f = state.filter.toLowerCase();
  if (!f) return true;
  return [repo, w.branch, w.ticket, w.owner].filter(Boolean).some((s) => s.toLowerCase().includes(f));
}

function rowHtml(w, repo) {
  const enc = encodeURIComponent(w.path);
  const pruneable = (w.stale || w.merged) && !w.isPrimary;
  return `<div class="row ${w.isPrimary ? '' : 'nested'}${w.priority ? ` prio-${w.priority}` : ''}" data-path="${enc}">
    <div class="col-branch branch">${branchCell(w)}</div>
    <div class="col-status">${statusBadge(w)}${gateBadge(w)}${ticketBadge(w)}</div>
    <div class="col-owner">${esc(w.owner)}</div>
    <div class="col-agent">${agentCell(w.agent)}</div>
    <div class="col-age">${ageCell(w)}</div>
    <div class="col-size">${sizeCell(w)}</div>
    <div class="col-actions actions">
      <button title="Quick task" data-act="task" data-path="${enc}">⚡</button>
      <button title="Launch a session" data-act="launch" data-path="${enc}">▶</button>
      ${w.scope && w.scope.missing
        ? `<button title="Repair ${w.scope.missing} missing hook script(s)" data-act="repair" data-path="${enc}">🩹</button>`
        : `<button title="Refresh hooks: re-provision this worktree from the current pack/kit sources (stale registrations are cleaned up; a session already running here keeps its old hook config until restarted)" data-act="repair" data-path="${enc}">↻</button>`}
      <button title="Open in Cursor" data-act="open-cursor" data-path="${enc}">⤓</button>
      ${w.isPrimary ? '' : `<button data-act="finish" data-path="${enc}" title="Finish: land this worktree's branch, then put the main checkout back on its previous branch">✓</button>`}
      ${pruneable ? `<button title="Prune" data-act="remove" data-path="${enc}" data-repo="${encodeURIComponent(w.repoPath)}" data-primary="${w.isPrimary}">🧹</button>` : ''}
    </div>
  </div>`;
}

// The basename of a listed repo path — client-side equivalent of node's
// path.basename() for the absolute POSIX paths forest deals in. Falls back
// to the raw path so a degenerate entry (e.g. "/") never renders a blank
// header label.
function baseName(p) {
  const raw = String(p ?? '');
  const s = raw.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  const name = i === -1 ? s : s.slice(i + 1);
  return name || raw;
}

// A listed path discovery couldn't render (deleted, renamed, unmounted disk —
// or the Finding-1 case, a subdirectory/bare-repo that never should have been
// accepted). Without this stub the entry sits in repos.json with no card and
// no way for the user to remove it — editing the file by hand is exactly the
// workflow this feature exists to eliminate. Reuses the same
// data-act="unlist-repo" control (and doAction branch) the normal group's ✕
// uses, so removal works identically.
function skippedGroupHtml(path) {
  const name = baseName(path);
  return `<div class="repo-group"><div class="repo-name"><span class="repo-name-label">${esc(name)}</span><button class="repo-unlist" data-act="unlist-repo" data-path="${encodeURIComponent(path)}" title="Remove ${esc(name)} from the list (nothing on disk is deleted)">✕</button></div><div class="repo-stub">${esc(path)} is listed but not currently a git repository.</div></div>`;
}

function render() {
  const groupsHtml = state.snapshot.repos.map((r) => {
    const shown = r.worktrees.filter((w) => matches(w, r.repo));
    const rows = shown.map((w) => rowHtml(w, r.repo)).join('');
    // A scanned (non-listed) repo with nothing visible has no removable
    // control to preserve, so it's fine to drop the card entirely. A listed
    // repo must stay on screen — and stay removable — even when a search
    // filter hides every one of its worktrees.
    if (!rows && !r.listed) return '';
    const removeBtn = r.listed
      ? `<button class="repo-unlist" data-act="unlist-repo" data-path="${encodeURIComponent(r.repoPath)}" title="Remove ${esc(r.repo)} from the list (nothing on disk is deleted)">✕</button>`
      : '';
    return `<div class="repo-group"><div class="repo-name"><span class="repo-name-label">${esc(r.repo)}<span class="repo-count">${shown.length}</span></span><button class="repo-add" data-repo="${esc(r.repoPath)}" title="New worktree in ${esc(r.repo)}">+ worktree</button><button class="repo-prune" data-act="prune-repo" data-path="${encodeURIComponent(r.repoPath)}" title="Delete worktrees in ${esc(r.repo)} that are merged, clean and older than ${esc(String(state.config?.staleDays ?? 14))} days, and their branches">prune</button><button class="repo-tickets" data-act="repo-tickets" data-path="${encodeURIComponent(r.repoPath)}" title="Start a session from Jira tickets in ${esc(r.repo)}">tickets</button>${removeBtn}</div>${rows}</div>`;
  }).join('');
  const skippedHtml = (state.snapshot.skippedRepos || []).map(skippedGroupHtml).join('');
  const html = groupsHtml + skippedHtml;
  $('#table').innerHTML = html || '<p class="empty">No worktrees match.</p>';
  renderReadout();
}

function renderReadout() {
  // Counts merged-or-old worktrees, which is NOT what the repo `prune` button
  // acts on — that requires clean and unused as well. Labelled "stale" so the
  // two never contradict each other on screen (this number is routinely
  // non-zero while prune correctly finds nothing).
  let total = 0, changed = 0, stale = 0, live = 0;
  for (const r of state.snapshot.repos) for (const w of r.worktrees) {
    total++;
    if (w.status.dirty && !(w.stale || w.merged)) changed++;
    if ((w.stale || w.merged) && !w.isPrimary) stale++;
    if (w.agent.state === 'running') live++;
  }
  const el = $('#readout');
  if (!el) return;
  el.innerHTML = `<b>${total}</b> worktrees`
    + (changed ? ` · <b>${changed}</b> changed` : '')
    + (stale ? ` · <b class="rd-stale">${stale}</b> stale` : '')
    + (live ? ` · <span class="dot run"></span><b class="rd-live">${live}</b> live` : '');
}

function findWorktree(path) {
  for (const r of state.snapshot.repos) for (const w of r.worktrees) if (w.path === path) return w;
  return null;
}

function siblingWorktrees(w) {
  const repo = state.snapshot.repos.find((r) => r.repoPath === w.repoPath);
  return repo ? repo.worktrees.filter((x) => x.path !== w.path) : [];
}

// Parse a unified `git diff` into files → rows, tracking old/new line numbers.
function parseDiff(text) {
  const files = [];
  let f = null, oldLn = 0, newLn = 0;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git')) { f = { header: l, oldPath: null, newPath: null, mode: null, adds: 0, dels: 0, rows: [] }; files.push(f); continue; }
    if (!f) continue;
    if (l.startsWith('new file')) { f.mode = 'added'; continue; }
    if (l.startsWith('deleted file')) { f.mode = 'deleted'; continue; }
    if (l.startsWith('rename ')) { f.mode = 'renamed'; continue; }
    if (l.startsWith('--- ')) { f.oldPath = l.slice(4); continue; }
    if (l.startsWith('+++ ')) { f.newPath = l.slice(4); continue; }
    if (l.startsWith('index ') || l.startsWith('similarity ') || l.startsWith('old mode') || l.startsWith('new mode') || l.startsWith('Binary ')) {
      if (l.startsWith('Binary ')) f.rows.push({ type: 'meta', text: l });
      continue;
    }
    if (l.startsWith('@@')) {
      const m = l.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (m) { oldLn = +m[1]; newLn = +m[2]; }
      f.rows.push({ type: 'hunk', text: l });
      continue;
    }
    if (l.startsWith('+')) { f.rows.push({ type: 'add', newLn, text: l.slice(1) }); newLn++; f.adds++; continue; }
    if (l.startsWith('-')) { f.rows.push({ type: 'del', oldLn, text: l.slice(1) }); oldLn++; f.dels++; continue; }
    if (l.startsWith('\\')) { f.rows.push({ type: 'meta', text: l.slice(2) }); continue; } // "No newline at end of file"
    f.rows.push({ type: 'ctx', oldLn, newLn, text: l.startsWith(' ') ? l.slice(1) : l });
    oldLn++; newLn++;
  }
  return files;
}

// Human filename for a parsed file block (handles add/delete/rename).
function diffFileName(f) {
  const clean = (p) => (p ? p.replace(/^[ab]\//, '').replace(/\t.*$/, '').trim() : null);
  const nw = clean(f.newPath), od = clean(f.oldPath);
  if (f.mode === 'renamed' && od && nw && od !== nw) return `${od} → ${nw}`;
  if (nw && nw !== '/dev/null') return nw;
  if (od && od !== '/dev/null') return od;
  const m = f.header.match(/ b\/(.+)$/);
  return m ? m[1] : f.header.replace('diff --git ', '');
}

const SIGN = { add: '+', del: '−', ctx: '', hunk: '', meta: '' };

function renderDiff(text) {
  const files = parseDiff(text);
  if (!files.length) return '<div class="diff-empty">No changes in this worktree.</div>';
  return files.map((f) => {
    const tag = f.mode ? `<span class="dfile-tag t-${f.mode}">${f.mode}</span>` : '';
    const rows = f.rows.map((r) => {
      if (r.type === 'hunk') return `<div class="dl dl-hunk"><span class="dc">${esc(r.text)}</span></div>`;
      if (r.type === 'meta') return `<div class="dl dl-meta"><span class="dc">${esc(r.text)}</span></div>`;
      const o = r.oldLn != null ? r.oldLn : '';
      const n = r.newLn != null ? r.newLn : '';
      return `<div class="dl dl-${r.type}"><span class="dn">${o}</span><span class="dn">${n}</span><span class="ds">${SIGN[r.type]}</span><span class="dc">${esc(r.text) || ' '}</span></div>`;
    }).join('');
    return `<div class="dfile">
      <div class="dfile-head"><span class="dfile-name">${esc(diffFileName(f))}</span>${tag}<span class="dfile-stat"><span class="d-add">+${f.adds}</span><span class="d-del">−${f.dels}</span></span></div>
      <div class="dfile-body">${rows}</div>
    </div>`;
  }).join('');
}

// Which worktree the drawer is currently showing. Async panels (description,
// diff) check it before writing, so a slow response for the worktree you just
// navigated away from cannot land in the drawer for the one you opened.
let drawerPath = null;

function closeDrawer() {
  $('#drawer').classList.add('hidden');
  drawerPath = null;
}

// Priority swatches — user-assigned color labels; forest renders them and
// never interprets them. The ✕ clears.
const PRIO_COLORS = ['red', 'amber', 'blue', 'green'];
function prioSwatches(w) {
  const dots = PRIO_COLORS.map((c) => `<button class="prio-pick prio-${c}${w.priority === c ? ' sel' : ''}" data-prio="${c}" title="Label ${c}"></button>`).join('');
  return `${dots}<button class="prio-pick prio-clear${w.priority ? '' : ' sel'}" data-prio="" title="No label">✕</button>`;
}

async function openDrawer(path) {
  const w = findWorktree(path);
  if (!w) return;
  drawerPath = path;
  const d = $('#drawer');
  d.classList.remove('hidden');
  const sibs = siblingWorktrees(w);
  const applyHtml = (w.status.dirty && sibs.length)
    ? `<h4>Move uncommitted changes to…</h4>
       <div class="apply-row">
         <select id="apply-target">${sibs.map((s) => `<option value="${esc(s.path)}">${esc(s.branch || '(detached)')}</option>`).join('')}</select>
         <button id="apply-go" class="btn-accent">Apply diff</button>
       </div>`
    : '';
  const removeHtml = w.isPrimary ? ''
    : `<div class="drawer-danger"><button id="drawer-finish" class="btn-accent">Finish worktree</button> <button id="wt-remove" class="btn-danger">Remove worktree</button></div>`;
  const repoRec = state.snapshot.repos.find((r) => r.repoPath === w.repoPath);
  const landed = (repoRec && repoRec.landed) || [];
  const lastLanding = landed[landed.length - 1];
  const ejectHtml = (w.isPrimary && landed.length > 0)
    ? `<div class="drawer-eject"><button id="eject-go" class="btn-accent">↩ Eject last landing: ${esc(lastLanding.branch)}</button></div>`
    : '';
  d.innerHTML = `<button id="drawer-close" class="drawer-close">Close ✕</button>
    <h3>${esc(w.branch) || '(detached)'}</h3>
    <p class="meta-line">${esc(w.repo)} · ${esc(w.owner)} · ${ageCell(w)} · ${sizeCell(w)}</p>
    <div class="prio-row">${prioSwatches(w)}</div>
    ${applyHtml}
    <h4 class="desc-head"><button id="desc-toggle" class="desc-toggle" aria-expanded="true">Description</button></h4>
    <div id="desc-panel" class="desc"><p class="desc-loading">loading…</p></div>
    <div id="task-panel"></div>
    <h4>Diff</h4><div id="diff" class="diffview">loading…</div>
    ${removeHtml}
    ${ejectHtml}`;
  $('#drawer-close').onclick = closeDrawer;
  for (const btn of d.querySelectorAll('.prio-pick')) {
    btn.onclick = async () => {
      const r = await api('/api/worktree/priority', { path, priority: btn.dataset.prio });
      if (!r || r.error) { toast(`Priority: ${(r && r.error) || 'server unreachable'}`); return; }
      // Local echo so the deck and swatch ring recolor now; SSE confirms.
      w.priority = r.priority;
      for (const b of d.querySelectorAll('.prio-pick')) b.classList.toggle('sel', (b.dataset.prio || '') === (w.priority || ''));
      render();
    };
  }
  const finishBtn = $('#drawer-finish');
  if (finishBtn) finishBtn.onclick = () => openFinish(w.path);
  const ejectBtn = $('#eject-go');
  if (ejectBtn) ejectBtn.onclick = async () => {
    if (!confirm('Recreate the worktree and switch the main checkout back?')) return;
    ejectBtn.disabled = true;
    const r = await api('/api/worktree/eject', { repoPath: w.repoPath, mode: state.mode });
    ejectBtn.disabled = false;
    if (r.error) { toast(`Error: ${r.error}`); return; }
    toast(state.mode === 'guided' ? 'Eject sequence sent to terminal' : `Ejected ${r.branch} — worktree restored`);
  };
  const rmBtn = $('#wt-remove');
  if (rmBtn) rmBtn.onclick = async () => {
    rmBtn.disabled = true;
    const r = await removeWorktree(w);
    rmBtn.disabled = false;
    // In auto mode the worktree is gone — close the drawer. SSE refreshes the deck.
    if (r && !r.error && state.mode === 'auto') closeDrawer();
  };
  const applyBtn = $('#apply-go');
  if (applyBtn) applyBtn.onclick = async () => {
    const targetPath = $('#apply-target').value;
    applyBtn.disabled = true;
    const r = await api('/api/worktree/apply-diff', { sourcePath: w.path, targetPath, mode: state.mode });
    applyBtn.disabled = false;
    if (r && r.error) { toast(`Error: ${r.error}`); return; }
    toast(state.mode === 'guided' ? 'Apply sent to terminal' : 'Diff applied');
  };
  const buf = state.taskBuf[path];
  if (buf) renderTaskPanel(path);
  loadDescription(path);
  const res = await fetch(`/api/diff?path=${encodeURIComponent(path)}`).then((r) => r.json());
  $('#diff').innerHTML = renderDiff(res.diff || '');
}

// ---- description ----
//
// Seeded from the branch's Jira ticket, overwritable, and stored per branch.
// Rendered from the server's answer rather than composed here, so the browser
// never needs the Jira credentials.
//
// Two states: reading (the default — plain text, with the ticket URL clickable)
// and editing (a textarea, entered by Edit and left by Save). Reading is the
// default because that is what opening a drawer is usually for.

const descCollapsedKey = 'forest-desc-collapsed';
const descCollapsed = () => localStorage.getItem(descCollapsedKey) === '1';

function setDescCollapsed(collapsed) {
  localStorage.setItem(descCollapsedKey, collapsed ? '1' : '0');
  const panel = $('#desc-panel');
  const toggle = $('#desc-toggle');
  if (panel) panel.classList.toggle('collapsed', collapsed);
  if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
}

// Turns bare URLs into links. Splitting on a capturing regex puts the matches
// at the odd indices, so every part — link or not — is escaped exactly once and
// no user text can reach the DOM unescaped.
function linkify(text) {
  return String(text ?? '')
    .split(/(https?:\/\/[^\s<]+)/g)
    .map((part, i) => (i % 2
      ? `<a class="desc-link" href="${esc(part)}" target="_blank" rel="noopener">${esc(part)}</a>`
      : esc(part)))
    .join('');
}

// Grows the box to fit its content, so a one-line description is one line tall
// and a long one never needs an inner scrollbar.
function autoGrow(area) {
  area.style.height = 'auto';
  area.style.height = `${Math.max(area.scrollHeight, 38)}px`;
}

// Rendered only when everything the click needs exists: a ticket to write to,
// a branch to write, and a configured field to write into. Anything less and
// the feature simply is not there — no disabled button to explain.
function jiraBranchButton(path, d) {
  const branch = findWorktree(path)?.branch;
  if (!d.ticket || !branch || !state.config?.jiraBranchFieldId) return '';
  return `<button id="desc-jira-branch" class="desc-flat"
    title="Write ${esc(branch)} into ${esc(d.ticket)}'s Git Branch Name field">Branch → Jira</button>`;
}

function renderDescription(path, d, { editing = false } = {}) {
  const panel = $('#desc-panel');
  // The drawer may have been closed or switched to another worktree while the
  // request was in flight.
  if (!panel || drawerPath !== path) return;
  const note = d.override ? 'edited' : d.url ? 'from the ticket' : '';
  const body = editing
    ? `<textarea id="desc-text" class="desc-text" spellcheck="false"
         placeholder="What is this worktree for?">${esc(d.text || '')}</textarea>`
    : (d.text
      ? `<div class="desc-read">${linkify(d.text)}</div>`
      : `<p class="desc-empty">No description yet.</p>`);
  const controls = editing
    ? `<button id="desc-save" class="btn-accent">Save</button>
       <button id="desc-cancel" class="desc-flat">Cancel</button>
       ${d.override ? '<button id="desc-reset" class="desc-flat">Reset to auto</button>' : ''}`
    : `<button id="desc-edit" class="desc-flat">Edit</button>${jiraBranchButton(path, d)}`;

  panel.innerHTML = `${body}
    <div class="desc-row">${controls}<span class="desc-note">${note}</span></div>
    ${d.jiraError ? `<p class="desc-warn">${esc(d.jiraError)}</p>` : ''}`;
  panel.classList.toggle('collapsed', descCollapsed());

  const edit = $('#desc-edit');
  if (edit) edit.onclick = () => renderDescription(path, d, { editing: true });
  const jiraBtn = $('#desc-jira-branch');
  if (jiraBtn) {
    jiraBtn.onclick = async () => {
      let r = await api('/api/jira/submit-branch', { path });
      if (r && r.conflict) {
        if (!confirm(`${d.ticket}'s Git Branch Name already holds "${r.conflict}" — overwrite?`)) return;
        r = await api('/api/jira/submit-branch', { path, force: true });
      }
      if (!r || r.error) { toast(`Jira: ${(r && r.error) || 'server unreachable'}`); return; }
      jiraBtn.classList.remove('attn');
      toast(r.already ? `Git Branch Name already set on ${r.key}` : `Git Branch Name set on ${r.key}`);
    };
    checkBranchField(path, d);
  }
  if (!editing) return;

  const area = $('#desc-text');
  autoGrow(area);
  area.addEventListener('input', () => autoGrow(area));
  area.focus();

  const save = async () => {
    const text = area.value;
    const r = await api('/api/description/save', { path, text });
    if (!r || !r.ok) { toast(`Save failed: ${(r && r.error) || 'server unreachable'}`); return; }
    toast('Description saved');
    // Back to reading, and now an override — so "Reset to auto" is offered the
    // next time this is edited.
    renderDescription(path, { ...d, text, override: true, jiraError: undefined });
  };
  $('#desc-save').onclick = save;
  $('#desc-cancel').onclick = () => renderDescription(path, d);
  area.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    // Escape leaves the editor rather than closing the whole drawer, which
    // would throw away what was typed.
    if (e.key === 'Escape') { e.stopPropagation(); renderDescription(path, d); }
  });
  const reset = $('#desc-reset');
  if (reset) reset.onclick = async () => {
    const r = await api('/api/description/reset', { path });
    if (!r || !r.ok) { toast(`Reset failed: ${(r && r.error) || 'server unreachable'}`); return; }
    toast('Reset to the ticket');
    renderDescription(path, r);
  };
}

// Quietly asks what the ticket's branch field holds; an empty field earns the
// button a small dot, so an unfilled ticket is visible at a glance. Errors stay
// silent — the description panel already reports Jira trouble.
async function checkBranchField(path, d) {
  const r = await api('/api/jira/branch-field', { path });
  if (drawerPath !== path) return;
  const btn = $('#desc-jira-branch');
  if (!btn || !r || !r.ok || r.value) return;
  btn.classList.add('attn');
  btn.title = `${d.ticket}'s Git Branch Name is empty — click to fill it`;
}

async function loadDescription(path) {
  // Apply the remembered collapse state before the request resolves, so a
  // collapsed section never flashes open while it loads.
  setDescCollapsed(descCollapsed());
  const toggle = $('#desc-toggle');
  if (toggle) toggle.onclick = () => setDescCollapsed(!descCollapsed());
  const d = await api('/api/description', { path });
  if (!d || d.error) {
    const panel = $('#desc-panel');
    if (panel && drawerPath === path) panel.innerHTML = `<p class="desc-warn">${esc((d && d.error) || 'server unreachable')}</p>`;
    return;
  }
  renderDescription(path, d);
}

function renderTaskPanel(path) {
  const panel = $('#task-panel');
  if (!panel) return;
  const buf = state.taskBuf[path];
  if (!buf) { panel.innerHTML = ''; return; }
  panel.innerHTML = `<h4>Task output</h4><pre>${buf.text.replace(/</g, '&lt;')}</pre>
    ${buf.done ? `<button id="continue-int">Continue in ${agentLabel(loadAgent(localStorage, path))}</button>` : '<em>running…</em>'}`;
  const c = $('#continue-int');
  if (c) c.onclick = () => api('/api/launch', { path, agent: loadAgent(localStorage, path) });
}

// Shows a button as working for the duration of `fn`, and blocks a second
// click while it runs. The 4s re-render can swap the node out mid-flight, in
// which case the visual state is lost but the operation continues — the busy
// flag, not the DOM, is what prevents a double run.
const busy = new Set();
async function withPending(el, key, label, fn) {
  if (busy.has(key)) return;
  busy.add(key);
  const prev = el ? el.textContent : null;
  if (el) { el.disabled = true; el.textContent = label; }
  try { return await fn(); }
  finally {
    busy.delete(key);
    if (el && el.isConnected) { el.disabled = false; el.textContent = prev; }
  }
}

async function doAction(act, ds, el) {
  const path = decodeURIComponent(ds.path);
  if (act === 'launch') { openPicker(path); return; }
  if (act === 'open-cursor') { await api('/api/open', { path, target: 'cursor' }); return; }
  if (act === 'repair') {
    // withPending: the button itself is the progress indicator — disabled and
    // showing an hourglass while the replay runs, so a click visibly took.
    return withPending(el, `repair:${path}`, '⏳', async () => {
      const r = await api('/api/worktree/repair', { path });
      // Pre-branch worktrees have no provision record to replay — repair can only
      // guess, so hand the user to the picker instead of a dead-end toast.
      if (r && r.error === 'no provision record') { openPicker(path); return; }
      if (!r || r.error || !r.scope) { toast(`Repair failed: ${(r && r.error) || 'server unreachable'} — open the picker and re-provision`); return; }
      // The restart reminder is part of the result, not decoration: hook config
      // is snapshotted at session start, so a session already running in this
      // worktree keeps exec'ing whatever it loaded — a refresh reaches disk,
      // never a live snapshot.
      toast(repairToast(r));
      reportConflicts(r.provisioned);
    });
  }
  if (act === 'task') {
    const prompt = state.mode === 'auto' ? window.prompt('Task for Claude (headless):') : null;
    if (state.mode === 'auto' && !prompt) return;
    state.taskBuf[path] = { text: '', done: false };
    await api('/api/task', { path, prompt, mode: state.mode, agent: loadAgent(localStorage, path) });
    openDrawer(path);
    return;
  }
  if (act === 'remove') {
    const w = findWorktree(path);
    if (w) await removeWorktree(w);
    return;
  }
  if (act === 'finish') { openFinish(path); return; }
  if (act === 'repo-tickets') {
    const repo = state.snapshot.repos.find((r) => r.repoPath === path);
    const primary = repo && repo.worktrees.find((w) => w.isPrimary);
    if (!primary) { toast('no primary checkout for this repo'); return; }
    // baseBranch rides along on `target` even though the seeded prompt no
    // longer names a base branch at all (that wording was dropped) — kept
    // here in case a future caller needs it again, cheap to carry, and
    // removing it now would just be churn on a field nothing currently reads.
    openTickets({
      repoPath: repo.repoPath, repo: repo.repo, primaryPath: primary.path, baseBranch: primary.baseBranch,
    });
    return;
  }
  if (act === 'prune-repo') {
    return withPending(el, `prune:${path}`, 'prune…', async () => {
    // `path` is the repo path here. The preview is read-only: nothing is
    // deleted until the confirm below is accepted.
    const pv = await api('/api/repo/prune-preview', { repoPath: path });
    if (!pv || pv.error) { toast(`Prune failed: ${(pv && pv.error) || 'server unreachable'}`); return; }
    const kept = {};
    for (const k of pv.kept || []) kept[k.reason] = (kept[k.reason] || 0) + 1;
    const keptLine = Object.entries(kept).map(([reason, n]) => `${n} ${reason}`).join(', ') || 'none';
    const keptTotal = (pv.kept || []).length;
    if (!(pv.candidates || []).length) {
      alert(`Nothing to prune.\n\nKept ${keptTotal}: ${keptLine}.`);
      return;
    }
    // Below a megabyte, round-to-MB reads as a bare "0 MB"; show KB instead.
    const size = (b) => (b == null ? '—' : b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${Math.round(b / 1e6)} MB`);
    const list = pv.candidates
      .map((c) => `  ${c.branch || '(detached)'}   ${c.ageDays}d   ${size(c.sizeBytes)}`)
      .join('\n');
    if (!confirm(
      `Prune ${pv.candidates.length} worktree(s)?\n\n${list}\n\n`
      + 'Branches are deleted with `git branch -d` (merged only).\n'
      + `Kept ${keptTotal}: ${keptLine}.`,
    )) return;
    const r = await api('/api/repo/prune', { repoPath: path, paths: pv.candidates.map((c) => c.path), mode: state.mode });
    if (!r || r.error) { toast(`Prune failed: ${(r && r.error) || 'server unreachable'}`); return; }
    if (state.mode === 'guided') { toast('Sent to terminal'); return; }
    const failed = (r.failed || []).length;
    const skipped = (r.skipped || []).length;
    toast(`Pruned ${(r.removed || []).length}`
      + (skipped ? `, ${skipped} skipped` : '')
      + (failed ? `, ${failed} failed — see the journal` : ''));
    });
  }
  if (act === 'unlist-repo') {
    if (!confirm(`Remove ${path} from forest's list?\n\nNothing on disk is deleted — the repo, its worktrees and its .claude/ stay exactly as they are.`)) return;
    const r = await api('/api/repos/remove', { path });
    if (!r || !r.ok) { toast(`Remove failed: ${(r && r.error) || 'server unreachable'}`); return; }
    toast(`Removed ${path} from the list`);
    return;
  }
}

// Shared remove flow — used by the row prune button and the drawer.
// Returns the server response (or undefined if the user cancelled a confirm).
async function removeWorktree(w) {
  if (w.isPrimary) { toast('Cannot remove the primary worktree'); return; }
  if (w.status.dirty && !confirm('Worktree has uncommitted changes. Remove anyway?')) return;
  if (!confirm(`Remove worktree?\n${w.path}`)) return;
  const r = await api('/api/worktree/remove', { repoPath: w.repoPath, path: w.path, force: w.status.dirty, isPrimary: w.isPrimary, mode: state.mode });
  toast(r.error ? `Error: ${r.error}` : state.mode === 'guided' ? 'Sent to terminal' : 'Removed');
  return r;
}

// Client-side echo of finish.mjs's dirtyMainRefusal: a Finish that switches the
// main checkout while it still holds someone's uncommitted work carries that
// work onto the landed branch. The server refuses too — this only saves the
// round trip and says so in the dialog's own language.
function dirtyMainToast(pv) {
  const tb = pv.targetBranch ?? (pv.candidates || [])[0];
  if (!pv.mainDirty || pv.mainBranch === tb) return false;
  toast(`Main checkout has ${pv.mainDirtyCount} uncommitted file(s) — commit or stash them before landing ${tb}`);
  return true;
}

let finishCtx = null; // { w, preview }

async function openFinish(path) {
  const w = findWorktree(path);
  if (!w || w.isPrimary) { toast('Cannot finish the primary worktree'); return; }
  const preview = await api('/api/worktree/finish-preview', { repoPath: w.repoPath, path: w.path });
  if (preview.error) { toast(`Error: ${preview.error}`); return; }
  if (preview.mergeInProgress) { toast('Main checkout has a merge in progress — resolve it first'); return; }
  if (!preview.targetBranch && !preview.nameMismatch) { toast('Cannot resolve a target branch for this worktree'); return; }
  if (dirtyMainToast(preview)) return;
  finishCtx = { w, preview };
  // Where the main checkout ends up (finish step 8): back where it was, unless
  // it has to hold the carried files, or it is already on the landed branch.
  const target = preview.targetBranch ?? preview.candidates[0];
  const mainAfter = !preview.mainBranch || preview.mainBranch === target ? ''
    : preview.dirtyCount ? ' · main checkout stays on the landed branch to hold them'
    : ` · main checkout returns to ${preview.mainBranch}`;
  $('#fw-summary').textContent =
    `${preview.worktreeName} → ${preview.relanding ? 'merge into' : 'land as'} ${target}` +
    ` · ${preview.dirtyCount} uncommitted file(s) will carry over${mainAfter} · ↑${w.ahead} ↓${w.behind} vs ${w.baseBranch}`;
  $('#fw-namechoice').classList.toggle('hidden', !preview.nameMismatch);
  if (preview.nameMismatch) {
    $('#fw-name-branch-label').textContent = `Land as "${preview.candidates[0]}" (the branch's name)`;
    $('#fw-name-wt-label').textContent = `Land as "${preview.candidates[1]}" (the worktree's name)`;
    $('#fw-name-branch').checked = true;
  }
  $('#fw-remove').checked = true;
  $('#finishwt').classList.remove('hidden');
}

async function submitFinish() {
  const w = findWorktree(finishCtx.w.path);
  if (!w) { toast('Worktree is gone — refresh'); $('#finishwt').classList.add('hidden'); finishCtx = null; return; }
  const fresh = await api('/api/worktree/finish-preview', { repoPath: w.repoPath, path: w.path });
  if (fresh.error) { toast(`Error: ${fresh.error}`); return; }
  if (fresh.mergeInProgress) { toast('Main checkout has a merge in progress — resolve it first'); $('#finishwt').classList.add('hidden'); finishCtx = null; return; }
  if (dirtyMainToast(fresh)) { $('#finishwt').classList.add('hidden'); finishCtx = null; return; }
  if (fresh.targetBranch !== finishCtx.preview.targetBranch || fresh.nameMismatch !== finishCtx.preview.nameMismatch) {
    toast('Worktree state changed — review again');
    openFinish(w.path);
    return;
  }
  const targetBranch = fresh.nameMismatch
    ? ($('#fw-name-wt').checked ? fresh.candidates[1] : fresh.candidates[0])
    : fresh.targetBranch;
  $('#finishwt').classList.add('hidden');
  const r = await api('/api/worktree/finish', {
    repoPath: w.repoPath, path: w.path, targetBranch,
    remove: $('#fw-remove').checked, isPrimary: w.isPrimary, mode: state.mode,
  });
  finishCtx = null;
  if (r.error) { toast(`Error: ${r.error}`); return; }
  if (state.mode === 'guided') { toast('Finish sequence sent to terminal'); return; }
  if (r.conflict) { toast('Merge conflict — resolve in your IDE, then press Finish again'); return; }
  toast(`Landed ${r.targetBranch}${r.removed ? ', worktree removed' : ''}${r.returned ? `, main checkout back on ${r.returnedTo}` : ''}${r.stayReason ? ` — ${r.stayReason}` : ''}${r.stashConflict ? ' — stash pop conflicted, stash kept' : ''}${r.removeError ? ` — worktree remove failed: ${r.removeError}` : ''}${r.removeSkipped ? ` — worktree kept: ${r.removeSkipped}` : ''}`);
}

// The base the new branch will actually be cut from, shown filled in rather
// than left to a placeholder: the field used to look like it said "master"
// while an empty value meant "the primary checkout's current HEAD" — two
// different things every time the primary is not on its base branch. 'HEAD'
// is never prefilled: it is baseBranch's last resort for a repo where nothing
// resolves, and the server reaches the same answer from an empty field.
function repoBaseBranch(repoPath) {
  const repo = state.snapshot.repos.find((r) => r.repoPath === repoPath);
  const primary = repo && repo.worktrees.find((w) => w.isPrimary);
  const base = primary && primary.baseBranch;
  return !base || base === 'HEAD' ? '' : base;
}

function openNewWorktree(repoPath) {
  const sel = $('#nw-repo');
  sel.innerHTML = state.snapshot.repos.map((r) => `<option value="${esc(r.repoPath)}">${esc(r.repo)}</option>`).join('');
  if (repoPath) sel.value = repoPath;
  $('#nw-branch').value = '';
  $('#nw-base').value = repoBaseBranch(sel.value);
  sel.onchange = () => { $('#nw-base').value = repoBaseBranch(sel.value); };
  $('#nw-newbranch').checked = true;
  $('#newwt').classList.remove('hidden');
  $('#nw-branch').focus();
}
function closeNewWorktree() { $('#newwt').classList.add('hidden'); }
async function submitNewWorktree() {
  const repoPath = $('#nw-repo').value;
  const branch = $('#nw-branch').value.trim();
  if (!branch) { toast('Enter a branch or ticket name'); $('#nw-branch').focus(); return; }
  const newBranch = $('#nw-newbranch').checked;
  const base = $('#nw-base').value.trim() || undefined;
  const btn = $('#nw-create');
  btn.disabled = true;
  let r;
  try {
    r = await api('/api/worktree/create', { repoPath, branch, newBranch, base, mode: state.mode });
  } finally {
    btn.disabled = false;
  }
  if (r && r.error) { toast(`Error: ${r.error}`); return; }
  closeNewWorktree();
  toast(state.mode === 'guided' ? 'Create sent to terminal' : 'Worktree created');
}

// ---- skill/kit picker (shown before launching a session) ----
let pickerPath = null;
// Which agent Start launches. Restored per worktree on open from
// forest-agent:<path> (Task 9's loadAgent), written on click.
let pickerAgent = 'cursor';
// refreshPickerScope is async and the toggle can be clicked (or the picker
// re-opened on another row) while a fetch is in flight; the token lets the
// stale response drop instead of painting the previous agent's line.
let scopeToken = 0;
// The last /api/worktree/scope response for pickerPath, so a checkbox click
// can repaint the line without a refetch. Cleared on every refresh.
let pickerScope = null;
const skillKey = (path) => `forest-skills:${path}`;
function loadSel(path) { try { return JSON.parse(localStorage.getItem(skillKey(path))) || {}; } catch { return {}; } }
function saveSel(path, sel) { localStorage.setItem(skillKey(path), JSON.stringify(sel)); }
const groupLabel = (g) => g.charAt(0).toUpperCase() + g.slice(1);

function skillRow(pack, kind, id, label, desc, checked) {
  return `<label class="pk-item">
    <input type="checkbox" class="pk-cb" data-pack="${esc(pack)}" data-kind="${kind}" data-id="${esc(id)}" ${checked ? 'checked' : ''} />
    <span class="pk-item-text"><span class="pk-item-label">${esc(label)}</span>${desc ? `<span class="pk-item-desc">${esc(desc)}</span>` : ''}</span>
  </label>`;
}
// One collapsible section: a master checkbox that takes the whole group in a
// single click, plus a header that folds the rows away so 20+ skills across
// five groups stay skimmable. Every group renders collapsed — a "Select all"
// would otherwise unfold all of them at once — and the n/total badge on the
// header is what says what a folded group is about to launch.
function pkGroup(title, rows) {
  return `<section class="pk-group">
    <div class="pk-group-h">
      <input type="checkbox" class="pk-group-cb" aria-label="Select all ${esc(title)}" />
      <button type="button" class="pk-group-toggle" aria-expanded="false">
        <span class="pk-chev" aria-hidden="true">▶</span>
        <span class="pk-group-name">${esc(title)}</span>
        <span class="pk-group-count"></span>
      </button>
    </div>
    <div class="pk-group-body hidden">${rows}</div>
  </section>`;
}
function setGroupOpen(group, open) {
  if (!group) return;
  group.classList.toggle('open', open);
  const btn = group.querySelector('.pk-group-toggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  const body = group.querySelector('.pk-group-body');
  if (body) body.classList.toggle('hidden', !open);
}
function renderPack(p, picked, auto = false) {
  const skills = picked.skills || [], kits = picked.kits || [];
  const groups = (p.groups && p.groups.length) ? p.groups : [...new Set(p.skillsets.map((s) => s.group || 'other'))];
  const sections = groups.map((g) => {
    const items = p.skillsets.filter((s) => (s.group || 'other') === g);
    if (!items.length) return '';
    const rows = items.map((s) => skillRow(p.pack, 'skill', s.id, s.label, s.description, skills.includes(s.id))).join('');
    return pkGroup(groupLabel(g), rows);
  }).join('');
  const kitSection = (p.kits && p.kits.length)
    ? pkGroup('Kits', p.kits.map((k) => skillRow(p.pack, 'kit', k.id, k.label, '', kits.includes(k.id))).join(''))
    : '';
  const hooksSection = p.hooks
    ? pkGroup('Gates', skillRow(p.pack, 'hooks', p.hooks.id, p.hooks.label, p.hooks.description, !!picked.hooks))
    : '';
  const tag = auto ? '<span class="pk-auto" title="Pre-ticked: this pack targets this repo (catalog targets)">auto</span>' : '';
  const head = `<div class="pk-pack-h"><label class="pk-all-row"><input type="checkbox" class="pk-all" /> Select all ${esc(p.pack)}</label>${tag}</div>`;
  return `<div class="pk-pack">${head}${sections}${kitSection}${hooksSection}</div>`;
}

// Reflect every master — per group and per pack — from the individual
// checkboxes under it (checked when all are on, indeterminate when some are),
// and stamp each group header with its own n/total, so a collapsed group still
// says what it holds and what is picked inside it.
function syncMasters() {
  document.querySelectorAll('#pk-body .pk-group').forEach((g) => {
    const boxes = g.querySelectorAll('.pk-cb');
    const on = [...boxes].filter((b) => b.checked).length;
    const master = g.querySelector('.pk-group-cb');
    if (master) {
      master.checked = boxes.length > 0 && on === boxes.length;
      master.indeterminate = on > 0 && on < boxes.length;
    }
    const count = g.querySelector('.pk-group-count');
    if (count) {
      count.textContent = on ? `${on}/${boxes.length}` : `${boxes.length}`;
      count.classList.toggle('on', on > 0);
    }
  });
  document.querySelectorAll('#pk-body .pk-pack').forEach((pk) => {
    const all = pk.querySelector('.pk-all');
    if (!all) return;
    const boxes = pk.querySelectorAll('.pk-cb');
    const on = [...boxes].filter((b) => b.checked).length;
    all.checked = boxes.length > 0 && on === boxes.length;
    all.indeterminate = on > 0 && on < boxes.length;
  });
}

async function openPicker(path) {
  const w = findWorktree(path);
  if (!w) return;
  pickerPath = path;
  $('#pk-sub').textContent = `${w.repo} · ${w.branch || '(detached)'}`;
  // A saved selection is the override and wins. Otherwise the server's
  // automatic selection for this repo is what a launch would install, so it
  // is what the boxes show — the picker never re-implements the targeting
  // rule (the server owns it; see autoSelections in lib/packs.mjs).
  let sel = loadSel(path);
  const autoPacks = new Set();
  if (!Object.keys(sel).length) {
    const j = await fetch(`/api/packs?repo=${encodeURIComponent(w.repo)}`).then((r) => r.json()).catch(() => ({ auto: [] }));
    sel = {};
    for (const a of (j.auto || [])) { sel[a.pack] = { skills: a.skills, kits: a.kits, hooks: a.hooks }; autoPacks.add(a.pack); }
  }
  if (pickerPath !== path) return; // the picker moved on while the fetch was in flight
  $('#pk-body').innerHTML = state.packs.length
    ? state.packs.map((p) => renderPack(p, sel[p.pack] || {}, autoPacks.has(p.pack))).join('')
    : `<p class="pk-empty">No skill packs found in <code>packs/</code>. The session will start with no extra skills.</p>`;
  $('#picker').classList.remove('hidden');
  syncMasters();
  // Restores the saved agent, relabels Start and fetches the scope line for
  // that agent — the same three things a toggle click does. persist: false —
  // reading what was last chosen must not immediately write it back.
  setPickerAgent(loadAgent(localStorage, path), { persist: false });
}
function closePicker() { $('#picker').classList.add('hidden'); pickerPath = null; pickerScope = null; }
function setPickerAgent(agent, { persist = true } = {}) {
  pickerAgent = agent === 'claude' ? 'claude' : 'cursor';
  document.querySelectorAll('.pk-agent-btn').forEach((b) => b.classList.toggle('on', b.dataset.agent === pickerAgent));
  // The note only matters when the checkboxes will NOT be what the session
  // reads — i.e. Cursor CLI.
  $('#pk-agent-note').classList.toggle('hidden', pickerAgent !== 'cursor');
  if (persist && pickerPath) saveAgent(localStorage, pickerPath, pickerAgent);
  updatePickerCount();
  if (pickerPath) refreshPickerScope(pickerPath);
}
function updatePickerCount() {
  const n = document.querySelectorAll('#pk-body .pk-cb:checked').length;
  $('#pk-count').textContent = n ? `${n} selected` : 'none selected';
  $('#pk-start').textContent = startLabel(pickerAgent, n);
  // The Cursor wording depends on whether anything is ticked, so a checkbox
  // click repaints the line from the last fetched scope — no refetch.
  paintPickerScope(n);
}
function paintPickerScope(selectedCount) {
  const el = $('#pk-scope');
  if (!pickerScope) { el.textContent = ''; el.classList.remove('warn'); return; }
  const line = scopeLine(pickerAgent, pickerScope, selectedCount);
  el.textContent = line.text;
  el.classList.toggle('warn', !!line.warn);
}
// What the session will load today — before provisioning anything. Makes the
// remaining ~/.claude inheritance visible instead of implicit; for Cursor CLI
// it reads the .cursor/hooks.json block instead.
async function refreshPickerScope(path) {
  pickerScope = null;
  paintPickerScope(0);
  const token = ++scopeToken;
  const s = await api('/api/worktree/scope', { path });
  if (token !== scopeToken || pickerPath !== path) return;
  if (!s || s.error || !s.sources) return;
  pickerScope = s;
  paintPickerScope(document.querySelectorAll('#pk-body .pk-cb:checked').length);
}
function collectSel() {
  const sel = {};
  document.querySelectorAll('#pk-body .pk-cb:checked').forEach((cb) => {
    const p = (sel[cb.dataset.pack] ||= { skills: [], kits: [], hooks: false });
    if (cb.dataset.kind === 'kit') p.kits.push(cb.dataset.id);
    else if (cb.dataset.kind === 'hooks') p.hooks = true;
    else p.skills.push(cb.dataset.id);
  });
  return sel;
}
// A collision is the only signal a provisioned file was left at its old
// content: copyTree never overwrites a destination that differs, it records
// the path and moves on. Until now that list reached the journal and nothing
// else, so a launch that quietly kept a stale file looked identical to one
// that refreshed everything.
// A toast, deliberately not an alert(): conflicts arrive one per provisioned
// worktree, and a modal per worktree walls the user off from their own app
// (observed 2026-08-05 — "I cannot pass through this pop up"). Every conflict
// is already journalled line-by-line by the server; the toast says how many
// and where to read them.
function reportConflicts(prov) {
  const c = (prov && prov.conflicts) || [];
  if (!c.length) return;
  const first = c[0].path.split('/').slice(-2).join('/');
  toast(
    `${c.length} file(s) kept at their existing content (${first}${c.length > 1 ? ', …' : ''}) — `
    + 'hand-edited or colliding copies are never overwritten; details in the command journal',
  );
}

// Everything a launch response carries that is worth saying: what was
// provisioned, what gates are still missing (a forced launch reports them and
// used to drop them on the floor), and what provisioning refused to overwrite.
//
// `lead` is an optional prefix for callers that launched with more context
// than the picker has — the Tickets modal names how many tickets went into the
// prompt. It defaults to '' so every existing call site reads exactly as
// before; a caller that wants its own sentence must still come through here,
// because this is the only place scope.missing and conflicts are reported.
function reportLaunched(r, lead = '') {
  toast(launchToast(r, lead));
  reportConflicts(r.provisioned);
}

async function startSession() {
  const path = pickerPath;
  if (!path) return;
  const sel = collectSel();
  saveSel(path, sel);
  const selections = Object.entries(sel).map(([pack, v]) => ({ pack, skills: v.skills, kits: v.kits, hooks: v.hooks }));
  const btn = $('#pk-start');
  btn.disabled = true;
  const r = await api('/api/launch', { path, selections, mode: state.mode, agent: pickerAgent });
  btn.disabled = false;
  if (r && r.blocked === 'missing-hooks') {
    const names = r.missing
      .map((h) => (h.command.match(/([^/"']+\.sh)/) || [, h.command])[1])
      .filter((v, i, a) => a.indexOf(v) === i);
    const list = names.map((n) => `    ${n}`).join('\n');
    // ONE dialog, launch-or-not. Repair is no longer offered here: the ↻
    // button on the worktree row is the repair surface, and chaining two more
    // confirms behind this one buried the launch under popups (observed
    // 2026-08-05). Cancel (and Escape, which maps to it) must NOT start a
    // session: dismissing a dialog should never be what launches an ungated
    // agent — launching is only ever reached by an explicit OK.
    if (!confirm(
      `Launch Claude with ${r.missing.length} hook script(s) missing?\n\n${list}\n\n`
      + 'These gates will not run in this session.\n\n'
      + 'OK — launch anyway.\n'
      + 'Cancel — do not launch. (To fix the gates first, use ↻ on this worktree\'s row, then launch again.)',
    )) return;
    // selections: [] on purpose — provisioning already ran on the first call,
    // and re-sending them would provision twice.
    const forced = await api('/api/launch', { path, selections: [], mode: state.mode, agent: pickerAgent, force: true });
    if (!forced || !forced.ok) { toast(`Launch failed: ${(forced && forced.error) || 'server unreachable'}`); return; }
    closePicker();
    reportLaunched(forced);
    return;
  }
  if (r && r.blocked === 'orphaned-units') {
    const list = r.orphaned.map((o) => `  • ${o.kind} ${o.id} (since ${o.since.slice(0, 10)})`).join('\n');
    // "If their files are still on disk" rather than a flat "they still run":
    // the record is what fires this guard, and a unit can have been deleted
    // out from under it by hand. (It used to have a second reason — Remove
    // below recursed into startSession() and hit this same dialog with the
    // files already gone. It no longer does: Remove updates the record, so
    // that recursion gets past this guard.)
    const intro = `${r.orphaned.length} unit(s) are recorded as provisioned here but no longer selected:\n\n${list}\n\n`
      + 'If their files are still on disk, they are running at the version they had when they were last provisioned.\n\n';

    // Ordered so Cancel never defaults toward the irreversible option. Native
    // confirm() can't relabel its buttons — the user always sees generic
    // OK/Cancel, and Escape maps to Cancel — so the ordering itself has to
    // carry the safety, not the wording alone: Update (reversible, the
    // common case) first, then Launch anyway (touches nothing on disk),
    // then Remove (the one thing that can't be undone) last. Cancelling any
    // of them moves to the next; cancelling — or Escape-spamming through —
    // all three is a genuine no-op, matching the missing-hooks block above,
    // where the first Cancel already means "do not launch".
    if (confirm(
      `${intro}Update them — check them back on and relaunch?\n\n`
      // Not "brings them current", which is what this said and is not what
      // provisioning does: copyTree never overwrites a file whose content
      // differs, so a plain skill and the copy under .claude/kits/<id>/ stay
      // exactly as they are. A kit that ships install.sh is the one thing that
      // is genuinely re-run from source.
      + 'That clears this guard and puts them back under forest\'s management. A kit with its own '
      + 'install.sh is re-run, which is what can bring it current; plain skills and the copy under '
      + '.claude/kits/ are NOT refreshed — provisioning never overwrites a file whose content differs.\n\n'
      + 'OK — reselect and relaunch.\n'
      + 'Cancel — see other options.',
    )) {
      let unmatched = 0;
      for (const o of r.orphaned) {
        const cb = $(`.pk-cb[data-kind="${o.kind}"][data-id="${o.id}"]`);
        // Open the group too: a re-checked box inside a collapsed section is a
        // selection the user never sees before it launches.
        if (cb) { cb.checked = true; setGroupOpen(cb.closest('.pk-group'), true); } else unmatched++;
      }
      syncMasters();
      updatePickerCount();
      if (unmatched) toast(`${unmatched} unit(s) are no longer offered by any pack — not reselected`);
      return startSession();
    }

    if (confirm(
      `${intro}Launch anyway, leaving them running unmanaged — nothing on disk changes?\n\n`
      + 'OK — launch.\n'
      + 'Cancel — see removal instead.',
    )) {
      // selections (not []): unlike the missing-hooks retry above, nothing
      // has been provisioned yet — the orphan check runs before
      // provisioning — so the real selections still need to go along on
      // this forced call.
      const forced = await api('/api/launch', { path, selections, mode: state.mode, agent: pickerAgent, force: true });
      if (!forced || !forced.ok) { toast(`Launch failed: ${(forced && forced.error) || 'server unreachable'}`); return; }
      closePicker();
      // The response carries scope.missing and provisioned.conflicts. Toasting
      // a flat "Launching Claude…" over both is how a forced launch went out
      // with a dead gate and said nothing about it.
      reportLaunched(forced);
      return;
    }

    if (confirm(
      // "their files from .claude/" without qualification was too wide: only
      // the unit's own directory goes. A kit's installer also writes skill
      // directories under .claude/skills/, and forest keeps no map of which
      // kit wrote which — so they stay, inert, and the copy has to say so
      // before the user accepts an irreversible action.
      `${intro}Remove — permanently delete .claude/kits/<id>/ or .claude/skills/<id>/ for each of them now? `
      + 'This cannot be undone.\n\n'
      + 'What stays: their harness registrations (forest does not edit settings.json), and any skill '
      + 'directories a kit\'s own installer wrote — those are inert without the kit, and removing them '
      + 'would need an ownership map forest does not keep.\n\n'
      + 'OK — remove now.\n'
      + 'Cancel — do nothing.',
    )) {
      const rm = await api('/api/worktree/remove-units', { path, units: r.orphaned.map(({ kind, id }) => ({ kind, id })) });
      if (!rm || !rm.ok) { toast(`Remove failed: ${(rm && rm.error) || 'server unreachable'}`); return; }

      // `stillListed` is what the route says about the RECORD, not about the
      // filesystem, and it is the only thing that decides which of these two
      // messages is true. A unit that was never on disk is dropped from the
      // record even though its removal was "refused"; a hardened one keeps its
      // place there because its files really are still running.
      const removedLine = rm.removed?.length ? `Removed ${rm.removed.join(', ')}.\n\n` : '';
      const stuck = (rm.refused || []).filter((f) => f.stillListed);
      const dropped = (rm.refused || []).filter((f) => !f.stillListed);
      const droppedLine = dropped.length ? `${dropped.map((f) => f.reason).join('\n')}\n\n` : '';

      if (stuck.length) {
        // The claim "this guard is clear" used to be made whenever ANY unit was
        // removed, and then startSession() recursed straight back into this
        // dialog — which met the guard again on whatever was refused. Say what
        // is still listed and why, and do not recurse: the previous copy's own
        // reasoning was that recursing is honest BECAUSE the guard is clear, so
        // when it is not clear, re-opening this dialog on the user's behalf is
        // the loop the reviewer walked into. The picker stays open; pressing
        // Start again is a deliberate choice, and "Launch anyway" is there.
        alert(
          `${removedLine}${droppedLine}`
          // Only in this branch: the clean-sweep paragraph below already says
          // the record no longer lists anything, so repeating it there read as
          // the same sentence twice.
          + (dropped.length ? `Forest's record no longer lists ${dropped.length > 1 ? 'those' : 'that one'}.\n\n` : '')
          + `${stuck.length} unit(s) still appear in forest's record:\n\n`
          + `${stuck.map((f) => `  • ${f.reason}`).join('\n')}\n\n`
          // Not always "their files are still on disk": that was true only for
          // the hardened-kit refusal this dialog was first written for. Since
          // the record rewrite is best-effort, `stillListed` can now also be
          // true for a unit whose files WERE deleted but whose id could not be
          // dropped from the record — the reason above says which happened.
          + 'Either way, forest\'s record still names them, so the next launch meets this guard again. '
          + 'Unlock a hardened kit and remove again, make .claude/.forest-provision.json writable and '
          + 'remove again if it was the record update that failed, or choose "Launch anyway" to proceed '
          + 'regardless of what is listed above.',
        );
        return;
      }

      if (removedLine || droppedLine) {
        // A clean sweep, so this is now true: the record no longer lists any of
        // them and relaunching does not meet this guard again — which is what
        // makes recursing into startSession() below honest. What it cannot
        // clear is the harness registration: a kit's own installer owns its
        // wiring and forest does not edit settings.json. If one now points at a
        // deleted file, the next launch reports missing-hooks, and the remedy
        // that works is re-selecting the unit — repair replays what the record
        // names, and the record no longer names it.
        alert(
          `${removedLine}${droppedLine}`
          + 'Forest\'s record no longer lists them, so this guard is clear — relaunching does not meet it again.\n\n'
          + 'Their harness registrations are untouched and may still point at files that are now gone. '
          + 'If the next launch reports missing hook scripts, the fix is to re-select that unit in the '
          + 'launcher and launch: that re-runs its own installer, which rewrites the registration. '
          + 'Repair cannot do it — it only re-provisions what the record still names.',
        );
      }
      return startSession();
    }
    // Cancelled all three: do nothing. No removal, no forced launch, no
    // provisioning — the only path Escape-spamming can reach.
    return;
  }
  if (!r || !r.ok) { toast(`Launch failed: ${(r && r.error) || 'server unreachable'}`); return; }
  closePicker();
  reportLaunched(r);
}

async function addRepoFromForm() {
  const input = $('#addrepo-path');
  const err = $('#addrepo-err');
  const path = input.value.trim();
  if (!path) return;
  err.textContent = '';
  const btn = $('#addrepo-go');
  btn.disabled = true;
  let r;
  try {
    r = await api('/api/repos/add', { path });
  } finally {
    btn.disabled = false;
  }
  if (!r || !r.ok) { err.textContent = (r && r.error) || 'server unreachable'; return; }
  input.value = '';
  $('#addrepo-form').classList.add('hidden');
  toast(`Added ${path}`);
}

function wireEvents() {
  $('#mode-toggle').onclick = () => setMode(state.mode === 'auto' ? 'guided' : 'auto');
  $('#theme-toggle').onclick = toggleTheme;
  $('#journal-toggle').onclick = () => setJournalCollapsed(!$('#journal').classList.contains('collapsed'));
  $('#new-wt').onclick = () => openNewWorktree();
  $('#nw-cancel').onclick = closeNewWorktree;
  $('#nw-create').onclick = submitNewWorktree;
  $('#newwt').addEventListener('click', (e) => { if (e.target.id === 'newwt') closeNewWorktree(); });
  $('#nw-branch').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNewWorktree(); });
  $('#fw-go').onclick = submitFinish;
  $('#fw-cancel').onclick = () => $('#finishwt').classList.add('hidden');
  $('#finishwt').addEventListener('click', (e) => { if (e.target.id === 'finishwt') $('#finishwt').classList.add('hidden'); });
  $('#pk-cancel').onclick = closePicker;
  $('#pk-start').onclick = startSession;
  document.querySelectorAll('.pk-agent-btn').forEach((b) => { b.onclick = () => setPickerAgent(b.dataset.agent); });
  // The seam stays one-way: tickets.js never imports back out of app.js, so
  // everything it needs from here — the launch reporters that own the
  // missing-gate and conflict wording, and the skill picker the footer links
  // to — is handed over at init.
  initTickets({ api, toast, esc, state, reportLaunched, reportConflicts, openPicker });
  $('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') closePicker(); });
  $('#pk-body').addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('pk-all')) {
      t.closest('.pk-pack').querySelectorAll('.pk-cb').forEach((cb) => { cb.checked = t.checked; });
    }
    if (t.classList.contains('pk-group-cb')) {
      t.closest('.pk-group').querySelectorAll('.pk-cb').forEach((cb) => { cb.checked = t.checked; });
    }
    if (t.classList.contains('pk-cb') || t.classList.contains('pk-all') || t.classList.contains('pk-group-cb')) {
      syncMasters();
      updatePickerCount();
    }
  });
  $('#pk-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.pk-group-toggle');
    if (!btn) return;
    setGroupOpen(btn.closest('.pk-group'), btn.getAttribute('aria-expanded') !== 'true');
  });
  $('#search').oninput = (e) => { state.filter = e.target.value; render(); };
  $('#fetch-all').onclick = async () => { const r = await api('/api/fetch-all', { mode: state.mode }); toast(state.mode === 'guided' ? 'Sent to terminal' : 'Fetched all'); };
  $('#addrepo-toggle').onclick = () => {
    $('#addrepo-form').classList.toggle('hidden');
    $('#addrepo-err').textContent = '';
    $('#addrepo-path').focus();
  };
  $('#addrepo-go').onclick = addRepoFromForm;
  $('#addrepo-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') addRepoFromForm(); });

  $('#table').addEventListener('click', (e) => {
    const add = e.target.closest('.repo-add');
    if (add) { e.stopPropagation(); openNewWorktree(add.dataset.repo); return; }
    const btn = e.target.closest('button[data-act]');
    if (btn) { e.stopPropagation(); doAction(btn.dataset.act, btn.dataset, btn); return; }
    const row = e.target.closest('.row[data-path]');
    if (row) openDrawer(decodeURIComponent(row.dataset.path));
  });

  wireDrawerResize();

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); togglePalette(); }
    if (e.key === 'Escape') { $('#palette').classList.add('hidden'); closeDrawer(); $('#newwt').classList.add('hidden'); $('#picker').classList.add('hidden'); $('#finishwt').classList.add('hidden'); closeTickets(); }
  });
}

function setDrawerWidth(px) {
  const w = Math.min(window.innerWidth * 0.95, Math.max(360, px));
  document.documentElement.style.setProperty('--drawer-w', `${Math.round(w)}px`);
}
function wireDrawerResize() {
  const handle = $('#drawer-resize');
  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    dragging = true; handle.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic/edge pointer */ }
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (dragging) setDrawerWidth(window.innerWidth - e.clientX); // drawer is right-anchored
  });
  const end = () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    localStorage.setItem('forest-drawer-w', getComputedStyle(document.documentElement).getPropertyValue('--drawer-w').trim());
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => { localStorage.removeItem('forest-drawer-w'); document.documentElement.style.removeProperty('--drawer-w'); });
}

function togglePalette() {
  const p = $('#palette');
  const show = p.classList.contains('hidden');
  p.classList.toggle('hidden');
  if (show) { $('#palette-input').value = ''; renderPalette(''); $('#palette-input').focus(); }
}
function paletteItems() {
  const items = [];
  for (const r of state.snapshot.repos) for (const w of r.worktrees) {
    items.push({ label: `${r.repo} · ${w.branch || '(detached)'}`, path: w.path });
  }
  return items;
}
function renderPalette(q) {
  const ql = q.toLowerCase();
  const items = paletteItems().filter((i) => i.label.toLowerCase().includes(ql)).slice(0, 30);
  $('#palette-list').innerHTML = items.map((i) => `<li data-path="${encodeURIComponent(i.path)}">${esc(i.label)}</li>`).join('');
}

function wirePalette() {
  $('#palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
  $('#palette-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-path]');
    if (li) { $('#palette').classList.add('hidden'); openDrawer(decodeURIComponent(li.dataset.path)); }
  });
}

function setJournalCollapsed(collapsed) {
  $('#journal').classList.toggle('collapsed', collapsed);
  document.documentElement.classList.toggle('journal-collapsed', collapsed);
  localStorage.setItem('forest-journal', collapsed ? 'collapsed' : 'open');
}

function addJournal(entry) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="j-mode">${esc(entry.mode || '')}</span>${esc(entry.cmd)}`;
  const list = $('#journal-list');
  list.appendChild(li);
  $('#journal-count').textContent = `· ${list.children.length}`;
  if (!$('#journal').classList.contains('collapsed')) $('#journal').scrollTop = $('#journal').scrollHeight;
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('worktrees', (e) => { state.snapshot = JSON.parse(e.data); render(); });
  es.addEventListener('journal', (e) => addJournal(JSON.parse(e.data)));
  es.addEventListener('task', (e) => {
    const d = JSON.parse(e.data);
    const buf = (state.taskBuf[d.path] ||= { text: '', done: false });
    if (d.chunk) buf.text += d.chunk;
    if (d.done) buf.done = true;
    renderTaskPanel(d.path);
  });
}

async function init() {
  syncThemeButton();
  const savedW = localStorage.getItem('forest-drawer-w');
  if (savedW) document.documentElement.style.setProperty('--drawer-w', savedW);
  setJournalCollapsed(localStorage.getItem('forest-journal') === 'collapsed');
  state.config = await fetch('/api/config').then((r) => r.json());
  setMode(localStorage.getItem('forest-mode') || state.config.defaultMode);
  state.snapshot = await fetch('/api/worktrees').then((r) => r.json());
  state.packs = await fetch('/api/packs').then((r) => r.json()).then((j) => j.packs || []).catch(() => []);
  (await fetch('/api/journal').then((r) => r.json())).forEach(addJournal);
  render();
  wireEvents();
  wirePalette();
  connectSSE();
}
init();
