// public/agent-choice.js — the pure half of the Claude / Cursor CLI choice:
// the stored preference, and every string the picker, the Tickets modal and
// the toasts derive from an agent. No DOM here, so agent-choice.test.mjs
// runs it under node the way prompt.test.mjs runs prompt.js.
//
// Two different defaults, on purpose:
//   coerceAgent  names a PREFERENCE — nothing saved yet means Cursor CLI,
//                the harness the team moved to.
//   agentLabel   names what a server RESPONSE said — a response with no
//                `agent` field predates this feature and was a Claude launch.

export const DEFAULT_AGENT = 'cursor';

export function coerceAgent(value) { return value === 'claude' ? 'claude' : 'cursor'; }
export function agentLabel(agent) { return agent === 'cursor' ? 'Cursor CLI' : 'Claude'; }
export const agentKey = (path) => `forest-agent:${path}`;

// `storage` is passed in (localStorage in the browser) rather than read from
// a global, so the tests hand in a plain object and a throwing one.
export function loadAgent(storage, path) {
  try { return coerceAgent(storage.getItem(agentKey(path))); } catch { return DEFAULT_AGENT; }
}
export function saveAgent(storage, path, agent) {
  try { storage.setItem(agentKey(path), coerceAgent(agent)); } catch { /* storage unavailable: the choice just does not persist */ }
}

// The picker's scope line, keyed on the agent that will run: the Claude
// numbers come from settings.json, the Cursor numbers from .cursor/hooks.json.
// `scope` is the /api/worktree/scope response; its `cursor` block may be
// absent on a server that predates it. `selectedCount` is how many units are
// ticked: Start only installs .cursor/ when something is — the line must not
// promise an install that an empty selection will not perform.
export function scopeLine(agent, scope, selectedCount = 0) {
  if (agent === 'cursor') {
    const c = scope.cursor || { active: 0, missing: [], file: null };
    if (!c.file) {
      return {
        text: selectedCount ? 'no .cursor/ yet — Start installs the selected pack(s)' : 'no .cursor/ yet — tick a pack and Start installs it',
        warn: false,
      };
    }
    const missing = (c.missing || []).length;
    return { text: `${c.active} Cursor gates active${missing ? ` · ${missing} missing` : ''}`, warn: missing > 0 };
  }
  const missing = (scope.missing || []).length;
  return {
    text: missing
      ? `${scope.active} hooks active · ${missing} missing`
      : `${scope.active} hooks active · ${(scope.sources || []).length} settings source(s)`,
    warn: missing > 0,
  };
}

export function startLabel(agent, selectedCount) {
  return selectedCount ? `Provision & start ${agentLabel(agent)}` : `Start ${agentLabel(agent)}`;
}

// The Tickets modal's Start button. The Cursor-app target creates git
// worktrees and branches, so its label keeps saying so; the Terminal target
// names the agent it will run in the primary checkout.
export function ticketStartLabel({ launchTarget, agent, ticketCount }) {
  if (launchTarget === 'cursor') {
    return ticketCount > 1 ? `Create ${ticketCount} worktrees + open Cursor` : 'Create worktree + open Cursor';
  }
  const who = agentLabel(agent);
  return ticketCount > 1 ? `Start multi-ticket session (${who})` : `Start ticket session (${who})`;
}

// Everything a launch response carries that is worth saying: what was
// provisioned, what gates are still missing, and — Cursor only — whether the
// pack's install.sh failed to land the gates. `lead` is an optional prefix
// for callers with more context than the picker (the Tickets modal names how
// many tickets went into the prompt).
export function launchToast(r, lead = '') {
  const name = agentLabel(r.agent);
  if (r.action === 'focused') return `${name} already running — Terminal brought to front`;
  const prov = r.provisioned;
  const provMsg = prov && (prov.skills.length || prov.kits.length || prov.hooks)
    ? `${prov.skills.length} skill(s)${prov.kits.length ? `, ${prov.kits.length} kit(s)` : ''}${prov.hooks ? ', gates' : ''} · ` : '';
  const adapter = r.cursorAdapter && r.cursorAdapter.error ? ` — Cursor gates NOT wired: ${r.cursorAdapter.error}` : '';
  const miss = r.scope && r.scope.missing ? r.scope.missing.length : 0;
  if (!miss) return `${lead}${provMsg}Launching ${name}…${adapter}`;
  const noun = r.agent === 'cursor' ? 'Cursor gate script(s)' : 'registered hook script(s)';
  return `${lead}${provMsg}Launching ${name} — ${miss} ${noun} missing${adapter}`;
}

// The ↻ toast. The restart reminder is part of the result, not decoration:
// hook config is snapshotted at session start, so a session already running
// here keeps exec'ing whatever it loaded.
export function repairToast(r) {
  const cur = !r.cursor ? ''
    : r.cursor.error ? ` · Cursor axis NOT re-wired: ${r.cursor.error}`
      : ` · Cursor gates re-wired (${r.cursor.wired} pack(s))`;
  return `Refreshed · ${r.scope.active} hooks active, ${r.scope.missing} missing${cur} — restart any session already running here`;
}
