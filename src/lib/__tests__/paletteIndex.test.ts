import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { loadNamespaceIndex, __clearNamespaceIndex } from '../paletteIndex';

beforeEach(() => {
  invoke.mockReset();
  __clearNamespaceIndex();
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

  it('returns an empty index for a failing connection without throwing', async () => {
    invoke.mockRejectedValue(new Error('down'));
    const ns = await loadNamespaceIndex([{ id: 'c1', name: 'prod' }]);
    expect(ns).toEqual([]);
  });
});
