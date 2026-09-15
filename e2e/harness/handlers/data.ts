// Connection, database, collection, document, saved-query, index and schema
// commands, answered from the in-memory servers in the fake backend's state (#396).
//
// The built-in sample server (`mongodb://mock`) answers the way the backend
// answers for it: reads come from its data with the sample server's simpler
// matching, and writes are checked and then dropped, so its documents never
// change. Only its indexes do, as in the backend. Every write passes the
// backend's write guard first.
import type { Backend, Handler } from '../backend';
import { generateDocuments, inferTemplate, previewDocuments } from '../generate';
import { collectionForWrite, guardWritable, isMock } from '../lookup';
import { aggregate, applyUpdate, find, inferSchema, jsonEqual, matches, mockFind, mockMatches, newObjectId } from '../mongo';
import type { Doc } from '../seed';
import type { Collection, CollectionQueries, E2EState, Server } from '../state';
import { recordTask } from '../tasks';
import { duplicateIndexKey, duplicateKey } from '../unique';

const MOCK_AGGREGATE = 'Aggregation pipelines are not supported on mock connections';
const MOCK_GENERATE_CAP = 10_000;
const GENERATE_CAP = 50_000;

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

/**
 * A filter as the server's explain reports it: a plain value becomes `$eq`, and
 * several fields are joined under `$and`. Operators and `$and`/`$or` pass through.
 */
function parsedQuery(filter: Doc): Doc {
  const clauses = Object.entries(filter).map(([key, value]): Doc => {
    const isOperatorDoc =
      typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).some((k) => k.startsWith('$'));
    return { [key]: key.startsWith('$') || isOperatorDoc ? value : { $eq: value } };
  });
  return clauses.length === 1 ? clauses[0] : clauses.length === 0 ? {} : { $and: clauses };
}

/**
 * The sample server's explain (`get_mock_explain` in src-tauri/src/mock_db.rs):
 * the same canned plan whatever the filter, a sorted collection scan for
 * sales_db.transactions and an index scan for everything else.
 */
function mockExplain(db: string, coll: string, filter: unknown): string {
  const winningPlan =
    db === 'sales_db' && coll === 'transactions'
      ? { stage: 'SORT', sortPattern: { timestamp: -1 }, inputStage: { stage: 'COLLSCAN' } }
      : { stage: 'IXSCAN', keyPattern: { category: 1 }, indexName: 'category_1', isMultiKey: false, direction: 'forward' };
  let parsed: unknown = null;
  try {
    if (typeof filter === 'string' && filter.trim() !== '') parsed = JSON.parse(filter);
  } catch {
    parsed = null;
  }
  return JSON.stringify(
    {
      explainVersion: '1',
      queryPlanner: { namespace: `${db}.${coll}`, indexFilterSet: false, parsedQuery: parsed, winningPlan },
      executionStats: { executionSuccess: true, nReturned: 3, executionTimeMillis: 1, totalKeysExamined: 3, totalDocsExamined: 3 },
    },
    null,
    2,
  );
}

/**
 * What a profile connects to, compared the way `would_retarget_live_profile`
 * compares it: the URI with its option names lower-cased and its options in key
 * order (a repeated option keeps its own order), plus the SSH tunnel when one
 * is on.
 */
function serverIdentity(profile: Record<string, unknown>): string {
  const uri = String(profile.uri ?? '');
  const at = uri.indexOf('?');
  let canonical = uri;
  if (at >= 0) {
    const keyOf = (param: string) => param.split('=')[0];
    const params = uri
      .slice(at + 1)
      .split('&')
      .filter((param) => param !== '')
      .map((param) => {
        const eq = param.indexOf('=');
        return eq < 0 ? param.toLowerCase() : `${param.slice(0, eq).toLowerCase()}${param.slice(eq)}`;
      })
      .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    canonical = `${uri.slice(0, at)}?${params.join('&')}`;
  }
  const ssh = profile.ssh as { enabled?: boolean } | undefined;
  return JSON.stringify([canonical, ssh?.enabled ? ssh : null]);
}

/** An embedded document, as opposed to a scalar, an array or an Extended JSON value such as `{ $oid }`. */
const isSubDocument = (value: unknown): value is Doc =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.keys(value).some((key) => key.startsWith('$'));

