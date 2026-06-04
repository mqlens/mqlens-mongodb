import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => invoke(...a) }));

import { useCollectionSchema, __clearSchemaCache } from '../useCollectionSchema';

beforeEach(() => { invoke.mockReset(); __clearSchemaCache(); });

const report = JSON.stringify({
  sampled: 3,
  fields: [
    { path: 'plan', types: [{ type: 'string', count: 3 }], presence: 3, coverage: 1, enumValues: ['Free', 'Team'] },
    { path: 'seats', types: [{ type: 'int', count: 3 }], presence: 3, coverage: 1 },
  ],
});

describe('useCollectionSchema', () => {
  it('fetches once and maps path -> {type, enumValues}', async () => {
    invoke.mockResolvedValue(report);
    const { result } = renderHook(() => useCollectionSchema('c1', 'db', 'coll'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.schema.get('plan')).toEqual({ type: 'string', enumValues: ['Free', 'Team'] });
    expect(result.current.schema.get('seats')).toEqual({ type: 'int', enumValues: undefined });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('caches per (conn,db,coll) — second hook does not refetch', async () => {
    invoke.mockResolvedValue(report);
    const h1 = renderHook(() => useCollectionSchema('c1', 'db', 'coll'));
    await waitFor(() => expect(h1.result.current.ready).toBe(true));
    renderHook(() => useCollectionSchema('c1', 'db', 'coll'));
    await waitFor(() => {});
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('on error resolves to an empty map', async () => {
    invoke.mockRejectedValue('boom');
    const { result } = renderHook(() => useCollectionSchema('c1', 'db', 'coll'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.schema.size).toBe(0);
  });
});
