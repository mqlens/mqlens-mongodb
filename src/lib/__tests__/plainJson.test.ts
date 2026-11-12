import { describe, expect, it } from 'vitest';
import { Binary, BSONRegExp, BSONSymbol, Code, DBRef, Decimal128, Double, EJSON, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp, UUID } from 'bson';
import { toPlainJson } from '../plainJson';

describe('toPlainJson', () => {
  it('recursively converts BSON scalars to predictable JSON values without mutating them', () => {
    const id = new ObjectId('603d779f4f102e3a185c3220');
    const date = new Date('2026-06-15T15:48:03.793Z');
    const input = { id, nested: [date, Long.fromString('9223372036854775807'), Decimal128.fromString('123.450')],
      timestamp: Timestamp.fromBits(3, 2), binary: new Binary(new Uint8Array([1, 2, 3])),
      uuid: new UUID('00112233-4455-6677-8899-aabbccddeeff'), int: new Int32(42), double: new Double(1.5),
      regex: new BSONRegExp('a.*', 'im'), code: new Code('return x', { x: 1 }), symbol: new BSONSymbol('s'),
      min: new MinKey(), max: new MaxKey(), ref: new DBRef('users', id, 'shop', { extra: id }),
      empty: {}, nil: null, bool: true, text: 'line\n"quoted"', ordinary: { $custom: 'kept' } };
    const output = toPlainJson(input);
    expect(output).toEqual({ id: id.toHexString(), nested: [date.toISOString(), '9223372036854775807', '123.450'],
      timestamp: input.timestamp.toString(), binary: 'AQID', uuid: input.uuid.toString('base64'), int: 42, double: 1.5,
      regex: '/a.*/im', code: 'return x', symbol: 's', min: 'MinKey', max: 'MaxKey',
      ref: { $ref: 'users', $id: id.toHexString(), $db: 'shop', extra: id.toHexString() },
      empty: {}, nil: null, bool: true, text: 'line\n"quoted"', ordinary: { $custom: 'kept' } });
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
    expect(input.id).toBe(id);
    expect(input.nested[0]).toBe(date);
    expect(input.code.scope).toEqual({ x: 1 });
  });

  it('preserves unsafe integers and special numbers as strings and handles invalid dates', () => {
    expect(toPlainJson(EJSON.parse('{"n":{"$numberLong":"9007199254740993"}}', { relaxed: false })))
      .toEqual({ n: '9007199254740993' });
    expect(toPlainJson([NaN, Infinity, -Infinity, new Double(NaN), new Date(NaN), undefined]))
      .toEqual(['NaN', 'Infinity', '-Infinity', 'NaN', null, null]);
    expect(toPlainJson(new DBRef('users', new ObjectId('603d779f4f102e3a185c3220'))))
      .toEqual({ $ref: 'users', $id: '603d779f4f102e3a185c3220' });
  });
});
