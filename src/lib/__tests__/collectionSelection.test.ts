import { describe, it, expect } from 'vitest';
import { emptySelection, toggleCollection } from '../collectionSelection';

describe('collection selection', () => {
  it('toggles names within a scope', () => {
    let s = toggleCollection(emptySelection(), 'c1', 'app', 'orders');
    expect([...s.names]).toEqual(['orders']);
    s = toggleCollection(s, 'c1', 'app', 'users');
    expect(s.names.has('orders') && s.names.has('users')).toBe(true);
    s = toggleCollection(s, 'c1', 'app', 'orders');
    expect(s.names.has('orders')).toBe(false);
  });

  it('clears selection when switching to a different db scope', () => {
    let s = toggleCollection(emptySelection(), 'c1', 'app', 'orders');
    s = toggleCollection(s, 'c1', 'other', 'logs');
    expect([...s.names]).toEqual(['logs']);
  });
});
