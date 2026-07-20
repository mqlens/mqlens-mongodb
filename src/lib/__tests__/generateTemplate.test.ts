import { describe, it, expect } from 'vitest';
import {
  templateToRows,
  rowsToTemplate,
  newFieldRow,
  newObjectRow,
  newArrayRow,
  defaultOptionsFor,
  findEmptyPickRow,
  type GenRow,
} from '../generateTemplate';

describe('generateTemplate', () => {
  describe('templateToRows — representable shapes', () => {
    it('maps every bare-string generator', () => {
      const rows = templateToRows({
        name: '$name',
        first: '$firstName',
        last: '$lastName',
        email: '$email',
        id: '$objectId',
        uid: '$uuid',
        active: '$bool',
      });
      expect(rows).not.toBeNull();
      expect(rows!.map((r) => [r.name, r.kind])).toEqual([
        ['name', 'name'],
        ['first', 'firstName'],
        ['last', 'lastName'],
        ['email', 'email'],
        ['id', 'objectId'],
        ['uid', 'uuid'],
        ['active', 'bool'],
      ]);
    });

    it('maps $int with explicit and defaulted min/max', () => {
      const rows = templateToRows({ a: { $int: { min: 1, max: 5 } }, b: { $int: {} } });
      expect(rows).toEqual([
        expect.objectContaining({ name: 'a', kind: 'int', options: { min: 1, max: 5 } }),
        expect.objectContaining({ name: 'b', kind: 'int', options: { min: 0, max: 1000 } }),
      ]);
    });

    it('maps $float with decimals default', () => {
      const rows = templateToRows({ a: { $float: { min: 0, max: 10, decimals: 3 } } });
      expect(rows![0]).toMatchObject({ kind: 'float', options: { min: 0, max: 10, decimals: 3 } });
    });

    it('maps $date past_days and range forms', () => {
      const rows = templateToRows({
        a: { $date: { past_days: 30 } },
        b: { $date: { from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' } },
      });
      expect(rows![0]).toMatchObject({ kind: 'date', options: { mode: 'past_days', pastDays: 30 } });
      expect(rows![1]).toMatchObject({
        kind: 'date',
        options: { mode: 'range', from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' },
      });
    });

    it('maps $lorem, $pick, $array of a leaf generator', () => {
      const rows = templateToRows({
        bio: { $lorem: { words: 5 } },
        tier: { $pick: ['free', 'pro', 1, true, null] },
        tags: { $array: { of: { $lorem: { words: 1 } }, min: 2, max: 4 } },
      });
      expect(rows![0]).toMatchObject({ kind: 'lorem', options: { words: 5 } });
      expect(rows![1]).toMatchObject({ kind: 'pick', options: { values: ['free', 'pro', 1, true, null] } });
      expect(rows![2]).toMatchObject({ kind: 'array', options: { min: 2, max: 4 } });
      expect(rows![2].children).toHaveLength(1);
      expect(rows![2].children![0]).toMatchObject({ kind: 'lorem', options: { words: 1 } });
    });

    it('maps nested plain objects to object rows with children', () => {
      const rows = templateToRows({
        address: { city: { $lorem: { words: 1 } }, zip: { $int: { min: 10000, max: 99999 } } },
      });
      expect(rows![0]).toMatchObject({ name: 'address', kind: 'object' });
      expect(rows![0].children).toHaveLength(2);
      expect(rows![0].children![0]).toMatchObject({ name: 'city', kind: 'lorem' });
      expect(rows![0].children![1]).toMatchObject({ name: 'zip', kind: 'int' });
    });

    it('maps literal scalars, arrays, and $literal-wrapped values', () => {
      const rows = templateToRows({
        constant: 42,
        flag: true,
        nothing: null,
        plain: 'hello',
        list: [1, 2, 3],
        escaped: { $literal: '$notAGenerator' },
      });
      expect(rows).toHaveLength(6);
      for (const [i, expected] of [42, true, null, 'hello', [1, 2, 3], '$notAGenerator'].entries()) {
        expect(rows![i]).toMatchObject({ kind: 'literal', options: { value: expected } });
      }
    });
  });

  describe('templateToRows — unrepresentable shapes return null', () => {
    it('rejects a non-object root', () => {
      expect(templateToRows([1, 2, 3])).toBeNull();
      expect(templateToRows('hello')).toBeNull();
      expect(templateToRows(42)).toBeNull();
      expect(templateToRows(null)).toBeNull();
    });

    it('rejects a root with a $-prefixed key', () => {
      expect(templateToRows({ $literal: {} })).toBeNull();
    });

    it('rejects unknown bare generator strings', () => {
      expect(templateToRows({ a: '$emial' })).toBeNull();
    });

    it('rejects unknown $-wrapper keys', () => {
      expect(templateToRows({ a: { $notreal: {} } })).toBeNull();
    });

    it('rejects ambiguous multi-$-key objects', () => {
      expect(templateToRows({ a: { $int: {}, $float: {} } })).toBeNull();
    });

    it('rejects $pick with non-scalar choices', () => {
      expect(templateToRows({ a: { $pick: [{ x: 1 }, { y: 2 }] } })).toBeNull();
      expect(templateToRows({ a: { $pick: [[1, 2]] } })).toBeNull();
    });

    it('rejects $array missing of/min/max', () => {
      expect(templateToRows({ a: { $array: { min: 1, max: 2 } } })).toBeNull();
      expect(templateToRows({ a: { $array: { of: '$bool', max: 2 } } })).toBeNull();
    });

    it('rejects $int/$float/$lorem/$date with non-numeric or missing fields', () => {
      expect(templateToRows({ a: { $int: { min: 'x', max: 5 } } })).toBeNull();
      expect(templateToRows({ a: { $float: { min: 0 } } })).toBeNull();
      expect(templateToRows({ a: { $lorem: {} } })).toBeNull();
      expect(templateToRows({ a: { $date: {} } })).toBeNull();
    });

    it('propagates a nested unrepresentable field up to the whole template', () => {
      expect(templateToRows({ ok: '$name', bad: { $notreal: {} } })).toBeNull();
      expect(templateToRows({ nested: { ok: '$name', bad: '$emial' } })).toBeNull();
      expect(
        templateToRows({ tags: { $array: { of: { $notreal: {} }, min: 1, max: 2 } } })
      ).toBeNull();
    });
  });

  describe('rowsToTemplate', () => {
    it('emits every leaf generator in DSL form', () => {
      const rows: GenRow[] = [
        { id: '1', name: 'a', kind: 'name', options: {} },
        { id: '2', name: 'b', kind: 'email', options: {} },
        { id: '3', name: 'c', kind: 'int', options: { min: 1, max: 2 } },
        { id: '4', name: 'd', kind: 'float', options: { min: 0, max: 1, decimals: 4 } },
        { id: '5', name: 'e', kind: 'lorem', options: { words: 3 } },
        { id: '6', name: 'f', kind: 'pick', options: { values: ['x', 'y'] } },
      ];
      expect(rowsToTemplate(rows)).toEqual({
        a: '$name',
        b: '$email',
        c: { $int: { min: 1, max: 2 } },
        d: { $float: { min: 0, max: 1, decimals: 4 } },
        e: { $lorem: { words: 3 } },
        f: { $pick: ['x', 'y'] },
      });
    });

    it('emits $date in past_days or range form based on options.mode', () => {
      const rows: GenRow[] = [
        { id: '1', name: 'a', kind: 'date', options: { mode: 'past_days', pastDays: 10 } },
        {
          id: '2',
          name: 'b',
          kind: 'date',
          options: { mode: 'range', from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' },
        },
      ];
      expect(rowsToTemplate(rows)).toEqual({
        a: { $date: { past_days: 10 } },
        b: { $date: { from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' } },
      });
    });

    it('emits nested object and array rows correctly', () => {
      const rows: GenRow[] = [
        {
          id: '1',
          name: 'address',
          kind: 'object',
          options: {},
          children: [
            { id: '1a', name: 'city', kind: 'lorem', options: { words: 1 } },
            { id: '1b', name: 'zip', kind: 'int', options: { min: 10000, max: 99999 } },
          ],
        },
        {
          id: '2',
          name: 'tags',
          kind: 'array',
          options: { min: 1, max: 3 },
          children: [{ id: '2a', name: '', kind: 'lorem', options: { words: 1 } }],
        },
      ];
      expect(rowsToTemplate(rows)).toEqual({
        address: { city: { $lorem: { words: 1 } }, zip: { $int: { min: 10000, max: 99999 } } },
        tags: { $array: { of: { $lorem: { words: 1 } }, min: 1, max: 3 } },
      });
    });

    it('emits plain literals directly but wraps $-looking values in $literal', () => {
      const rows: GenRow[] = [
        { id: '1', name: 'a', kind: 'literal', options: { value: 42 } },
        { id: '2', name: 'b', kind: 'literal', options: { value: 'plain string' } },
        { id: '3', name: 'c', kind: 'literal', options: { value: '$looksLikeAGenerator' } },
        { id: '4', name: 'd', kind: 'literal', options: { value: { $foo: 1 } } },
        { id: '5', name: 'e', kind: 'literal', options: { value: [1, 2, 3] } },
      ];
      const template = rowsToTemplate(rows);
      expect(template.a).toBe(42);
      expect(template.b).toBe('plain string');
      expect(template.c).toEqual({ $literal: '$looksLikeAGenerator' });
      expect(template.d).toEqual({ $literal: { $foo: 1 } });
      expect(template.e).toEqual([1, 2, 3]);
    });
  });

  describe('round-trip: templateToRows(rowsToTemplate(rows)) preserves shape', () => {
    const cases: { label: string; rows: GenRow[] }[] = [
      {
        label: 'flat mixed generators',
        rows: [
          { id: '1', name: 'name', kind: 'name', options: {} },
          { id: '2', name: 'age', kind: 'int', options: { min: 18, max: 65 } },
          { id: '3', name: 'score', kind: 'float', options: { min: 0, max: 100, decimals: 2 } },
          { id: '4', name: 'bio', kind: 'lorem', options: { words: 4 } },
        ],
      },
      {
        label: 'nested object',
        rows: [
          {
            id: '1',
            name: 'address',
            kind: 'object',
            options: {},
            children: [
              { id: '1a', name: 'city', kind: 'lorem', options: { words: 1 } },
              { id: '1b', name: 'zip', kind: 'int', options: { min: 0, max: 99999 } },
            ],
          },
        ],
      },
      {
        label: 'array of object',
        rows: [
          {
            id: '1',
            name: 'items',
            kind: 'array',
            options: { min: 1, max: 5 },
            children: [
              {
                id: '1a',
                name: '',
                kind: 'object',
                options: {},
                children: [{ id: '1a1', name: 'sku', kind: 'uuid', options: {} }],
              },
            ],
          },
        ],
      },
      {
        label: '$pick',
        rows: [{ id: '1', name: 'tier', kind: 'pick', options: { values: ['free', 'pro', 3, false, null] } }],
      },
      {
        label: '$literal escaping a dollar-looking string',
        rows: [{ id: '1', name: 'note', kind: 'literal', options: { value: '$notAGenerator' } }],
      },
    ];

    for (const { label, rows } of cases) {
      it(label, () => {
        const template = rowsToTemplate(rows);
        const roundTripped = templateToRows(template);
        expect(roundTripped).not.toBeNull();
        // Compare structurally, ignoring generated ids.
        const strip = (rs: GenRow[]): unknown[] =>
          rs.map((r) => ({
            name: r.name,
            kind: r.kind,
            options: r.options,
            children: r.children ? strip(r.children) : undefined,
          }));
        expect(strip(roundTripped!)).toEqual(strip(rows));
        // And the re-emitted template is equivalent to the original.
        expect(rowsToTemplate(roundTripped!)).toEqual(template);
      });
    }
  });

  describe('row factories produce representable rows', () => {
    it('newFieldRow', () => {
      const row = newFieldRow('bio');
      expect(templateToRows(rowsToTemplate([row]))).not.toBeNull();
    });
    it('newObjectRow', () => {
      const row = newObjectRow('address');
      expect(templateToRows(rowsToTemplate([row]))).not.toBeNull();
    });
    it('newArrayRow', () => {
      const row = newArrayRow('tags');
      expect(templateToRows(rowsToTemplate([row]))).not.toBeNull();
    });
    it('row ids are unique', () => {
      const ids = new Set([newFieldRow('a').id, newFieldRow('b').id, newFieldRow('c').id]);
      expect(ids.size).toBe(3);
    });
  });

  describe('defaultOptionsFor("pick") — never seeds an invalid $pick', () => {
    it('seeds at least one placeholder value, not an empty array', () => {
      const options = defaultOptionsFor('pick');
      expect(Array.isArray(options.values)).toBe(true);
      expect((options.values as unknown[]).length).toBeGreaterThan(0);
    });

    it('a row freshly switched to pick is immediately representable and non-empty', () => {
      const row: GenRow = { id: '1', name: 'tier', kind: 'pick', options: defaultOptionsFor('pick') };
      const template = rowsToTemplate([row]);
      expect((template.tier as any).$pick.length).toBeGreaterThan(0);
      expect(findEmptyPickRow([row])).toBeNull();
    });
  });

  describe('findEmptyPickRow', () => {
    it('returns null when there are no pick rows or all have values', () => {
      expect(findEmptyPickRow([{ id: '1', name: 'a', kind: 'name', options: {} }])).toBeNull();
      expect(
        findEmptyPickRow([{ id: '1', name: 'tier', kind: 'pick', options: { values: ['x'] } }])
      ).toBeNull();
    });

    it('finds a top-level empty pick row', () => {
      const row: GenRow = { id: '1', name: 'tier', kind: 'pick', options: { values: [] } };
      expect(findEmptyPickRow([row])).toBe(row);
    });

    it('finds an empty pick row nested inside an object', () => {
      const nested: GenRow = { id: '2', name: 'tier', kind: 'pick', options: { values: [] } };
      const parent: GenRow = { id: '1', name: 'address', kind: 'object', options: {}, children: [nested] };
      expect(findEmptyPickRow([parent])).toBe(nested);
    });

    it('finds an empty pick row nested inside an array item', () => {
      const item: GenRow = { id: '2', name: '', kind: 'pick', options: { values: [] } };
      const arr: GenRow = { id: '1', name: 'tags', kind: 'array', options: { min: 1, max: 3 }, children: [item] };
      expect(findEmptyPickRow([arr])).toBe(item);
    });
  });
});
