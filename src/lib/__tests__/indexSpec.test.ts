import { describe, expect, it } from 'vitest';
import {
  displayKeys,
  emptyIndexForm,
  formFromSpec,
  inPlaceEdits,
  indexBuilds,
  indexKind,
  isEditable,
  isPlainIndex,
  specFromForm,
  specOf,
  validateIndex,
  type IndexDocument,
} from '../indexSpec';
import type { CurrentOp } from '../monitoringApi';

const doc = (spec: Partial<IndexDocument>): IndexDocument => ({ key: { a: 1 }, name: 'a_1', ...spec });

describe('specOf', () => {
  it('reads the whole document when the listing has one', () => {
    const spec = { v: 2, key: { a: 1 }, name: 'a_1', collation: { locale: 'de' } };
    expect(specOf({ name: 'a_1', keys: '{"a":1}', unique: false, sparse: false, spec: JSON.stringify(spec) })).toEqual(spec);
  });

  // A server before API version 5 sends no document.
  it('falls back to the plain fields without one', () => {
    expect(specOf({ name: 'a_1', keys: '{"a":-1}', unique: true, sparse: false })).toEqual({
      key: { a: -1 },
      name: 'a_1',
      unique: true,
    });
    expect(
      specOf({ name: 't', keys: '{"a":1}', unique: false, sparse: true, expireAfterSeconds: 60, hidden: true, partialFilterExpression: '{"x":1}' })
    ).toEqual({ key: { a: 1 }, name: 't', sparse: true, expireAfterSeconds: 60, hidden: true, partialFilterExpression: { x: 1 } });
  });

  it('survives keys and a document it cannot read', () => {
    expect(specOf({ name: 'x', keys: 'not json', unique: false, sparse: false, spec: 'nor this' })).toEqual({ key: {}, name: 'x' });
  });
});

describe('displayKeys', () => {
  it('shows the fields of a text index, not _fts and _ftsx', () => {
    expect(
      displayKeys({ key: { b: 1, _fts: 'text', _ftsx: 1, c: -1 }, name: 't', weights: { title: 5, body: 1 } })
    ).toEqual({ b: 1, title: 'text', body: 'text', c: -1 });
  });

  it('leaves a text key as it is without its weights', () => {
    expect(displayKeys({ key: { _fts: 'text', _ftsx: 1 }, name: 't' })).toEqual({ _fts: 'text', _ftsx: 1 });
  });

  it('leaves every other key as it is', () => {
    expect(displayKeys({ key: { a: 1, b: 'hashed' }, name: 'x' })).toEqual({ a: 1, b: 'hashed' });
  });
});

describe('isEditable', () => {
  const info = (keys: string, spec?: string) => ({ name: 'i', keys, unique: false, sparse: false, spec });

  it('takes any index with its document', () => {
    expect(isEditable(info('{"a":"hashed"}', '{"key":{"a":"hashed"},"name":"i"}'))).toBe(true);
  });

  it('takes a text index as MongoDB lists it', () => {
    const text = { key: { _fts: 'text', _ftsx: 1 }, name: 'i', weights: { bio: 1 } };
    expect(isEditable(info('{"_fts":"text","_ftsx":1}', JSON.stringify(text)))).toBe(true);
  });

  // A rebuild could not know its options, nor put it back if it failed.
  it('refuses any index without its document', () => {
    expect(isEditable(info('{"a":1,"b":-1}'))).toBe(false);
    expect(isEditable(info('{"a":"hashed"}'))).toBe(false);
    expect(isEditable(info('{"_fts":"text","_ftsx":1}'))).toBe(false);
  });

  // The form could not hold these as they are, and a save would change them.
  it('refuses keys the form cannot hold', () => {
    const edit = (key: Record<string, unknown>) => isEditable(info(JSON.stringify(key), JSON.stringify({ key, name: 'i' })));
    expect(edit({ a: -2 })).toBe(false);
    expect(edit({ a: 0.5 })).toBe(false);
    expect(edit({ '$**': 'columnstore' })).toBe(false);
    expect(edit({ a: 1, 2024: 1 })).toBe(false);
    expect(edit({ 2024: 1 })).toBe(true);
  });
});

