import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';

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

vi.mock('../../lib/monacoMongo', () => ({
  registerMongoCompletionProvider: vi.fn(),
  setModelMeta: vi.fn(),
  clearModelMeta: vi.fn(),
}));

vi.mock('../../lib/monacoAppTheme', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/monacoAppTheme')>();
  return {
    ...actual,
    registerMqlensMonacoThemes: vi.fn(),
    refreshMqlensMonacoTheme: vi.fn(),
  };
});

/** What Monaco reports its wrapped content needs. One line by default. */
let mockContentHeight = 18;

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react');
  return {
    default: ({
      value,
      onMount,
      options,
      height,
      wrapperProps,
    }: {
      value: string;
      options?: Record<string, unknown>;
      height?: number | string;
      wrapperProps?: Record<string, unknown>;
      onMount?: (ed: unknown, monaco: { KeyCode: typeof KeyCode; editor: { defineTheme: () => void; setTheme: () => void } }) => void;
    }) => {
      lastOptions = options;
      lastHeight = height;
      const editorRef = React.useRef({
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
          onDidChangeModelContent: vi.fn(),
          // The Query field follows its wrapped content height (#260). One
          // line's worth here, so the stock sizing assertions below still
          // describe a field showing a one-line query.
          onDidContentSizeChange: (handler: () => void) => {
            firstContentSizeHandler ??= handler;
            return { dispose: vi.fn() };
          },
          getContentHeight: () => mockContentHeight,
          getValue: () => value,
          setValue: vi.fn(),
          getPosition: () => null,
          setPosition: vi.fn(),
          getModel: () => ({ uri: { toString: () => 'test://model' } }),
          onDidDispose: vi.fn(),
      });
      React.useEffect(() => {
        onMount?.(
          editorRef.current,
          {
            KeyCode,
            editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
          },
        );
      }, []);
      return (
        <div
          data-testid={(wrapperProps?.['data-testid'] as string | undefined) ?? 'monaco'}
          data-value={value}
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
