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
import {
  aggregate,
  applyUpdate,
  bsonEqual,
  find,
  inferSchema,
  jsonEqual,
  matches,
  mockFind,
  mockMatches,
  newObjectId,
  valuesAt,
} from '../mongo';
import { parseExactJson } from '../numeric';
import { buildFieldUpdate, parseProjection } from '../projection';
import type { Doc } from '../seed';
import type { Collection, CollectionQueries, E2EState, Server } from '../state';
import { recordTask } from '../tasks';
import { duplicateIndexKey, duplicateKey, parallelArrays, parallelArraysOver } from '../unique';
import { validationError } from '../validation';
import { defineView } from '../views';

const MOCK_AGGREGATE = 'Aggregation pipelines are not supported on mock connections';
const MOCK_GENERATE_CAP = 10_000;
const GENERATE_CAP = 50_000;
/** The history entries kept per collection (`HISTORY_CAP` in src-tauri/src/queries.rs). */
const HISTORY_CAP = 20;
/** The most documents an aggregation returns (`MAX_AGGREGATE_RESULTS` in src-tauri/src/limits.rs). */
const MAX_AGGREGATE_RESULTS = 1_000;

/** A find's page size as `normalize_query_limit` sets it: 100 when none is given, never more than 1000. */
const normalizeQueryLimit = (limit: number) => (limit <= 0 ? 100 : Math.min(limit, 1_000));

/**
 * The backend takes filters, sorts and pipelines as JSON strings; blank means
 * "none". An integer past 2^53 stays exact, as serde_json reads it.
 */