describe('indexKind', () => {
  it('names each kind', () => {
    expect(indexKind({ a: 1 })).toBe('regular');
    expect(indexKind({ a: 1, b: -1 })).toBe('compound');
    expect(indexKind({ a: 'text' })).toBe('text');
    expect(indexKind({ a: '2dsphere' })).toBe('2dsphere');
    expect(indexKind({ a: '2d' })).toBe('2d');
    expect(indexKind({ a: 'hashed' })).toBe('hashed');
    expect(indexKind({ '$**': 1 })).toBe('wildcard');
    expect(indexKind({ 'a.$**': 1 })).toBe('wildcard');
  });

  it('calls an all-fields text index text, not wildcard', () => {
    expect(indexKind({ '$**': 'text' })).toBe('text');
  });
});

describe('validateIndex', () => {
  const problem = (spec: Partial<IndexDocument>) => validateIndex(doc(spec))?.key;

  it('passes a plain index', () => {
    expect(problem({})).toBeUndefined();
  });

  it('refuses a partial filter with sparse', () => {
    expect(problem({ sparse: true, partialFilterExpression: { a: 1 } })).toBe('partialWithSparse');
  });

  it('takes the operators a partial filter allows', () => {
    for (const filter of [
      { a: 1 },
      { a: { b: 1 } },
      { a: { $eq: 1 } },
      { a: { $exists: true } },
      { a: { $gt: 1, $lte: 5 } },
      { a: { $gte: 1 }, b: { $lt: 2 } },
      { a: { $type: 'int' } },
      { a: { $in: [1, 2] } },
      { $and: [{ a: 1 }, { b: { $gt: 1 } }] },
      { $or: [{ a: 1 }, { b: 2 }] },
    ]) {
      expect(problem({ partialFilterExpression: filter })).toBeUndefined();
    }
  });

  it('refuses the operators it does not, and names them', () => {
    for (const [filter, operator] of [
      [{ a: { $ne: 1 } }, '$ne'],
      [{ a: { $nin: [1] } }, '$nin'],
      [{ a: { $not: { $gt: 1 } } }, '$not'],
      [{ a: { $regex: 'x' } }, '$regex'],
      [{ a: { $mod: [2, 0] } }, '$mod'],
      [{ a: { $elemMatch: { $gt: 1 } } }, '$elemMatch'],
      [{ $nor: [{ a: 1 }] }, '$nor'],
      [{ $or: [{ a: { $ne: 1 } }] }, '$ne'],
    ] as const) {
      const found = validateIndex(doc({ partialFilterExpression: filter as Record<string, unknown> }));
      expect(found?.key).toBe('partialOperator');
      expect(found?.params).toEqual({ operator });
    }
  });

  it('refuses $exists: false, which MongoDB reads as a negation', () => {
    expect(problem({ partialFilterExpression: { a: { $exists: false } } })).toBe('partialExistsFalse');
  });

  // Extended JSON type wrappers are values, not operators.
  it('takes a date, an id and a long as values in a partial filter', () => {
    for (const value of [
      { $date: '2026-01-01T00:00:00Z' },
      { $oid: '507f1f77bcf86cd799439011' },
      { $numberLong: '5' },
    ]) {
      expect(problem({ partialFilterExpression: { a: { $gt: value } } })).toBeUndefined();
      expect(problem({ partialFilterExpression: { a: value } })).toBeUndefined();
    }
  });

  it('holds a hashed index to one field and no uniqueness', () => {
    expect(problem({ key: { a: 'hashed', b: 'hashed' } })).toBe('hashedOneField');
    expect(problem({ key: { a: 'hashed' }, unique: true })).toBe('hashedUnique');
    expect(problem({ key: { a: 1, b: 'hashed' } })).toBeUndefined();
  });

  it('holds a wildcard index to its rules', () => {
    expect(problem({ key: { '$**': 1 }, unique: true })).toBe('wildcardUnique');
    expect(problem({ key: { 'a.$**': 1 }, sparse: true })).toBe('wildcardSparse');
    expect(problem({ key: { '$**': 1 }, expireAfterSeconds: 60 })).toBe('wildcardTtl');
    expect(problem({ key: { 'a.$**': 1 }, wildcardProjection: { a: 1 } })).toBe('wildcardProjectionNeedsAllFields');
    expect(problem({ key: { b: 1, '$**': 1 } })).toBe('compoundWildcardNeedsProjection');
    expect(problem({ key: { b: 1, '$**': 1 }, wildcardProjection: { b: 0 } })).toBeUndefined();
    expect(problem({ key: { '$**': 1 }, wildcardProjection: { a: 1 } })).toBeUndefined();
  });

  it('takes the simple collation on text and 2d indexes', () => {
    expect(problem({ key: { a: 'text' }, collation: { locale: 'simple' } })).toBeUndefined();
    expect(problem({ key: { a: '2d' }, collation: { locale: 'simple' } })).toBeUndefined();
  });

  it('holds text weights to the text keys, which MongoDB would otherwise add to', () => {
    const found = validateIndex(doc({ key: { title: 'text' }, weights: { title: 2, body: 1 } }));
    expect(found).toEqual({ key: 'weightsNeedKey', params: { field: 'body' } });
    expect(problem({ key: { title: 'text' }, weights: { title: 2 } })).toBeUndefined();
    expect(problem({ key: { '$**': 'text' }, weights: { body: 2 } })).toBeUndefined();
  });

  it('refuses a collation on text and 2d indexes', () => {
    expect(problem({ key: { a: 'text' }, collation: { locale: 'en' } })).toBe('collationNotSupported');
    expect(problem({ key: { a: '2d' }, collation: { locale: 'en' } })).toBe('collationNotSupported');
    expect(problem({ key: { a: 'hashed' }, collation: { locale: 'en' } })).toBeUndefined();
  });
});

