/**
 * Monaco from the app bundle, not from a CDN.
 *
 * Left to itself, `@monaco-editor/react` injects `loader.js` from jsDelivr the
 * first time an editor mounts, at the version its loader package hardcodes.
 * That script then runs in the app's own origin with the Tauri IPC, every
 * editor waits on the network (forever, offline), and the Monaco that runs is
 * not the one in package-lock.json. Handing the loader this bundled copy before
 * any editor mounts means no script is ever fetched.
 *
 * The language services run in Vite-bundled workers. Monaco's own fallback for
 * the editor worker starts it from a `blob:` URL, which a content security
 * policy would have to allow.
 *
 * Imported for its side effects, first thing in `main.tsx`.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker';

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new JsonWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });
