// public/tickets.js — the Tickets modal: pick a person, pick their tickets,
// pick boxes, launch ONE session seeded with the prompt.
//
// Its own module because app.js already owns every other modal and is 1150
// lines. Dependencies arrive through initTickets() rather than being imported
// back out of app.js, so the seam stays one-way.

import { composeTicketPrompt } from './prompt.js';
import { loadAgent, saveAgent, agentLabel, ticketStartLabel } from './agent-choice.js';

let D = null;                                   // { api, toast, esc, state, reportLaunched, reportConflicts, openPicker }
let target = null;                              // { repoPath, repo, primaryPath, baseBranch }
let scope = 'sprint';
let person = null;                              // { name, displayName }
let lists = { sprint: null, backlog: null };    // scope -> { issues, total, truncated }
let filter = '';
const pickedTickets = new Set();
const pickedBoxes = new Set();
let boxes = [];        // [{ box, description, endDate, … }]
let boxSource = 'config';
let promptDirty = false;                        // user has typed into #tk-prompt — stop overwriting it
let skillUnits = 0;                             // units the last picker run left in forest-skills:<primaryPath>
let openToken = 0;                              // bumped on every open/close; invalidates stale timers
let lastBookmarklet = '';                       // raw (unescaped) javascript: source, for the Copy button
let launchTarget = 'terminal';                  // 'terminal' | 'cursor' — persisted per repo, see setLaunchTarget()
let agent = 'cursor';                           // 'claude' | 'cursor' — Terminal target only; persisted per primary checkout, see setAgent()

const $ = (s) => document.querySelector(s);
const PERSON_KEY = 'forest-jira-person';
const boxKey = (repoPath) => `forest-boxes:${repoPath}`;
const launchTargetKey = (repoPath) => `forest-launch-target:${repoPath}`;
// The SRP login form's remembered username — never the password, see
// wireLogin().
const SRP_USER_KEY = 'forest-srp-username';

export function initTickets(deps) {
  D = deps;
  $('#tk-cancel').onclick = close;
  $('#tk-close').onclick = close;
  // Deliberately NO backdrop-click close: this modal holds a ticket selection
  // and a hand-editable prompt, and a stray click on the page behind it used to
  // throw both away. Cancel, the × and Escape are the ways out.
  $('#tk-refresh').onclick = () => { load({ refresh: true }); loadBoxes(); };
  $('#tk-start').onclick = start;
  // The prompt is the last line of defence for every guess this feature makes
  // (the box label), so once it has been corrected by hand the correction
  // outranks anything renderFooter() would recompose. A fresh open clears the
  // flag — see openTickets().
  $('#tk-prompt').oninput = () => { promptDirty = true; };
  document.querySelectorAll('.tk-target-btn').forEach((b) => { b.onclick = () => setLaunchTarget(b.dataset.target); });
  document.querySelectorAll('.tk-agent-btn').forEach((b) => { b.onclick = () => setAgent(b.dataset.agent); });
  // The footer names what will be provisioned; this is the spec's link that
  // changes it. The picker is a separate modal on the same backdrop, so the
  // tickets modal closes first rather than stacking two.
  $('#tk-skills-edit').onclick = () => {
    const path = target && target.primaryPath;
    close();
    if (path) D.openPicker(path);
  };
  $('#tk-filter').oninput = (e) => { filter = e.target.value.toLowerCase(); renderList(); };
  $('#tk-person').onclick = openPersonSearch;
  $('#tk-person-q').oninput = debounce(searchPeople, 250);
  document.querySelectorAll('.tk-tab').forEach((t) => {
    t.onclick = () => { scope = t.dataset.scope; syncTabs(); load(); };
  });
  $('#tk-body').addEventListener('change', (e) => {
    if (!e.target.classList.contains('tk-cb')) return;
    toggle(pickedTickets, e.target.dataset.key, e.target.checked);
    renderFooter();
  });
  $('#tk-boxes').addEventListener('change', (e) => {
    if (!e.target.classList.contains('tk-box-cb')) return;
    toggle(pickedBoxes, e.target.dataset.box, e.target.checked);
    localStorage.setItem(boxKey(target.repoPath), JSON.stringify([...pickedBoxes]));
    renderFooter();
  });
}

