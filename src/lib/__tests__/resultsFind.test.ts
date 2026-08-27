import { describe, it, expect } from 'vitest';
import { ObjectId, Long } from 'bson';
import { cellText, findMatches, stepMatch, isMatchAt, type FindCell } from '../resultsFind';

const cell = (rowIndex: number, text: string, extra: Partial<FindCell> = {}): FindCell => ({
  rowIndex,
  text,
  ...extra,
});

describe('cellText', () => {
  it('joins the key and the value the way the grid shows them', () => {
    expect(cellText('serviceName', 'token-srv')).toBe('serviceName token-srv');
  });

  it('renders BSON as the scalar a user would copy, not the EJSON wrapper', () => {
    const oid = new ObjectId('507f1f77bcf86cd799439011');
    expect(cellText('_id', oid)).toBe('_id 507f1f77bcf86cd799439011');
    expect(cellText('big', Long.fromString('42'))).toBe('big 42');
  });

  it('handles the table view\'s plain extended-JSON shapes', () => {
    expect(cellText('_id', { $oid: '507f1f77bcf86cd799439011' })).toBe(
      '_id 507f1f77bcf86cd799439011',
    );
  });

  it('copes with a missing key or a missing value', () => {
    expect(cellText(null, 'lonely')).toBe('lonely');
    expect(cellText('lonely', undefined)).toBe('lonely');
    expect(cellText(null, undefined)).toBe('');
  });

  it('searches nested containers via their serialized form', () => {
    expect(cellText('address', { city: 'Pforzheim' })).toContain('Pforzheim');
  });
});

describe('findMatches', () => {
  const cells = [
    cell(0, 'serviceName token-srv'),
    cell(1, 'serviceName auth-srv'),
    cell(2, 'path /TOKEN'),
  ];

  it('finds matches case-insensitively, in view order', () => {
    const found = findMatches(cells, 'token');
    expect(found.map((m) => m.rowIndex)).toEqual([0, 2]);
  });

  it('ignores an empty or whitespace query', () => {
    expect(findMatches(cells, '')).toEqual([]);
    expect(findMatches(cells, '   ')).toEqual([]);
  });

  it('trims the query, so a stray space still matches', () => {
    expect(findMatches(cells, '  auth ')).toHaveLength(1);
  });

  it('reports one match per cell, since a cell is what can be stepped to', () => {
    // "srv" appears twice in this text; navigating to it twice would go nowhere.
    expect(findMatches([cell(0, 'srv and srv again')], 'srv')).toHaveLength(1);
  });

  it('carries the folds that must be opened to reach the row', () => {
    const found = findMatches([cell(7, 'deep value', { ancestors: [1, 4] })], 'deep');
    expect(found[0].ancestors).toEqual([1, 4]);
  });

  it('defaults ancestors to empty for views without folding', () => {
    expect(findMatches([cell(0, 'flat')], 'flat')[0].ancestors).toEqual([]);
  });

  it('keeps the column key so a table cell can be highlighted', () => {
    const found = findMatches([cell(3, 'gold', { columnKey: 'tier' })], 'gold');
    expect(found[0]).toMatchObject({ rowIndex: 3, columnKey: 'tier' });
  });
});

describe('stepMatch', () => {
  it('wraps forwards and backwards', () => {
    expect(stepMatch(3, 0, 1)).toBe(1);
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
  });

  it('selects an end when nothing is active yet', () => {
    expect(stepMatch(3, -1, 1)).toBe(0);
    expect(stepMatch(3, -1, -1)).toBe(2);
  });

  it('reports no selection when there is nothing to step through', () => {
    expect(stepMatch(0, -1, 1)).toBe(-1);
    expect(stepMatch(0, 5, -1)).toBe(-1);
  });
});

describe('isMatchAt', () => {
  it('matches on row and column together', () => {
    const m = { rowIndex: 2, columnKey: 'tier', ancestors: [] };
    expect(isMatchAt(m, 2, 'tier')).toBe(true);
    expect(isMatchAt(m, 2, 'name')).toBe(false);
    expect(isMatchAt(m, 3, 'tier')).toBe(false);
  });

  it('treats a column-less cell as its own identity', () => {
    const m = { rowIndex: 2, ancestors: [] };
    expect(isMatchAt(m, 2)).toBe(true);
    expect(isMatchAt(m, 2, 'tier')).toBe(false);
  });

  it('is false with no active match', () => {
    expect(isMatchAt(undefined, 0)).toBe(false);
  });
});
