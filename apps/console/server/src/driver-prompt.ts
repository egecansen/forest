import type { RunConfig } from './types.js';

/** The whole harness integration: the agent runs the kit's own SKILL loop; the
 *  console only redirects its user interaction + status reporting. */
export function buildPrompt(config: RunConfig, opts: { resume: boolean; mcpAvailable?: boolean }): string {
  const mcpAvailable = opts.mcpAvailable !== false; // default true
  const policy = config.permissionPolicy === 'autonomous'
    ? 'Applies that match a known recipe in core/config.json may proceed without asking; ask before other applies only if genuinely uncertain (SKILL batching discipline still applies).'
    : 'Before the FIRST apply of each picked batch, ask one AskUserQuestion summarizing the planned diffs (one option per cluster: proceed / skip).';
  return [
    opts.resume ? 'Resume the in-progress flaky triage below from its last state (re-read ledger.json). If verification runs were left in flight, collect their results first (check the gradle output / ledger), then continue.' : '',
    `Use the hektor-flaky-triage skill to triage this flaky run end-to-end.`,
    `s-report URL: ${config.targetUrl}`,
    `testbox: ${config.testbox}`,
    '',
    'You are running under Hektor Console (a GUI) — there is no terminal user. Rules:',
    '- ALL user interaction goes through the AskUserQuestion tool (the console renders it). Never wait for free-text input.',
    '- The user may answer any question with free text instead of (or in addition to) the offered options — treat such text as the authoritative answer.',
    mcpAvailable ? '- As soon as core/cluster.sh gives you the mechanical first cut, call mcp__hektor-console__set_clusters with those provisional clusters (state defaults to proposed; short provisional titles are fine). After the confirmation rerun, when you have the final meaning-bucket table and BEFORE asking the pick, call set_clusters again with the refined table — it replaces the provisional one; include a short detail per cluster: the failing signature, why it broke, and the intended fix approach.' : '',
    '- Ask the cluster pick as ONE AskUserQuestion (multiSelect: true, one option per cluster; option label = cluster id).',
    mcpAvailable ? '- On every cluster state change (fixing / verifying pass n of N / green / app-bug / error) call mcp__hektor-console__cluster_status.' : '',
    `- Apply policy: ${policy}`,
    '- Final scoreboard: emit it as your final message text (the console shows it as the report).',
    '- NEVER end the session while verification is pending: do not background the green-proof run and stop — wait for it, collect per-test verdicts, and update cluster_status for every picked cluster to green / app-bug / error BEFORE your final message. Your final message must be the converge scoreboard, not a status update.',
  ].filter(Boolean).join('\n');
}
