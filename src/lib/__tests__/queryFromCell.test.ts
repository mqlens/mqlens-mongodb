import { describe, it, expect } from 'vitest';
import { ObjectId, Long } from 'bson';
import {
  addFilterCondition,
  addProjectionField,
  isFilterableValue,
  sortByField,
} from '../queryFromCell';
import { parseQueryObject } from '../shellDoc';

const OID = '64f1a2b3c4d5e6f708091a2b';
/** The query the produced text runs as. */
const run = (text: string) => parseQueryObject(text);

describe('isFilterableValue', () => {
  it('accepts single values, typed or not', () => {
    for (const v of ['a', 0, false, null, { $oid: OID }, { $date: '2024-01-01T00:00:00Z' }, new ObjectId(OID), new Date(0)]) {
      expect(isFilterableValue(v)).toBe(true);
    }
  });

  it('rejects a missing field, arrays and sub-documents', () => {
    for (const v of [undefined, [1, 2], { city: 'Oslo' }, {}]) {
      expect(isFilterableValue(v)).toBe(false);
    }
  });
});

describe('addFilterCondition', () => {
  it('starts a filter from empty text', () => {
    expect(run(addFilterCondition('', 'status', 'active', 'eq'))).toEqual({ status: 'active' });
    expect(run(addFilterCondition('  ', 'status', 'active', 'ne'))).toEqual({ status: { $ne: 'active' } });
  });

  it('writes one line, and leaves a newline inside a value alone', () => {
    const text = addFilterCondition('{ a: 1 }', 'note', 'line one\n  line two', 'eq');
    expect(text).toBe('{ "a" : 1, "note" : "line one\\n  line two" }');
    expect(run(text)).toEqual({ a: 1, note: 'line one\n  line two' });
  });

  it('keeps the value typed, from Extended JSON or a BSON instance', () => {
    const fromEjson = addFilterCondition('', '_id', { $oid: OID }, 'eq');
    expect(fromEjson).toContain(`ObjectId("${OID}")`);
    expect(run(fromEjson)).toEqual({ _id: { $oid: OID } });
    expect(run(addFilterCondition('', '_id', new ObjectId(OID), 'eq'))).toEqual({ _id: { $oid: OID } });

    const date = addFilterCondition('', 'at', new Date('2024-01-02T03:04:05.000Z'), 'eq');
    expect(date).toContain('ISODate("2024-01-02T03:04:05.000Z")');
    expect(run(date)).toEqual({ at: { $date: '2024-01-02T03:04:05Z' } });

    expect(run(addFilterCondition('', 'n', Long.fromString('9007199254740993'), 'eq')))
      .toEqual({ n: { $numberLong: '9007199254740993' } });
  });

  it('does not turn a string that looks like another type into that type', () => {
    expect(run(addFilterCondition('', 'code', '42', 'eq'))).toEqual({ code: '42' });
    expect(run(addFilterCondition('', 'flag', 'true', 'eq'))).toEqual({ flag: 'true' });
    expect(run(addFilterCondition('', 'gone', null, 'eq'))).toEqual({ gone: null });
  });

  it('narrows: other conditions survive, hand-written ones included', () => {
    const text = '{ items: { $elemMatch: { qty: { $gt: 2 } } }, $or: [{ a: 1 }, { b: 2 }] }';
    expect(run(addFilterCondition(text, 'address.city', 'Oslo', 'eq'))).toEqual({
      items: { $elemMatch: { qty: { $gt: 2 } } },
      $or: [{ a: 1 }, { b: 2 }],
      'address.city': 'Oslo',
    });
  });

  it('keeps typed values already in the filter', () => {
    const text = `{ _id: ObjectId("${OID}"), at: { $gte: ISODate("2024-01-01T00:00:00Z") } }`;
    expect(run(addFilterCondition(text, 'status', 'x', 'eq'))).toEqual({
      _id: { $oid: OID },
      at: { $gte: { $date: '2024-01-01T00:00:00Z' } },
      status: 'x',
    });
  });

  it('replaces an earlier condition on the same field with the equality', () => {
    expect(run(addFilterCondition('{ status: { $ne: "a" }, n: 1 }', 'status', 'b', 'eq')))
      .toEqual({ status: 'b', n: 1 });
  });

  it('collects excluded values of one field into $nin', () => {
    let text = addFilterCondition('', 'status', 'a', 'ne');
    text = addFilterCondition(text, 'status', 'b', 'ne');
    expect(run(text)).toEqual({ status: { $nin: ['a', 'b'] } });
    text = addFilterCondition(text, 'status', 'c', 'ne');
    text = addFilterCondition(text, 'status', 'c', 'ne');
    expect(run(text)).toEqual({ status: { $nin: ['a', 'b', 'c'] } });
  });

  it('excludes typed values without mistaking them for operators', () => {
    let text = addFilterCondition('', 'owner', { $oid: OID }, 'eq');
    text = addFilterCondition(text, 'owner', { $oid: OID }, 'ne');
    expect(run(text)).toEqual({ owner: { $ne: { $oid: OID } } });
  });

  it('adds the exclusion beside other operators on the field', () => {
    expect(run(addFilterCondition('{ age: { $gt: 18 } }', 'age', 30, 'ne')))
      .toEqual({ age: { $gt: 18, $ne: 30 } });
    expect(run(addFilterCondition('{ name: { $regex: "^a" } }', 'name', 'abe', 'ne')))
      .toEqual({ name: { $regex: '^a', $ne: 'abe' } });
  });

  it('throws on text that is not a query, leaving the caller to keep it', () => {
    expect(() => addFilterCondition('{ status: ', 'a', 1, 'eq')).toThrow();
  });
});

describe('addProjectionField', () => {
  it('includes the field', () => {
    expect(run(addProjectionField('', 'name'))).toEqual({ name: 1 });
    expect(run(addProjectionField('{ name: 1 }', 'address.city'))).toEqual({ name: 1, 'address.city': 1 });
    expect(run(addProjectionField('{ _id: 0, name: 1 }', 'price'))).toEqual({ _id: 0, name: 1, price: 1 });
  });

  it('un-hides the field in a projection that works by excluding', () => {
    expect(run(addProjectionField('{ secret: 0, name: 0 }', 'name'))).toEqual({ secret: 0 });
    // Already returned: adding `price: 1` would make MongoDB reject the mix.
    expect(run(addProjectionField('{ secret: 0 }', 'price'))).toEqual({ secret: 0 });
    expect(addProjectionField('{ name: 0 }', 'name')).toBe('');
  });
});

describe('sortByField', () => {
  it('sorts by that field alone', () => {
    expect(run(sortByField('address.city', 1))).toEqual({ 'address.city': 1 });
    expect(run(sortByField('price', -1))).toEqual({ price: -1 });
  });
});