export async function openTickets(t) {
  target = t;
  openToken += 1;                                // invalidates any reload timer from a prior open
  pickedTickets.clear();
  pickedBoxes.clear();
  lists = { sprint: null, backlog: null };
  filter = '';
  scope = 'sprint';
  promptDirty = false;                           // a fresh open starts from a composed prompt again
  skillUnits = countUnits(savedSelections(t.primaryPath));
  $('#tk-filter').value = '';
  $('#tk-sub').textContent = `${t.repo} · session starts in ${t.primaryPath}`;
  syncTabs();
  let savedTarget = 'terminal';
  try { savedTarget = localStorage.getItem(launchTargetKey(t.repoPath)) || 'terminal'; } catch { savedTarget = 'terminal'; }
  setLaunchTarget(savedTarget, { persist: false }); // restoring, not choosing — do not re-write what was just read
  // The picker's key, on purpose: forest-agent:<primaryPath> is exactly the
  // path startTerminal() launches in, the same way savedSelections() shares
  // the picker's forest-skills:<primaryPath>. One preference, two surfaces.
  setAgent(loadAgent(localStorage, t.primaryPath), { persist: false });
  // BEFORE the first await, not after loadBoxes() resolves. Nothing is picked
  // yet, so this writes an empty prompt and a disabled Start — otherwise the
  // second and every later open showed the PREVIOUS repo's prompt with Start
  // still enabled (start() re-enables it and neither close() nor start()
  // clears the textarea) until /api/srp/boxes came back: instant on the
  // config-fallback path, up to 8s when SRP is unreachable, and a click in
  // that window launched a session in repo B seeded with repo A's tickets.
  // loadBoxes() ends with its own renderFooter(), which is what repaints the
  // footer once the boxes are in — this call is that one, moved, not a
  // second one.
  renderFooter();
  $('#tickets').classList.remove('hidden');
  await loadBoxes();
  await ensurePerson();
  await load();
}

export function closeTickets() { close(); }

function close() {
  openToken += 1;                                // invalidates any reload timer scheduled this session
  $('#tickets').classList.add('hidden');
  $('#tk-people').classList.add('hidden');
  $('#tk-person-q').classList.add('hidden');
  $('#tk-person-q').value = '';
}

const toggle = (set, v, on) => (on ? set.add(v) : set.delete(v));

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function syncTabs() {
  document.querySelectorAll('.tk-tab').forEach((t) => t.classList.toggle('on', t.dataset.scope === scope));
}

// ---- person ----

async function ensurePerson() {
  if (person) return;
  try { person = JSON.parse(localStorage.getItem(PERSON_KEY)) || null; } catch { person = null; }
  if (!person) {
    const r = await D.api('/api/jira/people', { q: '' });
    if (r.error) { $('#tk-person').textContent = 'no person'; D.toast(`Error: ${r.error}`); return; }
    person = r.me;
  }
  $('#tk-person').textContent = person.displayName || person.name;
}

function openPersonSearch() {
  const q = $('#tk-person-q');
  q.classList.remove('hidden');
  q.value = '';
  q.focus();
}

async function searchPeople() {
  const q = $('#tk-person-q').value.trim();
  const box = $('#tk-people');
  if (q.length < 2) { box.classList.add('hidden'); return; }
  const r = await D.api('/api/jira/people', { q });
  if (r.error) { box.classList.add('hidden'); D.toast(`Error: ${r.error}`); return; }
  box.innerHTML = (r.people || []).map((p) =>
    `<button type="button" class="tk-person-hit" data-name="${D.esc(p.name)}" data-label="${D.esc(p.displayName)}">${D.esc(p.displayName)} <span class="tk-dim">${D.esc(p.name)}</span></button>`).join('')
    || '<div class="tk-empty">no match</div>';
  box.classList.remove('hidden');
  box.querySelectorAll('.tk-person-hit').forEach((b) => {
    b.onclick = () => {
      person = { name: b.dataset.name, displayName: b.dataset.label };
      localStorage.setItem(PERSON_KEY, JSON.stringify(person));
      $('#tk-person').textContent = person.displayName;
      box.classList.add('hidden');
      $('#tk-person-q').classList.add('hidden');
      lists = { sprint: null, backlog: null };
      pickedTickets.clear();
      renderFooter();
      load();
    };
  });
}

// ---- tickets ----

async function load({ refresh = false } = {}) {
  if (!person) return;
  if (lists[scope] && !refresh) { renderList(); return; }
  $('#tk-body').innerHTML = '<div class="tk-empty">loading…</div>';
  const r = await D.api('/api/jira/tickets', { scope, assignee: person.name, refresh });
  if (r.error) {
    $('#tk-body').innerHTML = `<div class="tk-empty tk-err">${D.esc(r.error)}</div>`;
    return;
  }
  lists[scope] = r;
  syncCounts();
  renderList();
}

