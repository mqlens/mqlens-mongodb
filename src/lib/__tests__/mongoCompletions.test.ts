import { describe, it, expect } from 'vitest';
import { getCompletions, TYPE_VALUE_SCAFFOLDS, type CompletionCtx } from '../mongoCompletions';

const base = (over: Partial<CompletionCtx>): CompletionCtx => ({
  surface: 'filter', textBeforeCursor: '', token: '', fields: ['region', 'plan', '_id'], ...over,
});
const labels = (items: { label: string }[]) => items.map((i) => i.label);
const kinds = (items: { kind: string }[]) => new Set(items.map((i) => i.kind));

describe('getCompletions — filter', () => {
  it('suggests fields at a key position', () => {
    const items = getCompletions(base({ surface: 'filter', textBeforeCursor: '{ ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['region', 'plan', '_id']));
    expect(kinds(items).has('field')).toBe(true);
  });
  it('suggests query operators after a field colon', () => {
    const items = getCompletions(base({ surface: 'filter', textBeforeCursor: '{ "region": ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['$eq', '$in', '$gt', '$regex']));
  });
  it('suggests enum values for a field with enums at a value position', () => {
    const schema = new Map([['plan', { type: 'string', enumValues: ['Free', 'Team'] }]]);
    const items = getCompletions(base({ surface: 'filter', textBeforeCursor: '{ "plan": ', token: '', schema }));
    const enums = items.filter((i) => i.kind === 'enum');
    expect(enums.map((e) => e.insertText)).toEqual(expect.arrayContaining(['"Free"', '"Team"']));
  });
  it('does not double-quote enum values when already inside a quote', () => {
    const schema = new Map([['workspaceId', { type: 'string', enumValues: ['default', 'personal'] }]]);
    const items = getCompletions(base({ surface: 'filter', textBeforeCursor: '{ "workspaceId": "', token: '', schema }));
    const enums = items.filter((i) => i.kind === 'enum');
    expect(enums.map((e) => e.insertText)).toEqual(expect.arrayContaining(['default"', 'personal"']));
    expect(enums.map((e) => e.insertText)).not.toEqual(expect.arrayContaining(['"default"', '"personal"']));
  });
  it('does not add a closing quote when one is already ahead of the cursor', () => {
    const schema = new Map([['workspaceId', { type: 'string', enumValues: ['default', 'personal'] }]]);
    const items = getCompletions(base({
      surface: 'filter',
      textBeforeCursor: '{ "workspaceId": "',
      textAfterCursor: '"',
      token: '',
      schema,
    }));
    const enums = items.filter((i) => i.kind === 'enum');
    expect(enums.map((e) => e.insertText)).toEqual(expect.arrayContaining(['default', 'personal']));
  });
  it('prefix-filters by token', () => {
    const items = getCompletions(base({ surface: 'filter', textBeforeCursor: '{ reg', token: 'reg' }));
    expect(labels(items)).toContain('region');
    expect(labels(items)).not.toContain('plan');
  });
});

describe('getCompletions — projection/sort', () => {
  it('projection suggests fields', () => {
    expect(labels(getCompletions(base({ surface: 'projection', textBeforeCursor: '{ ', token: '' })))).toContain('region');
  });
  it('sort suggests fields', () => {
    expect(labels(getCompletions(base({ surface: 'sort', textBeforeCursor: '{ ', token: '' })))).toContain('region');
  });
});

describe('getCompletions — aggStage', () => {
  it('suggests stage operators at stage start', () => {
    const items = getCompletions(base({ surface: 'aggStage', textBeforeCursor: '{ ', token: '$m' }));
    expect(labels(items)).toContain('$match');
  });
  it('suggests group accumulators inside $group', () => {
    const items = getCompletions(base({ surface: 'aggStage', textBeforeCursor: '{ "$group": { "_id": "$region", "t": { ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['$sum', '$avg', '$max']));
  });
});

describe('getCompletions — shell', () => {
  it('suggests cursor methods after db.coll.', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.customers.', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['find', 'aggregate', 'countDocuments']));
  });
});

describe('getCompletions — JSON key quoting', () => {
  it('quotes field keys in filter (JSON)', () => {
    const items = getCompletions(base({ surface: 'filter', textBeforeCursor: '{ ', token: '' }));
    expect(items.find((i) => i.label === 'region')!.insertText).toBe('"region"');
  });
  it('does not double-quote when already inside a quote', () => {
    const items = getCompletions(base({ surface: 'filter', textBeforeCursor: '{ "reg', token: 'reg' }));
    expect(items.find((i) => i.label === 'region')!.insertText).toBe('region');
  });
  it('leaves keys bare in the shell (JS)', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.customers.find({ ', token: '', fields: ['region'] }));
    expect(items.find((i) => i.label === 'region')!.insertText).toBe('region');
  });
  it('quotes $operator keys in filter and scaffolds their value shape', () => {
    const items = getCompletions(base({ surface: 'filter', textBeforeCursor: '{ ', token: '$' }));
    expect(items.find((i) => i.label === '$and')!.insertText).toBe('"\\$and": [{$1}]');
  });
});

describe('getCompletions — shell collections vs methods', () => {
  it('suggests collection names + db methods after db.', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.', token: '', collections: ['customers', 'orders'] }));
    expect(labels(items)).toEqual(expect.arrayContaining(['customers', 'orders', 'getCollectionNames']));
  });
  it('prefix-filters collection names by the token', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.cust', token: 'cust', collections: ['customers', 'orders'] }));
    expect(labels(items)).toContain('customers');
    expect(labels(items)).not.toContain('orders');
  });
  it('suggests cursor methods after db.<coll>.', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.customers.', token: '', collections: ['customers'] }));
    expect(labels(items)).toEqual(expect.arrayContaining(['find', 'aggregate', 'insertOne']));
    expect(labels(items)).not.toContain('customers');
  });
});

describe('getCompletions — shell globals & chain methods', () => {
  it('suggests mongosh globals at the top level (print, ObjectId)', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'pr', token: 'pr' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['print', 'printjson']));
  });
  it('suggests cursor chain methods after find()', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.customers.find({}).', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['forEach', 'toArray', 'sort', 'limit', 'map']));
  });
});

const ALL_EJSON_LABELS = [
  '$oid', '$date', '$numberInt', '$numberLong', '$numberDouble', '$numberDecimal',
  '$regularExpression', '$timestamp', '$binary', '$uuid', '$code', '$symbol',
  '$undefined', '$minKey', '$maxKey', '$dbPointer',
];

describe('getCompletions — EJSON in filter', () => {
  it('offers every EJSON type wrapper at a value position', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "_id": ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(ALL_EJSON_LABELS));
  });
  it('EJSON value completions are snippets with escaped $ keys and a tab stop', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "_id": ', token: '$o' }));
    const oid = items.find((i) => i.label === '$oid')!;
    expect(oid.isSnippet).toBe(true);
    expect(oid.insertText).toContain('\\$oid');
    expect(oid.insertText).toContain('${1:');
  });
  it('still offers query operators alongside EJSON at a value position', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "_id": ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['$eq', '$in', '$gt']));
  });
  it('ranks $oid first for an objectId-typed field', () => {
    const schema = new Map([['_id', { type: 'objectId' }]]);
    const items = getCompletions(base({ textBeforeCursor: '{ "_id": ', token: '', schema }));
    expect(items[0].label).toBe('$oid');
  });
  it('ranks $date first for a date-typed field', () => {
    const schema = new Map([['created', { type: 'date' }]]);
    const items = getCompletions(base({ textBeforeCursor: '{ "created": ', token: '', schema }));
    expect(items[0].label).toBe('$date');
  });
  it('offers operator + EJSON keys (not field names) inside a field value object', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "_id": { ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['$eq', '$gt', '$oid', '$date']));
    expect(labels(items)).not.toContain('region');
  });
  it('quotes EJSON keys in the JSON surface and scaffolds their value', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "_id": { ', token: '$o' }));
    expect(items.find((i) => i.label === '$oid')!.insertText).toBe('"\\$oid": "${1:objectId}"');
  });
  it('does not double-quote EJSON keys when already inside a quote', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "_id": { "$o', token: '$o' }));
    expect(items.find((i) => i.label === '$oid')!.insertText).toBe('\\$oid": "${1:objectId}"');
  });
  it('offers fields + operators inside $elemMatch', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "tags": { "$elemMatch": { ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['region', '$eq']));
  });
  it('offers operators inside $not', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "age": { "$not": { ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['$gt', '$regex']));
    expect(labels(items)).not.toContain('region');
  });
  it('value-object detection survives earlier closed objects', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "a": { "$gt": 1 }, ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['region', '$and']));
  });
});

