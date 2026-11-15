import { describe, it, expect } from 'vitest';
import { undoBaseline } from '../undoEdit';

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
