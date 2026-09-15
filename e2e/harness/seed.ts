// What a test hands the fake backend before the app loads (#396).
//
// Serializable on purpose: fixtures pass it to the page through
// `page.addInitScript`, and the harness builds its mutable state from it.

export type VaultState = 'unlocked' | 'locked' | 'uninitialized';

/** A document in relaxed Extended JSON, as the app receives it from the backend. */
export type Doc = Record<string, unknown>;

export interface IndexSeed {
  name: string;
  keys: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
}

export interface CollectionSeed {
  type?: 'collection' | 'view' | 'timeseries';
  docs?: Doc[];
  indexes?: IndexSeed[];
}

export interface ServerSeed {
  version?: string;
  databases: Record<string, Record<string, CollectionSeed>>;
}

export interface ProfileSeed {
  id: string;
  name: string;
  uri: string;
  color_tag?: string | null;
  mcp_enabled?: boolean;
  connection_mode?: string;
}

/** What the monitoring commands report; any part left out comes from SAMPLE_MONITORING. */
export interface MonitoringSeed {
  serverStatus?: Record<string, unknown>;
  currentOps?: Array<Record<string, unknown> & { opid: number }>;
  /** `system.profile` entries across databases; `read_profile` returns a database's own. */
  profile?: Array<Record<string, unknown> & { ns: string }>;
  /** Profiling level and slow threshold by database; a database not listed is off. */
  profiling?: Record<string, { level: number; slowMs: number }>;
  replSet?: Record<string, unknown>;
}

export interface McpSeed {
  enabled?: boolean;
  port?: number;
  token?: string;
  log?: unknown[];
}

export interface MongoshSeed {
  /** Whether mongosh starts whatever path the app passes. Default true. */
  available?: boolean;
  /** Paths where mongosh starts even when it isn't otherwise available. */
  binaries?: string[];
  /** What `detect_mongosh_binary` finds; null when it finds nothing. */
  detection?: { path: string; version: string; source: string } | null;
}

/** One answer from generate_mql_query: the query it returns, or the error it fails with. */
export type AiReplySeed = { query: Record<string, unknown>; thoughts?: string; notes?: string } | { error: string };

export interface UserSeed {
  user: string;
  db: string;
  roles: Array<{ role: string; db: string }>;
  mechanisms: string[];
}

export interface GridFsFileSeed {
  filename: string;
  content: string;
  contentType?: string | null;
  uploadDate?: string;
}

export interface ToolSeed {
  path: string;
  version: string;
}

export interface DumpFolderSeed {
  dbs: Array<{ name: string; collections: Array<{ name: string; hasMetadata: boolean; gzip: boolean }> }>;
}

export interface Seed {
  vault?: VaultState;
  monitoring?: MonitoringSeed;
  mcp?: McpSeed;
  mongosh?: MongoshSeed;
  /** mongodump and mongorestore as detect_mongo_tools finds them; null when missing. Both found by default. */
  mongoTools?: { mongodump: ToolSeed | null; mongorestore: ToolSeed | null };
  /** What browse_dump_folder finds, by folder path. A dump to a folder adds its own. */
  dumpFolders?: Record<string, DumpFolderSeed>;
  /** Files the app can read, by path: import sources. */
  files?: Record<string, string>;
  /** The local audit log behind the Activity tab. */
  audit?: { status?: Record<string, unknown>; events?: Array<Record<string, unknown>> };
  /** Database users; SAMPLE_USERS by default, as the mock backend lists. */
  users?: UserSeed[];
  /** GridFS files by "database.bucket". */
  gridfs?: Record<string, GridFsFileSeed[]>;
  /** Replies generate_mql_query gives, in order; once they run out it fails as with no provider. */
  aiReplies?: AiReplySeed[];
  /** The models an AI provider lists. */
  aiModels?: string[];
  /** Touch ID / Windows Hello as biometric_status reports it; unavailable by default. */
  biometric?: { available?: boolean; enrolled?: boolean; biometryType?: number; unlockError?: string | null };
  /** When set, `vault_unlock` rejects any other password. */
  vaultPassword?: string;
  settings?: Record<string, unknown>;
  profiles?: ProfileSeed[];
  /** A `PersistedWorkspace` to restore at startup; null or absent opens Quick Start. */
  workspace?: unknown;
  /** Servers the app can connect to, keyed by connection URI. */
  servers?: Record<string, ServerSeed>;
  appVersion?: string;
  /** Canned answers for native file dialogs; null means the user cancelled. */
  dialog?: { open?: unknown; save?: unknown };
}

