import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect, useState } from 'react';

type KeyDownHandler = (e: {
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}) => void;

const KeyCode = { Enter: 3 };
let lastOptions: Record<string, unknown> | undefined;
let lastHeight: number | string | undefined;
let keyDownHandler: KeyDownHandler | undefined;
let enterRunCommand: (() => void) | undefined;
let enterRunWhen: string | undefined;
let firstContentSizeHandler: (() => void) | undefined;
let lastEditor: FakeEditor | undefined;
/** Model edits made while a content-change event was still being delivered. */
let editsInsideChangeEvent = 0;

vi.mock('../../lib/monacoMongo', () => ({
  registerMongoCompletionProvider: vi.fn(),
  setModelMeta: vi.fn(),
  clearModelMeta: vi.fn(),
}));

vi.mock('../../lib/monacoAppTheme', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/monacoAppTheme')>();
  return {
    ...actual,
  };
});

/** What Monaco reports its wrapped content needs. One line by default. */
let mockContentHeight = 18;

/** Monaco breaks lines at "\r\n", "\r" and "\n" alike. */
const splitLines = (text: string) => text.split(/\r\n|\r|\n/);

/**
 * Enough of a Monaco editor for QueryEditor. Where the single-line recursion
 * lived it behaves like Monaco: a lone "\r" still breaks a line, `getValue()`
 * joins lines with the model's EOL (CRLF, which Monaco picks under a Windows
 * user agent), and content listeners run synchronously inside the edit.
 */
function createFakeEditor(initialValue: string) {
  let lines = splitLines(initialValue);
  let position = { lineNumber: 1, column: 1 };
  const contentListeners: Array<() => void> = [];
  let deliveringChange = false;
  const replaceText = (text: string) => {
    if (deliveringChange) editsInsideChangeEvent++;
    lines = splitLines(text);
    const wasDelivering = deliveringChange;
    deliveringChange = true;
    try {
      for (const listener of [...contentListeners]) listener();
    } finally {
      deliveringChange = wasDelivering;
    }
  };
  return {
    onKeyDown: (handler: KeyDownHandler) => {
      keyDownHandler = handler;
    },
    addCommand: (key: number, handler: () => void, when?: string) => {
      if (key === KeyCode.Enter) {
        enterRunCommand = handler;
        enterRunWhen = when;
      }
      return 'run-on-enter';
    },
    onDidChangeModelContent: (listener: () => void) => {
      contentListeners.push(listener);
      return { dispose: vi.fn() };
    },
    // The Query field follows its wrapped content height (#260). One
    // line's worth here, so the stock sizing assertions below still
    // describe a field showing a one-line query.
    onDidContentSizeChange: (handler: () => void) => {
      firstContentSizeHandler ??= handler;
      return { dispose: vi.fn() };
    },
    getContentHeight: () => mockContentHeight,
    getOption: () => false,
    getValue: () => lines.join('\r\n'),
    setValue: (text: string) => replaceText(text),
    executeEdits: (_source: string, edits: Array<{ text: string }>) => {
      replaceText(edits[0].text);
      return true;
    },
    pushUndoStop: () => true,
    getPosition: () => position,
    setPosition: (next: { lineNumber: number; column: number }) => {
      position = next;
    },
    getModel: () => ({
      uri: { toString: () => 'test://model' },
      isDisposed: () => false,
      getLineCount: () => lines.length,
      getLinesContent: () => [...lines],
      getFullModelRange: () => ({}),
    }),
    onDidDispose: vi.fn(),
    /** A keystroke at the end of the line, where the caret is while typing. */
    type(text: string) {
      replaceText(lines.join('\r\n') + text);
    },
    /** A user edit such as a paste: the new text, with the caret left after it. */
    paste(text: string) {
      replaceText(text);
      position = { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
    },
  };
}
type FakeEditor = ReturnType<typeof createFakeEditor>;

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react');
  return {
    // Mirrors @monaco-editor/react where QueryEditor depends on it: onChange
    // reports every model change except the library's own, and a new `value`
    // is pushed into the model as one edit while onChange is muted.
    default: ({
      value,
      defaultValue,
      onChange,
      onMount,
      options,
      height,
      wrapperProps,
    }: {
      value?: string;
      defaultValue?: string;
      onChange?: (v: string) => void;
      options?: Record<string, unknown>;
      height?: number | string;
      wrapperProps?: Record<string, unknown>;
      onMount?: (ed: unknown, monaco: { KeyCode: typeof KeyCode; editor: { defineTheme: () => void; setTheme: () => void; EditorOption: { readOnly: number } } }) => void;
    }) => {
      lastOptions = options;
      lastHeight = height;
      const editorRef = React.useRef<FakeEditor | null>(null);
      editorRef.current ??= createFakeEditor(value ?? defaultValue ?? '');
      const onChangeRef = React.useRef(onChange);
      onChangeRef.current = onChange;
      const pushingValue = React.useRef(false);
      const mounted = React.useRef(false);
      React.useEffect(() => {
        const ed = editorRef.current!;
        lastEditor = ed;
        onMount?.(ed, { KeyCode, editor: { defineTheme: vi.fn(), setTheme: vi.fn(), EditorOption: { readOnly: 0 } } });
        ed.onDidChangeModelContent(() => {
          if (!pushingValue.current) onChangeRef.current?.(ed.getValue());
        });
      }, []);
      React.useEffect(() => {
        if (!mounted.current) {
          mounted.current = true;
          return;
        }
        const ed = editorRef.current!;
        if (value === undefined || value === ed.getValue()) return;
        pushingValue.current = true;
        try {
          ed.executeEdits('', [{ text: value }]);
          ed.pushUndoStop();
        } finally {
          pushingValue.current = false;
        }
      }, [value]);
      return (
        <div
          data-testid={(wrapperProps?.['data-testid'] as string | undefined) ?? 'monaco'}
          data-value={value ?? defaultValue}
        />
      );
    },
  };
});

