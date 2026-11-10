import { maskLiterals } from './jsLiterals';

// What, at the start of the next line's code, continues the statement before
// it: a chained call, a call or index on its value (ASI joins those too), or
// an operator (not a comment, nor a prefix ++/--), or the rest of an if/try.
const CONTINUES_NEXT_LINE = /^(?:(?!\/[/*]|\+\+|--)[.?:,()[\]}+\-*/%=&|^<>]|(?:else|catch|finally)\b)/;
// What, at the end of a line's code, leaves its statement open. A postfix
// ++/-- does not; a sign after a different one (`+-`) does.
const LEFT_OPEN = /(?:(?<!\+)\+|(?<!-)-|[=*/%&|^<>!?:,.]|\b(?:else|do|try|finally))$/;
// Whitespace and comments, skipped when looking for the next code.
const SPACE_AND_COMMENTS = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/;
const nextCode = (text: string, from: number) => text.slice(from).replace(SPACE_AND_COMMENTS, '');
// A control, catch or function-declaration header, up to its opening
// parenthesis, where a statement, a block or another header before it ends.
const CONTROL_HEADER =
  /(?:^|[;{})]|\belse)\s*(?:if|for|while|with|switch|catch|(?:async\s+)?function\b[\s*]*[\w$]*)\s*\($/;
// Any function header, a function expression's too: its body may open on the
// next line, but its braces are a value, not a block statement.
const FUNCTION_HEADER = /\bfunction\b[\s*]*[\w$]*\s*\($/;
// What, just before a `{`, makes it open a block rather than an object.
const BLOCK_AFTER = /\b(?:else|try|finally|do)$|^\s*class\s+[\w$]+(?:\s+extends\b[^{]*)?$/;

/**
 * Start/end offsets of each top-level statement in a shell script. A statement
 * ends after a `;`, or at a line break (one inside a block comment too) outside
 * brackets and strings —
 * unless what follows clearly belongs to it (`.limit(1)`, `else`, `&& b`, a
 * `do` loop's `while`), comments aside, the
 * line leaves it open (`x =`), or it is a control or function header still
 * waiting for its body (`if (x)`). After a finished block statement (`if (x) {}`)
 * only else/catch/finally continue. Running too much is safer than running a
 * body without its condition, so doubtful cases join.
 * acorn reads the strings, comments, regex and template literals first, so
 * nothing inside them counts as code.
 * ponytail: a lexer over acorn's tokens, not a parser.
 */
function statementSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let comment: '//' | '/*' | null = null;
  // Whether a header's parenthesis is open, where the last one closed, and
  // whether its braces open a block statement (not a function expression's).
  let headerOpen = false;
  let headerBlock = false;
  let headerClose = -1;
  let headerCloseBlock = false;
  // Just past the statement's last character of code (not space or comment).
  let codeEnd = 0;
  // `do` loops in this statement still waiting for their `while`, and whether
  // the last `while` read ends one rather than starting a loop.
  let pendingDo = 0;
  let whileEndsDo = false;
  const awaitingWhile = () => pendingDo > 0;
  // Whether the statement-level `{` open now starts a block (not an object),
  // and where the last such block closed.
  let openIsBlock = false;
  let blockClose = -1;
  // Whether the block comment being read spans a line break.
  let commentBroke = false;
  const boundary = (end: number, next: number) => {
    spans.push([start, end]);
    start = next;
    codeEnd = next;
    headerClose = -1;
    blockClose = -1;
    pendingDo = 0;
    whileEndsDo = false;
  };
  // A line break at `end`, the next code from `from`: the statement ends there
  // unless something keeps it open.
  const lineBreak = (end: number, from: number) => {
    // No code (comments aside) since the header's closing parenthesis.
    const awaitingBody = headerClose >= 0 && codeEnd - 1 === headerClose;
    const next = nextCode(text, from);
    // A finished block takes no operand or call: only else/catch/finally follow it.
    const continues = blockClose === codeEnd - 1 ? /^(?:else|catch|finally)\b/.test(next) : CONTINUES_NEXT_LINE.test(next);
    if (
      !awaitingBody &&
      !continues &&
      !(awaitingWhile() && /^while\b/.test(next)) &&
      !LEFT_OPEN.test(text.slice(start, codeEnd))
    ) {
      boundary(end, from);
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comment === '//') {
      if (c === '\n') comment = null;
      else continue;
    } else if (comment === '/*') {
      // JavaScript reads a block comment with a line break in it as a line break.
      if (c === '\n' && depth === 0) commentBroke = true;
      if (c === '*' && text[i + 1] === '/') {
        comment = null;
        i++;
        if (commentBroke) lineBreak(codeEnd, i + 1);
        commentBroke = false;
      }
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
    // Where the code before this character ended, comments and space skipped.
    const codeBefore = codeEnd;
    if (!/\s/.test(c)) codeEnd = i + 1;
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (depth === 0 && /^(?:do|while)\b/.test(text.slice(i, i + 6)) && !/[\w$.]/.test(text[i - 1] ?? '')) {
      if (c === 'd') pendingDo++;
      else {
        whileEndsDo = pendingDo > 0;
        if (whileEndsDo) pendingDo--;
      }
    } else if ('([{'.includes(c)) {
      if (c === '(' && depth === 0) {
        const head = text.slice(start, i + 1);
        headerBlock = CONTROL_HEADER.test(head) && !(whileEndsDo && /\bwhile\s*\($/.test(head));
        headerOpen = headerBlock || FUNCTION_HEADER.test(head);
      }
      if (c === '{' && depth === 0) {
        const before = text.slice(start, codeBefore);
        openIsBlock =
          before.trim() === '' || (codeBefore - 1 === headerClose && headerCloseBlock) || BLOCK_AFTER.test(before);
      }
      depth++;
    } else if (')]}'.includes(c)) {
      depth = Math.max(0, depth - 1);
      if (c === ')' && depth === 0 && headerOpen) {
        headerClose = i;
        headerCloseBlock = headerBlock;
        headerOpen = false;
      }
      if (c === '}' && depth === 0) {
        blockClose = openIsBlock ? i : -1;
        // A finished block ends its statement even on the same line, unless
        // its else/catch/finally (or a do loop's while) follows.
        let k = i + 1;
        while (text[k] === ' ' || text[k] === '\t') k++;
        const rest = text.slice(k, k + 8);
        if (
          openIsBlock && k < text.length && !/^[\r\n;]/.test(rest) &&
          !/^(?:else|catch|finally)\b/.test(rest) && !(awaitingWhile() && /^while\b/.test(rest))
        ) {
          boundary(i + 1, i + 1);
        }
      }
    } else if (depth === 0 && c === ';') {
      const next = nextCode(text, i + 1);
      if (!/^(?:else|catch|finally)\b/.test(next) && !(awaitingWhile() && /^while\b/.test(next))) {
        boundary(i + 1, i + 1);
      }
    } else if (depth === 0 && c === '\n') {
      lineBreak(i, i);
    }
  }
  spans.push([start, text.length]);
  return spans;
}

/** The statement under `offset`, or the nearest one before it (else after it) when the cursor sits on blank space. */
export function statementAt(text: string, offset: number): string {
  // Each statement without the space and comments around it.
  const code = maskLiterals(text);
  const trimmed = statementSpans(code)
    .map(([s, e]): [number, number] => {
      const body = code.slice(s, e);
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