describe('getCompletions — shell value constructors', () => {
  it('offers shell constructors (not EJSON wrappers) at a value position in find()', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.c.find({ _id: ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['ObjectId', 'ISODate', 'NumberLong', 'UUID']));
    expect(labels(items)).not.toContain('$oid');
  });
  it('shell constructors are snippets with a cursor inside the parens', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.c.find({ _id: Obj', token: 'Obj' }));
    const ctor = items.find((i) => i.label === 'ObjectId')!;
    expect(ctor.isSnippet).toBe(true);
    expect(ctor.insertText).toContain('ObjectId("${1:');
  });
});

describe('getCompletions — projection operators & EJSON', () => {
  it('offers 1/0 and projection operator snippets at a value position', () => {
    const items = getCompletions(base({ surface: 'projection', textBeforeCursor: '{ "comments": ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['1', '0', '$slice', '$elemMatch', '$meta']));
  });
  it('projection operator value completions are snippets', () => {
    const items = getCompletions(base({ surface: 'projection', textBeforeCursor: '{ "comments": ', token: '$s' }));
    const slice = items.find((i) => i.label === '$slice')!;
    expect(slice.isSnippet).toBe(true);
    expect(slice.insertText).toContain('\\$slice');
  });
  it('offers EJSON wrappers at a projection value position', () => {
    const items = getCompletions(base({ surface: 'projection', textBeforeCursor: '{ "comments": ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['$oid', '$date']));
  });
  it('offers projection operator keys with value scaffolds inside a field value object', () => {
    const items = getCompletions(base({ surface: 'projection', textBeforeCursor: '{ "comments": { ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['$slice', '$elemMatch', '$meta']));
    expect(items.find((i) => i.label === '$slice')!.insertText).toBe('"\\$slice": ${1:5}');
  });
  it('offers fields + query operators inside a projection $elemMatch', () => {
    const items = getCompletions(base({ surface: 'projection', textBeforeCursor: '{ "comments": { "$elemMatch": { ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['region', '$eq']));
  });
  it('keeps fields only at the top-level key position', () => {
    const items = getCompletions(base({ surface: 'projection', textBeforeCursor: '{ ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['region', 'plan', '_id']));
    expect(labels(items)).not.toContain('$slice');
  });
});

describe('getCompletions — operator value scaffolds', () => {
  it('array operators scaffold an array value ($in/$nin/$all)', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "qty": { ', token: '$' }));
    expect(items.find((i) => i.label === '$in')!.insertText).toBe('"\\$in": [$1]');
    expect(items.find((i) => i.label === '$all')!.insertText).toBe('"\\$all": [$1]');
  });
  it('logical operators scaffold an array of condition objects', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ ', token: '$' }));
    expect(items.find((i) => i.label === '$or')!.insertText).toBe('"\\$or": [{$1}]');
    expect(items.find((i) => i.label === '$nor')!.insertText).toBe('"\\$nor": [{$1}]');
  });
  it('object operators scaffold an object value ($elemMatch, $not)', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "tags": { ', token: '$' }));
    expect(items.find((i) => i.label === '$elemMatch')!.insertText).toBe('"\\$elemMatch": {$1}');
    expect(items.find((i) => i.label === '$not')!.insertText).toBe('"\\$not": {$1}');
  });
  it('scalar operators scaffold typed placeholders ($exists, $regex, $mod, $size)', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "x": { ', token: '$' }));
    expect(items.find((i) => i.label === '$exists')!.insertText).toBe('"\\$exists": ${1:true}');
    expect(items.find((i) => i.label === '$regex')!.insertText).toBe('"\\$regex": "${1:pattern}"');
    expect(items.find((i) => i.label === '$mod')!.insertText).toBe('"\\$mod": [${1:divisor}, ${2:remainder}]');
    expect(items.find((i) => i.label === '$size')!.insertText).toBe('"\\$size": ${1:0}');
  });
  it('comparison operators use the field schema type for their value', () => {
    const schema = new Map([['createdTime', { type: 'date' }]]);
    const items = getCompletions(base({ textBeforeCursor: '{ "createdTime": { ', token: '$g', schema }));
    expect(items.find((i) => i.label === '$gt')!.insertText).toBe('"\\$gt": {"\\$date": "${1:2024-01-01T00:00:00Z}"}');
  });
  it('operator chosen at a value position wraps itself in an object', () => {
    const schema = new Map([['createdTime', { type: 'date' }]]);
    const items = getCompletions(base({ textBeforeCursor: '{ "createdTime": ', token: '$gt', schema }));
    expect(items.find((i) => i.label === '$gt')!.insertText).toBe('{"\\$gt": {"\\$date": "${1:2024-01-01T00:00:00Z}"}}');
  });
  it('comparison operators fall back to a bare tab stop without schema', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "x": { ', token: '$gt' }));
    expect(items.find((i) => i.label === '$gt')!.insertText).toBe('"\\$gt": $1');
  });
  it('shell surface scaffolds operators with bare keys', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.c.find({ qty: { ', token: '$' }));
    expect(items.find((i) => i.label === '$in')!.insertText).toBe('\\$in: [$1]');
  });
  it('agg stages scaffold their body shape', () => {
    const items = getCompletions(base({ surface: 'aggStage', textBeforeCursor: '{ ', token: '$' }));
    expect(items.find((i) => i.label === '$match')!.insertText).toBe('"\\$match": {$1}');
    expect(items.find((i) => i.label === '$limit')!.insertText).toBe('"\\$limit": ${1:10}');
    expect(items.find((i) => i.label === '$unwind')!.insertText).toBe('"\\$unwind": "\\$${1:field}"');
    expect(items.find((i) => i.label === '$lookup')!.insertText).toContain('"from": "${1:collection}"');
  });
  it('group accumulators scaffold their value', () => {
    const items = getCompletions(base({ surface: 'aggStage', textBeforeCursor: '{ "$group": { "_id": "$region", "t": { ', token: '$' }));
    expect(items.find((i) => i.label === '$sum')!.insertText).toBe('"\\$sum": ${1:1}');
    expect(items.find((i) => i.label === '$push')!.insertText).toBe('"\\$push": "\\$${1:field}"');
  });
});

describe('getCompletions — shell constructors in the JSON query bar', () => {
  it('offers shell constructors at a filter value position (query bar parses them)', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "x": ', token: '' }));
    const ctor = items.find((i) => i.label === 'ObjectId')!;
    expect(ctor).toBeDefined();
    expect(ctor.isSnippet).toBe(true);
    expect(ctor.insertText).toBe('ObjectId("${1:objectId}")');
    expect(labels(items)).toEqual(expect.arrayContaining(['ISODate', 'NumberLong', 'UUID']));
  });
});

describe('getCompletions — typed field scaffolds at key position', () => {
  const schema = new Map([
    ['_id', { type: 'objectId' }],
    ['createdTime', { type: 'date' }],
    ['region', { type: 'string' }],
  ]);
  it('objectId field inserts the full key + $oid wrapper as a snippet', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ ', token: '', schema, fields: ['_id', 'createdTime', 'region'] }));
    const id = items.find((i) => i.label === '_id')!;
    expect(id.isSnippet).toBe(true);
    expect(id.insertText).toContain('"_id": {"\\$oid": "${1:');
  });
  it('date field inserts the full key + $date wrapper as a snippet', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ ', token: '', schema, fields: ['_id', 'createdTime', 'region'] }));
    const created = items.find((i) => i.label === 'createdTime')!;
    expect(created.isSnippet).toBe(true);
    expect(created.insertText).toContain('"createdTime": {"\\$date": "${1:');
  });
  it('string fields scaffold a quoted value', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ ', token: '', schema, fields: ['_id', 'createdTime', 'region'] }));
    const region = items.find((i) => i.label === 'region')!;
    expect(region.isSnippet).toBe(true);
    expect(region.insertText).toBe('"region": "${1:value}"');
  });
  it('fields without schema info keep the plain quoted-key insert', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ ', token: '', schema, fields: ['unknownField'] }));
    expect(items.find((i) => i.label === 'unknownField')!.insertText).toBe('"unknownField"');
  });
  it('covers every BSON type label the schema analyzer emits', () => {
    const labels = ['double', 'string', 'object', 'array', 'bool', 'null', 'regex', 'int', 'long',
      'timestamp', 'binary', 'objectId', 'date', 'decimal', 'javascript', 'symbol',
      'minKey', 'maxKey', 'undefined', 'dbPointer'];
    for (const t of labels) {
      expect(TYPE_VALUE_SCAFFOLDS[t], `missing scaffold for type "${t}"`).toBeDefined();
      expect(TYPE_VALUE_SCAFFOLDS[t].json).toBeTruthy();
      expect(TYPE_VALUE_SCAFFOLDS[t].shell).toBeTruthy();
    }
  });
  it('numeric types scaffold correctly (int plain, long/decimal wrapped)', () => {
    const numSchema = new Map([
      ['age', { type: 'int' }],
      ['views', { type: 'long' }],
      ['price', { type: 'decimal' }],
      ['score', { type: 'double' }],
    ]);
    const items = getCompletions(base({ textBeforeCursor: '{ ', token: '', schema: numSchema, fields: ['age', 'views', 'price', 'score'] }));
    expect(items.find((i) => i.label === 'age')!.insertText).toBe('"age": ${1:0}');
    expect(items.find((i) => i.label === 'views')!.insertText).toBe('"views": {"\\$numberLong": "${1:0}"}');
    expect(items.find((i) => i.label === 'price')!.insertText).toBe('"price": {"\\$numberDecimal": "${1:0}"}');
    expect(items.find((i) => i.label === 'score')!.insertText).toBe('"score": ${1:0.0}');
  });
  it('bool, regex, and binary scaffold their EJSON shapes', () => {
    const s = new Map([
      ['active', { type: 'bool' }],
      ['pattern', { type: 'regex' }],
      ['blob', { type: 'binary' }],
    ]);
    const items = getCompletions(base({ textBeforeCursor: '{ ', token: '', schema: s, fields: ['active', 'pattern', 'blob'] }));
    expect(items.find((i) => i.label === 'active')!.insertText).toBe('"active": ${1:true}');
    expect(items.find((i) => i.label === 'pattern')!.insertText).toContain('"\\$regularExpression"');
    expect(items.find((i) => i.label === 'blob')!.insertText).toContain('"\\$binary"');
  });
  it('shell uses native literals for numeric and regex types', () => {
    const s = new Map([
      ['views', { type: 'long' }],
      ['pattern', { type: 'regex' }],
    ]);
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.c.find({ ', token: '', schema: s, fields: ['views', 'pattern'] }));
    expect(items.find((i) => i.label === 'views')!.insertText).toBe('views: NumberLong("${1:0}")');
    expect(items.find((i) => i.label === 'pattern')!.insertText).toBe('pattern: /${1:pattern}/${2:i}');
  });
  it('completes the scaffold without doubling the quote when already inside one', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "_i', token: '_i', schema, fields: ['_id'] }));
    const id = items.find((i) => i.label === '_id')!;
    expect(id.insertText.startsWith('_id": {"\\$oid"')).toBe(true);
  });
  it('uses shell constructors for typed fields in the shell surface', () => {
    const items = getCompletions(base({ surface: 'shell', textBeforeCursor: 'db.c.find({ ', token: '', schema, fields: ['_id', 'createdTime'] }));
    expect(items.find((i) => i.label === '_id')!.insertText).toContain('_id: ObjectId("${1:');
    expect(items.find((i) => i.label === 'createdTime')!.insertText).toContain('createdTime: ISODate("${1:');
  });
  it('scaffolds typed fields inside $elemMatch bodies too', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "refs": { "$elemMatch": { ', token: '', schema, fields: ['_id'] }));
    expect(items.find((i) => i.label === '_id')!.insertText).toContain('"_id": {"\\$oid"');
  });
  it('projection fields scaffold an include/exclude choice instead of a typed value', () => {
    const items = getCompletions(base({ surface: 'projection', textBeforeCursor: '{ ', token: '', schema, fields: ['_id'] }));
    const id = items.find((i) => i.label === '_id')!;
    expect(id.isSnippet).toBe(true);
    expect(id.insertText).toBe('"_id": ${1|1,0|}');
  });
  it('sort fields scaffold a direction choice instead of a typed value', () => {
    const items = getCompletions(base({ surface: 'sort', textBeforeCursor: '{ ', token: '', schema, fields: ['createdTime'] }));
    const created = items.find((i) => i.label === 'createdTime')!;
    expect(created.isSnippet).toBe(true);
    expect(created.insertText).toBe('"createdTime": ${1|1,-1|}');
  });
});

describe('getCompletions — sort $meta', () => {
  it('offers 1, -1 and $meta at a sort value position', () => {
    const items = getCompletions(base({ surface: 'sort', textBeforeCursor: '{ "score": ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['1', '-1', '$meta']));
  });
  it('offers the $meta key with its value inside a sort value object', () => {
    const items = getCompletions(base({ surface: 'sort', textBeforeCursor: '{ "score": { ', token: '$' }));
    expect(items.find((i) => i.label === '$meta')!.insertText).toBe('"\\$meta": "${1:textScore}"');
  });
  it('does not double-quote sort fields when already inside a quote', () => {
    const items = getCompletions(base({ surface: 'sort', textBeforeCursor: '{ "reg', token: 'reg' }));
    expect(items.find((i) => i.label === 'region')!.insertText).toBe('region": ${1|1,-1|}');
  });
});

describe('getCompletions — aggStage position awareness', () => {
  it('does not suggest stages inside a $match body', () => {
    const items = getCompletions(base({ surface: 'aggStage', textBeforeCursor: '{ "$match": { ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['region']));
    expect(labels(items)).not.toContain('$lookup');
  });
  it('offers EJSON at a value position inside $match', () => {
    const items = getCompletions(base({ surface: 'aggStage', textBeforeCursor: '{ "$match": { "_id": ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['$oid', '$eq']));
  });
});

describe('getCompletions — per-stage body editor (stageOperator)', () => {
  const stage = (op: string, text: string, token = '', extra: Partial<CompletionCtx> = {}) =>
    base({ surface: 'aggStage', stageOperator: op, textBeforeCursor: text, token, ...extra });

  it('$match body suggests fields, never stage names', () => {
    const items = getCompletions(stage('$match', '{ '));
    expect(labels(items)).toEqual(expect.arrayContaining(['region', 'plan']));
    expect(labels(items)).not.toContain('$lookup');
    expect(labels(items)).not.toContain('$match');
  });
  it('$match body value position offers EJSON and operators', () => {
    const items = getCompletions(stage('$match', '{ "_id": '));
    expect(labels(items)).toEqual(expect.arrayContaining(['$oid', '$eq']));
  });
  it('$sort body behaves like the sort surface', () => {
    const items = getCompletions(stage('$sort', '{ '));
    expect(items.find((i) => i.label === 'region')!.insertText).toBe('"region": ${1|1,-1|}');
  });
  it('$project body behaves like the projection surface', () => {
    const items = getCompletions(stage('$project', '{ '));
    expect(items.find((i) => i.label === 'region')!.insertText).toBe('"region": ${1|1,0|}');
  });
  it('$group body suggests _id at the top-level key position', () => {
    const items = getCompletions(stage('$group', '{ '));
    expect(labels(items)).toContain('_id');
    expect(labels(items)).not.toContain('$lookup');
  });
  it('$group body offers accumulators at a value position', () => {
    const items = getCompletions(stage('$group', '{ "total": ', '$s'));
    expect(items.find((i) => i.label === '$sum')!.insertText).toBe('{"\\$sum": ${1:1}}');
  });
  it('$group body offers field path refs at a value position', () => {
    const items = getCompletions(stage('$group', '{ "_id": ', '$reg'));
    expect(items.find((i) => i.label === '$region')!.insertText).toBe('"$region"');
  });
  it('$lookup body suggests its parameter keys with value scaffolds', () => {
    const items = getCompletions(stage('$lookup', '{ '));
    expect(labels(items)).toEqual(expect.arrayContaining(['from', 'localField', 'foreignField', 'as']));
    expect(items.find((i) => i.label === 'from')!.insertText).toBe('"from": "${1:collection}"');
  });
  it('$lookup localField value offers field names as strings', () => {
    const items = getCompletions(stage('$lookup', '{ "localField": ', 'reg'));
    expect(items.find((i) => i.label === 'region')!.insertText).toBe('"region"');
  });
  it('$lookup localField value does not double-quote when already inside a quote', () => {
    const items = getCompletions(stage('$lookup', '{ "localField": "', 'reg'));
    expect(items.find((i) => i.label === 'region')!.insertText).toBe('region"');
  });
  it('$lookup localField value does not add a closing quote when one is ahead', () => {
    const items = getCompletions(stage('$lookup', '{ "localField": "', 'reg', { textAfterCursor: '"' }));
    expect(items.find((i) => i.label === 'region')!.insertText).toBe('region');
  });
  it('$unwind body suggests field path refs', () => {
    const items = getCompletions(stage('$unwind', '', '$reg'));
    expect(items.find((i) => i.label === '$region')!.insertText).toBe('"$region"');
  });
});
