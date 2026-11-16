import { describe, it, expect } from 'vitest';
import { queryShape, groupProfileByShape } from '../profileShape';
import type { ProfileEntry } from '../monitoringApi';

describe('queryShape', () => {
  it('keeps the command and its collection, and replaces values with ?', () => {
    expect(queryShape('{ "find": "customers", "filter": { "tier": "gold", "age": { "$gte": 30 } }, "limit": 10 }')).toBe(
      '{find: "customers", filter: {tier: ?, age: {$gte: ?}}, limit: ?}'
    );
  });

  it('gives queries that differ only in their values the same shape', () => {
    const a = queryShape('{ "find": "c", "filter": { "_id": ObjectId("64b7f0c2a1b2c3d4e5f60718") } }');
    const b = queryShape('{ "find": "c", "filter": { "_id": ObjectId("64b7f0c2a1b2c3d4e5f60719") } }');
    expect(a).toBe(b);
    expect(a).toBe('{find: "c", filter: {_id: ?}}');
  });

  it('reads the JSON the e2e harness and the server send', () => {
    expect(queryShape('{"find":"customers","filter":{"joined":{"$gte":"2024-01-01"}}}')).toBe(
      '{find: "customers", filter: {joined: {$gte: ?}}}'
    );
  });

  it('treats a list of values as one value, whatever its length', () => {
    expect(queryShape('{ "find": "c", "filter": { "k": { "$in": [1, 2, 3] } } }')).toBe(
      queryShape('{ "find": "c", "filter": { "k": { "$in": [4] } } }')
    );
  });

  it('keeps the structure of a pipeline and of nested documents in lists', () => {
    expect(
      queryShape('{ "aggregate": "o", "pipeline": [{ "$match": { "s": "A" } }, { "$group": { "_id": "$c", "n": { "$sum": 1 } } }], "cursor": {} }')
    ).toBe('{aggregate: "o", pipeline: [{$match: {s: ?}}, {$group: {_id: "$c", n: {$sum: ?}}}]}');
  });

  it('collapses repeated elements of the same shape, as in a batch of updates', () => {
    expect(queryShape('{ "update": "p", "updates": [{ "q": { "_id": 1 } }, { "q": { "_id": 2 } }] }')).toBe(
      queryShape('{ "update": "p", "updates": [{ "q": { "_id": 3 } }] }')
    );
  });

  it('leaves out session and driver fields that are not part of the query', () => {
    expect(
      queryShape('{ "find": "c", "filter": {}, "lsid": { "id": Binary(0x4, AAAA) }, "$db": "sales", "$clusterTime": { "clusterTime": Timestamp(1, 2) }, "$readPreference": { "mode": "primary" } }')
    ).toBe('{find: "c", filter: {}}');
  });

  it('reads values written as constructors, even with commas inside', () => {
    expect(queryShape('{ "find": "c", "filter": { "t": Timestamp(1700000000, 3), "d": DateTime(2024-01-01 0:00:00.0 +00:00:00) } }')).toBe(
      '{find: "c", filter: {t: ?, d: ?}}'
    );
  });

  it('copes with a command cut short', () => {
    expect(queryShape('{ "find": "c", "filter": { "a": { "$in": [1, 2, 3…')).toBe('{find: "c", filter: {a: {$in: [?]}}}');
  });

  it('returns text that is not a document as it is', () => {
    expect(queryShape('  not a command ')).toBe('not a command');
  });
});

describe('groupProfileByShape', () => {
  const entry = (millis: number, command: string, ns = 'db.c', op = 'query'): ProfileEntry => ({
    op,
    ns,
    millis,
    tsMs: millis,
    planSummary: 'COLLSCAN',
    command,
  });

  it('counts each shape and sums, averages and bounds its durations, most total time first', () => {
    const groups = groupProfileByShape([
      entry(10, '{ "find": "c", "filter": { "a": 1 } }'),
      entry(500, '{ "find": "c", "filter": { "b": 1 } }'),
      entry(30, '{ "find": "c", "filter": { "a": 2 } }'),
      entry(20, '{ "find": "c", "filter": { "a": 3 } }'),
    ]);
    expect(groups.map((g) => [g.shape, g.count, g.totalMs, g.avgMs, g.maxMs, g.minMs])).toEqual([
      ['{find: "c", filter: {b: ?}}', 1, 500, 500, 500, 500],
      ['{find: "c", filter: {a: ?}}', 3, 60, 20, 30, 10],
    ]);
    // The slowest run stands for its group in the detail panel.
    expect(groups[1].slowest.millis).toBe(30);
  });

  it('keeps the same shape apart on different namespaces and operations', () => {
    const groups = groupProfileByShape([
      entry(1, '{ "find": "c" }', 'a.c'),
      entry(1, '{ "find": "c" }', 'b.c'),
      entry(1, '{ "find": "c" }', 'a.c', 'getmore'),
    ]);
    expect(groups).toHaveLength(3);
  });
});

