// Phase 3 Task 5: the emptied-secondary-window close path (`App.tsx`'s
// tabs-empty effect, `!isMainWindow` branch) and the remote-close detection
// path (the reconciliation listener's `!winEntry` branch) only run when
// `windowLabel()` resolves to something other than `"main"`. Every OTHER
// test in this suite (App.test.tsx) runs as main — jsdom has no real Tauri
// runtime, so `getCurrentWebviewWindow()` throws and `windowLabel()` falls
// back to `"main"` (see workspaceStore.ts's doc comment) — and that fallback
// is cached process-wide for the lifetime of the module. This file exists
// SOLELY to get a different, non-throwing `getCurrentWebviewWindow()` mock
// registered before `workspaceStore.ts` is ever imported, in a separate
// vitest module registry (each test FILE gets its own), so `windowLabel()`
// resolves to `"win-2"` for every test below — proving Task 5's
// secondary-window-only behaviors without touching App.test.tsx's "always
// main" assumption relied on by ~everything else in that much larger file.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/render-with-providers';
import App from '../../App';

vi.mock('../../lib/vault', () => ({
  getVaultStatus: vi.fn().mockResolvedValue('unlocked'),
  initializeVault: vi.fn(),
  unlockVault: vi.fn(),
  lockVault: vi.fn(),
  changeVaultPassword: vi.fn(),
  resetVault: vi.fn(),
  biometricStatus: vi.fn().mockResolvedValue({ available: false, biometryType: 0, enrolled: false }),
  biometricEnable: vi.fn(),
  biometricDisable: vi.fn(),
  notifyVaultUnlocked: vi.fn(),
}));

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

// The one mock this file adds beyond App.test.tsx's baseline set: a
// non-throwing `getCurrentWebviewWindow()` claiming THIS window is a
// secondary one, `"win-2"` — see the file-level comment above.
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'win-2' }),
}));

const eventListeners = new Map<string, Array<(event: { payload: unknown }) => void>>();
function fireMockEvent(eventName: string, payload: unknown) {
  for (const cb of eventListeners.get(eventName) ?? []) cb({ payload });
}
vi.mock('@tauri-apps/api/event', () => ({
  listen: (eventName: string, cb: (event: { payload: unknown }) => void) => {
    const arr = eventListeners.get(eventName) ?? [];
    arr.push(cb);
    eventListeners.set(eventName, arr);
    return Promise.resolve(() => {
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    });
  },
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: () => Promise.resolve('0.3.1'),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appConfigDir: () => Promise.resolve('/tmp/MQLens'),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
  open: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../Sidebar', () => ({
  Sidebar: () => <div data-testid="mock-sidebar" />,
}));

describe('App as a secondary window (windowLabel() === "win-2") — Phase 3 Task 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
  });

  it('an emptied secondary window (no tabs restored for it) closes itself via close_workspace_window', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'load_app_settings') return Promise.resolve({});
      if (cmd === 'workspace_get') {
        // A valid document with no "win-2" entry — `toDisconnectedSnapshot`
        // falls back to an empty layout for this window, `tabs.length`
        // hits 0, and (since this is NOT main) the tabs-empty effect fires
        // `closeWorkspaceWindow()` instead of resurrecting Quick Start.
        return Promise.resolve({
          revision: 1,
          windows: [{ id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: [], activeTabId: null } }],
          tabs: [],
        });
      }
      return Promise.resolve([]);
    });

    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');

    await vi.waitFor(() => {
      const closeCalls = calls.filter((c) => c.cmd === 'close_workspace_window');
      expect(closeCalls).toHaveLength(1);
      expect(closeCalls[0].args).toEqual({ label: 'win-2', origin: 'win-2' });
    });
    // Never the main-window resurrection path.
    expect(calls.some((c) => c.cmd === 'open_tab')).toBe(false);
    expect(screen.queryByTestId('quickstart-tab')).not.toBeInTheDocument();
  });

  it('discovering its own entry missing from a crossWindow broadcast also closes itself via close_workspace_window', async () => {
    const calls: any[] = [];
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === 'load_app_settings') return Promise.resolve({});
      if (cmd === 'workspace_get') {
        // This window DOES start with a tab of its own, so the tabs-empty
        // effect does not fire on boot — the close below must come from the
        // reconciliation listener's remote-close detection instead.
        return Promise.resolve({
          revision: 1,
          windows: [
            { id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: [], activeTabId: null } },
            { id: 'win-2', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: ['conn-1.sales_db.customers'], activeTabId: 'conn-1.sales_db.customers' } },
          ],
          tabs: [
            { id: 'conn-1.sales_db.customers', type: 'collection', profileId: '', profileName: '', db: 'sales_db', collection: 'customers' },
          ],
        });
      }
      return Promise.resolve([]);
    });

    const { act, within } = await import('@testing-library/react');
    renderWithProviders(<App />);
    await screen.findByTestId('mock-sidebar');
    await within(screen.getByTestId('workspace-tab-strip')).findByText('customers');

    calls.length = 0;

    // Another window's op (e.g. a MoveTabToWindow of win-2's last tab
    // elsewhere) removed win-2 from the document entirely.
    await act(async () => {
      fireMockEvent('workspace-changed', {
        revision: 2,
        origin: 'win-1',
        crossWindow: true,
        workspace: {
          revision: 2,
          windows: [{ id: 'main', focusedPaneId: 'pane-1', splitTree: { kind: 'pane', id: 'pane-1', tabIds: [], activeTabId: null } }],
          tabs: [],
        },
      });
    });

    await vi.waitFor(() => {
      const closeCalls = calls.filter((c) => c.cmd === 'close_workspace_window');
      expect(closeCalls).toHaveLength(1);
      expect(closeCalls[0].args).toEqual({ label: 'win-2', origin: 'win-2' });
    });
  });
});