function syncCounts() {
  for (const s of ['sprint', 'backlog']) {
    const el = $(`#tk-tab-${s}`);
    const n = lists[s] ? lists[s].total : null;
    el.textContent = n === null ? (s === 'sprint' ? 'Sprint' : 'Backlog') : `${s === 'sprint' ? 'Sprint' : 'Backlog'} ${n}`;
  }
}

function renderList() {
  const data = lists[scope];
  if (!data) return;
  const rows = data.issues.filter((i) =>
    !filter || i.key.toLowerCase().includes(filter) || (i.summary || '').toLowerCase().includes(filter));
  $('#tk-body').innerHTML = rows.length
    ? rows.map((i) => `<label class="tk-item">
        <input type="checkbox" class="tk-cb" data-key="${D.esc(i.key)}" ${pickedTickets.has(i.key) ? 'checked' : ''} />
        <span class="tk-key">${D.esc(i.key)}</span>
        <span class="tk-status">${D.esc(i.status)}</span>
        <span class="tk-summary">${D.esc(i.summary)}</span>
      </label>`).join('')
      + (data.truncated ? `<div class="tk-empty">showing ${data.issues.length} of ${data.total}</div>` : '')
    : `<div class="tk-empty">no tickets in the ${scope === 'sprint' ? 'current sprint' : 'backlog'} for ${D.esc(person.displayName)}</div>`;
}

// ---- boxes (SRP, degrading to config.testboxes when SRP is unconfigured,
// unreachable, or refuses the token — /api/srp/boxes never errors, it just
// says why it fell back) ----

async function loadBoxes() {
  $('#tk-boxes').innerHTML = '<div class="tk-empty">reading your SRP reservations…</div>';
  const r = await D.api('/api/srp/boxes', {});
  boxes = (r && r.boxes) || [];
  boxSource = (r && r.source) || 'config';
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(boxKey(target.repoPath))) || []; } catch { saved = []; }
  const live = new Set(boxes.map((b) => b.box));
  // Prune first: a box picked earlier this session (or restored on open) can
  // drop off the live list by the time ↻ re-fetches — e.g. its reservation
  // expired — and pickedBoxes must not go on counting it once it is no
  // longer offered, even though openTickets() already clears the set on a
  // fresh open and this is a no-op there.
  [...pickedBoxes].forEach((b) => { if (!live.has(b)) pickedBoxes.delete(b); });
  saved.filter((b) => live.has(b)).forEach((b) => pickedBoxes.add(b));
  renderBoxes(r && r.reason);
  renderFooter();
}

function renderBoxes(reason) {
  const head = `<div class="tk-boxes-h">Boxes ${boxSource === 'srp' ? '(SRP)' : '(config fallback)'}</div>`;
  // Anything short of a live SRP read is an opening for the bookmarklet —
  // unconfigured, a refused/stale token, or SRP being unreachable all land
  // here with boxSource still 'config'. Re-running the bookmarklet is a
  // free, harmless action in every one of those cases, so the control is
  // offered on all of them rather than trying to parse `reason` for which
  // exact one this is.
  const offerConnect = boxSource !== 'srp';
  const note = reason
    ? `<div class="tk-empty">${D.esc(reason)}${offerConnect ? ' <button type="button" class="tk-link" id="tk-srp-connect-toggle">Connect SRP</button>' : ''}</div>`
    : '';
  const connect = offerConnect ? connectPanelHtml() : '';
  // Reserving happens in SRP now, not in forest — this row only ever lists
  // what's already held, or points at SRP when nothing is.
  const body = boxes.length ? boxes.map((b) => `<label class="tk-box">
      <input type="checkbox" class="tk-box-cb" data-box="${D.esc(b.box)}" ${pickedBoxes.has(b.box) ? 'checked' : ''} />
      <span>${D.esc(b.box)}</span>
      ${b.endDate ? `<span class="tk-dim">until ${D.esc(String(b.endDate).replace('T', ' ').slice(0, 16))}</span>` : ''}
      ${b.description ? `<span class="tk-dim">${D.esc(b.description)}</span>` : ''}
    </label>`).join('') : noBoxesHtml();
  $('#tk-boxes').innerHTML = head + note + connect + body;
  wireConnect();
  wireLogin();
}

