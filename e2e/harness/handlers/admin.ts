// Server monitoring, users and roles, the embedded MCP server, and the settings
// that probe the local machine for tools and agents (#396).
//
// On the built-in sample server, monitoring and users answer with the canned
// values of src-tauri/src/monitoring.rs and src-tauri/src/db/users.rs, and
// their writes are checked and then dropped.
import type { Backend, Handler } from '../backend';
import { guardWritable, isMock } from '../lookup';
import { SAMPLE_MONITORING, SAMPLE_USERS, type UserSeed } from '../seed';
import type { E2EState } from '../state';

/** Built-in roles every database offers, and those only admin adds. */
const DATABASE_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin'];
const ADMIN_ROLES = ['readAnyDatabase', 'readWriteAnyDatabase', 'dbAdminAnyDatabase', 'userAdminAnyDatabase', 'clusterMonitor', 'root'];

/** The roles the sample server lists for any database (`mock_roles`). */
const MOCK_ROLES = [
  'read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin', 'clusterAdmin',
  'readAnyDatabase', 'readWriteAnyDatabase', 'userAdminAnyDatabase', 'dbAdminAnyDatabase', 'root',
];

const MOCK_SERVER_STATUS = {
  host: 'mqlens-demo:27017',
  version: '7.0.0',
  uptimeSeconds: 86_400,
  connections: { current: 7, available: 838_853, totalCreated: 412 },
  opcounters: { insert: 1200, query: 53_400, update: 980, delete: 120, getmore: 8400, command: 91_000 },
  memory: { residentMb: 412, virtualMb: 2_810 },
  network: { bytesIn: 8_400_000, bytesOut: 19_200_000, numRequests: 64_000 },
  cache: { bytesInCache: 268_435_456, maxBytes: 536_870_912, dirtyBytes: 12_582_912 },
};

const MOCK_NOW_MS = 1_749_427_200_000;
const mockMember = (
  name: string, stateStr: string, self: boolean, uptimeSecs: number, optimeDateMs: number,
  pingMs: number | null, syncSource: string, lagSecs: number | null,
) => ({ name, stateStr, health: 1, self, uptimeSecs, optimeDateMs, pingMs, syncSource, lagSecs });

const MOCK_REPL_SET = {
  isReplicaSet: true,
  clusterType: 'replicaSet',
  set: 'rs0',
  myStateStr: 'PRIMARY',
  mongoVersion: '7.0.0',
  members: [
    mockMember('mqlens-demo:27017', 'PRIMARY', true, 86_400, MOCK_NOW_MS, null, '', null),
    mockMember('mqlens-demo-2:27017', 'SECONDARY', false, 86_300, MOCK_NOW_MS - 800, 1, 'mqlens-demo:27017', 0.8),
    mockMember('mqlens-demo-3:27017', 'SECONDARY', false, 4_200, MOCK_NOW_MS - 42_000, 3, 'mqlens-demo:27017', 42),
  ],
};

const MOCK_CURRENT_OPS = [
  {
    opid: 10241,
    op: 'query',
    ns: 'sales_db.orders',
    secsRunning: 3,
    client: '127.0.0.1:51544',
    desc: 'conn412',
    command: '{ find: "orders", filter: { status: "open" } }',
  },
];

const MOCK_PROFILE = [
  {
    op: 'query',
    ns: 'sales_db.orders',
    millis: 142,
    tsMs: MOCK_NOW_MS,
    planSummary: 'COLLSCAN',
    command: '{ find: "orders", filter: { region: "EU" } }',
  },
];