const oid = (hex: string) => ({ $oid: hex });
/** A secondary index as the mock backend lists it: never unique or sparse. */
const index = (name: string, keys: Record<string, number>): IndexSeed => ({ name, keys });

/** The users the Rust mock backend lists (src-tauri/src/db/users.rs). */
export const SAMPLE_USERS: UserSeed[] = [
  { user: 'admin', db: 'admin', roles: [{ role: 'root', db: 'admin' }], mechanisms: ['SCRAM-SHA-256'] },
  { user: 'app_user', db: 'sales_db', roles: [{ role: 'readWrite', db: 'sales_db' }], mechanisms: ['SCRAM-SHA-256'] },
  { user: 'analyst', db: 'sales_db', roles: [{ role: 'read', db: 'sales_db' }], mechanisms: ['SCRAM-SHA-256'] },
];

/** A standalone server with two operations in flight and a profile of past ones. */
export const SAMPLE_MONITORING: Required<MonitoringSeed> = {
  serverStatus: {
    host: 'mock:27017',
    version: '7.0.5',
    uptimeSeconds: 7_200,
    connections: { current: 5, available: 995, totalCreated: 42 },
    opcounters: { insert: 12, query: 340, update: 8, delete: 2, getmore: 0, command: 910 },
    memory: { residentMb: 128, virtualMb: 2_048 },
    network: { bytesIn: 480_000, bytesOut: 1_250_000, numRequests: 1_260 },
    cache: { bytesInCache: 52_428_800, maxBytes: 209_715_200, dirtyBytes: 0 },
  },
  currentOps: [
    {
      opid: 101,
      op: 'query',
      ns: 'sales_db.customers',
      secsRunning: 7,
      client: '127.0.0.1:52001',
      desc: 'conn12',
      command: '{"find":"customers","filter":{"tier":"Premium"}}',
    },
    {
      opid: 102,
      op: 'insert',
      ns: 'user_analytics.events',
      secsRunning: 0,
      client: '127.0.0.1:52002',
      desc: 'conn13',
      command: '{"insert":"events","ordered":true}',
    },
  ],
  profile: [
    {
      op: 'query',
      ns: 'sales_db.customers',
      millis: 180,
      tsMs: 1_747_000_000_000,
      planSummary: 'COLLSCAN',
      command: '{"find":"customers","filter":{"joined":{"$gte":"2024-01-01"}}}',
    },
    {
      op: 'update',
      ns: 'sales_db.products',
      millis: 14,
      tsMs: 1_747_000_060_000,
      planSummary: 'IXSCAN { _id: 1 }',
      command: '{"update":"products","updates":[{"q":{"_id":1}}]}',
    },
  ],
  profiling: {},
  replSet: { isReplicaSet: false, clusterType: 'standalone', set: '', myStateStr: '', mongoVersion: '7.0.5', members: [] },
};

/**
 * The same sample data the Rust backend serves for `mongodb://mock`
 * (src-tauri/src/mock_db.rs), so the app sees what "Load sample data" shows.
 */