const themeConfig: Record<string, unknown> = { presetId: 'mqlens-dark', mode: 'dark', fontSize: 13, uiZoom: 1, queryBarHeight: 29 };
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ config: themeConfig, resolvedMode: 'dark' as const }),
  useThemeOptional: () => ({ config: themeConfig, resolvedMode: 'dark' as const }),
}));

import { QueryEditor } from '../QueryEditor';
import { QUERY_BAR_OPTION_HEIGHT } from '@/lib/themes/ui-scale';

function pressEnter(modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  keyDownHandler?.({
    keyCode: KeyCode.Enter,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault,
    stopPropagation,
    ...modifiers,
  });
  return { preventDefault, stopPropagation };
}

describe('QueryEditor', () => {
  beforeEach(() => {
    keyDownHandler = undefined;
    enterRunCommand = undefined;
    enterRunWhen = undefined;
    firstContentSizeHandler = undefined;
  });

  it('renders a Monaco editor with the given value', () => {
    const { getByTestId } = render(
      <QueryEditor surface="aggStage" value='{ "$match": {} }' onChange={() => {}} fields={['region']} schema={undefined} />,
    );
    expect(getByTestId('monaco').getAttribute('data-value')).toBe('{ "$match": {} }');
  });

  it('runs on Cmd/Ctrl+Enter in multi-line mode', () => {
    const onRun = vi.fn();
    render(
      <QueryEditor surface="filter" value="{}" onChange={() => {}} fields={[]} onRun={onRun} />,
    );
    const { preventDefault } = pressEnter({ metaKey: true });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('does not run on plain Enter in multi-line mode', () => {
    const onRun = vi.fn();
    render(
      <QueryEditor surface="filter" value="{}" onChange={() => {}} fields={[]} onRun={onRun} />,
    );
    pressEnter();
    enterRunCommand?.();
    expect(onRun).not.toHaveBeenCalled();
    expect(enterRunCommand).toBeUndefined();
  });

  it('binds plain Enter to run only when suggestions are closed', () => {
    const onRun = vi.fn();
    render(
      <QueryEditor singleLine surface="filter" value="{}" onChange={() => {}} fields={[]} onRun={onRun} />,
    );
    expect(enterRunWhen).toContain('!suggestWidgetVisible');
    enterRunCommand?.();
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});

describe('QueryEditor — size follows the query bar height setting', () => {
  it('uses the stock font size and height at the default setting', () => {
    themeConfig.queryBarHeight = 29;
    render(<QueryEditor singleLine large surface="filter" value="" onChange={() => {}} fields={[]} />);
    expect(lastOptions?.fontSize).toBe(13);
    expect(lastHeight).toBe(29);
  });

  it('grows the text with the row so a taller bar is not a small line in a big box', () => {
    themeConfig.queryBarHeight = 29;
    render(<QueryEditor singleLine large surface="filter" value="" onChange={() => {}} fields={[]} />);
    const smallFont = lastOptions?.fontSize as number;

    themeConfig.queryBarHeight = 58;
    render(<QueryEditor singleLine large surface="filter" value="" onChange={() => {}} fields={[]} />);
    const bigFont = lastOptions?.fontSize as number;

    expect(bigFont).toBeGreaterThan(smallFont);
    expect(bigFont).toBeCloseTo(smallFont * 2, 0);
    expect(lastHeight).toBe(58);
    themeConfig.queryBarHeight = 29;
  });

  it('keeps the single line vertically centred as the row grows', () => {
    themeConfig.queryBarHeight = 58;
    render(<QueryEditor singleLine large surface="filter" value="" onChange={() => {}} fields={[]} />);
    const padTop = lastOptions?.padding as { top: number };
    const lineHeight = lastOptions?.lineHeight as number;
    // Equal space above and below the line within the 58px row.
    expect(padTop.top).toBe(Math.max(0, Math.round((58 - lineHeight) / 2)));
    themeConfig.queryBarHeight = 29;
  });
});

describe('QueryEditor — the Query field shows the whole query (#260)', () => {
  // Reported as "the height of the query section is locked, so a multiline
  // query is not fully visible": the field did not wrap, its horizontal
  // scrollbar was hidden, and raising the height setting only made one line
  // taller. Nothing could bring the rest of the query on screen.
  beforeEach(() => {
    themeConfig.queryBarHeight = 29;
    mockContentHeight = 18;
    firstContentSizeHandler = undefined;
  });

  it('wraps the primary Query field', () => {
    render(<QueryEditor singleLine large surface="filter" value="" onChange={() => {}} fields={[]} />);
    expect(lastOptions?.wordWrap).toBe('on');
  });

  it('wraps and grows the primary Query field with compact export styling', () => {
    mockContentHeight = 18 * 3;
    render(
      <QueryEditor
        singleLine
        growWithContent
        surface="filter"
        value=""
        onChange={() => {}}
        fields={[]}
      />
    );
    expect(lastOptions?.wordWrap).toBe('on');
    expect(lastHeight as number).toBeGreaterThan(QUERY_BAR_OPTION_HEIGHT);
  });

  it('does not grow a one-line query just because Monaco includes top padding', () => {
    // 18px text + the default 6px Monaco top padding still represents one row.
    mockContentHeight = 24;
    render(<QueryEditor singleLine large surface="filter" value="" onChange={() => {}} fields={[]} />);
    expect(lastHeight).toBe(29);
  });

  it('leaves the compact option rows on one line', () => {
    // Projection, sort, skip and limit hold short values and must not move
    // when the query above them grows.
    render(<QueryEditor singleLine surface="filter" value="" onChange={() => {}} fields={[]} />);
    expect(lastOptions?.wordWrap).toBe('off');
  });

  it('grows to fit a query that wraps', () => {
    mockContentHeight = 18 * 3;
    const { getByTestId } = render(
      <QueryEditor
        singleLine
        large
        surface="filter"
        value=""
        onChange={() => {}}
        fields={[]}
        data-testid="query-input"
      />
    );
    expect(lastHeight as number).toBeGreaterThan(29);
    expect(getByTestId('query-input').parentElement).toHaveStyle({ height: `${lastHeight}px` });
  });

  it('recomputes wrapped height with current appearance metrics', () => {
    mockContentHeight = 18 * 3;
    const { rerender } = render(
      <QueryEditor singleLine large surface="filter" value="" onChange={() => {}} fields={[]} />
    );

    themeConfig.queryBarHeight = 58;
    rerender(
      <QueryEditor singleLine large surface="filter" value="" onChange={() => {}} fields={[]} />
    );
    act(() => firstContentSizeHandler?.());

    // At the larger setting the line height is 36px. Monaco's 54px content
    // therefore occupies two rows, with the new 22px vertical padding retained.
    expect(lastHeight).toBe(94);
  });

  it('stops growing, and can be scrolled from there', () => {
    mockContentHeight = 18 * 200;
    render(<QueryEditor singleLine large surface="filter" value="" onChange={() => {}} fields={[]} />);
    const capped = lastHeight as number;
    expect(capped).toBeLessThan(18 * 200);
    // A hidden scrollbar over a fixed height is what made the query
    // unreachable in the first place.
    expect((lastOptions?.scrollbar as { vertical: string }).vertical).toBe('auto');
  });
});

describe('QueryEditor — multi-line text in a single-line field', () => {
  // Pretty-printed JSON from the visual query builder, a saved query or a
  // history entry overflowed the stack in Chromium. Under a CRLF model the
  // flatten handler removed only "\n", leaving "\r" line breaks, and it
  // rewrote the model from inside Monaco's own change event — so every
  // rewrite set off another one.
  const pretty = '{\n  "tier": "Premium"\n}';
  const flat = '{  "tier": "Premium"}';

  beforeEach(() => {
    editsInsideChangeEvent = 0;
    lastEditor = undefined;
  });

  it('shows a multi-line value on one line, without echoing it back', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <QueryEditor singleLine surface="filter" value="" onChange={onChange} fields={[]} />,
    );
    expect(() =>
      rerender(<QueryEditor singleLine surface="filter" value={pretty} onChange={onChange} fields={[]} />),
    ).not.toThrow();

    expect(lastEditor!.getValue()).toBe(flat);
    expect(editsInsideChangeEvent).toBe(0);
    // The parent set this text. Reporting a reflowed copy of it would feed
    // the builder's own sync from the filter text.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('joins the lines of a CRLF paste once, keeping the caret after it', async () => {
    const onChange = vi.fn();
    render(<QueryEditor singleLine surface="filter" value="" onChange={onChange} fields={[]} />);

    await act(async () => {
      lastEditor!.paste('{\r\n  tier: "Premium"\r\n}');
    });

    const joined = '{  tier: "Premium"}';
    expect(lastEditor!.getValue()).toBe(joined);
    expect(lastEditor!.getPosition()).toEqual({ lineNumber: 1, column: joined.length + 1 });
    expect(onChange).toHaveBeenLastCalledWith(joined);
    expect(editsInsideChangeEvent).toBe(0);
  });

  it('joins lines broken by a lone "\\r"', async () => {
    render(<QueryEditor singleLine surface="filter" value="" onChange={() => {}} fields={[]} />);

    await act(async () => {
      lastEditor!.paste('{ a: 1,\r b: 2 }');
    });

    expect(lastEditor!.getValue()).toBe('{ a: 1, b: 2 }');
  });

  it('leaves line breaks alone in a multi-line editor', async () => {
    render(<QueryEditor surface="aggStage" value="" onChange={() => {}} fields={[]} />);

    await act(async () => {
      lastEditor!.paste(pretty);
    });

    expect(lastEditor!.getModel().getLineCount()).toBe(3);
  });
});

describe('QueryEditor — typing ahead of React', () => {
  beforeEach(() => {
    lastEditor = undefined;
  });

  /**
   * Types one key each time the parent commits new text, from a passive
   * effect: the next keystroke reaching the model after React has rendered
   * the previous one but before the rest of that render's passive effects
   * have run. Chromium delivers Monaco's typing through EditContext events
   * React doesn't treat as discrete, and on a slow CPU the E2E suite typed
   * into exactly that gap. It sits before the editor so its effect runs first.
   */
  function NextKeystroke({ text, keys }: { text: string; keys: string[] }) {
    useEffect(() => {
      if (text !== '' && keys.length > 0) lastEditor!.type(keys.shift()!);
    }, [text, keys]);
    return null;
  }

  function TypedFilter({ keys }: { keys: string[] }) {
    const [text, setText] = useState('');
    return (
      <>
        <NextKeystroke text={text} keys={keys} />
        <QueryEditor singleLine surface="filter" value={text} onChange={setText} fields={['tier']} />
      </>
    );
  }

  it('keeps every keystroke when the parent echoes each one back late', async () => {
    const { getByTestId } = render(<TypedFilter keys={['i', 'e']} />);

    await act(async () => {
      lastEditor!.type('{ t');
    });

    // Written back from a passive effect, the echo of "{ t" replaced "{ ti"
    // and the echo of "{ ti" replaced "{ te": the field ended up "{ te".
    expect(lastEditor!.getValue()).toBe('{ tie');
    expect(getByTestId('monaco').getAttribute('data-value')).toBe('{ tie');
  });

  it('still shows text the parent sets', () => {
    const { rerender } = render(<QueryEditor singleLine surface="filter" value="{ a: 1 }" onChange={() => {}} fields={[]} />);
    expect(lastEditor!.getValue()).toBe('{ a: 1 }');

    rerender(<QueryEditor singleLine surface="filter" value="{ b: 2 }" onChange={() => {}} fields={[]} />);
    expect(lastEditor!.getValue()).toBe('{ b: 2 }');
  });
});
