/**
 * Syntax highlighting for the document editor, sharing the results grid's colours.
 *
 * The grid renders documents with a React walker over *parsed* BSON values
 * (`val instanceof ObjectId`, `typeof val === 'number'`) and colours them with
 * the `--syntax-*` design tokens. An editor cannot reuse that: it has to colour
 * raw text as it is typed, including text that is momentarily invalid, so there
 * is no parsed value to inspect. A tokenizer is therefore unavoidable.
 *
 * What *is* avoidable is a second set of colours. Monaco's themes previously
 * declared `rules: []`, so every editor fell back to VS Code's built-in token
 * colours and the same document looked different in the grid and the editor.
 * [`DOC_SYNTAX_TOKENS`] is the one place the mapping lives; the theme reads the
 * design tokens through it, so the two surfaces cannot drift apart again.
 */
import type { Monaco } from "@monaco-editor/react";

/** Language id for the mongosh-flavoured document text the editor holds. */
export const DOC_LANGUAGE_ID = "mqlens-doc";

/**
 * Suffix Monarch appends to every token this language emits, so `string` becomes
 * `string.mqlens-doc`.
 *
 * Monaco theme rules match by token name across *all* languages, so unscoped
 * rules for `string`/`number`/`delimiter` would also repaint the JavaScript query
 * and shell editors, which inherit the VS/VS Dark palette. Scoping the rules to
 * this suffix keeps them to the document editor.
 *
 * Monarch defaults `tokenPostfix` to `.<languageId>`; it is set explicitly below
 * so the theme's dependency on it is visible rather than incidental.
 */
export const DOC_TOKEN_POSTFIX = `.${DOC_LANGUAGE_ID}`;

/**
 * Monarch token → design token, with a fallback for when the CSS variable
 * cannot be read (SSR, tests).
 *
 * The design tokens are the same ones `DataGrid` applies as `text-syntax-*`
 * classes, so a colour changes in both places at once. `delimiter` follows the
 * grid's `jsonPunct`, which renders `:`, `,` and brackets in muted-foreground.
 * Constructor *names* use `syntax-boolean` because the grid does
 * (`<span className="text-syntax-boolean">ObjectId</span>`).
 */
export const DOC_SYNTAX_TOKENS: ReadonlyArray<{
  token: string;
  cssToken: string;
  fallback: string;
}> = [
  { token: "key", cssToken: "syntax-key", fallback: "#7dd3fc" },
  { token: "string", cssToken: "syntax-string", fallback: "#86efac" },
  { token: "number", cssToken: "syntax-number", fallback: "#f59e0b" },
  { token: "boolean", cssToken: "syntax-boolean", fallback: "#c4b5fd" },
  { token: "null", cssToken: "syntax-null", fallback: "#8b93a1" },
  { token: "constructor", cssToken: "syntax-boolean", fallback: "#c4b5fd" },
  { token: "delimiter", cssToken: "muted-foreground", fallback: "#8b93a1" },
];

/** BSON helpers mongosh accepts, rendered as calls in the grid and the editor. */
const BSON_CONSTRUCTORS = [
  "ObjectId",
  "ISODate",
  "NumberLong",
  "NumberDecimal",
  "NumberInt",
  "Timestamp",
  "BinData",
  "UUID",
  "DBRef",
  "MinKey",
  "MaxKey",
  "Code",
  "Decimal128",
  "Date",
  "Long",
] as const;

/**
 * Constructors whose argument the grid colours as a *number* even though
 * `docToShell` writes it quoted.
 *
 * A 64-bit value cannot survive as a JavaScript number, so `docToShell` emits
 * `NumberLong("42")` deliberately — but `DataGrid` renders the same value as
 * `NumberLong(` + `text-syntax-number` + `)`. Colouring the quoted argument as a
 * number keeps the two agreeing. `NumberInt` needs no special case: it is emitted
 * unquoted, so the ordinary number rule already matches what the grid does.
 */
const NUMERIC_ARGUMENT_CONSTRUCTORS = ["NumberLong", "Long"] as const;

let registered = false;

