// End-to-end entry (#396), loaded only by e2e/index.html.
//
// Builds the fake backend from the test's seed and installs it on Tauri's IPC
// before any app module loads, then boots the real app from src/main.tsx.
// Nothing here ships: the app's own index.html loads src/main.tsx directly.
import { loader } from '@monaco-editor/react';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';
import { Backend, type InvokeArgs } from './backend';
import { registerAdminHandlers } from './handlers/admin';
import { registerAiHandlers } from './handlers/ai';
import { registerAppHandlers } from './handlers/app';
import { registerDataHandlers } from './handlers/data';
import { registerGridFsHandlers } from './handlers/gridfs';
import { registerShellHandlers } from './handlers/shell';
import { registerStreamHandlers } from './handlers/streams';
import { registerTransferHandlers } from './handlers/transfer';
import type { Seed } from './seed';
import { createState } from './state';

declare global {
  interface Window {
    /** Set by the test fixture before the page loads. */
    __MQLENS_E2E_SEED__?: Seed;
    /** Handle for tests: inspect calls and state, inject failures, emit events. */
    __MQLENS_E2E__?: Backend;
    /** The Monaco instance the app's editors use, for tests that set editor text. */
    __MQLENS_E2E_MONACO__?: () => Promise<unknown>;
  }
}

const seed = window.__MQLENS_E2E_SEED__ ?? {};
const state = createState(seed);
const backend = new Backend(state);
registerAdminHandlers(backend, state);
registerAiHandlers(backend, state);
registerAppHandlers(backend, state);
registerDataHandlers(backend, state);
registerGridFsHandlers(backend, state);
registerShellHandlers(backend, state);
registerStreamHandlers(backend, state);
registerTransferHandlers(backend, state);
window.__MQLENS_E2E__ = backend;
// Monaco from this repo's own copy, the same version the loader would fetch from
// its CDN, so a run never depends on jsdelivr and editors load without a network
// round trip. The workers are bundled alongside.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new JsonWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
// Monaco's ES-module build sets no global. The loader hands back the one
// instance the app's editors share.
window.__MQLENS_E2E_MONACO__ = () => loader.init();

mockWindows(seed.windowLabel ?? 'main');
mockIPC((cmd, args) => backend.handle(cmd, args as InvokeArgs), { shouldMockEvents: true });

// A dynamic import on purpose: a static one would be hoisted and run the app
// before the mocks above exist.
void import('../../src/main.tsx');