/**
 * The update that turns a row as loaded into the row as edited, the way
 * build_field_update makes it (src-tauri/src/db/documents.rs). Embedded
 * documents on both sides are compared field by field and written as dotted
 * paths, so a projected edit of `address.city` leaves `address.state` alone.
 * Anything else that changed is set whole, and a field the row showed that the
 * edit dropped is unset. The top-level `_id` is never part of it.
 */
function fieldUpdate(before: Doc, after: Doc, prefix = ''): { set: Doc; unset: Doc } {
  const set: Doc = {};
  const unset: Doc = {};
  for (const [key, value] of Object.entries(after)) {
    if (prefix === '' && key === '_id') continue;
    const path = `${prefix}${key}`;
    if (key in before && isSubDocument(before[key]) && isSubDocument(value)) {
      const inner = fieldUpdate(before[key] as Doc, value, `${path}.`);
      Object.assign(set, inner.set);
      Object.assign(unset, inner.unset);
    } else if (!(key in before) || !jsonEqual(before[key], value)) {
      set[path] = value;
    }
  }
  for (const key of Object.keys(before)) {
    if (prefix === '' && key === '_id') continue;
    if (!(key in after)) unset[`${prefix}${key}`] = '';
  }
  return { set, unset };
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

const isBlank = (value: unknown) => String(value ?? '').trim() === '';

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
      // A profile with an open connection can't move to another server: that
      // session would stay on the old one under the new settings.
      if (
        at >= 0 &&
        serverIdentity(state.profiles[at] as unknown as Record<string, unknown>) !== serverIdentity(next as unknown as Record<string, unknown>) &&
        Object.values(state.connections).some((conn) => conn.profileId === next.id)
      ) {
        throw "This connection is open in another window. Close it there before changing its server, so that session isn't left pointing at the old one.";
      }
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
      guardWritable(state, id);
      if (isBlank(coll)) throw 'Collection name is required';
      if (isMock(state, id)) return null;
      const dbs = server(id).databases;
      dbs[String(db)] ??= {};
      if (dbs[String(db)][String(coll)]) throw `Collection already exists: ${String(coll)}`;
      dbs[String(db)][String(coll)] = { type: 'collection', docs: [], indexes: [] };
      return null;
    },
    drop_collection: ({ id, database: db, collection: coll, confirmed }) => {
      guardWritable(state, id, { destructive: true, confirmed });
      if (isMock(state, id)) return null;
      delete database(id, db)[String(coll)];
      return null;
    },
    rename_collection: ({ id, database: db, from, to, confirmed }) => {
      guardWritable(state, id, { destructive: true, confirmed });
      if (isBlank(to)) throw 'Collection name is required';
      if (from === to) throw 'New collection name must be different';
      if (isMock(state, id)) return null;
      const colls = database(id, db);
      const source = collection(id, db, from);
      // The backend renames with dropTarget: false, which MongoDB refuses onto an existing name.
      if (colls[String(to)]) throw 'Failed to rename collection: Command failed (NamespaceExists): target namespace exists';
      colls[String(to)] = source;
      delete colls[String(from)];
      return null;
    },
    drop_database: ({ id, database: db, confirmed }) => {
      guardWritable(state, id, { destructive: true, confirmed });
      if (isBlank(db)) throw 'Database name is required';
      if (isMock(state, id)) return null;
      delete server(id).databases[String(db)];
      return null;
    },
    rename_database: ({ id, from, to, confirmed }) => {
      guardWritable(state, id, { destructive: true, confirmed });
      if (isBlank(to)) throw 'Database name is required';
      if (from === to) throw 'New database name must be different';
      if (isMock(state, id)) return { collections: 0, documents: 0 };
      const dbs = server(id).databases;
      if (!dbs[String(from)]) throw `Source database "${String(from)}" does not exist`;
      if (dbs[String(to)]) throw `Target database "${String(to)}" already exists`;
      const moved = dbs[String(from)];
      // The backend moves plain collections only, and checks every one before it creates anything.
      for (const [name, coll] of Object.entries(moved)) {
        if (coll.type === 'view') throw `Cannot rename database: collection "${name}" is a view`;
        if (coll.type === 'timeseries') throw `Cannot rename database: collection "${name}" is time-series`;
        if (coll.type !== 'collection') throw `Cannot rename database: collection "${name}" has an unsupported type`;
      }
      dbs[String(to)] = moved;
      delete dbs[String(from)];
      return {
        collections: Object.keys(moved).length,
        documents: Object.values(moved).reduce((sum, coll) => sum + coll.docs.length, 0),
      };
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
    execute_mql_query: ({ id, database: db, collection: coll, filter, sort, projection, limit, skip }) => {
      const options = {
        filter: parseJson<Doc>(filter, {}, 'filter'),
        sort: parseJson<Doc>(sort, {}, 'sort'),
        projection: parseJson<Doc>(projection, {}, 'projection'),
        limit: Number(limit ?? 0),
        skip: Number(skip ?? 0),
      };
      const docs = collection(id, db, coll).docs;
      // The sample server checks the projection but doesn't apply it.
      const rows = isMock(state, id) ? mockFind(docs, options) : find(docs, options);
      return rows.map((doc) => JSON.stringify(doc));
    },
    count_documents: ({ id, database: db, collection: coll, filter }) => {
      const where = parseJson<Doc>(filter, {}, 'filter');
      const match = isMock(state, id) ? mockMatches : matches;
      return collection(id, db, coll).docs.filter((doc) => match(doc, where)).length;
    },
    execute_aggregate: ({ id, database: db, collection: coll, pipeline, confirmed }) => {
      const stages = parseJson<Doc[]>(pipeline, [], 'pipeline');
      if (stages.some((stage) => '$out' in stage || '$merge' in stage)) guardWritable(state, id, { destructive: true, confirmed });
      if (isMock(state, id)) throw MOCK_AGGREGATE;
      return aggregate(collection(id, db, coll).docs, stages).map((doc) => JSON.stringify(doc));
    },
    explain_mql_query: ({ id, database: db, collection: coll, filter }) => {
      if (isMock(state, id)) return mockExplain(String(db), String(coll), filter);
      const where = parseJson<Doc>(filter, {}, 'filter');
      const docs = collection(id, db, coll).docs;
      const returned = docs.filter((doc) => matches(doc, where)).length;
      return JSON.stringify({
        queryPlanner: {
          namespace: `${String(db)}.${String(coll)}`,
          parsedQuery: parsedQuery(where),
          winningPlan: { stage: 'COLLSCAN', filter: where },
        },
        executionStats: { nReturned: returned, executionTimeMillis: 1, totalKeysExamined: 0, totalDocsExamined: docs.length },
      });
    },
    explain_aggregate_query: ({ id, database: db, collection: coll, pipeline }) => {
      if (isMock(state, id)) throw 'Aggregation explain is not supported on mock connections';
      return JSON.stringify({
        stages: parseJson<Doc[]>(pipeline, [], 'pipeline'),
        queryPlanner: { namespace: `${String(db)}.${String(coll)}`, winningPlan: { stage: 'COLLSCAN' } },
        executionStats: { nReturned: collection(id, db, coll).docs.length, executionTimeMillis: 1 },
      });
    },
    insert_document: ({ id, database: db, collection: coll, document }) => {
      guardWritable(state, id);
      const doc = parseJson<Doc>(document, {}, 'document');
      if (isMock(state, id)) return 'mock-inserted-id';
      const target = collectionForWrite(state, id, db, coll);
      doc._id ??= { $oid: newObjectId() };
      const clash = duplicateKey(`${String(db)}.${String(coll)}`, target, doc);
      if (clash) throw `Failed to insert document: ${clash}`;
      target.docs.push(doc);
      return JSON.stringify(doc._id);
    },
    update_document: ({ id, database: db, collection: coll, filter, original, edited, projection }) => {
      // Like the backend (#275): the app sends the document as loaded and as
      // edited, and only what changed is written. `projection` is null when the
      // row came from a pipeline that reshapes documents, and then the backend
      // refuses to write at all.
      guardWritable(state, id);
      if (projection === null) {
        throw 'cannot save: these rows did not come from a plain query, so MQLens cannot tell which stored document each one came from. Re-run as a find query to edit documents.';
      }
      const before = parseJson<Doc>(original, {}, 'document');
      const after = parseJson<Doc>(edited, {}, 'document');
      if ('_id' in before) {
        if (!('_id' in after)) throw "cannot remove _id: a document's _id is immutable. Restore it and save again.";
        if (!jsonEqual(before._id, after._id)) throw "cannot change _id: a document's _id is immutable. Insert a new document instead.";
      }
      const { set, unset } = fieldUpdate(before, after);
      const change: Doc = {};
      if (Object.keys(set).length > 0) change.$set = set;
      if (Object.keys(unset).length > 0) change.$unset = unset;
      if (Object.keys(change).length === 0) return 0;
      if (isMock(state, id)) return 1;
      const found = collection(id, db, coll);
      const where = parseJson<Doc>(filter, {}, 'filter');
      const at = found.docs.findIndex((doc) => matches(doc, where));
      if (at < 0) return 0;
      const next = applyUpdate(found.docs[at], change);
      if (jsonEqual(next, found.docs[at])) return 0;
      // MongoDB refuses an update that gives a unique index a key another document has, and changes nothing.
      const clash = duplicateKey(`${String(db)}.${String(coll)}`, found, next, found.docs[at]);
      if (clash) throw `Failed to update document: ${clash}`;
      found.docs[at] = next;
      return 1;
    },
    delete_document: ({ id, database: db, collection: coll, filter }) => {
      guardWritable(state, id);
      const where = parseJson<Doc>(filter, {}, 'filter');
      if (isMock(state, id)) return 1;
      const docs = collection(id, db, coll).docs;
      const at = docs.findIndex((doc) => matches(doc, where));
      if (at < 0) return 0;
      docs.splice(at, 1);
      return 1;
    },
    delete_many: ({ id, database: db, collection: coll, filter, confirmed }) => {
      guardWritable(state, id, { destructive: true, confirmed });
      const where = parseJson<Doc>(filter, {}, 'filter');
      if (isMock(state, id)) return 0;
      const found = collection(id, db, coll);
      const before = found.docs.length;
      found.docs = found.docs.filter((doc) => !matches(doc, where));
      return before - found.docs.length;
    },
    update_many: ({ id, database: db, collection: coll, filter, update, confirmed }) => {
      guardWritable(state, id, { destructive: true, confirmed });
      const where = parseJson<Doc>(filter, {}, 'filter');
      const change = parseJson<Doc>(update, {}, 'update');
      const keys = Object.keys(change);
      if (keys.length === 0 || keys.some((key) => !key.startsWith('$'))) {
        throw 'Update must use operators like $set (e.g. { "$set": { … } })';
      }
      if (isMock(state, id)) return 0;
      const found = collection(id, db, coll);
      const ns = `${String(db)}.${String(coll)}`;
      // MongoDB's modified count: a match the update leaves as it was doesn't count.
      // A document the update can't take stops it with MongoDB's error, and like
      // a multi-update that stops at its first error, the documents already
      // updated keep their change.
      let modified = 0;
      for (const [i, doc] of found.docs.entries()) {
        if (!matches(doc, where)) continue;
        const next = applyUpdate(doc, change);
        if (!('_id' in next) || !jsonEqual(next._id, doc._id)) {
          throw "Failed to update documents: Performing an update on the path '_id' would modify the immutable field '_id'";
        }
        if (jsonEqual(next, doc)) continue;
        const clash = duplicateKey(ns, found, next, doc);
        if (clash) throw `Failed to update documents: ${clash}`;
        found.docs[i] = next;
        modified += 1;
      }
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
      { name: '_id_', keys: JSON.stringify({ _id: 1 }), unique: true, sparse: false },
      ...collection(id, db, coll).indexes.map((index) => ({
        name: index.name,
        keys: JSON.stringify(index.keys),
        unique: Boolean(index.unique),
        sparse: Boolean(index.sparse),
      })),
    ],
    create_index: ({ id, database: db, collection: coll, indexName, keys, unique, sparse }) => {
      guardWritable(state, id);
      const found = collection(id, db, coll);
      const name = String(indexName);
      const mock = isMock(state, id);
      const exists = found.indexes.some((index) => index.name === name);
      // The sample server keeps its own list of indexes, which this adds to; a name it already has stays as it is.
      if (exists && mock) return null;
      if (exists) throw `Index already exists: ${name}`;
      const parsedKeys = parseJson<Doc>(keys, {}, 'index keys');
      // MongoDB won't build a unique index over documents that already share a key.
      if (unique && !mock) {
        const clash = duplicateIndexKey(`${String(db)}.${String(coll)}`, name, parsedKeys, found.docs, Boolean(sparse));
        if (clash) throw `Failed to create index: ${clash}`;
      }
      found.indexes.push({ name, keys: parsedKeys, unique: Boolean(unique), sparse: Boolean(sparse) });
      return null;
    },
    delete_index: ({ id, database: db, collection: coll, indexName }) => {
      guardWritable(state, id);
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

    // Views and validation rules
    create_view: ({ id, database: db, viewName, sourceCollection, pipeline }) => {
      guardWritable(state, id);
      if (isBlank(viewName)) throw 'View name is required';
      if (isBlank(sourceCollection)) throw 'Source collection is required';
      let stages: unknown = [];
      try {
        stages = parseJson<unknown>(pipeline, [], 'pipeline');
      } catch (error) {
        throw `Invalid aggregation pipeline JSON: ${String(error)}`;
      }
      if (!Array.isArray(stages)) throw 'Aggregation pipeline must be a JSON array of stages';
      if (isMock(state, id)) return null;
      const collections = database(id, db);
      const ns = `${String(db)}.${String(viewName)}`;
      if (collections[String(viewName)]) throw `Collection already exists: ${ns}`;
      // A view is its pipeline over whatever its source holds when it's read,
      // so a later change to the source shows through. It can't be written to.
      const view: Collection = { type: 'view', docs: [], indexes: [] };
      Object.defineProperty(view, 'docs', {
        enumerable: true,
        get: () => aggregate(collections[String(sourceCollection)]?.docs ?? [], stages as Doc[]),
        set: () => {
          throw `Namespace ${ns} is a view, not a collection`;
        },
      });
      collections[String(viewName)] = view;
      return null;
    },
    get_collection_options: ({ id, database: db, collection: coll }) => {
      const none = { validator: '{}', validationLevel: '', validationAction: '' };
      if (isMock(state, id)) return none;
      return structuredClone(collection(id, db, coll).validation ?? none);
    },
    set_validator: ({ id, database: db, collection: coll, validator, validationLevel, validationAction }) => {
      guardWritable(state, id);
      let parsed: unknown = {};
      try {
        parsed = parseJson<unknown>(validator, {}, 'validator');
      } catch (error) {
        throw `Invalid validator JSON: ${String(error)}`;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw 'Validator must be a JSON object';
      if (isMock(state, id)) return null;
      collection(id, db, coll).validation = {
        validator: JSON.stringify(parsed, null, 2),
        validationLevel: String(validationLevel ?? ''),
        validationAction: String(validationAction ?? ''),
      };
      return null;
    },

    // Data generation (#91)
    infer_generate_template: ({ id, database: db, collection: coll }) =>
      inferTemplate(inferSchema(collection(id, db, coll).docs, 100)),
    preview_generated_documents: ({ template, count, seed }) =>
      previewDocuments(String(template), count == null ? undefined : Number(count), seed == null ? undefined : Number(seed)),
    start_generate_task: ({ id, database: db, collection: coll, template, count, seed }) => {
      guardWritable(state, id);
      const n = Number(count);
      if (!Number.isInteger(n) || n < 1 || n > GENERATE_CAP) throw `count must be between 1 and ${GENERATE_CAP}, got ${String(count)}`;
      const mock = isMock(state, id);
      if (mock && n > MOCK_GENERATE_CAP) {
        throw `Mock connections validate without writing and cap at ${MOCK_GENERATE_CAP} documents (got ${n}) — connect to a real database to generate up to ${GENERATE_CAP}`;
      }
      const docs = generateDocuments(String(template), n, seed == null ? undefined : Number(seed));
      // The sample server generates every batch to check the template, then drops it.
      if (!mock) {
        // A database-scoped run may name a collection that doesn't exist yet.
        const target = collectionForWrite(state, id, db, coll);
        target.docs.push(...docs.map((doc) => ({ _id: { $oid: newObjectId() }, ...doc })));
      }

      return recordTask(state, {
        kind: 'generate',
        label: `Generate ${n} documents`,
        subLabel: `${String(db)}.${String(coll)}`,
        startMessage: 'Generating documents…',
        message: mock ? `Validated ${n} documents (mock connection — not written)` : `Inserted ${n} documents`,
        processed: n,
        total: n,
      });
    },
  };

  backend.register(handlers);
}