export const SAMPLE_SERVER: ServerSeed = {
  version: '7.0.5',
  databases: {
    admin: {
      // `get_mock_indexes` splits a name at its last underscore, so this reads as one field.
      'system.users': { docs: [], indexes: [index('user_1_db_1', { user_1_db: 1 })] },
      'system.version': { docs: [] },
    },
    config: {},
    local: {},
    sales_db: {
      customers: {
        docs: [
          { _id: oid('603d779f4f102e3a105c3120'), name: 'Alice Smith', email: 'alice@example.com', tier: 'Premium', joined: '2024-01-10', address: { city: 'New York', state: 'NY' } },
          { _id: oid('603d779f4f102e3a105c3121'), name: 'Bob Johnson', email: 'bob@example.com', tier: 'Standard', joined: '2024-03-15', address: { city: 'San Francisco', state: 'CA' } },
          { _id: oid('603d779f4f102e3a105c3122'), name: 'Charlie Brown', email: 'charlie@example.com', tier: 'Premium', joined: '2023-11-20', address: { city: 'Seattle', state: 'WA' } },
        ],
        indexes: [index('email_1', { email: 1 }), index('tier_1', { tier: 1 })],
      },
      transactions: {
        docs: [
          { _id: oid('603d779f4f102e3a105c3220'), customer_name: 'Alice Smith', amount: 1250.0, items: ['SuperBook Pro'], status: 'Completed', timestamp: '2025-05-10T14:32:00Z' },
          { _id: oid('603d779f4f102e3a105c3221'), customer_name: 'Bob Johnson', amount: 199.99, items: ['Noise Cancelling Headphones'], status: 'Completed', timestamp: '2025-05-12T09:15:00Z' },
          { _id: oid('603d779f4f102e3a105c3222'), customer_name: 'Charlie Brown', amount: 549.49, items: ['Ergonomic Desk Chair', 'Monitor Stand'], status: 'Pending', timestamp: '2025-05-24T18:00:00Z' },
        ],
        indexes: [index('timestamp_-1', { timestamp: -1 }), index('customer_name_1', { customer_name: 1 })],
      },
      products: {
        docs: [
          { _id: oid('603d779f4f102e3a105c3320'), name: 'SuperBook Pro', category: 'Electronics', price: 1299.99, stock: 42 },
          { _id: oid('603d779f4f102e3a105c3321'), name: 'Noise Cancelling Headphones', category: 'Electronics', price: 199.99, stock: 150 },
          { _id: oid('603d779f4f102e3a105c3322'), name: 'Ergonomic Desk Chair', category: 'Office', price: 349.5, stock: 25 },
        ],
        indexes: [index('price_1', { price: 1 }), index('category_1', { category: 1 })],
      },
      sensor_readings: {
        type: 'timeseries',
        // The mock backend gives these the same ids as the products.
        docs: [
          { _id: oid('603d779f4f102e3a105c3320'), timestamp: '2026-07-10T08:00:00Z', sensor_id: 'temp-01', value: 21.4, unit: 'C' },
          { _id: oid('603d779f4f102e3a105c3321'), timestamp: '2026-07-10T08:05:00Z', sensor_id: 'temp-01', value: 21.9, unit: 'C' },
          { _id: oid('603d779f4f102e3a105c3322'), timestamp: '2026-07-10T08:10:00Z', sensor_id: 'hum-02', value: 44.0, unit: '%' },
        ],
        indexes: [index('timestamp_-1', { timestamp: -1 })],
      },
    },
    user_analytics: {
      events: {
        docs: [
          { _id: oid('603d779f4f102e3a105c3420'), event_type: 'page_view', path: '/home', timestamp: '2026-05-24T22:00:00Z' },
          { _id: oid('603d779f4f102e3a105c3421'), event_type: 'click', target: 'buy-now-btn', timestamp: '2026-05-24T22:05:00Z' },
        ],
        indexes: [index('event_type_1', { event_type: 1 }), index('timestamp_-1', { timestamp: -1 })],
      },
      sessions: {
        docs: [
          { _id: oid('603d779f4f102e3a105c3520'), session_id: 'sess_001', duration_seconds: 180, referrer: 'google.com' },
          { _id: oid('603d779f4f102e3a105c3521'), session_id: 'sess_002', duration_seconds: 950, referrer: 'github.com' },
        ],
        indexes: [index('session_id_1', { session_id: 1 })],
      },
    },
  },
};

/** The URI the Quick Start "Load sample data" button connects to. */
export const SAMPLE_URI = 'mongodb://mock';