// Points at SRP's own Overview page rather than offering a form here — SRP
// is the one place a reservation is actually made. The origin is derived
// from config.srpBaseUrl (the API root, e.g.
// https://srp.ngntest.sahibindenlocal.net/api) rather than hardcoded, so
// this follows whatever SRP deployment forest is actually configured against.
function noBoxesHtml() {
  const srpBaseUrl = (D.state.config && D.state.config.srpBaseUrl) || '';
  let srpOrigin = '';
  try { srpOrigin = srpBaseUrl ? new URL(srpBaseUrl).origin : ''; } catch { srpOrigin = ''; }
  const link = srpOrigin
    ? `<a href="${D.esc(srpOrigin)}/overview" target="_blank" rel="noopener">reserve one in SRP</a>`
    : 'reserve one in SRP (set srpBaseUrl in config.json first)';
  return `<div class="tk-empty">You hold no testboxes — ${link}, then ↻ here.</div>`;
}

// The bookmarklet's own source, built here rather than shipped as a static
// asset: it has to close over FOREST_ORIGIN (this page's own origin — the
// address the SRP tab needs to reach back to), which is only known at
// render time. The server-side half of this contract is the Origin check in
// lib/actions.mjs's /api/srp/token handler — it accepts a POST only from the
// origin of config.srpBaseUrl, so a stray copy of this bookmarklet run
// against the wrong SRP deployment simply gets refused there.
function bookmarkletSource(forestOrigin) {
  return `javascript:(async()=>{const r=localStorage.getItem('srpRefreshToken'),a=localStorage.getItem('srpAccessToken');
if(!r){alert('No SRP session found — log in to SRP in this tab first.');return;}
try{await fetch('${forestOrigin}/api/srp/token',{method:'POST',headers:{'Content-Type':'text/plain'},
body:JSON.stringify({refreshToken:r,accessToken:a})});alert('forest is connected to SRP.');}
catch(e){alert('Could not reach forest at ${forestOrigin} — is it running?');}})()`;
}

// Collapsed by default (the "Connect SRP" button above toggles it). SRP's
// web origin is derived from config.srpBaseUrl (the API root) rather than
// hand-configured separately, and gates BOTH halves of the panel: the login
// POST would only fail identically server-side without it, and the
// bookmarklet's fetch() only works AT ALL when it runs on that same origin.
//
// The login form leads — it is now the PRIMARY way to connect, added after
// the bookmarklet, because most people would rather type a password once
// than manage a browser bookmarklet. The bookmarklet stays below it as the
// alternative for people who would rather not type a password into forest
// at all.
function connectPanelHtml() {
  const forestOrigin = window.location.origin;
  const srpBaseUrl = (D.state.config && D.state.config.srpBaseUrl) || '';
  let srpOrigin = '';
  try { srpOrigin = srpBaseUrl ? new URL(srpBaseUrl).origin : ''; } catch { srpOrigin = ''; }
  if (!srpOrigin) {
    lastBookmarklet = '';
    return `<div id="tk-srp-connect" class="tk-srp-connect hidden">
      <p class="tk-dim">set srpBaseUrl in config.json before SRP can be connected from the browser.</p>
    </div>`;
  }
  lastBookmarklet = bookmarkletSource(forestOrigin);
  // The username is a convenience, remembered across sessions like the
  // person-picker's own localStorage key. The password is never written
  // anywhere — see wireLogin(), which clears the field the instant a submit
  // resolves, success or failure.
  const savedUsername = localStorage.getItem(SRP_USER_KEY) || '';
  return `<div id="tk-srp-connect" class="tk-srp-connect hidden">
    <form id="tk-srp-login" class="tk-srp-login">
      <input id="tk-srp-username" type="text" autocomplete="username" placeholder="SRP username" value="${D.esc(savedUsername)}" />
      <input id="tk-srp-password" type="password" autocomplete="current-password" placeholder="password" />
      <button type="submit" class="btn-accent" id="tk-srp-login-go">Log in</button>
    </form>
    <div id="tk-srp-login-err" class="tk-empty tk-err hidden"></div>
    <p class="tk-dim">or, without typing a password here: open <a href="${D.esc(srpOrigin)}" target="_blank" rel="noopener">SRP</a>, then drag this to your bookmarks bar — or click Copy and paste it into that tab's address bar.</p>
    <a href="${D.esc(lastBookmarklet)}" class="tk-bookmarklet" title="Drag me to your bookmarks bar">Connect forest to SRP</a>
    <button type="button" class="btn-ghost" id="tk-srp-connect-copy">Copy</button>
  </div>`;
}

