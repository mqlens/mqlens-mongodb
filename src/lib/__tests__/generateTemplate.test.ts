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

// ---------------------------------------------------------------------------
// Ported backend DSL shape-acceptance check (cross-layer invariant guard)
// ---------------------------------------------------------------------------

const STRING_GENERATOR_ALLOWLIST = new Set([
  '$name',
  '$firstName',
  '$lastName',
  '$email',
  '$objectId',
  '$uuid',
  '$bool',
]);
const KNOWN_WRAPPER_KEYS = new Set(['$int', '$float', '$date', '$lorem', '$pick', '$array', '$literal']);

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A structural port of the Rust backend's `parse_spec`
 * (`src-tauri/src/db/generate.rs`) — mirrors ONLY its shape-acceptance logic
 * (bare-`$…`-string generator allowlist, zero-vs-one-vs-many `$`-key
 * disambiguation, known wrapper-key set) — the exact class of check Fix 2's
 * bug (a shallow `needsLiteralWrap` letting a nested `$oid` key leak
 * unwrapped into a field position) would have failed. It does NOT replicate
 * `parse_int`/`parse_float`/`parse_date`/etc.'s numeric-range/date-format
 * validation — that's out of scope for the "never emits a shape the backend
 * would structurally reject as an unknown generator" contract this guards.
 *
 * LIMITATION: this is a hand-ported subset run inside the frontend test
 * harness, not a real call into `parse_template` (there is no way to invoke
 * the Rust binary from a vitest run here) — if the two drift, this can pass
 * a shape the real backend still rejects (or vice versa). Treat it as a
 * first line of defense against exactly this bug class, not a full
 * contract test. */
function assertAcceptedByGenerateDsl(value: unknown, path = ''): void {
  if (typeof value === 'string') {
    if (value.startsWith('$') && !STRING_GENERATOR_ALLOWLIST.has(value)) {
      throw new Error(`${path}: unknown generator ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    // Bare arrays are always literal passthrough in the DSL — contents are
    // never reinterpreted as specs, so nothing further to check.
    return;
  }
  if (isPlainObj(value)) {
    const keys = Object.keys(value);
    const dollarKeys = keys.filter((k) => k.startsWith('$'));
    if (dollarKeys.length === 0) {
      for (const k of keys) assertAcceptedByGenerateDsl(value[k], path ? `${path}.${k}` : k);
      return;
    }
    if (keys.length === 1) {
      const key = dollarKeys[0];
      if (!KNOWN_WRAPPER_KEYS.has(key)) throw new Error(`${path}: unknown generator ${key}`);
      if (key === '$array') {
        const inner = value[key];
        if (isPlainObj(inner) && 'of' in inner) assertAcceptedByGenerateDsl(inner.of, `${path}[0]`);
      }
      // $literal's payload is never re-parsed as a spec — verbatim passthrough.
      return;
    }
    throw new Error(`${path}: unknown generator ${dollarKeys[0]}`);
  }
  // number / boolean / null — always literal.
}

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

    // Regression for review Fix 2: `needsLiteralWrap` used to check only the
    // literal payload's TOP-LEVEL keys for a `$`-prefix, so a `$`-key nested
    // one or more levels deep (as opposed to right at the payload's root)
    // re-serialized unwrapped — `{"f": {"a": {"$oid": "..."}}}` — which the
    // backend rejects as `f.a: unknown generator $oid` even though the row
    // faithfully represented a valid `$literal` construct. The scan is now
    // deep (recurses through nested plain objects, not arrays — bare arrays
    // are always literal passthrough in the DSL regardless of contents).
    it('deep-scans a literal payload for $-keys at any nesting depth, not just the top level', () => {
      const rows: GenRow[] = [
        { id: '1', name: 'f', kind: 'literal', options: { value: { a: { $oid: '507f1f77bcf86cd799439011' } } } },
        // A $-key nested inside a bare array never needs wrapping — arrays
        // are literal passthrough at any position, contents included.
        { id: '2', name: 'g', kind: 'literal', options: { value: { list: [{ $oid: 'x' }] } } },
      ];
      const template = rowsToTemplate(rows);
      expect(template.f).toEqual({ $literal: { a: { $oid: '507f1f77bcf86cd799439011' } } });
      expect(template.g).toEqual({ list: [{ $oid: 'x' }] });
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
      {
        label: '$literal with a $-key nested below the top level (Fix 2 regression)',
        rows: [{ id: '1', name: 'f', kind: 'literal', options: { value: { a: { $oid: '507f1f77bcf86cd799439011' } } } }],
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

    // Cross-layer invariant (review recommendation): `rowsToTemplate` hand-
    // mirrors the backend's DSL parser (`src-tauri/src/db/generate.rs::parse_spec`)
    // rather than sharing code with it — the same seam that let Fix 2's bug
    // (a shallow-only `needsLiteralWrap`) through undetected by any prior
    // test, since every prior fixture only had `$`-keys at the payload root.
    // This drives every round-trip fixture's emitted template through a
    // ported structural subset of `parse_spec` (see `assertAcceptedByGenerateDsl`
    // above) so a future regression of this shape is caught mechanically
    // instead of relying on a reviewer to spot it by inspection again.
    it('every round-trip fixture template is accepted by the ported backend DSL shape check', () => {
      for (const { label, rows } of cases) {
        const template = rowsToTemplate(rows);
        expect(() => assertAcceptedByGenerateDsl(template), label).not.toThrow();
      }
    });
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
