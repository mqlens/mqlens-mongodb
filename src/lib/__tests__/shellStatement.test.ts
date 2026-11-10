import { describe, it, expect } from 'vitest';
import { statementAt } from '../shellStatement';

// `|` marks the cursor.
const at = (withCursor: string): string => {
  const offset = withCursor.indexOf('|');
  return statementAt(withCursor.slice(0, offset) + withCursor.slice(offset + 1), offset);
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

  it('takes the next statement when the cursor sits between two with no space', () => {
    expect(at('a();|b()')).toBe('b()');
  });

  it('keeps a control-flow header with its body on the next line', () => {
    expect(at('if (false)\n  db.orders.deleteMany(|{})')).toBe('if (false)\n  db.orders.deleteMany({})');
    expect(at('if (x)\n{\n  del(|)\n}')).toBe('if (x)\n{\n  del()\n}');
    expect(at('for (const d of docs)\n  print(|d)')).toBe('for (const d of docs)\n  print(d)');
    expect(at('if (x) a()\nelse\n  b(|)')).toBe('if (x) a()\nelse\n  b()');
  });

  it('keeps else, catch and finally with the block before them', () => {
    expect(at('if (x) {\n  a()\n}\nelse {\n  b(|)\n}')).toBe('if (x) {\n  a()\n}\nelse {\n  b()\n}');
    expect(at('try {\n  a()\n}\ncatch (e) {\n  pri|nt(e)\n}\nfinally {\n  c()\n}')).toBe(
      'try {\n  a()\n}\ncatch (e) {\n  print(e)\n}\nfinally {\n  c()\n}'
    );
  });

  it('keeps an expression that continues after an operator or before one', () => {
    expect(at('const n =\n  db.a.countDocu|ments()')).toBe('const n =\n  db.a.countDocuments()');
    expect(at('const ok = a()\n  && b(|)')).toBe('const ok = a()\n  && b()');
  });

  it('keeps a do loop with its while on the next line', () => {
    const loop = 'do {\n  print("once")\n}\nwhile (false);';
    expect(at('do {\n  print(|"once")\n}\nwhile (false);')).toBe(loop);
    expect(at('do {\n  print("once")\n}\nwhile (fal|se);')).toBe(loop);
    expect(at('do a(); while (x)\nb(|)')).toBe('b()');
    expect(at('do {\n  a()\n}\nwhile (x)\nb(|)')).toBe('b()');
  });

  it('looks past comments to see whether the next line continues a chain', () => {
    expect(at('db.a.find()\n  // only one\n  .limi|t(1)')).toBe('db.a.find()\n  // only one\n  .limit(1)');
    expect(at('db.a.find()\n  /* one */ .limi|t(1)')).toBe('db.a.find()\n  /* one */ .limit(1)');
  });

  it('does not read a trailing comment as an unfinished operator', () => {
    expect(at('print("ch|eck") /* note */\ndb.orders.deleteMany({})')).toBe('print("check") /* note */');
  });

  it('ends a statement after a postfix increment or decrement', () => {
    expect(at('globalThis.counter+|+\ndb.orders.deleteMany({})')).toBe('globalThis.counter++');
    expect(at('n-|-\ndb.orders.deleteMany({})')).toBe('n--');
    expect(at('a\n++|b')).toBe('++b');
  });

  it('keeps a trailing sign after another sign open', () => {
    const both = 'const delta = total+-\n  db.orders.countDocuments({})';
    expect(at('const del|ta = total+-\n  db.orders.countDocuments({})')).toBe(both);
    expect(at('const delta = total+-\n  db.orders.countDoc|uments({})')).toBe(both);
  });

  it('keeps a call or computed access that opens on the next line', () => {
    expect(at('db.orders.find\n({active: tr|ue})')).toBe('db.orders.find\n({active: true})');
    expect(at('db.orders.find()\n["limit"](|1)')).toBe('db.orders.find()\n["limit"](1)');
  });
});
