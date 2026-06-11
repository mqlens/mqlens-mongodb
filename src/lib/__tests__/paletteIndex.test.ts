import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { loadNamespaceIndex, matchesNamespaceScope, __clearNamespaceIndex } from '../paletteIndex';

beforeEach(() => {
  invoke.mockReset();
  __clearNamespaceIndex();
});

describe('matchesNamespaceScope', () => {
  const target = {
    connectionName: 'm01-test-01',
    db: 'cidaas-widas-test',
    collection: 'ReleaseManagement_UpdateRequest',
  };

  it('matches sidebar-style filters against connection, database, and collection text', () => {
    expect(matchesNamespaceScope('widas', target)).toBe(true);
    expect(matchesNamespaceScope('release', target)).toBe(true);
    expect(matchesNamespaceScope('m01', target)).toBe(true);
  });

  it('rejects namespaces outside the sidebar filter scope', () => {
    expect(matchesNamespaceScope('camlog', target)).toBe(false);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const wireMock = () => {
  invoke.mockImplementation(async (cmd: string, args: { id: string; db?: string }) => {
    if (cmd === 'list_databases') return ['shop', 'logs'];
    if (cmd === 'list_collections') return args.db === 'shop'
      ? [{ name: 'users' }, { name: 'orders' }]
      : [{ name: 'events' }];
    throw new Error(`unexpected ${cmd}`);
  });
};

describe('loadNamespaceIndex', () => {
  it('lists databases and collections per active connection', async () => {
    wireMock();
    const ns = await loadNamespaceIndex([{ id: 'c1', name: 'prod' }]);
    expect(ns).toEqual([
      { connectionId: 'c1', connectionName: 'prod', db: 'shop', collections: ['users', 'orders'] },
      { connectionId: 'c1', connectionName: 'prod', db: 'logs', collections: ['events'] },
    ]);
  });

  it('caches per connection — repeated loads do not refetch', async () => {
    wireMock();
    await loadNamespaceIndex([{ id: 'c1', name: 'prod' }]);
    const calls = invoke.mock.calls.length;
    await loadNamespaceIndex([{ id: 'c1', name: 'prod' }]);
    expect(invoke.mock.calls.length).toBe(calls);
  });

  it('can force refresh cached namespaces', async () => {
    wireMock();
    await loadNamespaceIndex([{ id: 'c1', name: 'prod' }]);
    const calls = invoke.mock.calls.length;
    await loadNamespaceIndex([{ id: 'c1', name: 'prod' }], { forceRefresh: true });
    expect(invoke.mock.calls.length).toBeGreaterThan(calls);
  });

  it('expires cached namespaces after the TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    wireMock();
    await loadNamespaceIndex([{ id: 'c1', name: 'prod' }], { ttlMs: 100 });
    const calls = invoke.mock.calls.length;
    vi.setSystemTime(101);
    await loadNamespaceIndex([{ id: 'c1', name: 'prod' }], { ttlMs: 100 });
    expect(invoke.mock.calls.length).toBeGreaterThan(calls);
  });

  it('clears one cached connection without clearing others', async () => {
    wireMock();
    await loadNamespaceIndex([{ id: 'c1', name: 'prod' }, { id: 'c2', name: 'stage' }]);
    const calls = invoke.mock.calls.length;
    __clearNamespaceIndex('c1');
    await loadNamespaceIndex([{ id: 'c1', name: 'prod' }, { id: 'c2', name: 'stage' }]);
    expect(invoke.mock.calls.length).toBe(calls + 3);
  });

  it('returns an empty index for a failing connection without throwing', async () => {
    invoke.mockRejectedValue(new Error('down'));
    const ns = await loadNamespaceIndex([{ id: 'c1', name: 'prod' }]);
    expect(ns).toEqual([]);
  });
});
