import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENT, coerceAgent, agentLabel, agentKey, loadAgent, saveAgent,
  scopeLine, startLabel, ticketStartLabel, launchToast, repairToast,
} from './agent-choice.js';

// A localStorage stand-in: the same two methods, nothing else.
function memStorage(items = {}) {
  return {
    items,
    getItem(k) { return Object.hasOwn(items, k) ? items[k] : null; },
    setItem(k, v) { items[k] = String(v); },
  };
}
const throwing = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('SecurityError'); },
};

test('coerceAgent: only the exact string "claude" is Claude; the default is cursor', () => {
  assert.equal(DEFAULT_AGENT, 'cursor');
  assert.equal(coerceAgent('claude'), 'claude');
  assert.equal(coerceAgent('cursor'), 'cursor');
  assert.equal(coerceAgent(null), 'cursor');
  assert.equal(coerceAgent('gemini'), 'cursor');
  assert.equal(coerceAgent('Claude'), 'cursor');
});

test('agentLabel: cursor → "Cursor CLI", everything else (including a missing field) → Claude', () => {
  assert.equal(agentLabel('cursor'), 'Cursor CLI');
  assert.equal(agentLabel('claude'), 'Claude');
  assert.equal(agentLabel(undefined), 'Claude');
});

test('loadAgent/saveAgent: one key per worktree path, restore defaults to cursor, storage errors are swallowed', () => {
  const s = memStorage();
  assert.equal(agentKey('/wt/a'), 'forest-agent:/wt/a');
  assert.equal(loadAgent(s, '/wt/a'), 'cursor');
  saveAgent(s, '/wt/a', 'claude');
  assert.equal(s.items['forest-agent:/wt/a'], 'claude');
  assert.equal(loadAgent(s, '/wt/a'), 'claude');
  assert.equal(loadAgent(s, '/wt/b'), 'cursor');
  saveAgent(s, '/wt/b', 'nonsense');
  assert.equal(s.items['forest-agent:/wt/b'], 'cursor');
  assert.equal(loadAgent(throwing, '/wt/a'), 'cursor');
  assert.doesNotThrow(() => saveAgent(throwing, '/wt/a', 'claude'));
});

test('scopeLine: Claude keeps the settings-source wording, missing hooks warn', () => {
  const clean = { active: 5, missing: [], sources: ['a', 'b'], cursor: { active: 0, missing: [], file: null } };
  assert.deepEqual(scopeLine('claude', clean), { text: '5 hooks active · 2 settings source(s)', warn: false });
  const broken = { ...clean, missing: [{ command: 'x' }] };
  assert.deepEqual(scopeLine('claude', broken), { text: '5 hooks active · 1 missing', warn: true });
});

test('scopeLine: Cursor reads the cursor block; no hooks.json words the empty and the ticked selection apart', () => {
  const none = { active: 5, missing: [], sources: ['a'], cursor: { active: 0, missing: [], file: null } };
  assert.deepEqual(scopeLine('cursor', none), { text: 'no .cursor/ yet — tick a pack and Start installs it', warn: false });
  const wired = { ...none, cursor: { active: 18, missing: [], file: '/wt/.cursor/hooks.json' } };
  assert.deepEqual(scopeLine('cursor', wired), { text: '18 Cursor gates active', warn: false });
  const gap = { ...none, cursor: { active: 17, missing: [{ event: 'preToolUse', command: './.cursor/hooks/x.sh', file: '/wt/.cursor/hooks/x.sh' }], file: '/wt/.cursor/hooks.json' } };
  assert.deepEqual(scopeLine('cursor', gap), { text: '17 Cursor gates active · 1 missing', warn: true });
  // A scope response from before the cursor block existed must not throw.
  assert.deepEqual(scopeLine('cursor', { active: 5, missing: [], sources: [] }), { text: 'no .cursor/ yet — tick a pack and Start installs it', warn: false });
  assert.deepEqual(scopeLine('cursor', none, 3), { text: 'no .cursor/ yet — Start installs the selected pack(s)', warn: false });
  assert.deepEqual(scopeLine('claude', { active: 5, missing: [], sources: ['a'] }, 3).text, '5 hooks active · 1 settings source(s)', 'the count only matters on the Cursor axis');
});

