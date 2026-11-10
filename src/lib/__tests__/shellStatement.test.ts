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
    expect(at('f(1) // a; b|')).toBe('f(1)');
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
    expect(at('print("ch|eck") /* note */\ndb.orders.deleteMany({})')).toBe('print("check")');
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

  it('keeps a function declaration with a body that opens on the next line', () => {
    const decl = 'function wipe()\n{\n  db.orders.deleteMany({})\n}';
    expect(at('function wipe()\n{\n  db.orders.deleteMa|ny({})\n}')).toBe(decl);
    const asyncDecl = 'async function wipe(a)\n{\n  await db.orders.deleteMany(a)\n}';
    expect(at('async function wipe(a)\n{\n  await db.orders.deleteMa|ny(a)\n}')).toBe(asyncDecl);
  });

  it('starts a new statement after a finished block statement', () => {
    expect(at('if (fal|se) {}\n(db.orders.deleteMany({}))')).toBe('if (false) {}');
    expect(at('function f() {}\n[db.orders.deleteMany({})]|')).toBe('[db.orders.deleteMany({})]');
    expect(at('for (const x of []) {\n}\n-db.orders.dele|teMany({})')).toBe('-db.orders.deleteMany({})');
    // An else, or a value that only looks like a block, still continues.
    expect(at('if (a) {\n}\nelse {\n  b(|)\n}')).toBe('if (a) {\n}\nelse {\n  b()\n}');
    expect(at('const f = function () {}\n(|1)')).toBe('const f = function () {}\n(1)');
  });

  it('ends a block statement whose brace follows a comment, or a class body', () => {
    expect(at('if (fal|se) /* note */ {}\n(db.orders.deleteMany({}))')).toBe('if (false) /* note */ {}');
    expect(at('class C {}\n(db.orders.deleteMa|ny({}))')).toBe('(db.orders.deleteMany({}))');
    expect(at('class D extends C {}\n[db.orders.deleteMa|ny({})]')).toBe('[db.orders.deleteMany({})]');
    // A class expression is a value, and still takes a call.
    expect(at('const K = class {}\n(|1)')).toBe('const K = class {}\n(1)');
  });

  it('reads brackets inside a regex literal as part of it', () => {
    expect(at('db.a.find({name: /[(]/}|)\ndb.orders.deleteMany({})')).toBe('db.a.find({name: /[(]/})');
    expect(at('db.a.find({name: /[{]/})\ndb.orders.deleteMa|ny({})')).toBe('db.orders.deleteMany({})');
    // Division is still division.
    expect(at('const half = total / 2 / (|1)\ndb.orders.deleteMany({})')).toBe('const half = total / 2 / (1)');
  });

  it('reads a nested template literal as one string', () => {
    const tpl = 'print(\x60outer ${\x60inner (\x60} end\x60)';
    expect(at(`${tpl.slice(0, 3)}|${tpl.slice(3)}\ndb.orders.deleteMany({})`)).toBe(tpl);
  });

  it('ends a finished block before a statement on the same line', () => {
    expect(at('if (fal|se) {} db.orders.deleteMany({})')).toBe('if (false) {}');
    expect(at('if (false) {} db.orders.deleteMa|ny({})')).toBe('db.orders.deleteMany({})');
    // else, catch, finally and a do loop's while stay with it, and an object value is not a block.
    expect(at('if (a) {} el|se { b() }')).toBe('if (a) {} else { b() }');
    expect(at('try { a() } catch (e) {} final|ly {}')).toBe('try { a() } catch (e) {} finally {}');
    expect(at('do { a() } wh|ile (x)')).toBe('do { a() } while (x)');
    expect(at('x = {} && d|b.a.find()')).toBe('x = {} && db.a.find()');
  });

  it('keeps nested headers joined to the body below them', () => {
    const ifs = 'if (false) if (true)\n  db.orders.deleteMany({})';
    expect(at('if (false) if (true)\n  db.orders.deleteMa|ny({})')).toBe(ifs);
    const fors = 'for (const a of []) for (const b of [])\n  db.orders.deleteOne({})';
    expect(at('for (const a of []) for (const b of [])\n  db.orders.deleteO|ne({})')).toBe(fors);
  });

  it('keeps a function expression with a body that opens on the next line', () => {
    const fn = 'const wipe = function ()\n{\n  db.orders.deleteMany({})\n}';
    expect(at('const wipe = function ()\n{\n  db.orders.deleteMa|ny({})\n}')).toBe(fn);
  });

  it('keeps a do loop under another control statement together', () => {
    expect(at('if (false) do {} while (fa|lse);')).toBe('if (false) do {} while (false);');
    expect(at('if (false) do { a() } while (false)\nb(|)')).toBe('b()');
  });

  it('keeps a keyword operator at a line end joined to its operand', () => {
    const both = 'if (false) void\n  db.orders.deleteMany({})';
    expect(at('if (false) void\n  db.orders.deleteMa|ny({})')).toBe(both);
    expect(at('const t = typeof\n  db.orders.fi|nd')).toBe('const t = typeof\n  db.orders.find');
  });

  it('keeps a labelled header joined to its body', () => {
    const guarded = 'guard: if (false)\n  db.orders.deleteMany({})';
    expect(at('guard: if (false)\n  db.orders.deleteMa|ny({})')).toBe(guarded);
  });

  it('does not count a property named do as a loop', () => {
    const text = 'db. do.findOne()\nwhile (false)\n  db.orders.deleteMany({})';
    expect(at('db. do.findOne()\nwhile (false)\n  db.orders.deleteMa|ny({})')).toBe('while (false)\n  db.orders.deleteMany({})');
    expect(at(`${text.slice(0, 5)}|${text.slice(5)}`)).toBe('db. do.findOne()');
  });

  it('keeps a header with a trailing comment joined to its body', () => {
    const guarded = 'if (false) // keep guarded\n  db.orders.deleteMany({})';
    expect(at('if (false) // keep guarded\n  db.orders.deleteMa|ny({})')).toBe(guarded);
    const blockGuarded = 'while (x) /* wait */\n  db.orders.deleteOne({})';
    expect(at('while (x) /* wait */\n  db.orders.deleteO|ne({})')).toBe(blockGuarded);
  });

  it('stays fast on a run of comment slashes before a brace', { timeout: 2_000 }, () => {
    const text = `a +${'//'.repeat(40)}\nb {}`;
    expect(at(`${text}|`)).toBe(text);
  });

  it('keeps an object value under a condition joined to the next line', () => {
    const both = 'if (false) globalThis.options = {}\n[db.orders.deleteMany({})]';
    expect(at('if (false) globalThis.options = {}\n[db.orders.deleteMa|ny({})]')).toBe(both);
    // A // inside a string is not a comment.
    const str = 'if (false) globalThis.options = "try // note" + {}\n[db.orders.deleteMany({})]';
    expect(at('if (false) globalThis.options = "try // note" + {}\n[db.orders.deleteMa|ny({})]')).toBe(str);
  });

  it('keeps try and switch with bodies that open on the next line', () => {
    const tryCatch = 'try\n{\n  throw new Error("expected")\n}\ncatch (e)\n{ print("handled") }';
    expect(at('try\n{\n  throw new Er|ror("expected")\n}\ncatch (e)\n{ print("handled") }')).toBe(tryCatch);
    expect(at('try\n{\n  throw new Error("expected")\n}\ncatch (e)\n{ print("hand|led") }')).toBe(tryCatch);
    const sw = 'switch (x)\n{\n  case 1: db.orders.deleteMany({})\n}';
    expect(at('switch (x)\n{\n  case 1: db.orders.dele|teMany({})\n}')).toBe(sw);
  });

  it('ends a statement at a line break inside a block comment', () => {
    expect(at('print("sa|fe") /* explanation\n*/ db.orders.deleteMany({})')).toBe('print("safe")');
    expect(at('print("safe") /* explanation\n*/ db.orders.dele|teMany({})')).toBe('db.orders.deleteMany({})');
    // A comment on one line still does not end it.
    expect(at('db.a.find() /* x */ .lim|it(1)')).toBe('db.a.find() /* x */ .limit(1)');
  });
});
