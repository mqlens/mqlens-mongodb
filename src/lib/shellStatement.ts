// What, at the start of the next line, continues the statement before it: a
// chained call or an operator (not a comment), or the rest of an if/try.
const CONTINUES_NEXT_LINE = /^\s*(?:(?!\/[/*])[.?:,)\]}+\-*/%=&|^<>]|(?:else|catch|finally)\b)/;
// What, at the end of a line, leaves its statement open.
const LEFT_OPEN = /(?:[=+\-*/%&|^<>!?:,.]|\b(?:else|do))\s*$/;
// An if/for/while/with header, up to its opening parenthesis.
const CONTROL_HEADER = /^\s*(?:\}?\s*else\s+)?(?:if|for|while|with)\s*\($/;

/**
 * Start/end offsets of each top-level statement in a shell script. A statement
 * ends after a `;`, or at a newline, outside brackets, strings and comments —
 * unless what follows clearly belongs to it (`.limit(1)`, `else`, `&& b`), the
 * line leaves it open (`x =`), or it is a control header still waiting for its
 * body (`if (x)`). Running too much is safer than running a body without its
 * condition, so doubtful cases join.
 * ponytail: a lexer, not a parser. Regex literals and `${}` inside template
 * strings are not tracked.
 */
function statementSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let comment: '//' | '/*' | null = null;
  // Where the current statement's control header closed its parenthesis, if it has one.
  let headerOpen = false;
  let headerClose = -1;
  const boundary = (end: number, next: number) => {
    spans.push([start, end]);
    start = next;
    headerClose = -1;
  };
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
    else if ('([{'.includes(c)) {
      if (c === '(' && depth === 0) headerOpen = CONTROL_HEADER.test(text.slice(start, i + 1));
      depth++;
    } else if (')]}'.includes(c)) {
      depth = Math.max(0, depth - 1);
      if (c === ')' && depth === 0 && headerOpen) { headerClose = i; headerOpen = false; }
    } else if (depth === 0 && c === ';') {
      if (!/^\s*(?:else|catch|finally)\b/.test(text.slice(i + 1))) boundary(i + 1, i + 1);
    } else if (depth === 0 && c === '\n') {
      const awaitingBody = headerClose >= 0 && text.slice(headerClose + 1, i).trim() === '';
      if (!awaitingBody && !CONTINUES_NEXT_LINE.test(text.slice(i + 1)) && !LEFT_OPEN.test(text.slice(start, i))) {
        boundary(i, i);
      }
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
  // Between two statements with nothing in between, the one starting there wins.
  const hit =
    trimmed.find(([s, e]) => s <= offset && offset < e) ??
    trimmed.find(([s, e]) => s <= offset && offset <= e) ??
    [...trimmed].reverse().find(([, e]) => e <= offset) ??
    trimmed[0];
  return hit ? text.slice(hit[0], hit[1]) : '';
}
