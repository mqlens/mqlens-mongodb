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
