import { describe, it, expect } from 'vitest';
import { undoBaseline, undoCondition } from '../undoEdit';

describe('undoBaseline', () => {
  it('gives a removed sub-document back as an empty parent, so undo adds its fields one by one', () => {
    const before = { _id: 1, name: 'A', address: { city: 'X', geo: { lat: 1 } } };
    const saved = { _id: 1, name: 'A' };
    expect(undoBaseline(saved, before)).toEqual({ _id: 1, name: 'A', address: { geo: {} } });
  });

  it('fills parents inside a sub-document the save kept', () => {
    const before = { _id: 1, address: { city: 'X', geo: { lat: 1 } } };
    const saved = { _id: 1, address: { city: 'X' } };
    expect(undoBaseline(saved, before)).toEqual({ _id: 1, address: { city: 'X', geo: {} } });
  });

  it('leaves typed values and empty documents alone: they are values, not parents', () => {
    const before = { _id: 1, at: { $date: '2024-01-01T00:00:00Z' }, empty: {}, tags: [{ a: 1 }] };
    const saved = { _id: 1 };
    expect(undoBaseline(saved, before)).toEqual({ _id: 1 });
  });

  it('changes nothing when the save removed no sub-document', () => {
    const before = { _id: 1, name: 'A', address: { city: 'X' } };
    const saved = { _id: 1, name: 'B', address: { city: 'Y' }, vip: true };
    expect(undoBaseline(saved, before)).toEqual(saved);
  });
});

describe('undoBaseline — emptied sub-documents', () => {
  it('fills parents inside a sub-document the save emptied but kept', () => {
    const before = { _id: 1, address: { geo: { lat: 1 } } };
    const saved = { _id: 1, address: {} };
    expect(undoBaseline(saved, before)).toEqual({ _id: 1, address: { geo: {} } });
  });
});

describe('undoCondition', () => {
  it('requires each value the save wrote to still be there, field by field', () => {
    const before = { _id: 1, name: 'A', email: 'a@x', tier: 'Gold' };
    const saved = { _id: 1, name: 'A', email: 'b@x', vip: true };
    expect(undoCondition(saved, before)).toEqual({ email: 'b@x', vip: true, tier: { $exists: false } });
  });

  it('reaches into sub-documents by path, so fields a projection hid are not compared', () => {
    const before = { _id: 1, address: { city: 'X', zip: '1' } };
    const saved = { _id: 1, address: { city: 'Y' } };
    expect(undoCondition(saved, before)).toEqual({ 'address.city': 'Y', 'address.zip': { $exists: false } });
  });

  it('compares typed values and arrays whole', () => {
    const before = { _id: 1, at: { $date: '2024-01-01T00:00:00Z' }, tags: ['a'] };
    const saved = { _id: 1, at: { $date: '2025-01-01T00:00:00Z' }, tags: ['a', 'b'] };
    expect(undoCondition(saved, before)).toEqual({ at: { $date: '2025-01-01T00:00:00Z' }, tags: ['a', 'b'] });
  });

  it('leaves out names a filter cannot address', () => {
    const before = { _id: 1, 'a.b': 1, $weird: 1 };
    const saved = { _id: 1, 'a.b': 2, $weird: 2 };
    expect(undoCondition(saved, before)).toEqual({});
  });
});

describe('undoCondition — removed sub-documents', () => {
  it('checks each field of a removed sub-document, as fields a projection hid may remain', () => {
    const before = { _id: 1, address: { city: 'X', geo: { lat: 1 } } };
    const saved = { _id: 1 };
    expect(undoCondition(saved, before)).toEqual({
      'address.city': { $exists: false },
      'address.geo.lat': { $exists: false },
    });
  });
});
