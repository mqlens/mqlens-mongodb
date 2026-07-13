import { describe, it, expect } from 'vitest';
import { ObjectId, Int32, Double, Long, Decimal128 } from 'bson';
import { bsonEqual, valueKind, diffDocuments } from '../docDiff';

describe('valueKind', () => {
  it('classifies containers vs scalars', () => {
    expect(valueKind({ a: 1 })).toBe('object');
    expect(valueKind([1, 2])).toBe('array');
    expect(valueKind('s')).toBe('scalar');
    expect(valueKind(3)).toBe('scalar');
    expect(valueKind(null)).toBe('scalar');
    // BSON wrappers are leaf scalars, not objects to recurse into.
    expect(valueKind(new ObjectId('507f1f77bcf86cd799439011'))).toBe('scalar');
    expect(valueKind(new Date('2025-01-01'))).toBe('scalar');
  });
});

describe('bsonEqual', () => {
  it('treats equal primitives as equal', () => {
    expect(bsonEqual(1, 1)).toBe(true);
    expect(bsonEqual('a', 'a')).toBe(true);
    expect(bsonEqual(null, null)).toBe(true);
    expect(bsonEqual(1, 2)).toBe(false);
    expect(bsonEqual('a', 'b')).toBe(false);
  });
  it('compares BSON wrappers by value', () => {
    expect(bsonEqual(new ObjectId('507f1f77bcf86cd799439011'), new ObjectId('507f1f77bcf86cd799439011'))).toBe(true);
    expect(bsonEqual(new ObjectId('507f1f77bcf86cd799439011'), new ObjectId('507f1f77bcf86cd799439012'))).toBe(false);
    expect(bsonEqual(new Date('2025-01-01'), new Date('2025-01-01'))).toBe(true);
    expect(bsonEqual(new Int32(7), new Int32(7))).toBe(true);
    expect(bsonEqual(new Double(2.5), new Double(2.5))).toBe(true);
    expect(bsonEqual(new Long(42), new Long(42))).toBe(true);
    expect(bsonEqual(Decimal128.fromString('3.14'), Decimal128.fromString('3.14'))).toBe(true);
  });
  it('numeric BSON wrappers equal their plain-number counterpart', () => {
    expect(bsonEqual(new Int32(7), 7)).toBe(true);
    expect(bsonEqual(new Double(2.5), 2.5)).toBe(true);
  });
  it('different kinds are not equal', () => {
    expect(bsonEqual(1, '1')).toBe(false);
    expect(bsonEqual(new ObjectId('507f1f77bcf86cd799439011'), '507f1f77bcf86cd799439011')).toBe(false);
  });
});

describe('diffDocuments — flat objects', () => {
  it('marks unchanged, changed, added, removed at the top level', () => {
    const left = { _id: 1, name: 'Ada', age: 36, city: 'London' };
    const right = { _id: 1, name: 'Grace', age: 36, country: 'USA' };
    const d = diffDocuments(left, right);

    // Left + right line arrays are aligned (same length, same index = same row).
    expect(d.left.length).toBe(d.right.length);
    expect(d.changedCount).toBe(1);   // name
    expect(d.addedCount).toBe(1);     // country (right only)
    expect(d.removedCount).toBe(1);   // city (left only)

    const byPath = (arr: typeof d.left, p: string) => arr.find((l) => l.path === p)!;
    expect(byPath(d.left, 'name').status).toBe('changed');
    expect(byPath(d.right, 'name').status).toBe('changed');
    expect(byPath(d.left, 'age').status).toBe('unchanged');
    expect(byPath(d.left, 'city').status).toBe('removed');
    expect(byPath(d.right, 'country').status).toBe('added');
  });

  it('renders a placeholder (gap) opposite an added/removed key so columns align', () => {
    const d = diffDocuments({ a: 1 }, { a: 1, b: 2 });
    const i = d.right.findIndex((l) => l.path === 'b');
    expect(d.right[i].status).toBe('added');
    expect(d.left[i].status).toBe('gap'); // empty filler on the side that lacks the key
  });
});

describe('diffDocuments — nested objects and arrays', () => {
  it('recurses into nested objects and marks only the changed leaf', () => {
    const left = { addr: { city: 'London', zip: 'N1' } };
    const right = { addr: { city: 'Paris', zip: 'N1' } };
    const d = diffDocuments(left, right);

    // Columns are aligned and contain a container "open" line for `addr`.
    expect(d.left.length).toBe(d.right.length);
    const open = d.left.find((l) => l.path === 'addr')!;
    expect(open.kind).toBe('object');
    expect(open.bracket).toBe('{');

    const city = d.left.find((l) => l.path === 'addr.city')!;
    expect(city.depth).toBe(1);
    expect(city.status).toBe('changed');
    expect(d.left.find((l) => l.path === 'addr.zip')!.status).toBe('unchanged');
    expect(d.changedCount).toBe(1);
  });

  it('treats a scalar->object change as a single changed entry, not a recurse', () => {
    const d = diffDocuments({ x: 1 }, { x: { y: 2 } });
    const lx = d.left.find((l) => l.path === 'x')!;
    const rx = d.right.find((l) => l.path === 'x')!;
    expect(lx.status).toBe('changed');
    expect(rx.status).toBe('changed');
    // No recursion into x.y because the kinds differ.
    expect(d.left.some((l) => l.path === 'x.y')).toBe(false);
    expect(d.changedCount).toBe(1);
  });

  it('diffs arrays positionally, marking added/removed/changed elements', () => {
    const d = diffDocuments({ tags: ['a', 'b', 'c'] }, { tags: ['a', 'B', 'c', 'd'] });
    expect(d.left.find((l) => l.path === 'tags[0]')!.status).toBe('unchanged');
    expect(d.left.find((l) => l.path === 'tags[1]')!.status).toBe('changed');
    const added = d.right.find((l) => l.path === 'tags[3]')!;
    expect(added.status).toBe('added');
    // The left column has a gap opposite the right-only element.
    const i = d.right.findIndex((l) => l.path === 'tags[3]');
    expect(d.left[i].status).toBe('gap');
    expect(d.addedCount).toBe(1);
    expect(d.changedCount).toBe(1);
  });

  it('recurses into nested objects inside array elements', () => {
    const left = { items: [{ q: 1 }] };
    const right = { items: [{ q: 2 }] };
    const d = diffDocuments(left, right);
    expect(d.left.find((l) => l.path === 'items[0].q')!.status).toBe('changed');
  });
});
