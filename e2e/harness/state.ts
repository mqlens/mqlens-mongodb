// The fake backend's mutable state for one page load, built from the test's seed (#396).
import { SAMPLE_MONITORING, SAMPLE_SERVER, SAMPLE_URI, SAMPLE_USERS } from './seed';
import type {
  AiReplySeed,
  Doc,
  DumpFolderSeed,
  GridFsFileSeed,
  IndexSeed,
  MongoshSeed,
  MonitoringSeed,
  ProfileSeed,
  Seed,
  ToolSeed,
  UserSeed,
  VaultState,
} from './seed';

export interface Collection {
  type: string;
  docs: Doc[];
  indexes: IndexSeed[];
  /** As `get_collection_options` reports it; absent means no validation set. */
  validation?: { validator: string; validationLevel: string; validationAction: string };
  /** Set on a view: the collection it reads, by name, and its pipeline. */
  view?: { on: string; pipeline: Doc[] };
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
  dialog: { open: unknown; save: unknown };
  appVersion: string;
  /** What the monitoring commands report, by server URI; each server keeps its own. */
  monitoring: Record<string, Required<MonitoringSeed>>;
  mcp: { enabled: boolean; port: number; token: string; log: unknown[] };
  mongosh: Required<MongoshSeed>;
  mongoTools: { mongodump: ToolSeed | null; mongorestore: ToolSeed | null };
  dumpFolders: Record<string, DumpFolderSeed>;
  /** Files the app can read, by path. */
  files: Record<string, string>;
  /** Files the app wrote (exports), by path. */
  writtenFiles: Record<string, string>;
  audit: { status: Record<string, unknown>; events: Array<Record<string, unknown>> };
  /** Database users by server URI; each server keeps its own. */
  users: Record<string, UserSeed[]>;
  /** GridFS files by server URI, then by "database.bucket". */
  gridfs: Record<string, Record<string, GridFsFile[]>>;
  changeStreams: Record<string, ChangeStream>;
  aiReplies: AiReplySeed[];
  aiModels: string[];
  biometric: { available: boolean; enrolled: boolean; biometryType: number; unlockError: string | null };
}

/** A GridFS file as `list_gridfs_files` reports it, plus the content a download writes. */
export interface GridFsFile {
  id: string;
  filename: string;
  length: number;
  chunk_size_bytes: number;
  upload_date: string;
  content_type: string | null;
  content: string;
}

export interface ChangeStream {
  connectionId: string;
  database: string | null;
  collection: string | null;
  operationTypes: string[];
  status: string;
  lastSeq: number;
  events: Array<Record<string, unknown>>;
  /** Events the buffer evicted since the stream started, as `StreamBuffer::dropped` counts them. */
  dropped: number;
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

/** The seeded GridFS files, as every seeded server holds them. */
function toGridFs(seed: Record<string, GridFsFileSeed[]>): Record<string, GridFsFile[]> {
  return Object.fromEntries(
    Object.entries(seed).map(([bucket, files]) => [
      bucket,
      files.map((file, i) => ({
        id: JSON.stringify({ $oid: `64b0${String(i).padStart(20, '0')}` }),
        filename: file.filename,
        length: file.content.length,
        chunk_size_bytes: 261_120,
        upload_date: file.uploadDate ?? '2025-05-01T12:00:00Z',
        content_type: file.contentType ?? null,
        content: file.content,
      })),
    ]),
  );
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
    dialog: { open: seed.dialog?.open ?? null, save: seed.dialog?.save ?? null },
    appVersion: seed.appVersion ?? '0.20.0',
    // The seeded monitoring starts out on every seeded server.
    monitoring: Object.fromEntries(
      Object.keys(servers).map((uri) => [uri, structuredClone({ ...SAMPLE_MONITORING, ...seed.monitoring })]),
    ),
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
    // The seeded users start out on every seeded server.
    users: Object.fromEntries(Object.keys(servers).map((uri) => [uri, structuredClone(seed.users ?? SAMPLE_USERS)])),
    gridfs: Object.fromEntries(Object.keys(servers).map((uri) => [uri, toGridFs(seed.gridfs ?? {})])),
    changeStreams: {},
    aiReplies: structuredClone(seed.aiReplies ?? []),
    aiModels: structuredClone(seed.aiModels ?? []),
    biometric: {
      available: seed.biometric?.available ?? false,
      enrolled: seed.biometric?.enrolled ?? false,
      biometryType: seed.biometric?.biometryType ?? 0,
      unlockError: seed.biometric?.unlockError ?? null,
    },
  };
}
