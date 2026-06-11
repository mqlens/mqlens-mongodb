import { describe, it, expect } from 'vitest';
import { getCompletions, type CompletionCtx } from '../mongoCompletions';

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
  it('quotes $operator keys in filter', () => {
    const items = getCompletions(base({ surface: 'filter', textBeforeCursor: '{ ', token: '$' }));
    expect(items.find((i) => i.label === '$and')!.insertText).toBe('"$and"');
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
  it('quotes EJSON keys in the JSON surface', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "_id": { ', token: '$o' }));
    expect(items.find((i) => i.label === '$oid')!.insertText).toBe('"$oid"');
  });
  it('does not double-quote EJSON keys when already inside a quote', () => {
    const items = getCompletions(base({ textBeforeCursor: '{ "_id": { "$o', token: '$o' }));
    expect(items.find((i) => i.label === '$oid')!.insertText).toBe('$oid');
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
  it('offers projection operator keys inside a field value object', () => {
    const items = getCompletions(base({ surface: 'projection', textBeforeCursor: '{ "comments": { ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['$slice', '$elemMatch', '$meta']));
    expect(items.find((i) => i.label === '$slice')!.insertText).toBe('"$slice"');
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

describe('getCompletions — sort $meta', () => {
  it('offers 1, -1 and $meta at a sort value position', () => {
    const items = getCompletions(base({ surface: 'sort', textBeforeCursor: '{ "score": ', token: '' }));
    expect(labels(items)).toEqual(expect.arrayContaining(['1', '-1', '$meta']));
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
