import { describe, it, expect } from 'vitest';
import {
  collectionRef,
  buildRunnableCommand,
  detectDestructiveOp,
  guardScriptRun,
  type GeneratedQuery,
} from '../mongoCommand';

describe('collectionRef', () => {
  it('uses dot access for identifier names', () => {
    expect(collectionRef('users')).toBe('users');
    expect(collectionRef('orders_2024')).toBe('orders_2024');
  });

  it('uses getCollection() for non-identifier names', () => {
    expect(collectionRef('weird name')).toBe('getCollection("weird name")');
    expect(collectionRef('has"quote')).toBe('getCollection("has\\"quote")');
    expect(collectionRef('has\\backslash')).toBe('getCollection("has\\\\backslash")');
  });
});

describe('buildRunnableCommand', () => {
  it('builds an aggregate command from a pipeline', () => {
    const cmd = buildRunnableCommand(
      { queryType: 'aggregate', pipeline: [{ $match: { active: true } }, { $count: 'n' }] },
      'users'
    );
    expect(cmd).toBe(
      'db.users.aggregate([\n  {\n    "$match": {\n      "active": true\n    }\n  },\n  {\n    "$count": "n"\n  }\n])'
    );
  });

  it('defaults an empty pipeline to [{ $match: {} }]', () => {
    const cmd = buildRunnableCommand({ queryType: 'aggregate', pipeline: [] }, 'users');
    expect(cmd).toBe('db.users.aggregate([\n  {\n    "$match": {}\n  }\n])');
  });

  it('builds a find command with filter only', () => {
    const cmd = buildRunnableCommand({ queryType: 'find', filter: { age: { $gt: 30 } } }, 'users');
    expect(cmd).toBe('db.users.find({"age":{"$gt":30}})');
  });

  it('includes projection as the second find arg when present', () => {
    const cmd = buildRunnableCommand(
      { queryType: 'find', filter: { active: true }, projection: { name: 1 } },
      'users'
    );
    expect(cmd).toBe('db.users.find({"active":true}, {"name":1})');
  });

  it('appends .sort() when sort is non-empty and omits it otherwise', () => {
    const withSort = buildRunnableCommand(
      { queryType: 'find', filter: {}, sort: { age: -1 } },
      'users'
    );
    expect(withSort).toBe('db.users.find({}).sort({"age":-1})');

    const noSort = buildRunnableCommand({ queryType: 'find', filter: {}, sort: {} }, 'users');
    expect(noSort).toBe('db.users.find({})');
  });

  it('escapes non-identifier collection names', () => {
    const cmd = buildRunnableCommand({ queryType: 'find', filter: {} }, 'my coll');
    expect(cmd).toBe('db.getCollection("my coll").find({})');
  });

  it('appends .skip()/.limit() for find when positive, after .sort()', () => {
    const cmd = buildRunnableCommand(
      { queryType: 'find', filter: { a: 1 }, sort: { a: -1 }, limit: 50, skip: 10 },
      'users'
    );
    expect(cmd).toBe('db.users.find({"a":1}).sort({"a":-1}).skip(10).limit(50)');
  });

  it('omits .skip()/.limit() when zero or absent', () => {
    const cmd = buildRunnableCommand(
      { queryType: 'find', filter: {}, limit: 0, skip: 0 },
      'users'
    );
    expect(cmd).toBe('db.users.find({})');
  });

  it('ignores limit/skip for aggregate', () => {
    const cmd = buildRunnableCommand(
      { queryType: 'aggregate', pipeline: [{ $count: 'n' }], limit: 50, skip: 10 },
      'users'
    );
    expect(cmd).toBe('db.users.aggregate([\n  {\n    "$count": "n"\n  }\n])');
  });

  it('returns a script query verbatim', () => {
    const script = 'db.users.updateMany({}, { $set: { active: true } });\nprintjson(db.users.countDocuments());';
    const cmd = buildRunnableCommand({ queryType: 'script', script }, 'users');
    expect(cmd).toBe(script);
  });

  it('returns empty string for a script query with no script', () => {
    expect(buildRunnableCommand({ queryType: 'script' }, 'users')).toBe('');
  });
});

describe('detectDestructiveOp', () => {
  it.each([
    ['deleteOne', 'db.users.deleteOne({ _id: 1 })'],
    ['deleteMany', 'db.users.deleteMany({})'],
    ['remove', 'db.users.remove({})'],
    ['drop', 'db.users.drop()'],
    ['dropDatabase', 'db.dropDatabase()'],
    ['dropIndex', 'db.users.dropIndex("ix_age")'],
    ['dropIndexes', 'db.users.dropIndexes()'],
  ])('flags %s', (op, script) => {
    expect(detectDestructiveOp(script)).toBe(op);
  });

  it('allows whitespace between the op and the paren', () => {
    expect(detectDestructiveOp('db.users.deleteMany ({})')).toBe('deleteMany');
  });

  it('does not report drop for dropDatabase', () => {
    expect(detectDestructiveOp('db.dropDatabase()')).toBe('dropDatabase');
  });

  it('returns null for non-destructive scripts', () => {
    expect(detectDestructiveOp('db.users.find({})')).toBeNull();
    expect(detectDestructiveOp('db.users.aggregate([{ $match: {} }])')).toBeNull();
    expect(detectDestructiveOp('db.users.insertOne({ a: 1 })')).toBeNull();
    expect(detectDestructiveOp('db.users.updateMany({}, { $set: { a: 1 } })')).toBeNull();
    expect(detectDestructiveOp('db.users.bulkWrite([])')).toBeNull();
  });

  it('is not fooled by a destructive name without a call', () => {
    expect(detectDestructiveOp('db.deleteMany_audit.find({})')).toBeNull();
  });
});

describe('guardScriptRun', () => {
  it('gates a destructive script and reports the op', () => {
    const q: GeneratedQuery = { queryType: 'script', script: 'db.users.deleteMany({})' };
    expect(guardScriptRun(q, 'db.users.deleteMany({})')).toEqual({
      action: 'confirm',
      operation: 'deleteMany',
    });
  });

  it('runs a non-destructive script', () => {
    const q: GeneratedQuery = { queryType: 'script', script: 'printjson(db.users.countDocuments())' };
    expect(guardScriptRun(q, 'printjson(db.users.countDocuments())')).toEqual({ action: 'run' });
  });

  it('never gates find/aggregate even if the command text looks destructive', () => {
    const find: GeneratedQuery = { queryType: 'find', filter: {} };
    expect(guardScriptRun(find, 'db.users.deleteMany({})')).toEqual({ action: 'run' });
    const agg: GeneratedQuery = { queryType: 'aggregate', pipeline: [] };
    expect(guardScriptRun(agg, 'db.users.drop()')).toEqual({ action: 'run' });
  });
});
