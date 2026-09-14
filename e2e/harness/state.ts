// The fake backend's mutable state for one page load, built from the test's seed (#396).
import { SAMPLE_MONITORING, SAMPLE_SERVER, SAMPLE_URI } from './seed';
import type {
  Doc,
  DumpFolderSeed,
  IndexSeed,
  MongoshSeed,
  MonitoringSeed,
  ProfileSeed,
  Seed,
  ToolSeed,
  VaultState,
} from './seed';

export interface Collection {
  type: string;
  docs: Doc[];
  indexes: IndexSeed[];
  /** As `get_collection_options` reports it; absent means no validation set. */
  validation?: { validator: string; validationLevel: string; validationAction: string };
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
  mongosh: Required<MongoshSeed>;
  mongoTools: { mongodump: ToolSeed | null; mongorestore: ToolSeed | null };
  dumpFolders: Record<string, DumpFolderSeed>;
  /** Files the app can read, by path. */
  files: Record<string, string>;
  /** Files the app wrote (exports), by path. */
  writtenFiles: Record<string, string>;
  audit: { status: Record<string, unknown>; events: Array<Record<string, unknown>> };
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
    mongosh: (() => {
      const detection =
        seed.mongosh?.detection === undefined
          ? { path: '/usr/local/bin/mongosh', version: '2.3.2', source: 'path' }
          : seed.mongosh.detection;
      return {
        available: seed.mongosh?.available ?? true,
        binaries: [...(seed.mongosh?.binaries ?? []), ...(detection ? [detection.path] : [])],
        detection,
      };
    })(),
    mongoTools: structuredClone(
      seed.mongoTools ?? {
        mongodump: { path: '/usr/local/bin/mongodump', version: '100.10.0' },
        mongorestore: { path: '/usr/local/bin/mongorestore', version: '100.10.0' },
      },
    ),
    dumpFolders: structuredClone(seed.dumpFolders ?? {}),
    files: structuredClone(seed.files ?? {}),
    writtenFiles: {},
    audit: {
      status: { active: true, degradedReason: null, integrityError: null, droppedCount: 0, ...seed.audit?.status },
      events: structuredClone(seed.audit?.events ?? []),
    },
  };
}
