import type { Run } from './run-store.js';

/**
 * Minimal stub: no MCP server wired yet. Task 10 replaces this with the
 * real `hektor-console` SDK MCP server exposing `set_clusters` /
 * `cluster_status` tools the prompt (driver-prompt.ts) instructs the agent
 * to call.
 */
export const hektorMcpServer = (_run: Run) => undefined;