function wireConnect() {
  const toggle = $('#tk-srp-connect-toggle');
  if (toggle) toggle.onclick = () => { const p = $('#tk-srp-connect'); if (p) p.classList.toggle('hidden'); };
  const copy = $('#tk-srp-connect-copy');
  if (!copy) return;
  copy.onclick = async () => {
    if (!lastBookmarklet) return;
    await navigator.clipboard.writeText(lastBookmarklet).catch(() => {});
    D.toast('Bookmarklet copied — paste it into the SRP tab\'s address bar and press Enter');
  };
}

function wireLogin() {
  const form = $('#tk-srp-login');
  if (!form) return;
  const errBox = $('#tk-srp-login-err');
  const showError = (msg) => { errBox.textContent = msg; errBox.classList.remove('hidden'); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const userEl = $('#tk-srp-username');
    const passEl = $('#tk-srp-password');
    const username = userEl.value.trim();
    const password = passEl.value;
    if (!username || !password) { showError('enter both a username and a password'); return; }
    // Captured before the await, like the reserve flow's own token: by the
    // time the request resolves the modal may have closed and reopened on a
    // different repo, and the box-list reload below must not repaint
    // whatever happens to be in the DOM at that moment.
    const token = openToken;
    const go = $('#tk-srp-login-go');
    go.disabled = true;
    const r = await D.api('/api/srp/login', { username, password });
    go.disabled = false;
    // Cleared unconditionally — success or failure — the moment the submit
    // resolves. The spec only requires this on success; a password that has
    // already been sent and answered has nothing left to do sitting in the
    // DOM after a failure either, and the user can always retype it, exactly
    // as any other login form asks after a rejected attempt.
    passEl.value = '';
    if (r && r.error) { showError(r.error); return; }
    errBox.classList.add('hidden');
    localStorage.setItem(SRP_USER_KEY, username);
    D.toast(`Connected to SRP as ${(r && r.username) || username}`);
    if (openToken === token) await loadBoxes();
  };
}

// ---- footer + launch ----

const countUnits = (sel) => sel.reduce((n, s) => n + s.skills.length + s.kits.length + (s.hooks ? 1 : 0), 0);

// The Tickets modal is a MUST for these two: hektor-from-jira is what
// actually runs a single ticket (and what hektor-multi-ticket dispatches per
// worktree anyway, so it is needed even when several tickets are ticked),
// and hektor-multi-ticket is the fan-out driver for two or more. Provisioned
// regardless of how many tickets are ticked — the count changes which skill
// takes over INSIDE the session, not what the session needs available. With
// the prompt now just ticket links + a box (composeTicketPrompt in
// prompt.js), there is no text naming a skill any more — this provisioning
// is what makes the session Hektor-capable at all.
const REQUIRED_HEKTOR_SKILLS = ['hektor-multi-ticket', 'hektor-from-jira'];

// The installed pack (from state.packs) whose skillsets menu offers a given
// skill id, or null if none does.
function packOffering(packs, skillId) {
  return (packs || []).find((p) => Array.isArray(p.skillsets) && p.skillsets.some((s) => s.id === skillId)) || null;
}

// Merges REQUIRED_HEKTOR_SKILLS, and the gates of whichever pack offers each,
// into `saved` (the checkout's saved picker selection) — merge, never
// replace: every skill/kit/gate the user already had selected, for that pack
// or any other, stays exactly as saved. This is the one function both
// renderSkills() (so the footer states the truth before the user clicks
// Start) and start()/resolveBlock() (so the actual launch matches what the
// footer promised) call, so the two can never say different things.
//
// -> { selections, addedSkills: [{pack, skill}], addedGates: [pack, …],
//      missing: [skillId, …] }. `missing` means no installed pack offers
//      that skill at all — the session cannot get it, and the caller must
//      say so plainly rather than launch one silently missing it.
function mergeRequiredSkills(saved, packs) {
  const byPack = new Map(saved.map((s) => [s.pack, { pack: s.pack, skills: new Set(s.skills), kits: [...s.kits], hooks: !!s.hooks }]));
  const addedSkills = [];
  const addedGates = [];
  const missing = [];
  for (const skillId of REQUIRED_HEKTOR_SKILLS) {
    const pack = packOffering(packs, skillId);
    if (!pack) { missing.push(skillId); continue; }
    let entry = byPack.get(pack.pack);
    if (!entry) { entry = { pack: pack.pack, skills: new Set(), kits: [], hooks: false }; byPack.set(pack.pack, entry); }
    if (!entry.skills.has(skillId)) { entry.skills.add(skillId); addedSkills.push({ pack: pack.pack, skill: skillId }); }
    if (!entry.hooks) { entry.hooks = true; addedGates.push(pack.pack); }
  }
  const selections = [...byPack.values()].map((e) => ({ pack: e.pack, skills: [...e.skills], kits: e.kits, hooks: e.hooks }));
  return { selections, addedSkills, addedGates: [...new Set(addedGates)], missing };
}

