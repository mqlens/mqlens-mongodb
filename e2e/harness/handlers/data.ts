// Connection, database, collection, document, saved-query, index and schema
// commands, answered from the in-memory servers in the fake backend's state (#396).
import type { Backend, Handler } from '../backend';
import { generateDocuments, inferTemplate, previewDocuments } from '../generate';
import { aggregate, applyUpdate, find, inferSchema, matches, newObjectId } from '../mongo';
import type { Doc } from '../seed';
import type { Collection, CollectionQueries, E2EState, Server } from '../state';

/** The backend takes filters, sorts and pipelines as JSON strings; blank means "none". */
function parseJson<T>(value: unknown, fallback: T, what: string): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value as T;
  if (value.trim() === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw `Invalid MQL ${what} JSON: ${String(error)}`;
  }
}

/** The host list of a MongoDB URI, without scheme, credentials, database or options. */
function hostsOf(uri: string): string {
  return uri
    .replace(/^mongodb(\+srv)?:\/\//i, '')
    .replace(/^[^@/]*@/, '')
    .split(/[/?]/)[0]
    .toLowerCase();
}

/**
 * The seeded server a URI reaches. The connection editor builds URIs with
 * options a seed doesn't spell out (`/?directConnection=true`, …), so a URI
 * that isn't an exact key matches a seeded one by its hosts.
 */
function serverKeyFor(state: E2EState, uri: string): string | undefined {
  if (state.servers[uri]) return uri;
  return Object.keys(state.servers).find((key) => hostsOf(key) === hostsOf(uri));
}

export function registerDataHandlers(backend: Backend, state: E2EState): void {
  const connection = (id: unknown) => {
    const conn = state.connections[String(id)];
    if (!conn) throw `Connection not found: ${String(id)}`;
    return conn;
  };
  const server = (id: unknown): Server => state.servers[connection(id).uri];
  const database = (id: unknown, db: unknown) => {
    const found = server(id).databases[String(db)];
    if (!found) throw `Database not found: ${String(db)}`;
    return found;
  };
  const collection = (id: unknown, db: unknown, coll: unknown): Collection => {
    const found = database(id, db)[String(coll)];
    if (!found) throw `Collection not found: ${String(db)}.${String(coll)}`;
    return found;
  };
  const queriesFor = (connectionName: unknown, db: unknown, coll: unknown): CollectionQueries => {
    const key = JSON.stringify([connectionName, db, coll].map(String));
    state.queries[key] ??= { saved: [], history: [], default: null };
    return state.queries[key];
  };
  const connectionList = () =>
    Object.entries(state.connections).map(([id, conn]) => ({
      id,
      profileId: conn.profileId,
      name: conn.name,
      viaMcp: false,
      mode: conn.mode,
    }));

  const handlers: Record<string, Handler> = {
    // Profiles and connections
    load_connection_profiles: () => structuredClone(state.profiles),
    save_connection_profile: ({ profile }) => {
      const next = structuredClone(profile) as E2EState['profiles'][number];
      const at = state.profiles.findIndex((existing) => existing.id === next.id);
      if (at >= 0) state.profiles[at] = next;
      else state.profiles.push(next);
      return null;
    },
    delete_connection_profile: ({ id }) => {
      state.profiles = state.profiles.filter((profile) => profile.id !== id);
      return null;
    },
    connect_db: ({ uri }) => {
      const key = serverKeyFor(state, String(uri));
      if (!key) throw `Database ping failed: no server answers at ${String(uri)}`;
      const id = `conn-${state.nextConnectionId++}`;
      // Stored under the seeded server's key, which later lookups go through.
      state.connections[id] = { uri: key, profileId: null, name: String(uri), mode: 'readWrite' };
      return id;
    },
    disconnect_db: async ({ id }) => {
      delete state.connections[String(id)];
      await backend.emit('connections-changed', { connections: connectionList() });
      return null;
    },
    connection_list: () => connectionList(),
    set_connection_meta: async ({ id, profileId, name, mode }) => {
      const conn = state.connections[String(id)];
      if (conn) {
        conn.profileId = profileId === undefined ? null : (profileId as string | null);
        conn.name = String(name);
        conn.mode = String(mode ?? 'readWrite');
      }
      await backend.emit('connections-changed', { connections: connectionList() });
      return null;
    },
    test_connection_uri: ({ uri, onPhase }) => {
      const send = (message: Record<string, unknown>) =>
        (onPhase as { onmessage?: (m: unknown) => void } | undefined)?.onmessage?.(message);
      for (const phase of ['parse', 'resolve', 'connect']) {
        send({ phase, status: 'start' });
        send({ phase, status: 'ok' });
      }
      send({ phase: 'ping', status: 'start' });
      if (!serverKeyFor(state, String(uri))) {
        const message = `no server answers at ${String(uri)}`;
        send({ phase: 'ping', status: 'fail', message });
        throw message;
      }
      send({ phase: 'ping', status: 'ok' });
      return null;
    },
    get_mongodb_version: ({ id }) => server(id).version,

    // Databases and collections
    list_databases: ({ id }) => Object.keys(server(id).databases),
    list_collections: ({ id, db }) =>
      Object.entries(database(id, db)).map(([name, coll]) => ({ name, type: coll.type })),
    create_collection: ({ id, database: db, collection: coll }) => {
      const dbs = server(id).databases;
      dbs[String(db)] ??= {};
      if (dbs[String(db)][String(coll)]) throw `Collection already exists: ${String(coll)}`;
      dbs[String(db)][String(coll)] = { type: 'collection', docs: [], indexes: [] };
      return null;
    },
    drop_collection: ({ id, database: db, collection: coll }) => {
      delete database(id, db)[String(coll)];
      return null;
    },
    rename_collection: ({ id, database: db, from, to }) => {
      const colls = database(id, db);
      colls[String(to)] = collection(id, db, from);
      delete colls[String(from)];
      return null;
    },
    drop_database: ({ id, database: db }) => {
      delete server(id).databases[String(db)];
      return null;
    },
    rename_database: ({ id, from, to }) => {
      const dbs = server(id).databases;
      dbs[String(to)] = database(id, from);
      delete dbs[String(from)];
      return null;
    },
    db_stats: ({ id, db }) => {
      const colls = Object.values(database(id, db));
      const objects = colls.reduce((sum, coll) => sum + coll.docs.length, 0);
      return {
        collections: colls.filter((coll) => coll.type !== 'view').length,
        views: colls.filter((coll) => coll.type === 'view').length,
        objects,
        avgObjSize: objects ? 256 : 0,
        dataSize: objects * 256,
        storageSize: objects * 128 + 4096,
        indexes: colls.reduce((sum, coll) => sum + coll.indexes.length + 1, 0),
        totalIndexSize: colls.length * 4096,
      };
    },
    coll_stats: ({ id, db, collection: coll }) => {
      const found = collection(id, db, coll);
      return {
        count: found.docs.length,
        avgObjSize: found.docs.length ? 256 : 0,
        size: found.docs.length * 256,
        storageSize: found.docs.length * 128 + 4096,
        nindexes: found.indexes.length + 1,
        totalIndexSize: (found.indexes.length + 1) * 4096,
        capped: false,
      };
    },

    // Documents
    execute_mql_query: ({ id, database: db, collection: coll, filter, sort, projection, limit, skip }) =>
      find(collection(id, db, coll).docs, {
        filter: parseJson<Doc>(filter, {}, 'filter'),
        sort: parseJson<Doc>(sort, {}, 'sort'),
        projection: parseJson<Doc>(projection, {}, 'projection'),
        limit: Number(limit ?? 0),
        skip: Number(skip ?? 0),
      }).map((doc) => JSON.stringify(doc)),
    count_documents: ({ id, database: db, collection: coll, filter }) => {
      const where = parseJson<Doc>(filter, {}, 'filter');
      return collection(id, db, coll).docs.filter((doc) => matches(doc, where)).length;
    },
    execute_aggregate: ({ id, database: db, collection: coll, pipeline }) =>
      aggregate(collection(id, db, coll).docs, parseJson<Doc[]>(pipeline, [], 'pipeline')).map((doc) => JSON.stringify(doc)),
    explain_mql_query: ({ id, database: db, collection: coll, filter }) => {
      const where = parseJson<Doc>(filter, {}, 'filter');
      const docs = collection(id, db, coll).docs;
      const returned = docs.filter((doc) => matches(doc, where)).length;
      return JSON.stringify({
        queryPlanner: { namespace: `${String(db)}.${String(coll)}`, winningPlan: { stage: 'COLLSCAN', filter: where } },
        executionStats: { nReturned: returned, executionTimeMillis: 1, totalKeysExamined: 0, totalDocsExamined: docs.length },
      });
    },
    explain_aggregate_query: ({ id, database: db, collection: coll, pipeline }) =>
      JSON.stringify({
        stages: parseJson<Doc[]>(pipeline, [], 'pipeline'),
        queryPlanner: { namespace: `${String(db)}.${String(coll)}`, winningPlan: { stage: 'COLLSCAN' } },
        executionStats: { nReturned: collection(id, db, coll).docs.length, executionTimeMillis: 1 },
      }),
    insert_document: ({ id, database: db, collection: coll, document }) => {
      const doc = parseJson<Doc>(document, {}, 'document');
      doc._id ??= { $oid: newObjectId() };
      collection(id, db, coll).docs.push(doc);
      return JSON.stringify(doc._id);
    },
    update_document: ({ id, database: db, collection: coll, filter, original, edited, projection }) => {
      // Like the backend (#275): the app sends the document as loaded and as
      // edited, and only what changed is written. `projection` is null when the
      // row came from a pipeline that reshapes documents, and then the backend
      // refuses to write at all.
      if (projection === null) throw 'This row came from an aggregation that reshapes documents, so it cannot be saved';
      const docs = collection(id, db, coll).docs;
      const where = parseJson<Doc>(filter, {}, 'filter');
      const at = docs.findIndex((doc) => matches(doc, where));
      if (at < 0) return 0;
      const before = parseJson<Doc>(original, {}, 'document');
      const after = parseJson<Doc>(edited, {}, 'document');
      const set: Doc = {};
      const unset: Doc = {};
      for (const [key, value] of Object.entries(after)) {
        if (key !== '_id' && JSON.stringify(before[key]) !== JSON.stringify(value)) set[key] = value;
      }
      // A field missing from the edit is a removal only when the row held the
      // whole document; under a projection it may simply not have been shown.
      const wholeDocument = Object.keys(parseJson<Doc>(projection, {}, 'projection')).length === 0;
      if (wholeDocument) {
        for (const key of Object.keys(before)) if (key !== '_id' && !(key in after)) unset[key] = '';
      }
      const change: Doc = {};
      if (Object.keys(set).length > 0) change.$set = set;
      if (Object.keys(unset).length > 0) change.$unset = unset;
      if (Object.keys(change).length === 0) return 0;
      docs[at] = applyUpdate(docs[at], change);
      return 1;
    },
    delete_document: ({ id, database: db, collection: coll, filter }) => {
      const docs = collection(id, db, coll).docs;
      const where = parseJson<Doc>(filter, {}, 'filter');
      const at = docs.findIndex((doc) => matches(doc, where));
      if (at >= 0) docs.splice(at, 1);
      return null;
    },
    delete_many: ({ id, database: db, collection: coll, filter }) => {
      const found = collection(id, db, coll);
      const where = parseJson<Doc>(filter, {}, 'filter');
      const before = found.docs.length;
      found.docs = found.docs.filter((doc) => !matches(doc, where));
      return before - found.docs.length;
    },
    update_many: ({ id, database: db, collection: coll, filter, update }) => {
      const found = collection(id, db, coll);
      const where = parseJson<Doc>(filter, {}, 'filter');
      const change = parseJson<Doc>(update, {}, 'update');
      let modified = 0;
      found.docs = found.docs.map((doc) => {
        if (!matches(doc, where)) return doc;
        modified += 1;
        return applyUpdate(doc, change);
      });
      return modified;
    },

    // Saved queries and history
    list_all_saved_queries: () =>
      Object.entries(state.queries).flatMap(([key, entry]) => {
        const [connectionName, db, coll] = JSON.parse(key) as string[];
        return (entry.saved as Doc[]).map((saved) => ({ connectionName, db, collection: coll, ...saved }));
      }),
    load_collection_queries: ({ connectionName, db, collection: coll }) =>
      structuredClone(queriesFor(connectionName, db, coll)),
    save_query: ({ connectionName, db, collection: coll, saved }) => {
      const entry = queriesFor(connectionName, db, coll);
      const next = saved as Doc;
      entry.saved = [...(entry.saved as Doc[]).filter((existing) => existing.id !== next.id), next];
      return null;
    },
    delete_saved_query: ({ connectionName, db, collection: coll, id }) => {
      const entry = queriesFor(connectionName, db, coll);
      entry.saved = (entry.saved as Doc[]).filter((existing) => existing.id !== id);
      return null;
    },
    record_history: ({ connectionName, db, collection: coll, entry }) => {
      queriesFor(connectionName, db, coll).history.unshift(entry);
      return null;
    },
    set_default_query: ({ connectionName, db, collection: coll, default: value }) => {
      queriesFor(connectionName, db, coll).default = value ?? null;
      return null;
    },

    // Indexes
    list_indexes: ({ id, db, collection: coll }) => [
      { name: '_id_', keys: JSON.stringify({ _id: 1 }), unique: false, sparse: false },
      ...collection(id, db, coll).indexes.map((index) => ({
        name: index.name,
        keys: JSON.stringify(index.keys),
        unique: Boolean(index.unique),
        sparse: Boolean(index.sparse),
      })),
    ],
    create_index: ({ id, database: db, collection: coll, indexName, keys, unique, sparse }) => {
      const found = collection(id, db, coll);
      const name = String(indexName);
      if (found.indexes.some((index) => index.name === name)) throw `Index already exists: ${name}`;
      found.indexes.push({ name, keys: parseJson<Doc>(keys, {}, 'index keys'), unique: Boolean(unique), sparse: Boolean(sparse) });
      return null;
    },
    delete_index: ({ id, database: db, collection: coll, indexName }) => {
      const found = collection(id, db, coll);
      found.indexes = found.indexes.filter((index) => index.name !== indexName);
      return null;
    },
    index_stats: ({ id, db, collection: coll }) =>
      ['_id_', ...collection(id, db, coll).indexes.map((index) => index.name)].map((name) => ({
        name,
        sizeBytes: 4096,
        ops: 0,
        sinceMs: Date.now() - 60_000,
      })),

    // Schema
    analyze_schema: ({ id, database: db, collection: coll, sampleSize }) =>
      JSON.stringify(inferSchema(collection(id, db, coll).docs, Number(sampleSize ?? 0))),

    // Data generation (#91)
    infer_generate_template: ({ id, database: db, collection: coll }) =>
      inferTemplate(inferSchema(collection(id, db, coll).docs, 100)),
    preview_generated_documents: ({ template, count, seed }) =>
      previewDocuments(String(template), count == null ? undefined : Number(count), seed == null ? undefined : Number(seed)),
    start_generate_task: ({ id, database: db, collection: coll, template, count, seed }) => {
      const n = Number(count);
      if (!Number.isInteger(n) || n < 1 || n > 50_000) throw `count must be between 1 and 50000, got ${String(count)}`;
      const docs = generateDocuments(String(template), n, seed == null ? undefined : Number(seed));
      // A database-scoped run may name a collection that doesn't exist yet.
      const target = (database(id, db)[String(coll)] ??= { type: 'collection', docs: [], indexes: [] });
      target.docs.push(...docs.map((doc) => ({ _id: { $oid: newObjectId() }, ...doc })));

      const now = Date.now();
      const task = {
        id: `generate-${now}-${state.tasks.length + 1}`,
        kind: 'generate',
        label: `Generate ${n} documents`,
        subLabel: `${String(db)}.${String(coll)}`,
        status: 'running',
        processed: 0,
        total: n,
        message: 'Generating documents…',
        path: null,
        error: null,
        createdAtMs: now,
        finishedAtMs: null,
      };
      // The backend returns the task as it starts. A fake run is already done,
      // so the task list the app polls next shows it finished.
      state.tasks.push({ ...task, status: 'completed', processed: n, message: `Inserted ${n} documents`, finishedAtMs: now });
      return task;
    },
  };

  backend.register(handlers);
}
