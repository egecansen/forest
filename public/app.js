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
    <div class="col-status">${statusBadge(w)}</div>
    <div class="col-owner">${esc(w.owner)}</div>
    <div class="col-agent">${agentCell(w.agent)}</div>
    <div class="col-age">${ageCell(w)}</div>
    <div class="col-size">${sizeCell(w)}</div>
    <div class="col-actions actions">
      <button title="Quick task" data-act="task" data-path="${enc}">⚡</button>
      <button title="Launch Claude" data-act="launch" data-path="${enc}">▶</button>
      <button title="Open in Cursor" data-act="open-cursor" data-path="${enc}">⤓</button>
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
    : `<div class="drawer-danger"><button id="wt-remove" class="btn-danger">Remove worktree</button></div>`;
  d.innerHTML = `<button id="drawer-close" class="drawer-close">Close ✕</button>
    <h3>${esc(w.branch) || '(detached)'}</h3>
    <p class="meta-line">${esc(w.repo)} · ${esc(w.owner)} · ${ageCell(w)} · ${sizeCell(w)}</p>
    ${applyHtml}
    <div id="task-panel"></div>
    <h4>Diff</h4><div id="diff" class="diffview">loading…</div>
    ${removeHtml}`;
  $('#drawer-close').onclick = () => d.classList.add('hidden');
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
  const r = await api('/api/worktree/create', { repoPath, branch, newBranch, base, mode: state.mode });
  btn.disabled = false;
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
  const head = `<div class="pk-pack-h"><label class="pk-all-row"><input type="checkbox" class="pk-all" /> Select all ${esc(p.pack)}</label></div>`;
  return `<div class="pk-pack">${head}${sections}${kitSection}</div>`;
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
}
function closePicker() { $('#picker').classList.add('hidden'); pickerPath = null; }
function updatePickerCount() {
  const n = document.querySelectorAll('#pk-body .pk-cb:checked').length;
  $('#pk-count').textContent = n ? `${n} selected` : 'none selected';
  $('#pk-start').textContent = n ? 'Provision & start' : 'Start session';
}
function collectSel() {
  const sel = {};
  document.querySelectorAll('#pk-body .pk-cb:checked').forEach((cb) => {
    const p = (sel[cb.dataset.pack] ||= { skills: [], kits: [] });
    (cb.dataset.kind === 'kit' ? p.kits : p.skills).push(cb.dataset.id);
  });
  return sel;
}
async function startSession() {
  const path = pickerPath;
  if (!path) return;
  const sel = collectSel();
  saveSel(path, sel);
  const selections = Object.entries(sel).map(([pack, v]) => ({ pack, skills: v.skills, kits: v.kits }));
  const btn = $('#pk-start');
  btn.disabled = true;
  const r = await api('/api/launch', { path, selections, mode: state.mode });
  btn.disabled = false;
  if (!r || (!r.ok && r.error)) { toast(`Launch failed: ${(r && r.error) || 'server unreachable'}`); return; }
  closePicker();
  const prov = r.provisioned;
  const provMsg = prov && (prov.skills.length || prov.kits.length)
    ? `${prov.skills.length} skill(s)${prov.kits.length ? `, ${prov.kits.length} kit(s)` : ''} · ` : '';
  toast(r.action === 'focused' ? 'Claude already running — Terminal brought to front' : `${provMsg}Launching Claude…`);
}

function wireEvents() {
  $('#mode-toggle').onclick = () => setMode(state.mode === 'auto' ? 'guided' : 'auto');
  $('#theme-toggle').onclick = toggleTheme;
  $('#journal-toggle').onclick = () => setJournalCollapsed(!$('#journal').classList.contains('collapsed'));
  $('#new-wt').onclick = openNewWorktree;
  $('#nw-cancel').onclick = closeNewWorktree;
  $('#nw-create').onclick = submitNewWorktree;
  $('#newwt').addEventListener('click', (e) => { if (e.target.id === 'newwt') closeNewWorktree(); });
  $('#nw-branch').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNewWorktree(); });
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

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); togglePalette(); }
    if (e.key === 'Escape') { $('#palette').classList.add('hidden'); $('#drawer').classList.add('hidden'); $('#newwt').classList.add('hidden'); $('#picker').classList.add('hidden'); }
  });
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