// What start() will provision, named before it happens. It provisions
// whatever `forest-skills:<primaryPath>` holds PLUS the required Hektor
// skills merged in by mergeRequiredSkills() above — a primary checkout that
// has never been through the picker no longer launches with NO Hektor
// skills; it launches with at least these two (when a pack offers them).
function renderSkills() {
  const el = $('#tk-skills');
  const merge = target
    ? mergeRequiredSkills(savedSelections(target.primaryPath), D.state.packs)
    : { addedSkills: [], addedGates: [], missing: [] };
  const base = skillUnits ? `skills: last selection (${skillUnits})` : 'skills: none saved for this checkout';
  const bits = [base];
  if (merge.addedSkills.length || merge.addedGates.length) {
    const names = merge.addedSkills.map((a) => a.skill);
    const gate = merge.addedGates.length ? [`gates`] : [];
    bits.push(`+ ${[...names, ...gate].join(', ')} (added for this launch)`);
  }
  if (merge.missing.length) {
    bits.push(`— no installed pack offers ${merge.missing.join(' or ')}; this session will start without ${merge.missing.length > 1 ? 'them' : 'it'}`);
  }
  el.textContent = bits.join(' ');
  el.classList.toggle('tk-warn', !skillUnits || merge.missing.length > 0);
}

// Terminal (today's behaviour, unchanged) vs Cursor (creates N worktrees +
// branches, then one Cursor window on all of them — see startCursor()).
// `persist: false` is the restore-on-open path: reading what was last
// chosen for this repo must not immediately re-write the same value back.
function setLaunchTarget(value, { persist = true } = {}) {
  launchTarget = value === 'cursor' ? 'cursor' : 'terminal';
  document.querySelectorAll('.tk-target-btn').forEach((b) => b.classList.toggle('on', b.dataset.target === launchTarget));
  // The agent sub-toggle only means something for Terminal — the Cursor-app
  // target opens the GUI, which runs neither CLI.
  $('#tk-agent').classList.toggle('hidden', launchTarget === 'cursor');
  if (persist && target) localStorage.setItem(launchTargetKey(target.repoPath), launchTarget);
  renderFooter();
}

// Same contract as setLaunchTarget: `persist: false` is the restore-on-open
// path and must not re-write the value it just read.
function setAgent(value, { persist = true } = {}) {
  agent = value === 'claude' ? 'claude' : 'cursor';
  document.querySelectorAll('.tk-agent-btn').forEach((b) => b.classList.toggle('on', b.dataset.agent === agent));
  if (persist && target) saveAgent(localStorage, target.primaryPath, agent);
  renderFooter();
}

function renderFooter() {
  const tickets = [...pickedTickets];
  const boxes = [...pickedBoxes];
  renderSkills();
  // Composed only while the textarea is still forest's to write. Once the user
  // has corrected it — the box label boxLabel() deliberately passes through
  // uncorrected is exactly what they would be correcting — the next checkbox
  // click must not silently throw that away. start() launches the textarea
  // either way.
  if (!promptDirty) {
    $('#tk-prompt').value = composeTicketPrompt({ tickets, boxes, jiraBaseUrl: D.state.config && D.state.config.jiraBaseUrl });
  }
  const ready = tickets.length > 0 && boxes.length > 0;
  $('#tk-start').disabled = !ready;
  // The label itself has to make the difference obvious before the click —
  // the Cursor-app path creates git worktrees and branches, the Terminal
  // path does not touch git at all and names the agent it will run.
  $('#tk-start').textContent = ticketStartLabel({ launchTarget, agent, ticketCount: tickets.length });
  $('#tk-count').textContent = !tickets.length ? 'pick at least one ticket'
    : !boxes.length ? 'pick at least one testbox'
      : launchTarget === 'cursor'
        ? `${tickets.length} ticket(s) · ${boxes.length} box(es) · creates ${tickets.length} git worktree(s) + branch(es) in ${target ? target.repo : 'this repo'}`
        : `${tickets.length} ticket(s) · ${boxes.length} box(es) · ${agentLabel(agent)}`;
}

