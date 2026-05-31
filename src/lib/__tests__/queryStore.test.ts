import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  loadCollectionQueries,
  saveQuery,
  deleteSavedQuery,
  recordHistory,
  setDefaultQuery,
} from '../queryStore';

describe('queryStore', () => {
  beforeEach(() => invokeMock.mockReset());

  it('loadCollectionQueries calls the command with the scope', async () => {
    invokeMock.mockResolvedValue({ saved: [], history: [], default: null });
    const res = await loadCollectionQueries('Local', 'db', 'coll');
    expect(invokeMock).toHaveBeenCalledWith('load_collection_queries', {
      connectionName: 'Local',
      db: 'db',
      collection: 'coll',
    });
    expect(res).toEqual({ saved: [], history: [], default: null });
  });

  it('saveQuery sends a SavedQuery with id + createdAt', async () => {
    invokeMock.mockResolvedValue(undefined);
    await saveQuery('Local', 'db', 'coll', 'My query', { queryType: 'find', filter: { a: 1 } });
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe('save_query');
    expect(args.connectionName).toBe('Local');
    expect(args.saved.name).toBe('My query');
    expect(args.saved.query).toEqual({ queryType: 'find', filter: { a: 1 } });
    expect(typeof args.saved.id).toBe('string');
    expect(args.saved.id.length).toBeGreaterThan(0);
    expect(typeof args.saved.createdAt).toBe('string');
  });

  it('deleteSavedQuery passes the id', async () => {
    invokeMock.mockResolvedValue(undefined);
    await deleteSavedQuery('Local', 'db', 'coll', 'id-1');
    expect(invokeMock).toHaveBeenCalledWith('delete_saved_query', {
      connectionName: 'Local',
      db: 'db',
      collection: 'coll',
      id: 'id-1',
    });
  });

  it('recordHistory sends an entry with ranAt', async () => {
    invokeMock.mockResolvedValue(undefined);
    await recordHistory('Local', 'db', 'coll', { queryType: 'find', filter: {} });
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe('record_history');
    expect(args.entry.query).toEqual({ queryType: 'find', filter: {} });
    expect(typeof args.entry.ranAt).toBe('string');
  });

  it('setDefaultQuery passes the body, or null to clear', async () => {
    invokeMock.mockResolvedValue(undefined);
    await setDefaultQuery('Local', 'db', 'coll', { queryType: 'find', filter: {} });
    expect(invokeMock).toHaveBeenLastCalledWith('set_default_query', {
      connectionName: 'Local',
      db: 'db',
      collection: 'coll',
      default: { queryType: 'find', filter: {} },
    });
    await setDefaultQuery('Local', 'db', 'coll', null);
    expect(invokeMock).toHaveBeenLastCalledWith('set_default_query', {
      connectionName: 'Local',
      db: 'db',
      collection: 'coll',
      default: null,
    });
  });
});
