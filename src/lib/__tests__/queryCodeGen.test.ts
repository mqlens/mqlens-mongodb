import { describe, it, expect } from 'vitest';
import { generateQueryCode, CODE_LANGUAGES, type QueryCodeSpec } from '../queryCodeGen';

const findSpec: QueryCodeSpec = {
  db: 'shop',
  collection: 'users',
  query: {
    queryType: 'find',
    filter: { _id: { $oid: '603d779f4f102e3a185c3220' } },
    sort: { createdAt: -1 },
    projection: { name: 1 },
    limit: 50,
    skip: 10,
  },
};

const aggSpec: QueryCodeSpec = {
  db: 'shop',
  collection: 'orders',
  query: {
    queryType: 'aggregate',
    pipeline: [{ $match: { status: 'paid' } }, { $limit: 5 }],
  },
};

describe('generateQueryCode', () => {
  it('exposes the language list with mongosh first', () => {
    expect(CODE_LANGUAGES[0]).toBe('mongosh');
    expect(CODE_LANGUAGES).toEqual(expect.arrayContaining(['Node.js', 'Python', 'Java', 'C#', 'Go']));
  });

  it('every language embeds the namespace and produces non-empty output for find and aggregate', () => {
    for (const lang of CODE_LANGUAGES) {
      const find = generateQueryCode(lang, findSpec);
      const agg = generateQueryCode(lang, aggSpec);
      expect(find.length, lang).toBeGreaterThan(20);
      expect(agg.length, lang).toBeGreaterThan(20);
      expect(find, lang).toContain('users');
      expect(agg, lang).toContain('orders');
      if (lang !== 'mongosh') {
        expect(find, lang).toContain('shop');
        expect(find, lang).toContain('mongodb://');
      }
    }
  });

  it('mongosh matches the existing runnable command', () => {
    const code = generateQueryCode('mongosh', findSpec);
    expect(code).toContain('db.users.find(');
    expect(code).toContain('.sort(');
    expect(code).toContain('.skip(10)');
    expect(code).toContain('.limit(50)');
  });

  it('Node.js parses the filter with EJSON and applies cursor options', () => {
    const code = generateQueryCode('Node.js', findSpec);
    expect(code).toContain("require('mongodb')");
    expect(code).toContain('EJSON.parse');
    expect(code).toContain('"$oid"');
    expect(code).toContain('.sort(');
    expect(code).toContain('.skip(10)');
    expect(code).toContain('.limit(50)');
  });

  it('Python uses json_util.loads and sorts via list of pairs', () => {
    const code = generateQueryCode('Python', findSpec);
    expect(code).toContain('from pymongo import MongoClient');
    expect(code).toContain('json_util');
    expect(code).toContain('loads(');
    expect(code).toContain('"$oid"');
    expect(code).toContain('.skip(10)');
    expect(code).toContain('.limit(50)');
  });

  it('Java escapes the embedded JSON for Document.parse', () => {
    const code = generateQueryCode('Java', findSpec);
    expect(code).toContain('Document.parse(');
    expect(code).toContain('\\"$oid\\"');
    expect(code).toContain('.skip(10)');
    expect(code).toContain('.limit(50)');
  });

  it('C# uses BsonDocument.Parse with verbatim strings', () => {
    const code = generateQueryCode('C#', findSpec);
    expect(code).toContain('BsonDocument.Parse(');
    expect(code).toContain('""$oid""');
    expect(code).toContain('.Skip(10)');
    expect(code).toContain('.Limit(50)');
  });

  it('Go unmarshals extended JSON', () => {
    const code = generateQueryCode('Go', findSpec);
    expect(code).toContain('bson.UnmarshalExtJSON');
    expect(code).toContain('"$oid"');
    expect(code).toContain('SetSkip(10)');
    expect(code).toContain('SetLimit(50)');
  });

  it('omits unset find options', () => {
    const bare: QueryCodeSpec = { db: 'shop', collection: 'users', query: { queryType: 'find', filter: {} } };
    for (const lang of CODE_LANGUAGES) {
      const code = generateQueryCode(lang, bare);
      expect(code.toLowerCase(), lang).not.toContain('skip(');
      expect(code.toLowerCase(), lang).not.toContain('sort(');
    }
  });

  it('aggregate embeds every stage', () => {
    for (const lang of CODE_LANGUAGES) {
      const code = generateQueryCode(lang, aggSpec);
      expect(code, lang).toContain('$match');
      expect(code, lang).toContain('$limit');
    }
  });
});