describe('queryShape — review fixes', () => {
  it('drops driver fields only from the command, not from the query', () => {
    expect(queryShape('{ "find": "c", "filter": { "comment": "pending", "cursor": 1 }, "comment": "from the app" }')).toBe(
      '{find: "c", filter: {comment: ?, cursor: ?}}'
    );
  });

  it('keeps every stage of a pipeline, repeats included', () => {
    const once = queryShape('{ "aggregate": "o", "pipeline": [{ "$unwind": "$items" }] }');
    const twice = queryShape('{ "aggregate": "o", "pipeline": [{ "$unwind": "$items" }, { "$unwind": "$items" }] }');
    expect(twice).toBe('{aggregate: "o", pipeline: [{$unwind: "$items"}, {$unwind: "$items"}]}');
    expect(twice).not.toBe(once);
  });
});

describe('queryShape — structural values', () => {
  it('keeps sort directions and projection flags, which change the plan', () => {
    expect(queryShape('{ "find": "c", "filter": { "a": 5 }, "sort": { "a": 1, "b": -1 }, "projection": { "a": 1, "_id": 0 } }')).toBe(
      '{find: "c", filter: {a: ?}, sort: {a: 1, b: -1}, projection: {a: 1, _id: 0}}'
    );
    expect(queryShape('{ "aggregate": "o", "pipeline": [{ "$sort": { "t": -1 } }, { "$project": { "t": 1 } }] }')).toBe(
      '{aggregate: "o", pipeline: [{$sort: {t: -1}}, {$project: {t: 1}}]}'
    );
  });

  it('keeps what a $lookup joins on', () => {
    expect(
      queryShape('{ "aggregate": "o", "pipeline": [{ "$lookup": { "from": "users", "localField": "uid", "foreignField": "_id", "as": "u" } }] }')
    ).toBe('{aggregate: "o", pipeline: [{$lookup: {from: "users", localField: "uid", foreignField: "_id", as: "u"}}]}');
  });

  it('collapses a list of values named pipeline in a filter, like any other list', () => {
    expect(queryShape('{ "find": "c", "filter": { "pipeline": { "$in": [1, 2] } } }')).toBe(
      queryShape('{ "find": "c", "filter": { "pipeline": { "$in": [3] } } }')
    );
    expect(queryShape('{ "find": "c", "filter": { "pipeline": [1, 2] } }')).toBe(queryShape('{ "find": "c", "filter": { "pipeline": [3] } }'));
  });
});

describe('queryShape — values kept only where they shape the query', () => {
  it('replaces the values of application fields named sort, projection or hint', () => {
    const a = queryShape('{ "find": "c", "filter": { "sort": "new", "hint": 1, "projection": { "a": 1 } } }');
    const b = queryShape('{ "find": "c", "filter": { "sort": "old", "hint": 2, "projection": { "a": 0 } } }');
    expect(a).toBe(b);
    expect(a).toBe('{find: "c", filter: {sort: ?, hint: ?, projection: {a: ?}}}');
  });

  it('replaces constants inside a computed projection, and keeps its flags', () => {
    expect(queryShape('{ "aggregate": "o", "pipeline": [{ "$project": { "t": 1, "x": { "$ifNull": ["$a", "none"] } } }] }')).toBe(
      '{aggregate: "o", pipeline: [{$project: {t: 1, x: {$ifNull: ["$a", ?]}}}]}'
    );
  });

  it('keeps repeated arguments of an expression, which change what it computes', () => {
    expect(queryShape('{ "aggregate": "o", "pipeline": [{ "$set": { "v": { "$concat": ["$a", "$a"] } } }] }')).toBe(
      '{aggregate: "o", pipeline: [{$set: {v: {$concat: ["$a", "$a"]}}}]}'
    );
  });

  it('still collapses the clauses of an $or, like the values of an $in', () => {
    expect(queryShape('{ "find": "c", "filter": { "$or": [{ "a": 1 }, { "a": 2 }] } }')).toBe(
      queryShape('{ "find": "c", "filter": { "$or": [{ "a": 3 }] } }')
    );
  });
});

