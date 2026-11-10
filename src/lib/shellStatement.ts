/**
 * Start/end offsets of each top-level statement in a shell script. A statement
 * ends after a `;`, or at a newline when the next line does not start with `.`
 * (so `find()\n  .limit(1)` stays one) — in both cases only outside brackets,
 * strings and comments.
 * ponytail: a lexer, not a parser. Regex literals and `${}` inside template
 * strings are not tracked, and a line ending in an operator (`x =\n 1`) splits.
 */
function statementSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let comment: '//' | '/*' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comment === '//') {
      if (c === '\n') comment = null;
      else continue;
    } else if (comment === '/*') {
      if (c === '*' && text[i + 1] === '/') { comment = null; i++; }
      continue;
    } else if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) { comment = text[i + 1] === '/' ? '//' : '/*'; i++; }
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ';') { spans.push([start, i + 1]); start = i + 1; }
    else if (depth === 0 && c === '\n' && !/^\s*\./.test(text.slice(i + 1))) {
      spans.push([start, i]);
      start = i;
    }
  }
  spans.push([start, text.length]);
  return spans;
}

/** The statement under `offset`, or the nearest one before it (else after it) when the cursor sits on blank space. */
export function statementAt(text: string, offset: number): string {
  // Each statement's text without its surrounding whitespace.
  const trimmed = statementSpans(text)
    .map(([s, e]): [number, number] => {
      const body = text.slice(s, e);
      return [s + (body.length - body.trimStart().length), e - (body.length - body.trimEnd().length)];
    })
    .filter(([s, e]) => s < e);
  const hit =
    trimmed.find(([s, e]) => s <= offset && offset <= e) ??
    [...trimmed].reverse().find(([, e]) => e <= offset) ??
    trimmed[0];
  return hit ? text.slice(hit[0], hit[1]) : '';
}
