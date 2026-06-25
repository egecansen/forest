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
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // surface unexpected I/O errors
    return mergeConfig({});
  }
  return mergeConfig(JSON.parse(text)); // let parse errors surface
}