describe('forms and documents', () => {
  const filled = (changes: Partial<ReturnType<typeof emptyIndexForm>>) => ({
    ...emptyIndexForm(),
    name: 'i',
    keys: { a: 1 },
    ...changes,
  });
  const spec = (changes: Partial<ReturnType<typeof emptyIndexForm>>, base?: IndexDocument) =>
    specFromForm(filled(changes), base);

  it('makes the smallest document for a plain index', () => {
    expect(spec({})).toEqual({ spec: { key: { a: 1 }, name: 'i' } });
  });

  it('carries every general option', () => {
    expect(
      spec({
        unique: true,
        ttlSeconds: 60,
        hidden: true,
        partialFilterExpression: '{"a":{"$gt":1}}',
        collation: '{"locale":"de"}',
        storageEngine: '{"wiredTiger":{"configString":"block_compressor=zstd"}}',
      })
    ).toEqual({
      spec: {
        key: { a: 1 },
        name: 'i',
        unique: true,
        expireAfterSeconds: 60,
        hidden: true,
        partialFilterExpression: { a: { $gt: 1 } },
        collation: { locale: 'de' },
        storageEngine: { wiredTiger: { configString: 'block_compressor=zstd' } },
      },
    });
  });

  it('carries the options of a text index', () => {
    expect(
      spec({
        keys: { t: 'text' },
        weights: '{"t":5}',
        defaultLanguage: 'german',
        languageOverride: 'lang',
        textIndexVersion: '3',
      }).spec
    ).toEqual({
      key: { t: 'text' },
      name: 'i',
      weights: { t: 5 },
      default_language: 'german',
      language_override: 'lang',
      textIndexVersion: 3,
    });
  });

  it('carries the options of geo and wildcard indexes', () => {
    expect(spec({ keys: { l: '2dsphere' }, sphereIndexVersion: '3' }).spec).toEqual({
      key: { l: '2dsphere' },
      name: 'i',
      '2dsphereIndexVersion': 3,
    });
    expect(spec({ keys: { l: '2d' }, bits: '20', min: '-10', max: '100.5' }).spec).toEqual({
      key: { l: '2d' },
      name: 'i',
      bits: 20,
      min: -10,
      max: 100.5,
    });
    expect(spec({ keys: { '$**': 1 }, wildcardProjection: '{"a":1}' }).spec).toEqual({
      key: { '$**': 1 },
      name: 'i',
      wildcardProjection: { a: 1 },
    });
  });

  it('leaves out the options of a type the keys no longer have', () => {
    expect(spec({ keys: { a: 1 }, weights: '{"t":5}', bits: '20', wildcardProjection: '{"a":1}' }).spec).toEqual({
      key: { a: 1 },
      name: 'i',
    });
  });

  it('says which option is not valid', () => {
    expect(spec({ collation: 'nope' }).problem).toEqual({ key: 'optionNotJson', params: { option: 'collation' } });
    expect(spec({ partialFilterExpression: '[1]' }).problem).toEqual({
      key: 'optionNotJson',
      params: { option: 'partialFilterExpression' },
    });
    expect(spec({ keys: { l: '2d' }, bits: 'many' }).problem).toEqual({ key: 'optionNotNumber', params: { option: 'bits' } });
    expect(spec({ keys: { t: 'text' }, textIndexVersion: '3.5' }).problem).toEqual({
      key: 'optionNotNumber',
      params: { option: 'textIndexVersion' },
    });
  });

  it('runs the rules on what the form makes', () => {
    expect(spec({ sparse: true, partialFilterExpression: '{"a":1}' }).problem?.key).toBe('partialWithSparse');
  });

  it('keeps what the form has no field for, and drops what the server sets', () => {
    const base: IndexDocument = { v: 2, ns: 'd.c', key: { a: 1 }, name: 'a_1', prepareUnique: true, future: { x: 1 } };
    expect(spec({ name: 'a_1' }, base).spec).toEqual({ key: { a: 1 }, name: 'a_1', prepareUnique: true, future: { x: 1 } });
  });

  // MongoDB refuses the two together, and unique is what prepareUnique leads to.
  it('stops preparing an index the edit makes unique', () => {
    const base: IndexDocument = { key: { a: 1 }, name: 'i', prepareUnique: true };
    expect(spec({ unique: true }, base).spec).toEqual({ key: { a: 1 }, name: 'i', unique: true });
    expect(spec({}, base).spec).toEqual({ key: { a: 1 }, name: 'i', prepareUnique: true });
  });

  it('removes what an edit cleared', () => {
    const base: IndexDocument = {
      key: { a: 1 }, name: 'i', unique: true, sparse: true, hidden: true, expireAfterSeconds: 60,
      collation: { locale: 'de' }, partialFilterExpression: { a: 1 },
    };
    expect(spec({}, base).spec).toEqual({ key: { a: 1 }, name: 'i' });
  });

  // Every field of the form starts from the document, and nothing is lost.
  it.each([
    [{ key: { b: 1, _fts: 'text', _ftsx: 1 }, name: 'i', weights: { t: 5, z: 1 }, default_language: 'german', language_override: 'lang', textIndexVersion: 3 }],
    [{ key: { l: '2dsphere' }, name: 'i', '2dsphereIndexVersion': 3 }],
    [{ key: { l: '2d' }, name: 'i', bits: 20, min: -10, max: 100 }],
    [{ key: { '$**': 1 }, name: 'i', wildcardProjection: { a: 1 } }],
    [{ key: { a: 1 }, name: 'i', unique: true, expireAfterSeconds: 60, hidden: true, collation: { locale: 'de', strength: 2 } }],
    [{ key: { a: 1 }, name: 'i', sparse: true, storageEngine: { wiredTiger: {} } }],
    [{ key: { a: 1 }, name: 'i', partialFilterExpression: { at: { $gt: { $date: '2026-01-01T00:00:00Z' } } } }],
  ])('rebuilds %j unchanged through the form', (document) => {
    const made = specFromForm(formFromSpec(document), document).spec as IndexDocument;
    expect(made).toEqual({ ...document, key: displayKeys(document) });
  });
});

