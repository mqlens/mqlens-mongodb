import { describe, it, expect } from 'vitest';
import { uniqueCollectionTabId } from '../tabId';

describe('uniqueCollectionTabId', () => {
  it('returns the base id unchanged when nothing else is open', () => {
    expect(uniqueCollectionTabId('conn.db.orders', [])).toBe('conn.db.orders');
  });

  it('returns the base id when the base id itself is not taken', () => {
    expect(uniqueCollectionTabId('conn.db.orders', ['conn.db.users'])).toBe('conn.db.orders');
  });

  it('appends ::2 when the base id is already open', () => {
    expect(uniqueCollectionTabId('conn.db.orders', ['conn.db.orders'])).toBe('conn.db.orders::2');
  });

  it('skips taken suffixes and returns the smallest free one', () => {
    expect(
      uniqueCollectionTabId('conn.db.orders', ['conn.db.orders', 'conn.db.orders::2', 'conn.db.orders::3']),
    ).toBe('conn.db.orders::4');
  });

  it('fills a gap left by a closed duplicate', () => {
    expect(
      uniqueCollectionTabId('conn.db.orders', ['conn.db.orders', 'conn.db.orders::3']),
    ).toBe('conn.db.orders::2');
  });

  it('keeps connectionId as the leading segment', () => {
    const id = uniqueCollectionTabId('profile:abc.db.orders', ['profile:abc.db.orders']);
    expect(id.startsWith('profile:abc.db.orders')).toBe(true);
  });
});