describe('queryShape — operators that are part of a sort or hint', () => {
  it('keeps the direction of a $natural hint or sort', () => {
    expect(queryShape('{ "find": "c", "filter": {}, "hint": { "$natural": 1 } }')).toBe('{find: "c", filter: {}, hint: {$natural: 1}}');
    expect(queryShape('{ "find": "c", "filter": {}, "sort": { "$natural": -1 } }')).toBe('{find: "c", filter: {}, sort: {$natural: -1}}');
  });

  it('keeps what a $meta sort or projection asks for', () => {
    expect(queryShape('{ "find": "c", "filter": {}, "sort": { "s": { "$meta": "textScore" } } }')).toBe(
      '{find: "c", filter: {}, sort: {s: {$meta: "textScore"}}}'
    );
  });
});

describe('queryShape — values pushed with $each', () => {
  it('collapses the values of $each, which are data, whatever their number', () => {
    const update = (each: string) => `{ "update": "c", "updates": [{ "q": { "_id": 1 }, "u": { "$push": { "tags": { "$each": [${each}] } } } }] }`;
    expect(queryShape(update('1'))).toBe(queryShape(update('2, 3')));
  });
});

describe('queryShape — options of each statement in a write', () => {
  it('keeps the hint of an update or delete statement, and not a filter field named hint', () => {
    expect(queryShape('{ "update": "c", "updates": [{ "q": { "a": 1, "hint": "x" }, "u": { "$set": { "b": 1 } }, "hint": "a_1" }] }')).toBe(
      '{update: "c", updates: [{q: {a: ?, hint: ?}, u: {$set: {b: ?}}, hint: "a_1"}]}'
    );
    expect(queryShape('{ "delete": "c", "deletes": [{ "q": { "a": 1 }, "limit": 1, "hint": { "a": 1 } }] }')).toBe(
      '{delete: "c", deletes: [{q: {a: ?}, limit: ?, hint: {a: 1}}]}'
    );
  });

  it('collapses the array a $literal or $const holds, which is data', () => {
    const literal = (op: string, items: string) => `{ "aggregate": "o", "pipeline": [{ "$set": { "v": { "${op}": [${items}] } } }] }`;
    expect(queryShape(literal('$literal', '1'))).toBe(queryShape(literal('$literal', '2, 3')));
    expect(queryShape(literal('$const', '1'))).toBe(queryShape(literal('$const', '2, 3')));
  });
});

describe('queryShape — arrays in a query are values', () => {
  it('collapses an array a query compares with, whatever its length', () => {
    const find = (op: string, items: string) => `{ "find": "c", "filter": { "tags": { "${op}": [${items}] } } }`;
    expect(queryShape(find('$eq', '1'))).toBe(queryShape(find('$eq', '2, 3')));
    expect(queryShape(find('$ne', '1'))).toBe(queryShape(find('$ne', '2, 3')));
    const match = (items: string) => `{ "aggregate": "o", "pipeline": [{ "$match": { "tags": { "$eq": [${items}] } } }] }`;
    expect(queryShape(match('1'))).toBe(queryShape(match('2, 3')));
    const del = (items: string) => `{ "delete": "c", "deletes": [{ "q": { "tags": { "$eq": [${items}] } }, "limit": 0 }] }`;
    expect(queryShape(del('1'))).toBe(queryShape(del('2, 3')));
  });

  it('keeps the positional arguments of an expression inside a query', () => {
    expect(queryShape('{ "find": "c", "filter": { "$expr": { "$eq": ["$a", "$a"] } } }')).toBe(
      '{find: "c", filter: {$expr: {$eq: ["$a", "$a"]}}}'
    );
  });
});

describe('queryShape — arrayFilters are queries', () => {
  it('collapses an array an array filter compares with, and keeps $expr arguments there', () => {
    const update = (filter: string) =>
      `{ "update": "c", "updates": [{ "q": {}, "u": { "$set": { "es.$[e].ok": true } }, "arrayFilters": [${filter}] }] }`;
    expect(queryShape(update('{ "e.tags": { "$eq": [1] } }'))).toBe(queryShape(update('{ "e.tags": { "$eq": [2, 3] } }')));
    expect(queryShape(update('{ "$expr": { "$eq": ["$e.a", "$e.a"] } }'))).toContain('$eq: ["$e.a", "$e.a"]');
  });
});
