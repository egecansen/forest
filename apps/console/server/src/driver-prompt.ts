import type { RunConfig } from './types.js';

/** The whole harness integration: the agent runs the kit's own SKILL loop; the
 *  console only redirects its user interaction + status reporting. */
export function buildPrompt(config: RunConfig, opts: { resume: boolean }): string {
  const policy = config.permissionPolicy === 'autonomous'
    ? 'Applies that match a known recipe in core/config.json may proceed without asking; ask before other applies only if genuinely uncertain (SKILL batching discipline still applies).'
    : 'Before the FIRST apply of each picked batch, ask one AskUserQuestion summarizing the planned diffs (one option per cluster: proceed / skip).';
  return [
    opts.resume ? 'Resume the in-progress flaky triage below from its last state (re-read ledger.json).' : '',
    `Use the hektor-flaky-triage skill to triage this flaky run end-to-end.`,
    `s-report URL: ${config.targetUrl}`,
    `testbox: ${config.testbox}`,
    '',
    'You are running under Hektor Console (a GUI) — there is no terminal user. Rules:',
    '- ALL user interaction goes through the AskUserQuestion tool (the console renders it). Never wait for free-text input.',
    '- After you build the meaning-bucket clusters table and BEFORE asking the pick, call mcp__hektor-console__set_clusters with the full table.',
    '- Ask the cluster pick as ONE AskUserQuestion (multiSelect: true, one option per cluster; option label = cluster id).',
    '- On every cluster state change (fixing / verifying pass n of N / green / app-bug / error) call mcp__hektor-console__cluster_status.',
    `- Apply policy: ${policy}`,
    '- Final scoreboard: emit it as your final message text (the console shows it as the report).',
  ].filter(Boolean).join('\n');
}
