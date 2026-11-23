import { describe, it, expect } from 'vitest';
import { bareObjectIdFilter, convertObjectIdStrings, resolveFindFilter } from '../objectIdQuery';
import type { SchemaMap } from '../useCollectionSchema';

const A = '64f1a2b3c4d5e6f708091a2b';
const B = '0123456789abcdef01234567';
const schema: SchemaMap = new Map([
  ['_id', { type: 'objectId' }],
  ['userId', { type: 'objectId' }],
  ['owner.id', { type: 'objectId' }],
  ['token', { type: 'string' }],
]);
const ON = { autoConvertObjectId: true, defaultIdSearch: true };
const OFF = { autoConvertObjectId: false, defaultIdSearch: false };

describe('bareObjectIdFilter', () => {
  it.each([A, ` ${A}\n`, `"${A}"`, `'${A}'`, `ObjectId("${A}")`, `ObjectId('${A}')`])(
    'turns %j into an _id lookup',
    (text) => {
      expect(bareObjectIdFilter(text)).toBe(`{ _id: ObjectId("${A}") }`);
    },
  );

  it.each(['', '{}', A.slice(1), `${A}0`, `{ _id: "${A}" }`, `"${A}'`, 'zzzzzzzzzzzzzzzzzzzzzzzz'])(
    'leaves %j alone',
    (text) => {
      expect(bareObjectIdFilter(text)).toBeNull();
    },
  );
});

describe('convertObjectIdStrings', () => {
  it('converts direct, operator, list, nested and logical comparisons', () => {
    const input = {
      userId: A,
      _id: { $in: [A, B, 'not-an-id'], $ne: B },
      'owner.id': { $not: { $eq: A } },
      owner: { id: B },
      $or: [{ userId: { $gt: A } }, { token: A }],
    };
    const { filter, converted } = convertObjectIdStrings(input, schema);
    expect(filter).toEqual({
      userId: { $oid: A },
      _id: { $in: [{ $oid: A }, { $oid: B }, 'not-an-id'], $ne: { $oid: B } },
      'owner.id': { $not: { $eq: { $oid: A } } },
      owner: { id: { $oid: B } },
      $or: [{ userId: { $gt: { $oid: A } } }, { token: A }],
    });
    expect(converted).toHaveLength(7);
    // The input is not mutated.
    expect(input.userId).toBe(A);
  });

  it('leaves string fields, unknown fields, existing ObjectIds and other operators alone', () => {
    const input = {
      token: A,
      unknown: A,
      userId: { $oid: A },
      _id: { $regex: A, $exists: true },
    };
    const { filter, converted } = convertObjectIdStrings(input, schema);
    expect(filter).toEqual(input);
    expect(converted).toEqual([]);
  });
});

describe('resolveFindFilter', () => {
  it('runs a bare ObjectId as an _id lookup', () => {
    expect(resolveFindFilter(A, schema, ON)).toEqual({
      filter: { _id: { $oid: A } },
      text: `{ _id: ObjectId("${A}") }`,
    });
  });

  it('wraps converted strings in ObjectId() and keeps the rest of the text', () => {
    const text = `{ userId: '${A}',  token: "x" }`;
    expect(resolveFindFilter(text, schema, ON)).toEqual({
      filter: { userId: { $oid: A }, token: 'x' },
      text: `{ userId: ObjectId("${A}"),  token: "x" }`,
    });
  });

  it('does not double-wrap an ObjectId that shares its hex with a converted string', () => {
    const text = `{ _id: ObjectId("${A}"), userId: "${A}" }`;
    expect(resolveFindFilter(text, schema, ON).text).toBe(
      `{ _id: ObjectId("${A}"), userId: ObjectId("${A}") }`,
    );
  });

  it('falls back to EJSON when the same hex is also a plain string elsewhere', () => {
    const r = resolveFindFilter(`{ userId: "${A}", token: "${A}" }`, schema, ON);
    expect(r.filter).toEqual({ userId: { $oid: A }, token: A });
    expect(r.text).toBe(JSON.stringify(r.filter));
  });

  it('returns the text untouched when nothing applies', () => {
    const text = `{ token: "${A}" }`;
    expect(resolveFindFilter(text, schema, ON)).toEqual({ filter: { token: A }, text });
    expect(resolveFindFilter('', schema, ON)).toEqual({ filter: {}, text: '' });
  });

  it('does nothing when both settings are off', () => {
    const text = `{ userId: "${A}" }`;
    expect(resolveFindFilter(text, schema, OFF)).toEqual({ filter: { userId: A }, text });
    expect(() => resolveFindFilter(A, schema, OFF)).toThrow();
  });
});

describe('rewriting the filter text', () => {
  it('rewrites every id of a long $in list, leaving other hex strings alone', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => i.toString(16).padStart(24, '0'));
    const text = `{ userId: { $in: [${ids.map((id) => `"${id}"`).join(', ')}] }, token: "${A}" }`;
    const resolved = resolveFindFilter(text, schema, ON);
    expect(resolved.text).toContain(`ObjectId("${ids[3999]}")`);
    expect(resolved.text).toContain(`token: "${A}"`);
    expect((resolved.filter.userId as { $in: unknown[] }).$in[3999]).toEqual({ $oid: ids[3999] });
    expect(resolved.filter.token).toBe(A);
  });
});
