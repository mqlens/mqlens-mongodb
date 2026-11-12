import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import type { Monaco, OnMount } from '@monaco-editor/react';
import { useMonacoValue } from '../useMonacoValue';

const READ_ONLY = 91;
const monaco = { editor: { EditorOption: { readOnly: READ_ONLY } } } as unknown as Monaco;

/**
 * Enough of a Monaco editor for the hook. Content listeners run synchronously
 * inside the edit, and a read-only editor refuses `executeEdits`, as Monaco's do.
 */
function createFakeEditor(initialValue: string, { readOnly = false } = {}) {
  let text = initialValue;
  // A model starts at version 1; every edit moves it on, as Monaco's does.
  let version = 1;
  const contentListeners: Array<() => void> = [];
  const disposeListeners: Array<() => void> = [];
  const replaceText = (next: string) => {
    text = next;
    version += 1;
    for (const listener of [...contentListeners]) listener();
  };
  return {
    getValue: () => text,
    getModel: () => ({ getFullModelRange: () => ({}), getVersionId: () => version }),
    getOption: (id: number) => (id === READ_ONLY ? readOnly : undefined),
    executeEdits: vi.fn((_source: string, edits: Array<{ text: string }>) => {
      if (readOnly) return false;
      replaceText(edits[0].text);
      return true;
    }),
    setValue: vi.fn((next: string) => replaceText(next)),
    pushUndoStop: vi.fn(() => true),
    onDidChangeModelContent: (listener: () => void) => {
      contentListeners.push(listener);
      return {
        dispose: () => {
          contentListeners.splice(contentListeners.indexOf(listener), 1);
        },
      };
    },
    onDidDispose: (listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    },
    dispose() {
      for (const listener of disposeListeners) listener();
    },
    /** A keystroke at the end of the text, where the caret is while typing. */
    type(key: string) {
      replaceText(text + key);
    },
  };
}
type FakeEditor = ReturnType<typeof createFakeEditor>;

/**
 * An editor wired up the way @monaco-editor/react wires one: the model is
 * created from `defaultValue`, and after mount `onMount` runs and every model
 * change is reported through `onChange`, both from passive effects.
 */
function Editor({ value, onChange, editor }: { value: string; onChange: (v: string) => void; editor: FakeEditor }) {
  const sync = useMonacoValue(value, onChange);
  useEffect(() => {
    sync.onMount(editor as unknown as Parameters<OnMount>[0], monaco);
    const subscription = editor.onDidChangeModelContent(() => sync.onChange(editor.getValue()));
    return () => subscription.dispose();
    // Mounted once, as the library does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div data-testid="editor" data-default-value={sync.defaultValue} />;
}

describe('useMonacoValue', () => {
  describe('typing ahead of React', () => {
    /**
     * Types one key each time the parent commits new text, from a passive
     * effect: the next keystroke reaching the model after React has rendered
     * the previous one but before the rest of that render's passive effects
     * have run. Chromium delivers Monaco's typing through EditContext events
     * React doesn't treat as discrete, and on a slow CPU input lands in exactly
     * that gap. It sits before the editor so its effect runs first.
     */
    function NextKeystroke({ text, keys, editor }: { text: string; keys: string[]; editor: FakeEditor }) {
      useEffect(() => {
        if (text !== '' && keys.length > 0) editor.type(keys.shift()!);
      }, [text, keys, editor]);
      return null;
    }

    function Typed({ keys, editor }: { keys: string[]; editor: FakeEditor }) {
      const [text, setText] = useState('');
      return (
        <>
          <NextKeystroke text={text} keys={keys} editor={editor} />
          <Editor value={text} onChange={setText} editor={editor} />
        </>
      );
    }

    it('keeps every keystroke when the parent echoes each one back late', async () => {
      const editor = createFakeEditor('');
      const { getByTestId } = render(<Typed keys={['i', 'e']} editor={editor} />);

      await act(async () => {
        editor.type('{ t');
      });

      // Written back from a passive effect, the echo of "{ t" replaced "{ ti"
      // and the echo of "{ ti" replaced "{ te": the editor ended up "{ te".
      expect(editor.getValue()).toBe('{ tie');
      expect(getByTestId('editor').getAttribute('data-default-value')).toBe('{ tie');
      expect(editor.executeEdits).not.toHaveBeenCalled();
    });
  });

  it('creates the model from the value it is given', () => {
    const editor = createFakeEditor('');
    const { getByTestId } = render(<Editor value="db.stats()" onChange={() => {}} editor={editor} />);
    expect(getByTestId('editor').getAttribute('data-default-value')).toBe('db.stats()');
  });

  it('writes a value the parent sets into the model as one undoable edit, without reporting it back', () => {
    const editor = createFakeEditor('{ a: 1 }');
    const onChange = vi.fn();
    const { rerender } = render(<Editor value="{ a: 1 }" onChange={onChange} editor={editor} />);

    rerender(<Editor value="{ b: 2 }" onChange={onChange} editor={editor} />);

    expect(editor.getValue()).toBe('{ b: 2 }');
    expect(editor.executeEdits).toHaveBeenCalledTimes(1);
    expect(editor.pushUndoStop).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports typing through the latest onChange', () => {
    const editor = createFakeEditor('');
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Editor value="" onChange={first} editor={editor} />);
    rerender(<Editor value="" onChange={second} editor={editor} />);

    act(() => editor.type('x'));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('x');
  });

  it('catches up on mount with a value that changed after the model was created', () => {
    // The model was created from an earlier render's text.
    const editor = createFakeEditor('show collections');
    render(<Editor value="db.orders.find({})" onChange={() => {}} editor={editor} />);
    expect(editor.getValue()).toBe('db.orders.find({})');
  });

  it('reports text written into the editor before it mounted instead of overwriting it', () => {
    // The library creates the editor from one effect and runs onMount and
    // subscribes onChange from the next. Text that lands in between (a test
    // driver's setValue, a fast paste) is in the model but was never reported.
    const editor = createFakeEditor('{}');
    editor.setValue('{ tier: "Premium" }');
    const onChange = vi.fn();
    render(<Editor value="{}" onChange={onChange} editor={editor} />);
    expect(editor.getValue()).toBe('{ tier: "Premium" }');
    expect(onChange).toHaveBeenCalledWith('{ tier: "Premium" }');
  });

  it('gives a read-only editor the text outright, since it refuses edits', () => {
    const editor = createFakeEditor('{ a: 1 }', { readOnly: true });
    const onChange = vi.fn();
    const { rerender } = render(<Editor value="{ a: 1 }" onChange={onChange} editor={editor} />);

    rerender(<Editor value="{ b: 2 }" onChange={onChange} editor={editor} />);

    expect(editor.getValue()).toBe('{ b: 2 }');
    expect(editor.setValue).toHaveBeenCalledWith('{ b: 2 }');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves a disposed editor alone', () => {
    const editor = createFakeEditor('{ a: 1 }');
    const { rerender } = render(<Editor value="{ a: 1 }" onChange={() => {}} editor={editor} />);

    editor.dispose();
    rerender(<Editor value="{ b: 2 }" onChange={() => {}} editor={editor} />);

    expect(editor.executeEdits).not.toHaveBeenCalled();
    expect(editor.getValue()).toBe('{ a: 1 }');
  });
});
