import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real editor needs a browser; a stand-in namespace is enough to check
// which copy the loader hands out. The workers are stand-ins too: jsdom has no
// Worker, and what matters is which one each language service gets.
vi.mock('monaco-editor', () => ({ editor: {}, languages: {}, typescript: {}, json: {} }));
vi.mock('monaco-editor/esm/vs/editor/editor.worker.js?worker', () => ({
  default: class EditorWorker {},
}));
vi.mock('monaco-editor/esm/vs/language/json/json.worker.js?worker', () => ({
  default: class JsonWorker {},
}));
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker.js?worker', () => ({
  default: class TsWorker {},
}));

import * as bundledMonaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';

describe('monacoSetup', () => {
  beforeEach(() => {
    vi.resetModules();
    document.head.replaceChildren();
    document.body.replaceChildren();
    delete (self as { MonacoEnvironment?: unknown }).MonacoEnvironment;
  });

  it('gives the editors the bundled Monaco without fetching one from a CDN', async () => {
    await import('../monacoSetup');
    const { loader } = await import('@monaco-editor/react');

    const init = loader.init();

    expect(document.querySelector('script[src]')).toBeNull();
    await expect(init).resolves.toBe(bundledMonaco);
  });

  it('runs each language service in a bundled worker', async () => {
    await import('../monacoSetup');
    const getWorker = self.MonacoEnvironment?.getWorker;

    expect(getWorker?.('workerMain.js', 'typescript')).toBeInstanceOf(TsWorker);
    expect(getWorker?.('workerMain.js', 'javascript')).toBeInstanceOf(TsWorker);
    expect(getWorker?.('workerMain.js', 'json')).toBeInstanceOf(JsonWorker);
    expect(getWorker?.('workerMain.js', 'editorWorkerService')).toBeInstanceOf(EditorWorker);
  });
});