function savedSelections(path) {
  let sel = {};
  try { sel = JSON.parse(localStorage.getItem(`forest-skills:${path}`)) || {}; } catch { sel = {}; }
  return Object.entries(sel).map(([pack, v]) => ({ pack, skills: v.skills || [], kits: v.kits || [], hooks: !!v.hooks }));
}

async function start() {
  const prompt = $('#tk-prompt').value.trim();
  if (!prompt) return;
  if (launchTarget === 'cursor') { await startCursor(prompt); return; }
  await startTerminal(prompt);
}

// One session — Claude or Cursor CLI, per the agent sub-toggle — launched in
// a Terminal window in the primary checkout.
async function startTerminal(prompt) {
  const btn = $('#tk-start');
  btn.disabled = true;
  // The MUST from item 4: never the raw saved selection alone — always
  // merged with the required Hektor skills, exactly what renderSkills()
  // already told the user would happen.
  const { selections } = mergeRequiredSkills(savedSelections(target.primaryPath), D.state.packs);
  const r = await D.api('/api/launch', {
    path: target.primaryPath,
    selections,
    prompt,
    mode: D.state.mode,
    agent,
  });
  btn.disabled = false;
  if (r && r.error) { D.toast(`Error: ${r.error}`); return; }
  // A launch that was blocked by a gate keeps the modal open: the ticket list
  // is expensive to reassemble and the user has to answer for the block first.
  if (r && r.blocked) { await resolveBlock(r, prompt); return; }
  await reportLaunch(r, prompt);
}

// One worktree + branch per ticket (server-side, /api/tickets/worktrees),
// then one Cursor window on all of them. No block-and-retry dance here —
// unlike /api/launch, this route is partial-failure tolerant per ticket by
// itself, so there is nothing for this modal to resolve after the fact.
async function startCursor(prompt) {
  const btn = $('#tk-start');
  btn.disabled = true;
  const { selections } = mergeRequiredSkills(savedSelections(target.primaryPath), D.state.packs);
  const tickets = [...pickedTickets];
  const boxes = [...pickedBoxes];
  // `boxes` and `prompt` ride along so the server can write each ticket's
  // own brief (docs/hektor/tickets/<KEY>.md) quoting the exact same box
  // list and session line the clipboard gets — nothing here is recomputed
  // server-side from scratch.
  const r = await D.api('/api/tickets/worktrees', { repoPath: target.repoPath, tickets, selections, boxes, prompt });
  btn.disabled = false;
  if (r && r.error) { D.toast(`Error: ${r.error}`); return; }
  const results = (r && r.results) || [];
  // Never claim a paste happened — only that the clipboard write itself
  // succeeded or didn't. Nothing outside Cursor can inject text into its
  // chat; the user pastes by hand with ⌘L ⌘V.
  let clipboardOk = true;
  try { await navigator.clipboard.writeText(prompt); } catch { clipboardOk = false; }
  close();
  D.toast(composeCursorToast(results, clipboardOk));
}

// One line, honest about all four possible outcomes per ticket: created,
// already existed, failed to create at all, or created but the Cursor
// adapter (.cursor/rules + hooks.json) failed to wire. Counts only — the
// per-ticket detail (which ticket, which error) is in the journal already,
// the same split every other bulk route in this app uses.
function composeCursorToast(results, clipboardOk) {
  const created = results.filter((x) => x.path && !x.existed).length;
  const existed = results.filter((x) => x.path && x.existed).length;
  const failed = results.filter((x) => x.error).length;
  const adapterFailed = results.filter((x) => x.path && x.cursorAdapterError).length;
  const bits = [];
  if (created) bits.push(`${created} worktree(s) created`);
  if (existed) bits.push(`${existed} already existed`);
  if (failed) bits.push(`${failed} failed — see journal`);
  if (adapterFailed) bits.push(`${adapterFailed} Cursor adapter not wired — see journal`);
  bits.push(clipboardOk
    ? 'prompt copied — paste into Cursor with ⌘L ⌘V'
    : 'could not copy the prompt — copy it from the text box before switching to Cursor');
  return bits.join(' · ');
}

