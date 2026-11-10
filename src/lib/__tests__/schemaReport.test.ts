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
});
