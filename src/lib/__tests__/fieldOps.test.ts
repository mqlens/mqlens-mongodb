import { describe, it, expect } from 'vitest';
import { addField, fieldNameError, fieldValue, removeField, renameField } from '../fieldOps';

const doc = () => ({ _id: { $oid: '603d779f4f102e3a105c3120' }, name: 'Ada', address: { city: 'Paris', zip: '75001' } });

describe('renameField', () => {
  it('moves a top-level value to the new name and leaves the input alone', () => {
    const input = doc();
    const out = renameField(input, ['name'], 'fullName');
    expect(out).toEqual({ _id: input._id, fullName: 'Ada', address: input.address });
    expect(input.name).toBe('Ada');
  });

  it('renames inside a sub-document', () => {
    expect(renameField(doc(), ['address', 'city'], 'town').address).toEqual({ town: 'Paris', zip: '75001' });
  });
});

describe('removeField', () => {
  it('drops a nested field and leaves the input alone', () => {
    const input = doc();
    expect(removeField(input, ['address', 'zip']).address).toEqual({ city: 'Paris' });
    expect(input.address.zip).toBe('75001');
  });
});

describe('addField', () => {
  it('adds at the top level for an empty parent path', () => {
    expect(addField(doc(), [], 'tier', 'pro').tier).toBe('pro');
  });

  it('adds inside a sub-document', () => {
    expect(addField(doc(), ['address'], 'country', 'FR').address).toEqual({ city: 'Paris', zip: '75001', country: 'FR' });
  });
});

describe('fieldNameError', () => {
  const siblings = { city: 'Paris', zip: '75001' };
  it.each([
    ['', 'empty'],
    ['a.b', 'dot'],
    ['$set', 'dollar'],
    ['zip', 'exists'],
  ])('refuses %j as %s', (name, error) => {
    expect(fieldNameError(name, siblings)).toBe(error);
  });

  it('accepts a new plain name', () => {
    expect(fieldNameError('country', siblings)).toBeNull();
  });
});

describe('fieldValue', () => {
  it.each([
    ['string', 'pro', 'pro'],
    ['string', '', ''],
    ['number', '42', 42],
    ['number', '1.5', 1.5],
    // Past 2^53 a JS number would round it; kept exact, as the in-place editor keeps it.
    ['number', '9007199254740993', { $numberLong: '9007199254740993' }],
    ['long', '9007199254740993', { $numberLong: '9007199254740993' }],
    ['decimal', '1.10', { $numberDecimal: '1.10' }],
    ['boolean', 'true', true],
    ['boolean', 'False', false],
    ['date', '2024-01-01T00:00:00Z', { $date: '2024-01-01T00:00:00Z' }],
    ['objectId', '603d779f4f102e3a105c3120', { $oid: '603d779f4f102e3a105c3120' }],
    ['null', '', null],
    ['object', '', {}],
    ['array', '', []],
  ])('reads a %s from %j', (type, text, expected) => {
    expect(fieldValue(type as any, text)).toEqual(expected);
  });

  it.each([
    ['number', 'abc'],
    ['number', ''],
    ['long', '1.5'],
    ['decimal', 'x'],
    ['boolean', 'yes'],
    ['date', 'not a date'],
    ['objectId', '123'],
  ])('refuses a %s from %j', (type, text) => {
    expect(() => fieldValue(type as any, text)).toThrow();
  });
});
