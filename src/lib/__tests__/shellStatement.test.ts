import { describe, it, expect } from 'vitest';
import { statementAt } from '../shellStatement';

// `|` marks the cursor.
const at = (withCursor: string): string => {
  const offset = withCursor.indexOf('|');
  return statementAt(withCursor.replace('|', ''), offset);
};

describe('statementAt', () => {
  it('takes the line the cursor is on when there is one statement per line', () => {
    expect(at('db.a.find()\ndb.b.fi|nd()\ndb.c.find()')).toBe('db.b.find()');
  });

  it('keeps a statement whole across lines inside brackets', () => {
    expect(at('db.a.insertOne({\n  x: |1,\n\n  y: 2\n})\nprint(1)')).toBe('db.a.insertOne({\n  x: 1,\n\n  y: 2\n})');
  });

  it('keeps a chained call that continues on a line starting with a dot', () => {
    expect(at('db.a.find()\n  .lim|it(1)\nprint(1)')).toBe('db.a.find()\n  .limit(1)');
  });

  it('splits at a top-level semicolon', () => {
    expect(at('a(); b(|)')).toBe('b()');
    expect(at('a(|); b()')).toBe('a();');
  });

  it('ignores semicolons and newlines inside strings and comments', () => {
    expect(at('print("a;b|")')).toBe('print("a;b")');
    expect(at('print(`a\n\nb|`)')).toBe('print(`a\n\nb`)');
    expect(at('f(/* x;\n\ny */ 1|)')).toBe('f(/* x;\n\ny */ 1)');
    expect(at('f(1) // a; b|')).toBe('f(1) // a; b');
  });

  it('falls back to the statement before the cursor on a blank spot', () => {
    expect(at('a();|\n\nb()')).toBe('a();');
    expect(at('a()\n|\nb()')).toBe('a()');
  });

  it('takes the next statement when nothing comes before the cursor', () => {
    expect(at('|\n\nb()')).toBe('b()');
  });
});
