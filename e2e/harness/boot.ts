// End-to-end entry (#396), loaded only by e2e/index.html.
//
// Builds the fake backend from the test's seed and installs it on Tauri's IPC
// before any app module loads, then boots the real app from src/main.tsx.
// Nothing here ships: the app's own index.html loads src/main.tsx directly.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { Backend, type InvokeArgs } from './backend';
import { registerAiHandlers } from './handlers/ai';
import { registerAppHandlers } from './handlers/app';
import { registerDataHandlers } from './handlers/data';
import type { Seed } from './seed';
import { createState } from './state';

declare global {
  interface Window {
    /** Set by the test fixture before the page loads. */
    __MQLENS_E2E_SEED__?: Seed;
    /** Handle for tests: inspect calls and state, inject failures, emit events. */
    __MQLENS_E2E__?: Backend;
  }
}

const state = createState(window.__MQLENS_E2E_SEED__ ?? {});
const backend = new Backend(state);
registerAppHandlers(backend, state);
registerDataHandlers(backend, state);
registerAiHandlers(backend, state);
window.__MQLENS_E2E__ = backend;

mockWindows('main');
mockIPC((cmd, args) => backend.handle(cmd, args as InvokeArgs), { shouldMockEvents: true });

await import('../../src/main.tsx');
