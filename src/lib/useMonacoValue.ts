import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Monaco, OnMount } from '@monaco-editor/react';

type MonacoEditor = Parameters<OnMount>[0];

/**
 * Keeps a Monaco editor's text in step with a React value, in place of
 * @monaco-editor/react's `value` prop.
 *
 * The library compares `value` with the model from a passive effect. Chromium
 * delivers Monaco's typing through EditContext events, which React doesn't
 * treat as discrete, so the render an onChange causes has its passive effects
 * run in a later task, and the next keystroke can reach the model first. The
 * library then wrote the previous keystroke's text over it: characters vanished
 * and the caret jumped to the end. This writes the value from a layout effect
 * instead, in the same task as the render, before any further input can land.
 *
 * Spread the result onto the editor: `defaultValue` in place of `value`, and
 * `onChange` and `onMount` as given. Call `onMount` from an editor's own mount
 * handler when it has one.
 */
export function useMonacoValue(value: string, onChange: (value: string) => void) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // Set while the value is written into the model, so that edit isn't reported
  // back through onChange as if it were typed.
  const pushingRef = useRef(false);

  const pushValue = useCallback(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const next = valueRef.current;
    if (!ed || !model || next === ed.getValue()) return;
    pushingRef.current = true;
    try {
      // A read-only editor refuses edits, so it is given the text outright, as
      // the library does.
      if (monacoRef.current && ed.getOption(monacoRef.current.editor.EditorOption.readOnly)) {
        ed.setValue(next);
      } else {
        ed.executeEdits('', [{ range: model.getFullModelRange(), text: next, forceMoveMarkers: true }]);
        ed.pushUndoStop();
      }
    } finally {
      pushingRef.current = false;
    }
  }, []);

  useLayoutEffect(pushValue, [value, pushValue]);

  const handleChange = useCallback((next: string | undefined) => {
    if (!pushingRef.current) onChangeRef.current(next ?? '');
  }, []);

  const handleMount = useCallback(
    (ed: MonacoEditor, monaco: Monaco) => {
      editorRef.current = ed;
      monacoRef.current = monaco;
      // The library creates the editor from one effect but calls onMount and
      // starts reporting changes from the next, so text can reach the model in
      // between without being reported. An edited model is newer than the
      // parent's value: report it. Otherwise the model was created from an
      // earlier render's value; catch up with one that arrived since.
      if ((ed.getModel()?.getVersionId() ?? 1) > 1) onChangeRef.current(ed.getValue());
      else pushValue();
      ed.onDidDispose(() => {
        if (editorRef.current === ed) editorRef.current = null;
      });
    },
    [pushValue],
  );

  return {
    // Only the text the model is created with; later values are written above.
    defaultValue: value,
    onChange: handleChange,
    onMount: handleMount,
  };
}
