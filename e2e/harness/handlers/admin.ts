// Server monitoring, the embedded MCP server, and the settings that probe the
// local machine for tools and agents (#396).
import type { Backend, Handler } from '../backend';
import type { E2EState } from '../state';

export function registerAdminHandlers(backend: Backend, state: E2EState): void {
  const requireConnection = (id: unknown) => {
    if (!state.connections[String(id)]) throw `Connection not found: ${String(id)}`;
  };
  const monitoring = state.monitoring;
  let tokenSerial = 1;

  const handlers: Record<string, Handler> = {
    // Monitoring
    server_status: ({ id }) => {
      requireConnection(id);
      return structuredClone(monitoring.serverStatus);
    },
    current_ops: ({ id }) => {
      requireConnection(id);
      return structuredClone(monitoring.currentOps);
    },
    kill_op: ({ id, opid }) => {
      requireConnection(id);
      monitoring.currentOps = monitoring.currentOps.filter((op) => op.opid !== opid);
      return null;
    },
    get_profiling_status: ({ id, database }) => {
      requireConnection(id);
      return structuredClone(monitoring.profiling[String(database)] ?? { level: 0, slowMs: 100 });
    },
    set_profiling_level: ({ id, database, level, slowMs }) => {
      requireConnection(id);
      const next = { level: Number(level), slowMs: Number(slowMs) };
      monitoring.profiling[String(database)] = next;
      return structuredClone(next);
    },
    read_profile: ({ id, database, limit }) => {
      requireConnection(id);
      return structuredClone(
        monitoring.profile.filter((entry) => entry.ns.split('.')[0] === database).slice(0, Number(limit ?? 50)),
      );
    },
    repl_set_status: ({ id }) => {
      requireConnection(id);
      return structuredClone(monitoring.replSet);
    },

    // Embedded MCP server
    mcp_get_status: () => structuredClone(state.mcp),
    mcp_set_enabled: ({ enabled, port }) => {
      state.mcp.enabled = Boolean(enabled);
      if (typeof port === 'number') state.mcp.port = port;
      return structuredClone(state.mcp);
    },
    mcp_regenerate_token: () => {
      tokenSerial += 1;
      state.mcp.token = `e2e-token-${tokenSerial}`;
      return structuredClone(state.mcp);
    },
    mcp_agent_instructions: () => 'Call list_connections first, then query only the connections it returns.',

    // Local tools and agents
    detect_local_agents: () => [
      { id: 'claude-code', binary: 'claude', available: true, version: '2.1.0' },
      { id: 'codex', binary: 'codex', available: false, version: '' },
      { id: 'cursor', binary: 'cursor-agent', available: false, version: '' },
      { id: 'antigravity', binary: 'antigravity', available: false, version: '' },
    ],
    managed_tools_status: () => [
      { name: 'mongosh', version: '2.3.2', installed: true, path: '/tmp/MQLens/tools/mongosh/bin/mongosh' },
      { name: 'mongodb-database-tools', version: '100.10.0', installed: false, path: null },
    ],
    test_mongosh_path: ({ path }) => {
      if (!String(path).includes('mongosh')) throw 'Failed to run mongosh: program not found';
      return '2.3.2';
    },
  };

  backend.register(handlers);
}