export function registerAdminHandlers(backend: Backend, state: E2EState): void {
  const requireConnection = (id: unknown) => {
    if (!state.connections[String(id)]) throw `Connection not found: ${String(id)}`;
  };
  /** The users on the server a connection reaches; each server keeps its own. */
  const usersOf = (id: unknown) => (state.users[state.connections[String(id)].uri] ??= []);
  const findUser = (id: unknown, database: unknown, username: unknown) =>
    usersOf(id).find((user) => user.db === database && user.user === username);
  const checkRoles = (roles: unknown) => {
    if ((roles as UserSeed['roles'] | null | undefined)?.some((role) => !role.role || !role.db)) {
      throw 'Every role needs both a role name and a database';
    }
  };
  /** The monitoring state of the server a connection reaches; each server keeps its own. */
  const monitoringOf = (id: unknown) => (state.monitoring[state.connections[String(id)].uri] ??= structuredClone(SAMPLE_MONITORING));
  let tokenSerial = 1;

  const handlers: Record<string, Handler> = {
    // Monitoring
    server_status: ({ id }) => {
      requireConnection(id);
      return structuredClone(isMock(state, id) ? MOCK_SERVER_STATUS : monitoringOf(id).serverStatus);
    },
    current_ops: ({ id }) => {
      requireConnection(id);
      return structuredClone(isMock(state, id) ? MOCK_CURRENT_OPS : monitoringOf(id).currentOps);
    },
    kill_op: ({ id, opid }) => {
      guardWritable(state, id);
      if (isMock(state, id)) return null;
      const monitoring = monitoringOf(id);
      monitoring.currentOps = monitoring.currentOps.filter((op) => op.opid !== opid);
      return null;
    },
    get_profiling_status: ({ id, database }) => {
      requireConnection(id);
      if (isMock(state, id)) return { level: 0, slowMs: 100 };
      return structuredClone(monitoringOf(id).profiling[String(database)] ?? { level: 0, slowMs: 100 });
    },
    set_profiling_level: ({ id, database, level, slowMs }) => {
      guardWritable(state, id);
      const next = { level: Number(level), slowMs: Number(slowMs) };
      if (!isMock(state, id)) monitoringOf(id).profiling[String(database)] = next;
      return structuredClone(next);
    },
    read_profile: ({ id, database, limit }) => {
      requireConnection(id);
      if (isMock(state, id)) return structuredClone(MOCK_PROFILE);
      return structuredClone(
        monitoringOf(id).profile.filter((entry) => entry.ns.split('.')[0] === database).slice(0, Number(limit ?? 50)),
      );
    },
    repl_set_status: ({ id }) => {
      requireConnection(id);
      return structuredClone(isMock(state, id) ? MOCK_REPL_SET : monitoringOf(id).replSet);
    },

    // Users and roles
    list_users: ({ id, database }) => {
      requireConnection(id);
      const users = isMock(state, id) ? SAMPLE_USERS : usersOf(id);
      return structuredClone(users.filter((user) => database == null || user.db === database));
    },
    list_roles: ({ id, database }) => {
      requireConnection(id);
      const db = String(database);
      const roles = isMock(state, id) ? MOCK_ROLES : [...DATABASE_ROLES, ...(db === 'admin' ? ADMIN_ROLES : [])];
      return roles.map((role) => ({ role, db, isBuiltin: true }));
    },
    create_user: ({ id, database, username, password, roles }) => {
      guardWritable(state, id);
      if (!username) throw 'Username is required';
      if (!password) throw 'Password is required';
      checkRoles(roles);
      if (isMock(state, id)) return null;
      if (findUser(id, database, username)) throw `User "${String(username)}@${String(database)}" already exists`;
      usersOf(id).push({
        user: String(username),
        db: String(database),
        roles: structuredClone(roles as UserSeed['roles']),
        mechanisms: ['SCRAM-SHA-256'],
      });
      return null;
    },
    update_user: ({ id, database, username, password, roles }) => {
      guardWritable(state, id);
      if (!password && roles == null) throw 'Nothing to update: provide a new password and/or roles';
      checkRoles(roles);
      if (isMock(state, id)) return null;
      const user = findUser(id, database, username);
      if (!user) throw `User "${String(username)}@${String(database)}" not found`;
      if (roles != null) user.roles = structuredClone(roles as UserSeed['roles']);
      return null;
    },
    drop_user: ({ id, database, username }) => {
      guardWritable(state, id);
      if (isMock(state, id)) return null;
      const user = findUser(id, database, username);
      if (!user) throw `User "${String(username)}@${String(database)}" not found`;
      const uri = state.connections[String(id)].uri;
      state.users[uri] = usersOf(id).filter((candidate) => candidate !== user);
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
    // The user's answer to an agent's write request. The backend hands it to the waiting tool call and returns nothing.
    mcp_resolve_write: () => null,

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