test('startLabel and ticketStartLabel name the agent; the Cursor-app target keeps its worktree wording', () => {
  assert.equal(startLabel('cursor', 0), 'Start Cursor CLI');
  assert.equal(startLabel('cursor', 3), 'Provision & start Cursor CLI');
  assert.equal(startLabel('claude', 1), 'Provision & start Claude');
  assert.equal(ticketStartLabel({ launchTarget: 'terminal', agent: 'cursor', ticketCount: 1 }), 'Start ticket session (Cursor CLI)');
  assert.equal(ticketStartLabel({ launchTarget: 'terminal', agent: 'claude', ticketCount: 2 }), 'Start multi-ticket session (Claude)');
  assert.equal(ticketStartLabel({ launchTarget: 'cursor', agent: 'claude', ticketCount: 1 }), 'Create worktree + open Cursor');
  assert.equal(ticketStartLabel({ launchTarget: 'cursor', agent: 'cursor', ticketCount: 3 }), 'Create 3 worktrees + open Cursor');
});

test('launchToast: keyed on r.agent, keeps the provisioning prefix and the lead', () => {
  const base = { ok: true, action: 'launched', agent: 'cursor', provisioned: { skills: [], kits: [], hooks: false, conflicts: [] }, scope: { active: 18, missing: [] } };
  assert.equal(launchToast(base), 'Launching Cursor CLI…');
  assert.equal(launchToast({ ...base, agent: 'claude' }), 'Launching Claude…');
  assert.equal(launchToast(base, '2 ticket(s) · '), '2 ticket(s) · Launching Cursor CLI…');
  const prov = { ...base, provisioned: { skills: ['a', 'b'], kits: ['k'], hooks: true, conflicts: [] } };
  assert.equal(launchToast(prov), '2 skill(s), 1 kit(s), gates · Launching Cursor CLI…');
  assert.equal(launchToast({ ...base, provisioned: null }), 'Launching Cursor CLI…');
});

test('launchToast: focused names the agent that is actually running; missing gates use the agent\'s noun', () => {
  const base = { ok: true, action: 'launched', agent: 'cursor', provisioned: null, scope: { active: 1, missing: [] } };
  assert.equal(launchToast({ ...base, action: 'focused', agent: 'claude' }), 'Claude already running — Terminal brought to front');
  assert.equal(launchToast({ ...base, action: 'focused' }), 'Cursor CLI already running — Terminal brought to front');
  assert.equal(
    launchToast({ ...base, scope: { active: 1, missing: [{ command: 'x' }, { command: 'y' }] } }),
    'Launching Cursor CLI — 2 Cursor gate script(s) missing',
  );
  assert.equal(
    launchToast({ ...base, agent: 'claude', scope: { active: 1, missing: [{ command: 'x' }] } }),
    'Launching Claude — 1 registered hook script(s) missing',
  );
});

test('launchToast: a failed Cursor axis is appended, never silent', () => {
  const r = { ok: true, action: 'launched', agent: 'cursor', provisioned: null, scope: { active: 0, missing: [] }, cursorAdapter: { error: 'hektor: install.sh exited 1' } };
  assert.equal(launchToast(r), 'Launching Cursor CLI… — Cursor gates NOT wired: hektor: install.sh exited 1');
  assert.equal(launchToast({ ...r, cursorAdapter: { error: null } }), 'Launching Cursor CLI…');
});

test('repairToast: the Cursor axis is reported when it ran, in either direction', () => {
  const scope = { active: 5, missing: 1 };
  assert.equal(repairToast({ scope, cursor: null }), 'Refreshed · 5 hooks active, 1 missing — restart any session already running here');
  assert.equal(repairToast({ scope, cursor: { wired: 2 } }), 'Refreshed · 5 hooks active, 1 missing · Cursor gates re-wired (2 pack(s)) — restart any session already running here');
  assert.equal(repairToast({ scope, cursor: { wired: 0, error: 'hektor: install.sh timed out' } }), 'Refreshed · 5 hooks active, 1 missing · Cursor axis NOT re-wired: hektor: install.sh timed out — restart any session already running here');
});
