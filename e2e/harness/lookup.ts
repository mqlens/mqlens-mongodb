// Finding a connection's server, databases and collections in the fake backend's state (#396).
import type { Collection, E2EState, Server } from './state';

export function serverOf(state: E2EState, id: unknown): Server {
  const conn = state.connections[String(id)];
  if (!conn) throw `Connection not found: ${String(id)}`;
  return state.servers[conn.uri];
}

export function databaseOf(state: E2EState, id: unknown, db: unknown): Record<string, Collection> {
  const found = serverOf(state, id).databases[String(db)];
  if (!found) throw `Database not found: ${String(db)}`;
  return found;
}

export function collectionOf(state: E2EState, id: unknown, db: unknown, coll: unknown): Collection {
  const found = databaseOf(state, id, db)[String(coll)];
  if (!found) throw `Collection not found: ${String(db)}.${String(coll)}`;
  return found;
}

/** A collection to write into, created with its database when they don't exist yet, as a write does in MongoDB. */
export function collectionForWrite(state: E2EState, id: unknown, db: unknown, coll: unknown): Collection {
  const databases = serverOf(state, id).databases;
  const collections = (databases[String(db)] ??= {});
  return (collections[String(coll)] ??= { type: 'collection', docs: [], indexes: [] });
}
