import { describe, it, expect } from 'vitest';
import { Binary, Decimal128, Double, Int32, Long, ObjectId, Timestamp } from 'bson';
import {
  bsonCallOf,
  bsonInstanceTypeLabel,
  bsonCallText,
  bsonValueText,
  isBsonInstance,
  jsonStringLiteral,
  plainBsonShape,
  tableValueText,
} from '../bsonDisplay';

describe('bsonValueText — what the JSON and tree views display', () => {
  it('shows BSON as the constructor call, not the bare scalar', () => {
    // The distinction local find got wrong at first: "copy value" yields the
    // hex, but the screen shows the call, so the call is what must be findable.
    const oid = new ObjectId('507f1f77bcf86cd799439011');
    expect(bsonValueText(oid)).toBe('ObjectId("507f1f77bcf86cd799439011")');
    expect(bsonValueText(new Date('2026-08-27T10:00:00.000Z'))).toBe(
      'ISODate("2026-08-27T10:00:00.000Z")',
    );
    expect(bsonValueText(Long.fromString('9007199254740993'))).toBe(
      'NumberLong(9007199254740993)',
    );
    expect(bsonValueText(Decimal128.fromString('1.25'))).toBe('NumberDecimal("1.25")');
    expect(bsonValueText(new Int32(7))).toBe('NumberInt(7)');
    expect(bsonValueText(new Double(1.5))).toBe('Double(1.5)');
  });

  it('quotes and escapes strings the way the view renders them', () => {
    expect(bsonValueText('Alice')).toBe('"Alice"');
    // A newline is on screen as the two characters \n, so that is what a search
    // for \n has to match.
    expect(bsonValueText('a\nb')).toBe('"a\\nb"');
    expect(bsonValueText('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('leaves the bare literals bare', () => {
    expect(bsonValueText(null)).toBe('null');
    expect(bsonValueText(true)).toBe('true');
    expect(bsonValueText(false)).toBe('false');
    expect(bsonValueText(42)).toBe('42');
    expect(bsonValueText(undefined)).toBe('');
  });

  it('gives BinData both of its displayed arguments', () => {
    const bin = new Binary(Buffer.from('hi'), 0);
    expect(bsonValueText(bin)).toBe(`BinData(0, ${JSON.stringify(bin.toString('base64'))})`);
  });

  it('renders a Timestamp through its own toString, as the view does', () => {
    const ts = new Timestamp({ t: 1, i: 2 });
    expect(bsonValueText(ts)).toBe(`Timestamp(${ts.toString()})`);
  });
});

describe('bsonCallOf', () => {
  it('describes the argument colour alongside its text', () => {
    expect(bsonCallOf(new ObjectId('507f1f77bcf86cd799439011'))).toEqual({
      ctor: 'ObjectId',
      args: [{ text: '"507f1f77bcf86cd799439011"', kind: 'string' }],
    });
    expect(bsonCallOf(Long.fromString('42'))).toEqual({
      ctor: 'NumberLong',
      args: [{ text: '42', kind: 'number' }],
    });
  });

  it('is null for values the grid does not call a constructor on', () => {
    expect(bsonCallOf('plain')).toBeNull();
    expect(bsonCallOf(7)).toBeNull();
    expect(bsonCallOf({ city: 'Pforzheim' })).toBeNull();
    expect(bsonCallOf({ $oid: '507f1f77bcf86cd799439011' })).toBeNull();
    expect(bsonCallOf(null)).toBeNull();
  });

  it('agrees with isBsonInstance', () => {
    for (const v of [new ObjectId(), new Date(), Long.fromString('1'), new Int32(1)]) {
      expect(isBsonInstance(v)).toBe(true);
    }
    for (const v of [{ $oid: 'x' }, 'x', 1, null, undefined, { a: 1 }]) {
      expect(isBsonInstance(v)).toBe(false);
    }
  });

  it('joins multi-argument calls the way the renderer spaces them', () => {
    expect(bsonCallText({ ctor: 'BinData', args: [
      { text: '0', kind: 'number' },
      { text: '"aGk="', kind: 'string' },
    ] })).toBe('BinData(0, "aGk=")');
  });
});

describe('plainBsonShape — the table view’s extended-JSON shapes', () => {
  it('unwraps the shapes the backend sends', () => {
    expect(plainBsonShape({ $oid: '507f1f77bcf86cd799439011' })).toEqual({
      text: '507f1f77bcf86cd799439011',
      kind: 'string',
    });
    expect(plainBsonShape({ $date: '2026-08-27T10:00:00.000Z' })).toEqual({
      text: '2026-08-27T10:00:00.000Z',
      kind: 'string',
    });
    expect(plainBsonShape({ $date: { $numberLong: '0' } })).toEqual({
      text: '1970-01-01T00:00:00.000Z',
      kind: 'string',
    });
    expect(plainBsonShape({ $numberLong: '42' })).toEqual({ text: '42', kind: 'number' });
    expect(plainBsonShape({ $numberDecimal: '1.25' })).toEqual({ text: '1.25', kind: 'number' });
    expect(plainBsonShape({ $numberInt: '7' })).toEqual({ text: '7', kind: 'number' });
    expect(plainBsonShape({ $numberDouble: '1.5' })).toEqual({ text: '1.5', kind: 'number' });
  });

  it('is null for an ordinary object', () => {
    expect(plainBsonShape({ city: 'Pforzheim' })).toBeNull();
  });
});

describe('tableValueText — what the table view displays', () => {
  it('shows strings unquoted, unlike the JSON view', () => {
    // The same document reads differently in the two views, and find follows
    // whichever one is on screen.
    expect(tableValueText('Alice')).toBe('Alice');
    expect(bsonValueText('Alice')).toBe('"Alice"');
  });

  it('shows the backend’s ObjectId as the bare hex the cell renders', () => {
    expect(tableValueText({ $oid: '507f1f77bcf86cd799439011' })).toBe(
      '507f1f77bcf86cd799439011',
    );
  });

  it('still calls a constructor when the value is a real BSON instance', () => {
    // renderColoredCell delegates those to renderBsonValueNode, so the text does too.
    expect(tableValueText(new ObjectId('507f1f77bcf86cd799439011'))).toBe(
      'ObjectId("507f1f77bcf86cd799439011")',
    );
  });

  it('falls back to JSON for a nested container, as the muted cell does', () => {
    expect(tableValueText({ city: 'Pforzheim' })).toBe('{"city":"Pforzheim"}');
  });

  it('is empty for an absent value', () => {
    expect(tableValueText(null)).toBe('');
    expect(tableValueText(undefined)).toBe('');
  });
});

describe('jsonStringLiteral', () => {
  it('is the quoting the JSON views use', () => {
    expect(jsonStringLiteral('a"b')).toBe('"a\\"b"');
  });
});

describe('bsonInstanceTypeLabel — the tree’s Type column', () => {
  it('names each BSON type the grid displays', () => {
    expect(bsonInstanceTypeLabel(new ObjectId())).toBe('ObjectId');
    expect(bsonInstanceTypeLabel(new Date())).toBe('Date');
    expect(bsonInstanceTypeLabel(Decimal128.fromString('1.25'))).toBe('Decimal128');
    expect(bsonInstanceTypeLabel(Long.fromString('42'))).toBe('Int64');
    expect(bsonInstanceTypeLabel(new Int32(7))).toBe('Int32');
    expect(bsonInstanceTypeLabel(new Double(1.5))).toBe('Double');
    expect(bsonInstanceTypeLabel(new Binary(Buffer.from('hi'), 0))).toBe('Binary');
  });

  it('labels a Timestamp as Timestamp, not as its Long base class', () => {
    // The label and the constructor call now come from one ordered list, so the
    // Type column cannot say Int64 while the value says Timestamp(…).
    const ts = new Timestamp({ t: 1, i: 2 });
    expect(bsonInstanceTypeLabel(ts)).toBe('Timestamp');
    expect(bsonValueText(ts)).toBe(`Timestamp(${ts.toString()})`);
  });

  it('is null for values the grid labels itself', () => {
    for (const v of [null, undefined, 'text', 7, true, { a: 1 }, [1, 2]]) {
      expect(bsonInstanceTypeLabel(v)).toBeNull();
    }
  });
});