// Both blocks the launch route can return, each offered the remedy that
// actually clears it — mirroring the picker's confirm-and-force rather than
// sending the user somewhere.
//
// The advice this replaced ("start this repo from its row to resolve it") made
// things worse: starting a session in the primary checkout means the next
// ticket Start finds it alive and returns promptSent:false, leaving the list
// to be pasted by hand. Pointing at ↻ instead would be wrong for the block
// that is actually reachable from here — /api/launch marks orphaned-units
// `repairable: false` and says why: repair replays the RECORD and never
// touches the incoming selection, which is the half that makes these units
// orphans. Neither ↻ nor a fresh session clears it, so the remedy has to be
// the forced relaunch, exactly as the picker offers it.
//
// One dialog per block, never a cascade: the picker's own comment records that
// chaining confirms buried the launch under popups. Cancel does nothing at
// all — dismissing a dialog must never be what starts an ungated agent.
async function resolveBlock(r, prompt) {
  if (r.blocked === 'missing-hooks') {
    const names = (r.missing || [])
      .map((h) => (h.command.match(/([^/"']+\.sh)/) || [, h.command])[1])
      .filter((v, i, a) => a.indexOf(v) === i);
    if (!confirm(
      `Launch ${agentLabel(agent)} in ${target.repo} with ${(r.missing || []).length} hook script(s) missing?\n\n`
      + `${names.map((n) => `    ${n}`).join('\n')}\n\n`
      + 'These gates will not run in this session.\n\n'
      + 'OK — launch anyway, with the ticket list.\n'
      + 'Cancel — do not launch. (To fix the gates first, use ↻ on this repo\'s row, then Start again.)',
    )) return;
    // selections: [] on purpose — the gate check runs AFTER provisioning, so
    // provisioning already ran on the call that was blocked and re-sending
    // them would provision twice. Same reasoning as the picker's retry.
    await forceLaunch([], prompt);
    return;
  }
  if (r.blocked === 'orphaned-units') {
    const list = (r.orphaned || []).map((o) => `  • ${o.kind} ${o.id} (since ${String(o.since || '').slice(0, 10)})`).join('\n');
    if (!confirm(
      `${(r.orphaned || []).length} unit(s) are recorded as provisioned in ${target.repo} but are not in the selection this launch carries:\n\n`
      + `${list}\n\n`
      + 'If their files are still on disk, they are running at the version they had when they were last provisioned. '
      + 'Launching from here does not change that either way.\n\n'
      + 'OK — launch anyway with the ticket list, leaving them running unmanaged. Nothing on disk changes.\n'
      + 'Cancel — do not launch. To re-select or remove them, use Launch on this repo\'s primary row and answer the '
      + 'picker\'s dialog; ↻ repair cannot clear this — it replays the provision record and never touches the '
      + 'selection the record is compared against.',
    )) return;
    // selections (not []): the orphan guard runs BEFORE provisioning, so
    // nothing has been provisioned yet and the real selections still have to
    // travel — again exactly what the picker does. Merged the same way
    // start() does, so a forced relaunch still carries the required skills.
    await forceLaunch(mergeRequiredSkills(savedSelections(target.primaryPath), D.state.packs).selections, prompt);
    return;
  }
  // An unknown block kind: say what came back rather than inventing a remedy.
  D.toast(`Launch blocked: ${r.blocked} — nothing was started`);
}

async function forceLaunch(selections, prompt) {
  const btn = $('#tk-start');
  btn.disabled = true;
  const forced = await D.api('/api/launch', {
    path: target.primaryPath, selections, prompt, mode: D.state.mode, agent, force: true,
  });
  btn.disabled = false;
  if (!forced || !forced.ok) { D.toast(`Launch failed: ${(forced && forced.error) || 'server unreachable'}`); return; }
  await reportLaunch(forced, prompt);
}

// The one exit both the first attempt and a forced relaunch take. The launch
// response also carries what gates are missing and what provisioning refused
// to overwrite; this modal used to drop both on the floor, so the reporting
// goes through app.js's reportLaunched/reportConflicts — handed in at
// initTickets, never imported back out — which is where that wording lives.
async function reportLaunch(r, prompt) {
  close();
  if (r && r.promptSent === false && r.action === 'focused') {
    await navigator.clipboard.writeText(prompt).catch(() => {});
    D.toast(`Session already running in ${target.repo} — ticket list NOT sent, copied to the clipboard instead`);
    // After the clipboard sentence, not before: reportConflicts is a no-op
    // unless provisioning actually kept a file at its existing content, and
    // when it did, that is the newer news — the same order app.js uses.
    D.reportConflicts(r.provisioned);
    return;
  }
  // "edited prompt" rather than a ticket count once the textarea has been
  // corrected by hand: the count is the picker's, and after an edit it is no
  // longer necessarily what was sent.
  D.reportLaunched(r, promptDirty ? 'edited prompt · ' : `${pickedTickets.size} ticket(s) · `);
}
