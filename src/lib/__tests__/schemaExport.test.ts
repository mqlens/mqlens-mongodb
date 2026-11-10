import { describe, it, expect } from 'vitest';
import { schemaToMarkdown } from '../schemaExport';

describe('schemaToMarkdown', () => {
  it('writes a table of each field with its types, coverage and top values', () => {
    const md = schemaToMarkdown('shop.customers', {
      sampled: 4,
      fields: [
        { path: '_id', types: [{ type: 'objectId', count: 4 }], presence: 4, coverage: 1 },
        {
          path: 'tier',
          types: [{ type: 'string', count: 3 }, { type: 'null', count: 1 }],
          presence: 4,
          coverage: 1,
          enumValues: ['Premium', 'Standard'],
          enumCounts: { Premium: 1, Standard: 2 },
        },
        { path: 'a|b', types: [{ type: 'int', count: 1 }], presence: 1, coverage: 0.25 },
      ],
    });
    expect(md).toBe(
      [
        '# Schema of shop.customers',
        '',
        'Sampled 4 documents.',
        '',
        '| Field | Types | Coverage | Values |',
        '|---|---|---:|---|',
        '| `_id` | objectId | 100% |  |',
        '| `tier` | string 75%, null 25% | 100% | Standard (2), Premium (1) |',
        '| `a\\|b` | int | 25% |  |',
        '',
      ].join('\n')
    );
  });
});
