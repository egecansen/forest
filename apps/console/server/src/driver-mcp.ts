import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Run } from './run-store.js';
import type { Cluster } from './types.js';

const clusterShape = {
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  title: z.string().max(200),
  bucket: z.enum(['easy-fix', 'selector', 'vrt', 'app-change', 'infra', 'likely-bug']),
  tests: z.array(z.string().max(300)).max(60),
};

/** In-process MCP server the agent uses to feed the GUI's clusters board.
 *  Advisory-only surface: nothing here mutates anything but the Run snapshot. */
export function hektorMcpServer(run: Run) {
  return createSdkMcpServer({
    name: 'hektor-console',
    version: '1.0.0',
    tools: [
      tool('set_clusters', 'Publish the full clusters table to the console (call once, before asking the pick).',
        { clusters: z.array(z.object(clusterShape)).max(40) },
        async ({ clusters }) => {
          run.setClusters(clusters.map((c): Cluster => ({ ...c, state: 'proposed' })));
          return { content: [{ type: 'text', text: `ok — ${clusters.length} clusters shown` }] };
        }),
      tool('cluster_status', 'Update one cluster\'s live state on the console board.',
        { id: z.string(), state: z.enum(['picked', 'skipped', 'fixing', 'verifying', 'green', 'app-bug', 'error']),
          passes: z.number().int().min(0).optional(), runs: z.number().int().min(1).optional(),
          note: z.string().max(200).optional() },
        async ({ id, state, passes, runs, note }) => {
          run.updateCluster(id, { state, passes, runs, note });
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
    ],
  });
}