/**
 * Register the document language. Idempotent, so every editor can call it.
 *
 * Tokenizes the format `docToShell` produces: quoted or bare keys, the three
 * JavaScript string forms, numbers, `true`/`false`/`null`, and BSON constructor
 * calls. A key is distinguished from a string value by the colon that follows
 * it — which is why `language="javascript"` could not do this, as Monaco's
 * JavaScript tokenizer emits plain `string` for every quoted literal.
 */
export function registerDocLanguage(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: DOC_LANGUAGE_ID });

  // A Monaco language carries editing behaviour as well as colours, and leaving
  // `javascript` dropped all of it: auto-closing braces and quotes, surrounding
  // a selection with a quote, bracket matching, bracket-based folding (which the
  // dialog enables) and word selection. Restored here, matching what the
  // JavaScript configuration provided for this content.
  //
  // Comments are deliberately not configured: the buffer is a document literal,
  // not code, so offering comment toggling would invite text the save path has no
  // reason to accept.
  monaco.languages.setLanguageConfiguration(DOC_LANGUAGE_ID, {
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      // `notIn: ["string"]` stops a quote auto-closing inside a string, which is
      // why the tokenizer has to emit `string` for half-typed values too.
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
      { open: "`", close: "`", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ],
    indentationRules: {
      increaseIndentPattern: /[{[]\s*$/,
      decreaseIndentPattern: /^\s*[}\]],?\s*$/,
    },
    // Without this, double-click selects across punctuation inside a document.
    wordPattern: /(-?\d*\.\d\w*)|([^\s{}[\](),:"'`]+)/g,
  });
  monaco.languages.setMonarchTokensProvider(DOC_LANGUAGE_ID, {
    defaultToken: "",
    tokenPostfix: DOC_TOKEN_POSTFIX,
    tokenizer: {
      root: [
        // Before the general rule, so the argument state is entered.
        [
          new RegExp(
            `\\b(?:${NUMERIC_ARGUMENT_CONSTRUCTORS.join("|")})\\b(?=\\s*\\()`,
          ),
          { token: "constructor", next: "@numericArgument" },
        ],

        // A constructor is a *call*, so require the parenthesis. Without it a
        // document with a bare field named `ObjectId` — `ObjectId: "legacy"` —
        // matched here before the bare-key rule and was coloured as a call.
        [
          new RegExp(`\\b(?:${BSON_CONSTRUCTORS.join("|")})\\b(?=\\s*\\()`),
          "constructor",
        ],

        // A quoted or bare identifier followed by `:` is a key, not a value.
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "key"],
        [/'(?:[^'\\]|\\.)*'(?=\s*:)/, "key"],
        [/`(?:[^`\\]|\\.)*`(?=\s*:)/, "key"],
        [/[A-Za-z_$][\w$]*(?=\s*:)/, "key"],

        // String values, in all three JavaScript quotings.
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'(?:[^'\\]|\\.)*'/, "string"],
        [/`(?:[^`\\]|\\.)*`/, "string"],
        // Half-typed strings: colour them as strings rather than dropping to the
        // default, so text does not flicker uncoloured while being written.
        [/"[^"]*$/, "string"],
        [/'[^']*$/, "string"],

        [/\b(?:true|false)\b/, "boolean"],
        [/\bnull\b/, "null"],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, "number"],

        // Matches the grid's `jsonPunct`. Parentheses are left alone because the
        // grid renders a constructor's own parens in the default foreground.
        [/[{}[\],:]/, "delimiter"],
      ],

      // Inside `NumberLong(...)`: the quoted 64-bit value is coloured as a
      // number, which is what the grid shows.
      numericArgument: [
        [/\(/, ""],
        [/\s+/, ""],
        [/"(?:[^"\\]|\\.)*"/, "number"],
        [/'(?:[^'\\]|\\.)*'/, "number"],
        [/-?\d+/, "number"],
        [/\)/, { token: "", next: "@pop" }],
        // Leave on anything unexpected, so a half-typed call cannot swallow the
        // rest of the document while it is being written.
        [/./, { token: "", next: "@pop" }],
      ],
    },
  });
}

/** Reset for tests, which register against a fresh Monaco stub each time. */
export function resetDocLanguageForTests(): void {
  registered = false;
}
