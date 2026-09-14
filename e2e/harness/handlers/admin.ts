// Server monitoring, users and roles, the embedded MCP server, and the settings
// that probe the local machine for tools and agents (#396).
import type { Backend, Handler } from '../backend';
import type { UserSeed } from '../seed';
import type { E2EState } from '../state';

/** Built-in roles every database offers, and those only admin adds. */
const DATABASE_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin'];
const ADMIN_ROLES = ['readAnyDatabase', 'readWriteAnyDatabase', 'dbAdminAnyDatabase', 'userAdminAnyDatabase', 'clusterMonitor', 'root'];

export function registerAdminHandlers(backend: Backend, state: E2EState): void {
  const requireConnection = (id: unknown) => {
    if (!state.connections[String(id)]) throw `Connection not found: ${String(id)}`;
  };
  const findUser = (database: unknown, username: unknown) =>
    state.users.find((user) => user.db === database && user.user === username);
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

    // Users and roles
    list_users: ({ id, database }) => {
      requireConnection(id);
      return structuredClone(state.users.filter((user) => database == null || user.db === database));
    },
    list_roles: ({ id, database }) => {
      requireConnection(id);
      const db = String(database);
      return [...DATABASE_ROLES, ...(db === 'admin' ? ADMIN_ROLES : [])].map((role) => ({ role, db, isBuiltin: true }));
    },
    create_user: ({ id, database, username, password, roles }) => {
      requireConnection(id);
      if (!password) throw 'A new user needs a password';
      if (findUser(database, username)) throw `User "${String(username)}@${String(database)}" already exists`;
      state.users.push({
        user: String(username),
        db: String(database),
        roles: structuredClone(roles as UserSeed['roles']),
        mechanisms: ['SCRAM-SHA-256'],
      });
      return null;
    },
    update_user: ({ id, database, username, roles }) => {
      requireConnection(id);
      const user = findUser(database, username);
      if (!user) throw `User "${String(username)}@${String(database)}" not found`;
      user.roles = structuredClone(roles as UserSeed['roles']);
      return null;
    },
    drop_user: ({ id, database, username }) => {
      requireConnection(id);
      const user = findUser(database, username);
      if (!user) throw `User "${String(username)}@${String(database)}" not found`;
      state.users = state.users.filter((candidate) => candidate !== user);
      return null;
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
