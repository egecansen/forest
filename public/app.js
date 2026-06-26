const $ = (s) => document.querySelector(s);
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const state = { config: null, snapshot: { repos: [] }, filter: '', mode: 'guided', taskBuf: {} };

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
    return `<div class="repo-group"><div class="repo-name">${esc(r.repo)}<span class="repo-count">${shown.length}</span></div>${rows}</div>`;
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

function colorizeDiff(text) {
  return text.split('\n').map((l) => {
    const e = l.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    if (l.startsWith('+')) return `<span class="diff-add">${e}</span>`;
    if (l.startsWith('-')) return `<span class="diff-del">${e}</span>`;
    if (l.startsWith('@@')) return `<span class="diff-hunk">${e}</span>`;
    return e;
  }).join('\n');
}

async function openDrawer(path) {
  const w = findWorktree(path);
  if (!w) return;
  const d = $('#drawer');
  d.classList.remove('hidden');
  d.innerHTML = `<button id="drawer-close" class="drawer-close">Close ✕</button>
    <h3>${esc(w.branch) || '(detached)'}</h3>
    <p class="meta-line">${esc(w.repo)} · ${esc(w.owner)} · ${ageCell(w)} · ${sizeCell(w)}</p>
    <div id="task-panel"></div>
    <h4>Diff</h4><pre id="diff">loading…</pre>`;
  $('#drawer-close').onclick = () => d.classList.add('hidden');
  const buf = state.taskBuf[path];
  if (buf) renderTaskPanel(path);
  const res = await fetch(`/api/diff?path=${encodeURIComponent(path)}`).then((r) => r.json());
  $('#diff').innerHTML = res.diff ? colorizeDiff(res.diff) : '(no changes)';
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
  if (act === 'launch') { const r = await api('/api/launch', { path }); toast(r && r.ok ? 'Launching Claude…' : `Launch failed: ${r.error || 'server unreachable'}`); return; }
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
    if (!w) return;
    if (w.status.dirty && !confirm('Worktree has uncommitted changes. Remove anyway?')) return;
    if (!confirm(`Remove worktree?\n${path}`)) return;
    const r = await api('/api/worktree/remove', { repoPath: decodeURIComponent(ds.repo), path, force: w.status.dirty, isPrimary: w.isPrimary, mode: state.mode });
    toast(r.error ? `Error: ${r.error}` : state.mode === 'guided' ? 'Sent to terminal' : 'Removed');
  }
}

function wireEvents() {
  $('#mode-toggle').onclick = () => setMode(state.mode === 'auto' ? 'guided' : 'auto');
  $('#theme-toggle').onclick = toggleTheme;
  $('#search').oninput = (e) => { state.filter = e.target.value; render(); };
  $('#fetch-all').onclick = async () => { const r = await api('/api/fetch-all', { mode: state.mode }); toast(state.mode === 'guided' ? 'Sent to terminal' : 'Fetched all'); };

  $('#table').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) { e.stopPropagation(); doAction(btn.dataset.act, btn.dataset); return; }
    const row = e.target.closest('.row[data-path]');
    if (row) openDrawer(decodeURIComponent(row.dataset.path));
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); togglePalette(); }
    if (e.key === 'Escape') { $('#palette').classList.add('hidden'); $('#drawer').classList.add('hidden'); }
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

function addJournal(entry) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="j-mode">${esc(entry.mode || '')}</span>${esc(entry.cmd)}`;
  $('#journal-list').appendChild(li);
  $('#journal').scrollTop = $('#journal').scrollHeight;
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
  state.config = await fetch('/api/config').then((r) => r.json());
  setMode(localStorage.getItem('forest-mode') || state.config.defaultMode);
  state.snapshot = await fetch('/api/worktrees').then((r) => r.json());
  (await fetch('/api/journal').then((r) => r.json())).forEach(addJournal);
  render();
  wireEvents();
  wirePalette();
  connectSSE();
}
init();
