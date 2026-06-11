import { invoke } from '@tauri-apps/api/core';

// Lazily-built namespace index for the command palette: databases and
// collections per active connection, cached per connection id so opening the
// palette repeatedly does not refetch. The cache lives for the app session;
// a reconnect gets a new connection id and therefore a fresh entry.
export interface NamespaceEntry {
  connectionId: string;
  connectionName: string;
  db: string;
  collections: string[];
}

const cache = new Map<string, Promise<NamespaceEntry[]>>();

export function __clearNamespaceIndex() {
  cache.clear();
}

async function fetchConnection(id: string, name: string): Promise<NamespaceEntry[]> {
  try {
    const dbs = await invoke<string[]>('list_databases', { id });
    return await Promise.all(
      dbs.map(async (db) => ({
        connectionId: id,
        connectionName: name,
        db,
        collections: (await invoke<{ name: string }[]>('list_collections', { id, db })).map((c) => c.name),
      })),
    );
  } catch {
    return [];
  }
}

export async function loadNamespaceIndex(
  connections: { id: string; name: string }[],
): Promise<NamespaceEntry[]> {
  const perConnection = await Promise.all(
    connections.map((c) => {
      let entry = cache.get(c.id);
      if (!entry) {
        entry = fetchConnection(c.id, c.name);
        cache.set(c.id, entry);
      }
      return entry;
    }),
  );
  return perConnection.flat();
}