function parseJson<T>(value: unknown, fallback: T, what: string): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value as T;
  if (value.trim() === '') return fallback;
  try {
    return parseExactJson(value) as T;
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

  // A human OIDC login (#430) that `test_connection_uri` or `connect_db` is waiting on, keyed
  // by `loginId`. This fake can't observe a real browser or socket, so it
  // never completes a login on its own — it only ever answers Cancel, which
  // is all the e2e suite here exercises (Rust tests cover the real listener).
  const pendingOidcLogins = new Map<string, () => void>();

  /**
   * Write an aggregation's results the way its final `$out` or `$merge` stage
   * does. `$out` replaces the target's documents and keeps its indexes.
   * `$merge` matches on `on` (by default `_id`) and, by default, merges a match
   * and inserts the rest. An option the fake doesn't implement is rejected.
   */
  const writeAggregateOutput = (id: unknown, db: unknown, stage: Doc, results: Doc[]) => {
    const targetOf = (into: unknown) =>
      typeof into === 'string'
        ? { db: String(db), coll: into }
        : { db: String((into as Doc).db ?? db), coll: String((into as Doc).coll) };
    const withId = (doc: Doc): Doc => (doc._id === undefined ? { _id: { $oid: newObjectId() }, ...doc } : doc);

    if ('$out' in stage) {
      const target = targetOf(stage.$out);
      const ns = `${target.db}.${target.coll}`;
      const collections = (server(id).databases[target.db] ??= {});
      const existing = collections[target.coll];
      if (existing?.type === 'view') throw `Namespace ${ns} is a view, not a collection`;
      // Built aside and swapped in whole, so a refused document leaves the old collection as it was.
      const replacement: Collection = {
        type: 'collection',
        docs: [],
        indexes: structuredClone(existing?.indexes ?? []),
        validation: existing?.validation,
      };
      for (const doc of results) {
        const incoming = withId(structuredClone(doc));
        const refusal =
          validationError(replacement, incoming) ?? parallelArrays(replacement, incoming) ?? duplicateKey(ns, replacement, incoming);
        if (refusal) throw refusal;
        replacement.docs.push(incoming);
      }
      collections[target.coll] = replacement;
      return;
    }

    const spec: Doc = typeof stage.$merge === 'string' ? { into: stage.$merge } : (stage.$merge as Doc);
    const target = targetOf(spec.into);
    const ns = `${target.db}.${target.coll}`;
    const on = spec.on === undefined ? ['_id'] : (Array.isArray(spec.on) ? spec.on : [spec.on]).map(String);
    const to = collectionForWrite(state, id, target.db, target.coll);
    if (to.type === 'view') throw `Namespace ${ns} is a view, not a collection`;
    // Matching on anything but _id needs a unique index on exactly those fields.
    const onId = on.length === 1 && on[0] === '_id';
    if (!onId && !to.indexes.some((index) => index.unique && jsonEqual(Object.keys(index.keys).sort(), [...on].sort()))) {
      throw 'Cannot find index to verify that join fields will be unique';
    }
    const keyOf = (doc: Doc) => on.map((field) => valuesAt(doc, field)[0] ?? null);
    for (const doc of results) {
      // Keys compare as BSON values, so a result's { $numberLong: "1" } matches a stored 1.
      const at = to.docs.findIndex((stored) => bsonEqual(keyOf(stored), keyOf(doc)));
      if (at >= 0) {
        const whenMatched = spec.whenMatched ?? 'merge';
        // Matched on other fields, a result with a different _id would change the stored document's immutable _id.
        if ((whenMatched === 'merge' || whenMatched === 'replace') && doc._id !== undefined && !bsonEqual(doc._id, to.docs[at]._id)) {
          throw "$merge failed to update the matching document, did you attempt to modify the _id or the shard key? :: caused by :: Performing an update on the path '_id' would modify the immutable field '_id'";
        }
        let updated: Doc;
        switch (whenMatched) {
          case 'merge':
            updated = { ...to.docs[at], ...structuredClone(doc) };
            break;
          case 'replace':
            // A result without an _id keeps the stored document's.
            updated = { ...structuredClone(doc), _id: to.docs[at]._id };
            break;
          case 'keepExisting':
            continue;
          case 'fail':
            throw "$merge with whenMatched: fail found an existing document with the same values for the 'on' field";
          default:
            throw `Unsupported $merge whenMatched ${JSON.stringify(spec.whenMatched)} in the e2e fake backend`;
        }
        // The updated document goes through the validator and unique indexes, as any update does.
        const refusal =
          validationError(to, updated, to.docs[at]) ?? parallelArrays(to, updated) ?? duplicateKey(ns, to, updated, to.docs[at]);
        if (refusal) throw refusal;
        to.docs[at] = updated;
      } else {
        switch (spec.whenNotMatched ?? 'insert') {
          case 'insert': {
            const incoming = withId(structuredClone(doc));
            const refusal = validationError(to, incoming) ?? parallelArrays(to, incoming) ?? duplicateKey(ns, to, incoming);
            if (refusal) throw refusal;
            to.docs.push(incoming);
            break;
          }
          case 'discard':
            break;
          case 'fail':
            throw '$merge could not find a matching document in the target collection for at least one document in the source collection';
          default:
            throw `Unsupported $merge whenNotMatched ${JSON.stringify(spec.whenNotMatched)} in the e2e fake backend`;
        }
      }
    }
  };

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
    connect_db: ({ uri, loginId }) => {
      // An OIDC connect (#430) waits on the browser login the same way the
      // connection test does, until `cancel_oidc_login` ends it.
      if (/authMechanism=MONGODB-OIDC/i.test(String(uri))) {
        return new Promise((_resolve, reject) => {
          pendingOidcLogins.set(String(loginId), () => reject('auth.oidc.errors.cancelled'));
        });
      }
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
    test_connection_uri: ({ uri, onPhase, loginId }) => {
      const send = (message: Record<string, unknown>) =>
        (onPhase as { onmessage?: (m: unknown) => void } | undefined)?.onmessage?.(message);
      for (const phase of ['parse', 'resolve', 'connect']) {
        send({ phase, status: 'start' });
        send({ phase, status: 'ok' });
      }
      send({ phase: 'ping', status: 'start' });
      // A human OIDC login (#430): the driver authenticates lazily on the
      // first operation, so `authenticate` starts only once Ping already
      // has — matching the real backend's own phase order. The call then
      // hangs, exactly as the real one does while a browser login is in
      // flight, until `cancel_oidc_login` resolves it.
      if (/authMechanism=MONGODB-OIDC/i.test(String(uri))) {
        send({ phase: 'authenticate', status: 'start' });
        return new Promise((_resolve, reject) => {
          pendingOidcLogins.set(String(loginId), () => {
            send({ phase: 'authenticate', status: 'fail', message: 'auth.oidc.errors.cancelled' });
            reject('auth.oidc.errors.cancelled');
          });
        });
      }
      if (!serverKeyFor(state, String(uri))) {
        const message = `no server answers at ${String(uri)}`;
        send({ phase: 'ping', status: 'fail', message });
        throw message;
      }
      send({ phase: 'ping', status: 'ok' });
      return null;
    },
    cancel_oidc_login: ({ loginId }) => {
      const cancel = pendingOidcLogins.get(String(loginId));
      pendingOidcLogins.delete(String(loginId));
      cancel?.();
      return null;
    },
    // The real backend reopens the stored authorization URL and never
    // rebuilds the request; this fake has no browser to open, so recording
    // the call (via `backend.calls`) is the whole of what a test can assert.
    reopen_oidc_login: () => null,
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
      // The sample server checks the projection but doesn't apply it. Both cap the page the same way.
      const rows = isMock(state, id) ? mockFind(docs, options) : find(docs, { ...options, limit: normalizeQueryLimit(options.limit) });
      return rows.map((doc) => JSON.stringify(doc));
    },
    count_documents: ({ id, database: db, collection: coll, filter }) => {
      const where = parseJson<Doc>(filter, {}, 'filter');
      const match = isMock(state, id) ? mockMatches : matches;
      return collection(id, db, coll).docs.filter((doc) => match(doc, where)).length;
    },
    execute_aggregate: ({ id, database: db, collection: coll, pipeline, confirmed }) => {
      const stages = parseJson<Doc[]>(pipeline, [], 'pipeline');
      const writeAt = stages.findIndex((stage) => '$out' in stage || '$merge' in stage);
      if (writeAt >= 0) guardWritable(state, id, { destructive: true, confirmed });
      if (isMock(state, id)) throw MOCK_AGGREGATE;
      if (writeAt >= 0 && writeAt !== stages.length - 1) {
        throw `${'$out' in stages[writeAt] ? '$out' : '$merge'} can only be the final stage in the pipeline`;
      }
      const results = aggregate(collection(id, db, coll).docs, writeAt >= 0 ? stages.slice(0, -1) : stages);
      // A pipeline that ends in $out or $merge writes its results and returns none.
      if (writeAt >= 0) {
        writeAggregateOutput(id, db, stages[writeAt], results);
        return [];
      }
      if (results.length > MAX_AGGREGATE_RESULTS) {
        throw `Aggregation result capped at ${MAX_AGGREGATE_RESULTS} documents — add a $limit stage for larger pipelines`;
      }
      return results.map((doc) => JSON.stringify(doc));
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
      // MongoDB checks the collection's validator, then keys the document for its indexes.
      const refusal =
        validationError(target, doc) ?? parallelArrays(target, doc) ?? duplicateKey(`${String(db)}.${String(coll)}`, target, doc);
      if (refusal) throw `Failed to insert document: ${refusal}`;
      target.docs.push(doc);
      return JSON.stringify(doc._id);
    },
    update_document: ({ id, database: db, collection: coll, filter, original, edited, projection }) => {
      // Like the backend (#275): the app sends the document as loaded and as
      // edited, with the projection the row came back under, and only what
      // changed is written. An edit that would lose or overwrite what the
      // projection hid is refused, and nothing is written for rows from a
      // pipeline that reshapes documents, which arrive with a null projection.
      guardWritable(state, id);
      const where = parseJson<Doc>(filter, {}, 'filter');
      const before = parseJson<Doc>(original, {}, 'document');
      const after = parseJson<Doc>(edited, {}, 'document');
      const plan = buildFieldUpdate(before, after, parseProjection(projection));
      if (plan === null) return 0;
      if (isMock(state, id)) return 1;
      const found = collection(id, db, coll);
      const at = found.docs.findIndex((doc) => matches(doc, where));
      if (at < 0) return 0;
      // A changed field name an update operator can't address is saved by
      // replacing the document, which the backend does only when it was loaded whole.
      const next = 'replace' in plan ? structuredClone(after) : applyUpdate(found.docs[at], plan.update);
      if (jsonEqual(next, found.docs[at])) return 0;
      // MongoDB refuses an update the validator rejects, one its indexes can't key,
      // or one that gives a unique index a key another document has, and changes nothing.
      const refusal =
        validationError(found, next, found.docs[at]) ??
        parallelArrays(found, next) ??
        duplicateKey(`${String(db)}.${String(coll)}`, found, next, found.docs[at]);
      if (refusal) throw `Failed to update document: ${refusal}`;
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
        let next: Doc;
        try {
          next = applyUpdate(doc, change);
        } catch (error) {
          throw `Failed to update documents: ${String(error)}`;
        }
        if (!('_id' in next) || !jsonEqual(next._id, doc._id)) {
          throw "Failed to update documents: Performing an update on the path '_id' would modify the immutable field '_id'";
        }
        if (jsonEqual(next, doc)) continue;
        const clash = validationError(found, next, doc) ?? parallelArrays(found, next) ?? duplicateKey(ns, found, next, doc);
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
    // Newest first, without an earlier entry for the same query, and no more
    // than HISTORY_CAP of them (`push_history`).
    record_history: ({ connectionName, db, collection: coll, entry }) => {
      const queries = queriesFor(connectionName, db, coll);
      const next = entry as Doc;
      queries.history = [next, ...(queries.history as Doc[]).filter((earlier) => !jsonEqual(earlier.query, next.query))].slice(
        0,
        HISTORY_CAP,
      );
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
      // MongoDB won't build a compound index over a document with parallel
      // arrays, or a unique index over documents that already share a key.
      if (!mock) {
        const clash =
          parallelArraysOver(parsedKeys, found.docs) ??
          (unique ? duplicateIndexKey(`${String(db)}.${String(coll)}`, name, parsedKeys, found.docs, Boolean(sparse)) : null);
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
      // Every stage has to be a document, which the backend checks before its sample-server shortcut.
      for (const stage of stages) {
        if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) {
          throw `Invalid aggregation stage: expected a document, found ${stage === null ? 'null' : Array.isArray(stage) ? 'an array' : typeof stage}`;
        }
      }
      if (isMock(state, id)) return null;
      const collections = database(id, db);
      const ns = `${String(db)}.${String(viewName)}`;
      if (collections[String(viewName)]) throw `Collection already exists: ${ns}`;
      collections[String(viewName)] = defineView(collections, ns, String(sourceCollection), stages as Doc[]);
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
      let written = 0;
      let error: string | undefined;
      if (!mock) {
        // A database-scoped run may name a collection that doesn't exist yet.
        const target = collectionForWrite(state, id, db, coll);
        const ns = `${String(db)}.${String(coll)}`;
        // Written with ordered inserts: a document the validator or a unique index
        // refuses fails the task, and the documents before it stay.
        for (const doc of docs) {
          const incoming = { _id: { $oid: newObjectId() }, ...doc };
          const refusal = validationError(target, incoming) ?? parallelArrays(target, incoming) ?? duplicateKey(ns, target, incoming);
          if (refusal) {
            error = `Failed to insert: ${refusal}`;
            break;
          }
          target.docs.push(incoming);
          written += 1;
        }
      }

      return recordTask(state, {
        kind: 'generate',
        label: `Generate ${n} documents`,
        subLabel: `${String(db)}.${String(coll)}`,
        startMessage: 'Generating documents…',
        message: error ? 'Task failed' : mock ? `Validated ${n} documents (mock connection — not written)` : `Inserted ${n} documents`,
        error,
        processed: mock ? n : written,
        total: n,
      });
    },
  };

  backend.register(handlers);
}
