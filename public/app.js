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
function agentCell(a) {
  const cls = a.state === 'running' ? 'run' : a.state === 'idle' ? 'idle' : 'unknown';
  const label = a.state === 'running' ? (a.kind || 'agent') : a.state;
  return `<span><span class="dot ${cls}"></span>${label}</span>`;
}
function ageCell(w) { return w.ageDays == null ? '—' : w.ageDays === 0 ? 'today' : `${w.ageDays}d`; }
function sizeCell(w) { return w.sizeBytes == null ? '—' : `${(w.sizeBytes / 1e9).toFixed(1)}G`; }
function ticketCell(w) {
  if (w.ticket && state.config.jiraBaseUrl) {
    return `<a class="ticket-link" href="${state.config.jiraBaseUrl}/browse/${encodeURIComponent(w.ticket)}" target="_blank" onclick="event.stopPropagation()">${esc(w.branch)}</a>`;
  }
  return esc(w.branch) || '(detached)';
}

function matches(w, repo) {
  const f = state.filter.toLowerCase();
  if (!f) return true;
  return [repo, w.branch, w.ticket, w.owner].filter(Boolean).some((s) => s.toLowerCase().includes(f));
}

function rowHtml(w, repo) {
  const enc = encodeURIComponent(w.path);
  const pruneable = (w.stale || w.merged) && !w.isPrimary;
  return `<div class="row ${w.isPrimary ? '' : 'nested'}" data-path="${enc}">
    <div class="col-branch branch">${ticketCell(w)}</div>
    <div class="col-status">${statusBadge(w)}${gateBadge(w)}</div>
    <div class="col-owner">${esc(w.owner)}</div>
    <div class="col-agent">${agentCell(w.agent)}</div>
    <div class="col-age">${ageCell(w)}</div>
    <div class="col-size">${sizeCell(w)}</div>
    <div class="col-actions actions">
      <button title="Quick task" data-act="task" data-path="${enc}">⚡</button>
      <button title="Launch Claude" data-act="launch" data-path="${enc}">▶</button>
      ${w.scope && w.scope.missing ? `<button title="Repair ${w.scope.missing} missing hook script(s)" data-act="repair" data-path="${enc}">🩹</button>` : ''}
      <button title="Open in Cursor" data-act="open-cursor" data-path="${enc}">⤓</button>
      ${w.isPrimary ? '' : `<button data-act="finish" data-path="${enc}" title="Finish: land this worktree's branch in the main checkout">✓</button>`}
      ${pruneable ? `<button title="Prune" data-act="remove" data-path="${enc}" data-repo="${encodeURIComponent(w.repoPath)}" data-primary="${w.isPrimary}">🧹</button>` : ''}
    </div>
  </div>`;
}

function render() {
  const html = state.snapshot.repos.map((r) => {
    const shown = r.worktrees.filter((w) => matches(w, r.repo));
    const rows = shown.map((w) => rowHtml(w, r.repo)).join('');
    if (!rows) return '';
    return `<div class="repo-group"><div class="repo-name"><span class="repo-name-label">${esc(r.repo)}<span class="repo-count">${shown.length}</span></span><button class="repo-add" data-repo="${esc(r.repoPath)}" title="New worktree in ${esc(r.repo)}">+ worktree</button></div>${rows}</div>`;
  }).join('');
  $('#table').innerHTML = html || '<p class="empty">No worktrees match.</p>';
  renderReadout();
}

