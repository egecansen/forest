import { readFile } from 'node:fs/promises';

export const DEFAULTS = {
  port: 5577,
  roots: [`${process.env.HOME}/sahibinden/repo`],
  jiraBaseUrl: '',
  staleDays: 14,
  defaultMode: 'guided',
  terminalApp: 'Terminal',
  openEditorCmd: 'open -a Cursor',
  setupScript: '.forest-setup.sh',
};

export function mergeConfig(user = {}) {
  return { ...DEFAULTS, ...user };
}

export async function loadConfig(path) {
  let parsed = {};
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    parsed = {};
  }
  return mergeConfig(parsed);
}