describe('inPlaceEdits', () => {
  const ttl = doc({ expireAfterSeconds: 60 });

  it('has nothing to do when nothing changed', () => {
    expect(inPlaceEdits(doc({}), doc({}))).toEqual([]);
    expect(inPlaceEdits(doc({ v: 2 }), doc({}))).toEqual([]);
  });

  it('counts a text index that comes back through the form as unchanged', () => {
    const text: IndexDocument = { v: 2, key: { _fts: 'text', _ftsx: 1 }, name: 't', weights: { t: 1 }, textIndexVersion: 3 };
    expect(inPlaceEdits(text, { ...text, key: { t: 'text' } })).toEqual([]);
  });

  it('changes hidden and the expiry in place', () => {
    expect(inPlaceEdits(doc({}), doc({ hidden: true }))).toEqual([{ command: 'set_index_option', args: { option: 'hidden', value: true } }]);
    expect(inPlaceEdits(doc({ hidden: true }), doc({}))).toEqual([{ command: 'set_index_option', args: { option: 'hidden', value: false } }]);
    expect(inPlaceEdits(ttl, doc({ expireAfterSeconds: 90 }))).toEqual([{ command: 'set_index_expiry', args: { expireAfterSeconds: 90 } }]);
    expect(inPlaceEdits(ttl, doc({ expireAfterSeconds: 90, hidden: true }))).toEqual([
      { command: 'set_index_expiry', args: { expireAfterSeconds: 90 } },
      { command: 'set_index_option', args: { option: 'hidden', value: true } },
    ]);
  });

  it('rebuilds for anything else', () => {
    expect(inPlaceEdits(doc({}), doc({ unique: true }))).toBeNull();
    expect(inPlaceEdits(doc({}), doc({ name: 'other' }))).toBeNull();
    expect(inPlaceEdits(doc({}), doc({ key: { a: -1 } }))).toBeNull();
    expect(inPlaceEdits(doc({}), doc({ expireAfterSeconds: 60 }))).toBeNull();
    expect(inPlaceEdits(ttl, doc({}))).toBeNull();
    expect(inPlaceEdits(doc({ key: { a: 1, b: 1 } }), doc({ key: { b: 1, a: 1 } }))).toBeNull();
    expect(inPlaceEdits(doc({ collation: { locale: 'de' } }), doc({ collation: { locale: 'en' } }))).toBeNull();
  });
});

