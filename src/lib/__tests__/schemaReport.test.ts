import { describe, it, expect } from 'vitest';
import { validatorFromSchemaReport } from '../schemaReport';

describe('validatorFromSchemaReport', () => {
  it('builds a nested $jsonSchema, requiring fields every parent has', () => {
    const v = validatorFromSchemaReport({
      sampled: 2,
      fields: [
        { path: '_id', types: [{ type: 'objectId', count: 2 }], presence: 2, coverage: 1 },
        { path: 'address', types: [{ type: 'object', count: 1 }], presence: 1, coverage: 0.5 },
        { path: 'address.city', types: [{ type: 'string', count: 1 }], presence: 1, coverage: 0.5 },
        {
          path: 'age',
          types: [{ type: 'int', count: 1 }, { type: 'null', count: 1 }],
          presence: 2,
          coverage: 1,
        },
        { path: 'blob', types: [{ type: 'binary', count: 1 }], presence: 1, coverage: 0.5 },
      ],
    });

    expect(v).toEqual({
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'age'],
        properties: {
          _id: { bsonType: 'objectId' },
          address: {
            bsonType: 'object',
            required: ['city'],
            properties: { city: { bsonType: 'string' } },
          },
          age: { bsonType: ['int', 'null'] },
          // The sampler says "binary"; $jsonSchema calls it "binData".
          blob: { bsonType: 'binData' },
        },
      },
    });
  });

  it('keeps a field named __proto__ as an ordinary property', () => {
    const v = validatorFromSchemaReport({
      sampled: 1,
      fields: [{ path: '__proto__', types: [{ type: 'string', count: 1 }], presence: 1, coverage: 1 }],
    });
    expect(JSON.parse(JSON.stringify(v)).$jsonSchema.properties).toEqual(
      JSON.parse('{"__proto__": {"bsonType": "string"}}')
    );
  });

  it('keeps a field named with the empty string apart from the top level', () => {
    const v = validatorFromSchemaReport({
      sampled: 1,
      fields: [
        { path: '', types: [{ type: 'string', count: 1 }], presence: 1, coverage: 1 },
        { path: 'name', types: [{ type: 'string', count: 1 }], presence: 1, coverage: 1 },
      ],
    });
    expect(JSON.parse(JSON.stringify(v)).$jsonSchema).toEqual({
      bsonType: 'object',
      properties: { '': { bsonType: 'string' }, name: { bsonType: 'string' } },
      required: ['', 'name'],
    });
  });

  it('allows JavaScript with scope where the sample saw JavaScript', () => {
    // The sampler labels both BSON code types `javascript`.
    const v = validatorFromSchemaReport({
      sampled: 2,
      fields: [
        { path: 'fn', types: [{ type: 'javascript', count: 2 }], presence: 2, coverage: 1 },
        {
          path: 'maybe',
          types: [{ type: 'javascript', count: 1 }, { type: 'null', count: 1 }],
          presence: 2,
          coverage: 1,
        },
      ],
    });
    expect(v.$jsonSchema.properties?.fn.bsonType).toEqual(['javascript', 'javascriptWithScope']);
    expect(v.$jsonSchema.properties?.maybe.bsonType).toEqual(['javascript', 'javascriptWithScope', 'null']);
  });
});
