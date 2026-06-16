import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

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
let keyDownHandler: KeyDownHandler | undefined;
let enterRunCommand: (() => void) | undefined;
let enterRunWhen: string | undefined;

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

vi.mock('@monaco-editor/react', () => ({
  default: ({
    value,
    onMount,
  }: {
    value: string;
    onMount?: (ed: unknown, monaco: { KeyCode: typeof KeyCode; editor: { defineTheme: () => void; setTheme: () => void } }) => void;
  }) => {
    if (onMount) {
      onMount(
        {
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
          getValue: () => value,
          setValue: vi.fn(),
          getPosition: () => null,
          setPosition: vi.fn(),
          getModel: () => ({ uri: { toString: () => 'test://model' } }),
          onDidDispose: vi.fn(),
        },
        {
          KeyCode,
          editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
        },
      );
    }
    return <div data-testid="monaco" data-value={value} />;
  },
}));

import { QueryEditor } from '../QueryEditor';

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
