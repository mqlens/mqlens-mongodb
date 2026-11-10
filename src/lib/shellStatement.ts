// What, at the start of the next line's code, continues the statement before
// it: a chained call, a call or index on its value (ASI joins those too), or
// an operator (not a comment, nor a prefix ++/--), or the rest of an if/try.
const CONTINUES_NEXT_LINE = /^(?:(?!\/[/*]|\+\+|--)[.?:,()[\]}+\-*/%=&|^<>]|(?:else|catch|finally)\b)/;
// What, at the end of a line's code, leaves its statement open. A postfix
// ++/-- does not; a sign after a different one (`+-`) does.
const LEFT_OPEN = /(?:(?<!\+)\+|(?<!-)-|[=*/%&|^<>!?:,.]|\b(?:else|do))$/;
// Whitespace and comments, skipped when looking for the next code.
const SPACE_AND_COMMENTS = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/;
const nextCode = (text: string, from: number) => text.slice(from).replace(SPACE_AND_COMMENTS, '');
// An if/for/while/with or function header, up to its opening parenthesis.
const CONTROL_HEADER = /^\s*(?:(?:\}?\s*else\s+)?(?:if|for|while|with)|(?:async\s+)?function\b[\s*]*[\w$]*)\s*\($/;
// A statement that, once its closing brace is in, takes no operand or call:
// only an else/catch/finally can still follow it.
const BLOCK_STATEMENT = /^(?:(?:if|for|while|with|switch|try|do|class)\b|(?:async\s+)?function\b|\{)/;

/**
 * Start/end offsets of each top-level statement in a shell script. A statement
 * ends after a `;`, or at a newline, outside brackets, strings and comments —
 * unless what follows clearly belongs to it (`.limit(1)`, `else`, `&& b`, a
 * `do` loop's `while`), comments aside, the
 * line leaves it open (`x =`), or it is a control or function header still
 * waiting for its body (`if (x)`). After a finished block statement (`if (x) {}`)
 * only else/catch/finally continue. Running too much is safer than running a
 * body without its condition, so doubtful cases join.
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
  // Just past the statement's last character of code (not space or comment).
  let codeEnd = 0;
  // Whether a `do` statement has reached its `while` yet.
  let doWhileSeen = false;
  const awaitingWhile = () => !doWhileSeen && /^do\b/.test(nextCode(text, start));
  const boundary = (end: number, next: number) => {
    spans.push([start, end]);
    start = next;
    codeEnd = next;
    headerClose = -1;
    doWhileSeen = false;
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
      codeEnd = i + 1;
      continue;
    }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      comment = text[i + 1] === '/' ? '//' : '/*';
      i++;
      continue;
    }
    if (!/\s/.test(c)) codeEnd = i + 1;
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (depth === 0 && /^while\b/.test(text.slice(i, i + 6)) && !/[\w$]/.test(text[i - 1] ?? '')) doWhileSeen = true;
    else if ('([{'.includes(c)) {
      if (c === '(' && depth === 0) headerOpen = CONTROL_HEADER.test(text.slice(start, i + 1));
      depth++;
    } else if (')]}'.includes(c)) {
      depth = Math.max(0, depth - 1);
      if (c === ')' && depth === 0 && headerOpen) { headerClose = i; headerOpen = false; }
    } else if (depth === 0 && c === ';') {
      const next = nextCode(text, i + 1);
      if (!/^(?:else|catch|finally)\b/.test(next) && !(awaitingWhile() && /^while\b/.test(next))) {
        boundary(i + 1, i + 1);
      }
    } else if (depth === 0 && c === '\n') {
      const awaitingBody = headerClose >= 0 && text.slice(headerClose + 1, i).trim() === '';
      const next = nextCode(text, i + 1);
      const blockDone = text[codeEnd - 1] === '}' && BLOCK_STATEMENT.test(nextCode(text, start));
      const continues = blockDone ? /^(?:else|catch|finally)\b/.test(next) : CONTINUES_NEXT_LINE.test(next);
      if (
        !awaitingBody &&
        !continues &&
        !(awaitingWhile() && /^while\b/.test(next)) &&
        !LEFT_OPEN.test(text.slice(start, codeEnd))
      ) {
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
