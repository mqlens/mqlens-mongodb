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

export interface Seed {
  vault?: VaultState;
  monitoring?: MonitoringSeed;
  mcp?: McpSeed;
  mongosh?: MongoshSeed;
  /** When set, `vault_unlock` rejects any other password. */
  vaultPassword?: string;
  settings?: Record<string, unknown>;
  profiles?: ProfileSeed[];
  /** A `PersistedWorkspace` to restore at startup; null or absent opens Quick Start. */
  workspace?: unknown;
  /** Servers the app can connect to, keyed by connection URI. */
  servers?: Record<string, ServerSeed>;
  appVersion?: string;
  aiProviders?: unknown[];
  /** Canned answers for native file dialogs; null means the user cancelled. */
  dialog?: { open?: unknown; save?: unknown };
}

const oid = (hex: string) => ({ $oid: hex });

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
      'system.users': { docs: [] },
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
        indexes: [{ name: 'email_1', keys: { email: 1 }, unique: true }],
      },
      transactions: {
        docs: [
          { _id: oid('603d779f4f102e3a105c3220'), customer_name: 'Alice Smith', amount: 1250.0, items: ['SuperBook Pro'], status: 'Completed', timestamp: '2025-05-10T14:32:00Z' },
          { _id: oid('603d779f4f102e3a105c3221'), customer_name: 'Bob Johnson', amount: 199.99, items: ['Noise Cancelling Headphones'], status: 'Completed', timestamp: '2025-05-12T09:15:00Z' },
          { _id: oid('603d779f4f102e3a105c3222'), customer_name: 'Charlie Brown', amount: 549.49, items: ['Ergonomic Desk Chair', 'Monitor Stand'], status: 'Pending', timestamp: '2025-05-24T18:00:00Z' },
        ],
      },
      products: {
        docs: [
          { _id: oid('603d779f4f102e3a105c3320'), name: 'SuperBook Pro', category: 'Electronics', price: 1299.99, stock: 42 },
          { _id: oid('603d779f4f102e3a105c3321'), name: 'Noise Cancelling Headphones', category: 'Electronics', price: 199.99, stock: 150 },
          { _id: oid('603d779f4f102e3a105c3322'), name: 'Ergonomic Desk Chair', category: 'Office', price: 349.5, stock: 25 },
        ],
      },
      sensor_readings: {
        type: 'timeseries',
        docs: [
          { _id: oid('603d779f4f102e3a105c3620'), sensor_id: 'temp-01', reading: 21.4, ts: { $date: '2026-05-24T22:00:00Z' } },
          { _id: oid('603d779f4f102e3a105c3621'), sensor_id: 'temp-01', reading: 21.9, ts: { $date: '2026-05-24T22:05:00Z' } },
        ],
      },
    },
    user_analytics: {
      events: {
        docs: [
          { _id: oid('603d779f4f102e3a105c3420'), event_type: 'page_view', path: '/home', timestamp: '2026-05-24T22:00:00Z' },
          { _id: oid('603d779f4f102e3a105c3421'), event_type: 'click', target: 'buy-now-btn', timestamp: '2026-05-24T22:05:00Z' },
        ],
      },
      sessions: {
        docs: [
          { _id: oid('603d779f4f102e3a105c3520'), session_id: 'sess_001', duration_seconds: 180, referrer: 'google.com' },
          { _id: oid('603d779f4f102e3a105c3521'), session_id: 'sess_002', duration_seconds: 45, referrer: 'direct' },
        ],
      },
    },
  },
};

/** The URI the Quick Start "Load sample data" button connects to. */
export const SAMPLE_URI = 'mongodb://mock';
