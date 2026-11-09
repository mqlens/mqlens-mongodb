import { useEffect, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

// A Monaco stand-in with a real text model, so useMonacoValue's writes into it
// are exercised: the other suite's textarea mock never mounts an editor.
class FakeEditor {
  text: string;
  version = 1;
  private changeListener?: (value: string) => void;
  private blurListeners: Array<() => void> = [];

  constructor(text: string) {
    this.text = text;
  }
  getValue = () => this.text;
  getModel = () => ({ getVersionId: () => this.version, getFullModelRange: () => ({}) });
  getOption = () => false;
  executeEdits = (_source: string, edits: Array<{ text: string }>) => {
    this.text = edits[0].text;
    this.version++;
    this.changeListener?.(this.text);
    return true;
  };
  pushUndoStop = () => true;
  onDidDispose = () => ({ dispose() {} });
  onDidBlurEditorText = (listener: () => void) => {
    this.blurListeners.push(listener);
    return { dispose() {} };
  };
  listen(listener: (value: string) => void) {
    this.changeListener = listener;
  }
  type(text: string) {
    this.text = text;
    this.version++;
    this.changeListener?.(text);
  }
  blur() {
    for (const listener of this.blurListeners) listener();
  }
}

let editor: FakeEditor | undefined;
vi.mock('@monaco-editor/react', () => ({
  default: ({ defaultValue, onChange, onMount }: any) => {
    useEffect(() => {
      editor = new FakeEditor(defaultValue);
      editor.listen(onChange);
      onMount(editor, { editor: { EditorOption: { readOnly: 0 } } });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  },
}));
vi.mock('../../lib/monacoDocLanguage', () => ({ DOC_LANGUAGE_ID: 'doc', registerDocLanguage: () => {} }));
vi.mock('../../lib/monacoAppTheme', async (original) => ({ ...(await original<object>()), attachMonaco: () => {} }));

import { DocumentEditModal } from '../DocumentEditModal';

// The caller owns the draft, as App does.
function Host() {
  const [json, setJson] = useState('{ "a": 1 }');
  return (
    <DocumentEditModal
      isOpen
      mode="edit"
      initialJson='{ "a": 1 }'
      json={json}
      onJsonChange={setJson}
      onClose={() => {}}
      onSave={() => {}}
    />
  );
}

describe('DocumentEditModal with a Monaco model', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps keys typed after the pause flush', () => {
    render(<Host />);
    act(() => editor!.type('{ "a": 12 }'));
    act(() => {
      vi.advanceTimersByTime(250);
      editor!.type('{ "a": 123 }');
    });
    expect(editor!.text).toBe('{ "a": 123 }');
  });

  it('keeps keys typed after the blur flush', () => {
    render(<Host />);
    act(() => editor!.type('{ "a": 12 }'));
    act(() => {
      editor!.blur();
      editor!.type('{ "a": 123 }');
    });
    expect(editor!.text).toBe('{ "a": 123 }');
  });
});
