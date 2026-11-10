import { tokenizer } from 'acorn';

const BACKTICK = '\x60';

/**
 * `text` as acorn reads it, at the same offsets: each comment blanked to
 * spaces (line breaks kept), and each string, regex literal and whole template
 * literal (with what is interpolated in it) turned into `"xxx"`. Brackets, `;`
 * and line breaks inside those no longer look like code.
 * Past a lexical error, such as a string still being typed, the text is left
 * as it is.
 */
export function maskLiterals(text: string): string {
  const out = text.split('');
  const opaque = (start: number, end: number) => {
    for (let i = start; i < end; i++) out[i] = 'x';
    out[start] = '"';
    out[end - 1] = '"';
  };
  // Inside a template literal: its start, and what is open within it.
  let templateStart = -1;
  const open: string[] = [];
  try {
    const tokens = tokenizer(text, {
      ecmaVersion: 'latest',
      allowHashBang: true,
      onComment: (_block, _text, start, end) => {
        for (let i = start; i < end; i++) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
      },
    });
    for (const token of tokens) {
      const label = token.type.label;
      if (templateStart >= 0) {
        if (label === BACKTICK) {
          if (open[open.length - 1] === BACKTICK) open.pop();
          else open.push(BACKTICK);
        } else if (label === '${' || label === '{') open.push('{');
        else if (label === '}') open.pop();
        if (open.length === 0) {
          opaque(templateStart, token.end);
          templateStart = -1;
        }
      } else if (label === BACKTICK) {
        templateStart = token.start;
        open.push(BACKTICK);
      } else if (label === 'string' || label === 'regexp') {
        opaque(token.start, token.end);
      }
    }
  } catch {
    // Left as typed from the error on.
  }
  return out.join('');
}