describe('isPlainIndex', () => {
  it('is the document a server before API version 5 can take', () => {
    expect(isPlainIndex({ key: { a: 'text' }, name: 'i', unique: true, sparse: true })).toBe(true);
    expect(isPlainIndex({ key: { a: 1 }, name: 'i', hidden: true })).toBe(false);
    expect(isPlainIndex({ key: { a: 1 }, name: 'i', expireAfterSeconds: 60 })).toBe(false);
  });
});

describe('indexBuilds', () => {
  const op = (changes: Partial<CurrentOp>): CurrentOp => ({
    opid: 1, op: 'command', ns: 'd.c', secsRunning: 12, client: '', desc: 'IndexBuildsCoordinatorMongod-0',
    command: '{ "createIndexes": "c", "indexes": [{ "v": 2, "key": { "a": 1 }, "name": "a_1" }, { "key": { "b": 1 }, "name":"b_1" }] }',
    ...changes,
  });

  it('finds the builds on this collection', () => {
    expect(indexBuilds([op({ progress: { done: 10, total: 40 } })], 'd.c')).toEqual([
      { opid: 1, names: ['a_1', 'b_1'], secsRunning: 12, percent: 25 },
    ]);
  });

  it('skips other collections, other operations and the client waiting on the build', () => {
    expect(indexBuilds([op({ ns: 'd.other' }), op({ desc: 'conn27' })], 'd.c')).toEqual([]);
  });

  it('has no percent without progress, as on a server connection', () => {
    expect(indexBuilds([op({})], 'd.c')[0].percent).toBeNull();
    expect(indexBuilds([op({ progress: { done: 0, total: 0 } })], 'd.c')[0].percent).toBeNull();
  });
});
