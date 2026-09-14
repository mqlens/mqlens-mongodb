// The fake backend's mutable state for one page load, built from the test's seed (#396).
import { SAMPLE_MONITORING, SAMPLE_SERVER, SAMPLE_URI } from './seed';
import type { Doc, IndexSeed, MonitoringSeed, ProfileSeed, Seed, VaultState } from './seed';

export interface Collection {
  type: string;
  docs: Doc[];
  indexes: IndexSeed[];
}

export interface Server {
  version: string;
  databases: Record<string, Record<string, Collection>>;
}

export interface Connection {
  uri: string;
  profileId: string | null;
  name: string;
  mode: string;
}

export interface CollectionQueries {
  saved: unknown[];
  history: unknown[];
  default: unknown;
}

export interface E2EState {
  vault: VaultState;
  vaultPassword: string | null;
  settings: Record<string, unknown>;
  profiles: ProfileSeed[];
  workspace: unknown;
  workspaceOps: unknown[];
  servers: Record<string, Server>;
  connections: Record<string, Connection>;
  nextConnectionId: number;
  queries: Record<string, CollectionQueries>;
  tasks: Array<Record<string, unknown>>;
  /** Messages the app sent to `log_frontend_error`: uncaught errors a test must not produce. */
  frontendErrors: string[];
  aiProviders: unknown[];
  dialog: { open: unknown; save: unknown };
  appVersion: string;
  monitoring: Required<MonitoringSeed>;
  mcp: { enabled: boolean; port: number; token: string; log: unknown[] };
}

function toServer(seed: Seed['servers'] extends Record<string, infer S> | undefined ? S : never): Server {
  const databases: Server['databases'] = {};
  for (const [dbName, collections] of Object.entries(seed.databases)) {
    databases[dbName] = {};
    for (const [collName, coll] of Object.entries(collections)) {
      databases[dbName][collName] = {
        type: coll.type ?? 'collection',
        docs: structuredClone(coll.docs ?? []),
        indexes: structuredClone(coll.indexes ?? []),
      };
    }
  }
  return { version: seed.version ?? '7.0.5', databases };
}

export function createState(seed: Seed): E2EState {
  const servers = seed.servers ?? { [SAMPLE_URI]: SAMPLE_SERVER };
  return {
    vault: seed.vault ?? 'unlocked',
    vaultPassword: seed.vaultPassword ?? null,
    settings: structuredClone(seed.settings ?? {}),
    profiles: structuredClone(seed.profiles ?? []),
    workspace: seed.workspace ?? null,
    workspaceOps: [],
    servers: Object.fromEntries(Object.entries(servers).map(([uri, server]) => [uri, toServer(server)])),
    connections: {},
    nextConnectionId: 1,
    queries: {},
    tasks: [],
    frontendErrors: [],
    aiProviders: structuredClone(seed.aiProviders ?? []),
    dialog: { open: seed.dialog?.open ?? null, save: seed.dialog?.save ?? null },
    appVersion: seed.appVersion ?? '0.20.0',
    monitoring: structuredClone({ ...SAMPLE_MONITORING, ...seed.monitoring }),
    mcp: {
      enabled: seed.mcp?.enabled ?? false,
      port: seed.mcp?.port ?? 8765,
      token: seed.mcp?.token ?? 'e2e-token-1',
      log: structuredClone(seed.mcp?.log ?? []),
    },
  };
}