function renderReadout() {
  let total = 0, changed = 0, prunable = 0, live = 0;
  for (const r of state.snapshot.repos) for (const w of r.worktrees) {
    total++;
    if (w.status.dirty && !(w.stale || w.merged)) changed++;
    if ((w.stale || w.merged) && !w.isPrimary) prunable++;
    if (w.agent.state === 'running') live++;
  }
  const el = $('#readout');
  if (!el) return;
  el.innerHTML = `<b>${total}</b> worktrees`
    + (changed ? ` · <b>${changed}</b> changed` : '')
    + (prunable ? ` · <b class="rd-prune">${prunable}</b> prunable` : '')
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

async function openDrawer(path) {
  const w = findWorktree(path);
  if (!w) return;
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
    ${applyHtml}
    <div id="task-panel"></div>
    <h4>Diff</h4><div id="diff" class="diffview">loading…</div>
    ${removeHtml}
    ${ejectHtml}`;
  $('#drawer-close').onclick = () => d.classList.add('hidden');
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
    if (r && !r.error && state.mode === 'auto') d.classList.add('hidden');
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
  const res = await fetch(`/api/diff?path=${encodeURIComponent(path)}`).then((r) => r.json());
  $('#diff').innerHTML = renderDiff(res.diff || '');
}

function renderTaskPanel(path) {
  const panel = $('#task-panel');
  if (!panel) return;
  const buf = state.taskBuf[path];
  if (!buf) { panel.innerHTML = ''; return; }
  panel.innerHTML = `<h4>Task output</h4><pre>${buf.text.replace(/</g, '&lt;')}</pre>
    ${buf.done ? `<button id="continue-int">Continue interactively</button>` : '<em>running…</em>'}`;
  const c = $('#continue-int');
  if (c) c.onclick = () => api('/api/launch', { path });
}

async function doAction(act, ds) {
  const path = decodeURIComponent(ds.path);
  if (act === 'launch') { openPicker(path); return; }
  if (act === 'open-cursor') { await api('/api/open', { path, target: 'cursor' }); return; }
  if (act === 'repair') {
    const r = await api('/api/worktree/repair', { path });
    // Pre-branch worktrees have no provision record to replay — repair can only
    // guess, so hand the user to the picker instead of a dead-end toast.
    if (r && r.error === 'no provision record') { openPicker(path); return; }
    if (!r || r.error || !r.scope) { toast(`Repair failed: ${(r && r.error) || 'server unreachable'} — open the picker and re-provision`); return; }
    toast(`Repaired · ${r.scope.active} hooks active, ${r.scope.missing} missing`);
    return;
  }
  if (act === 'task') {
    const prompt = state.mode === 'auto' ? window.prompt('Task for Claude (headless):') : null;
    if (state.mode === 'auto' && !prompt) return;
    state.taskBuf[path] = { text: '', done: false };
    await api('/api/task', { path, prompt, mode: state.mode });
    openDrawer(path);
    return;
  }
  if (act === 'remove') {
    const w = findWorktree(path);
    if (w) await removeWorktree(w);
    return;
  }
  if (act === 'finish') { openFinish(path); return; }
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

let finishCtx = null; // { w, preview }

async function openFinish(path) {
  const w = findWorktree(path);
  if (!w || w.isPrimary) { toast('Cannot finish the primary worktree'); return; }
  const preview = await api('/api/worktree/finish-preview', { repoPath: w.repoPath, path: w.path });
  if (preview.error) { toast(`Error: ${preview.error}`); return; }
  if (preview.mergeInProgress) { toast('Main checkout has a merge in progress — resolve it first'); return; }
  if (!preview.targetBranch && !preview.nameMismatch) { toast('Cannot resolve a target branch for this worktree'); return; }
  finishCtx = { w, preview };
  $('#fw-summary').textContent =
    `${preview.worktreeName} → ${preview.relanding ? 'merge into' : 'land as'} ${preview.targetBranch ?? preview.candidates[0]}` +
    ` · ${preview.dirtyCount} uncommitted file(s) will carry over · ↑${w.ahead} ↓${w.behind} vs ${w.baseBranch}`;
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
  toast(`Landed ${r.targetBranch}${r.removed ? ', worktree removed' : ''}${r.stashConflict ? ' — stash pop conflicted, stash kept' : ''}${r.removeError ? ` — worktree remove failed: ${r.removeError}` : ''}${r.removeSkipped ? ` — worktree kept: ${r.removeSkipped}` : ''}`);
}

function openNewWorktree(repoPath) {
  const sel = $('#nw-repo');
  sel.innerHTML = state.snapshot.repos.map((r) => `<option value="${esc(r.repoPath)}">${esc(r.repo)}</option>`).join('');
  if (repoPath) sel.value = repoPath;
  $('#nw-branch').value = '';
  $('#nw-base').value = '';
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

// ---- skill/kit picker (shown before launching a Claude session) ----
let pickerPath = null;
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
function renderPack(p, picked) {
  const skills = picked.skills || [], kits = picked.kits || [];
  const groups = (p.groups && p.groups.length) ? p.groups : [...new Set(p.skillsets.map((s) => s.group || 'other'))];
  const sections = groups.map((g) => {
    const items = p.skillsets.filter((s) => (s.group || 'other') === g);
    if (!items.length) return '';
    return `<div class="pk-group"><div class="pk-group-h">${esc(groupLabel(g))}</div>${
      items.map((s) => skillRow(p.pack, 'skill', s.id, s.label, s.description, skills.includes(s.id))).join('')}</div>`;
  }).join('');
  const kitSection = (p.kits && p.kits.length)
    ? `<div class="pk-group"><div class="pk-group-h">Kits</div>${p.kits.map((k) => skillRow(p.pack, 'kit', k.id, k.label, '', kits.includes(k.id))).join('')}</div>`
    : '';
  const hooksSection = p.hooks
    ? `<div class="pk-group"><div class="pk-group-h">Gates</div>${skillRow(p.pack, 'hooks', p.hooks.id, p.hooks.label, p.hooks.description, !!picked.hooks)}</div>`
    : '';
  const head = `<div class="pk-pack-h"><label class="pk-all-row"><input type="checkbox" class="pk-all" /> Select all ${esc(p.pack)}</label></div>`;
  return `<div class="pk-pack">${head}${sections}${kitSection}${hooksSection}</div>`;
}

// Reflect each pack's "Select all" master from its individual checkboxes
// (checked when all are on, indeterminate when some are).
function syncMasters() {
  document.querySelectorAll('#pk-body .pk-pack').forEach((pk) => {
    const all = pk.querySelector('.pk-all');
    if (!all) return;
    const boxes = pk.querySelectorAll('.pk-cb');
    const on = [...boxes].filter((b) => b.checked).length;
    all.checked = boxes.length > 0 && on === boxes.length;
    all.indeterminate = on > 0 && on < boxes.length;
  });
}

function openPicker(path) {
  const w = findWorktree(path);
  if (!w) return;
  pickerPath = path;
  $('#pk-sub').textContent = `${w.repo} · ${w.branch || '(detached)'}`;
  const sel = loadSel(path);
  $('#pk-body').innerHTML = state.packs.length
    ? state.packs.map((p) => renderPack(p, sel[p.pack] || {})).join('')
    : `<p class="pk-empty">No skill packs found in <code>SKLS/</code>. Claude will start with no extra skills.</p>`;
  $('#picker').classList.remove('hidden');
  syncMasters();
  updatePickerCount();
  refreshPickerScope(path);
}
function closePicker() { $('#picker').classList.add('hidden'); pickerPath = null; }
function updatePickerCount() {
  const n = document.querySelectorAll('#pk-body .pk-cb:checked').length;
  $('#pk-count').textContent = n ? `${n} selected` : 'none selected';
  $('#pk-start').textContent = n ? 'Provision & start' : 'Start session';
}
// What the session will load today — before provisioning anything. Makes the
// remaining ~/.claude inheritance visible instead of implicit.
async function refreshPickerScope(path) {
  const el = $('#pk-scope');
  el.textContent = '';
  el.classList.remove('warn');
  const s = await api('/api/worktree/scope', { path });
  if (!s || s.error || !s.sources) return;
  el.textContent = s.missing.length
    ? `${s.active} hooks active · ${s.missing.length} missing`
    : `${s.active} hooks active · ${s.sources.length} settings source(s)`;
  if (s.missing.length) el.classList.add('warn');
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
async function startSession() {
  const path = pickerPath;
  if (!path) return;
  const sel = collectSel();
  saveSel(path, sel);
  const selections = Object.entries(sel).map(([pack, v]) => ({ pack, skills: v.skills, kits: v.kits, hooks: v.hooks }));
  const btn = $('#pk-start');
  btn.disabled = true;
  const r = await api('/api/launch', { path, selections, mode: state.mode });
  btn.disabled = false;
  if (!r || !r.ok) { toast(`Launch failed: ${(r && r.error) || 'server unreachable'}`); return; }
  closePicker();
  const prov = r.provisioned;
  const provMsg = prov && (prov.skills.length || prov.kits.length || prov.hooks)
    ? `${prov.skills.length} skill(s)${prov.kits.length ? `, ${prov.kits.length} kit(s)` : ''}${prov.hooks ? ', gates' : ''} · ` : '';
  const miss = r.scope && r.scope.missing ? r.scope.missing.length : 0;
  if (miss) toast(`${provMsg}Launching Claude — ${miss} registered hook script(s) missing`);
  else toast(r.action === 'focused' ? 'Claude already running — Terminal brought to front' : `${provMsg}Launching Claude…`);
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
  $('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') closePicker(); });
  $('#pk-body').addEventListener('change', (e) => {
    if (e.target.classList.contains('pk-all')) {
      e.target.closest('.pk-pack').querySelectorAll('.pk-cb').forEach((cb) => { cb.checked = e.target.checked; });
    }
    if (e.target.classList.contains('pk-cb') || e.target.classList.contains('pk-all')) { syncMasters(); updatePickerCount(); }
  });
  $('#search').oninput = (e) => { state.filter = e.target.value; render(); };
  $('#fetch-all').onclick = async () => { const r = await api('/api/fetch-all', { mode: state.mode }); toast(state.mode === 'guided' ? 'Sent to terminal' : 'Fetched all'); };

  $('#table').addEventListener('click', (e) => {
    const add = e.target.closest('.repo-add');
    if (add) { e.stopPropagation(); openNewWorktree(add.dataset.repo); return; }
    const btn = e.target.closest('button[data-act]');
    if (btn) { e.stopPropagation(); doAction(btn.dataset.act, btn.dataset); return; }
    const row = e.target.closest('.row[data-path]');
    if (row) openDrawer(decodeURIComponent(row.dataset.path));
  });

  wireDrawerResize();

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); togglePalette(); }
    if (e.key === 'Escape') { $('#palette').classList.add('hidden'); $('#drawer').classList.add('hidden'); $('#newwt').classList.add('hidden'); $('#picker').classList.add('hidden'); $('#finishwt').classList.add('hidden'); }
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
