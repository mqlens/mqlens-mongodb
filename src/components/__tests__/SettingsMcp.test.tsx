import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsView } from '../SettingsModal';
import type { McpStatusUi } from '../../lib/mcpApi';
import type { ConnectionProfile } from '../../lib/connection';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('../theme/AppearanceSettings', () => ({
  AppearanceSettings: () => <div data-testid="appearance-settings">Theme preset</div>,
}));

vi.mock('../../lib/vault', () => ({
  changeVaultPassword: vi.fn(),
  resetVault: vi.fn(),
  biometricStatus: () => Promise.resolve({ available: false, biometryType: 0, enrolled: false }),
  biometricEnable: vi.fn(),
  biometricDisable: vi.fn(),
}));

const writeText = vi.fn();

function disabledStatus(overrides: Partial<McpStatusUi> = {}): McpStatusUi {
  return { enabled: false, port: 8765, token: '', log: [], ...overrides };
}

function enabledStatus(overrides: Partial<McpStatusUi> = {}): McpStatusUi {
  return { enabled: true, port: 8765, token: 'tok-xyz-123', log: [], ...overrides };
}

/** Wires `mockInvoke` for the handful of commands SettingsView + the MCP
 * panel issue, with per-command overrides supplied by each test. */
function setupInvoke(opts: {
  status?: McpStatusUi;
  setEnabled?: (args: { enabled: boolean; port: number | null }) => McpStatusUi | Promise<McpStatusUi>;
  regenerate?: () => McpStatusUi | Promise<McpStatusUi>;
  profiles?: ConnectionProfile[];
} = {}) {
  const status = opts.status ?? disabledStatus();
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '' });
    if (cmd === 'detect_local_agents') return Promise.resolve([]);
    if (cmd === 'managed_tools_status') return Promise.resolve([]);
    if (cmd === 'mcp_get_status') return Promise.resolve(status);
    if (cmd === 'mcp_set_enabled') {
      if (opts.setEnabled) {
        return Promise.resolve(
          opts.setEnabled(args as { enabled: boolean; port: number | null })
        );
      }
      return Promise.resolve(enabledStatus());
    }
    if (cmd === 'mcp_regenerate_token') {
      return Promise.resolve(opts.regenerate ? opts.regenerate() : enabledStatus());
    }
    if (cmd === 'load_connection_profiles') return Promise.resolve(opts.profiles ?? []);
    return Promise.resolve();
  });
}

async function openMcpTab() {
  fireEvent.click(screen.getByTestId('settings-tab-mcp'));
  await screen.findByTestId('mcp-enable-toggle');
}

describe('SettingsView MCP panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  it('toggling on invokes mcp_set_enabled with the configured port', async () => {
    setupInvoke({ status: disabledStatus() });
    render(<SettingsView />);
    await openMcpTab();

    fireEvent.click(screen.getByTestId('mcp-enable-toggle'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('mcp_set_enabled', { enabled: true, port: 8765 });
    });
  });

  it('rejects an out-of-range port with a friendly message and never calls mcp_set_enabled (final fix wave)', async () => {
    setupInvoke({ status: disabledStatus() });
    render(<SettingsView />);
    await openMcpTab();

    fireEvent.change(screen.getByTestId('mcp-port-input'), { target: { value: '80' } });
    fireEvent.click(screen.getByTestId('mcp-enable-toggle'));

    expect(await screen.findByTestId('mcp-error')).toHaveTextContent('Port must be between 1024 and 65535.');
    expect(mockInvoke).not.toHaveBeenCalledWith('mcp_set_enabled', expect.anything());
  });

  it('renders the vault-locked error inline when enabling fails', async () => {
    // mcp_set_enabled rejects (Tauri's Result<T, String> Err path) — set up
    // manually since setupInvoke's helper always resolves.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '' });
      if (cmd === 'detect_local_agents') return Promise.resolve([]);
      if (cmd === 'managed_tools_status') return Promise.resolve([]);
      if (cmd === 'mcp_get_status') return Promise.resolve(disabledStatus());
      if (cmd === 'mcp_set_enabled') return Promise.reject('vault is locked');
      if (cmd === 'load_connection_profiles') return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<SettingsView />);
    await openMcpTab();

    fireEvent.click(screen.getByTestId('mcp-enable-toggle'));

    expect(await screen.findByTestId('mcp-vault-locked')).toHaveTextContent('vault is locked');
  });

  it('masks the token by default and reveals it on demand', async () => {
    setupInvoke({ status: enabledStatus({ token: 'super-secret-token' }) });
    render(<SettingsView />);
    await openMcpTab();

    const display = await screen.findByTestId('mcp-token-display');
    expect(display).toHaveTextContent('••••••••••••••••');
    expect(display).not.toHaveTextContent('super-secret-token');

    fireEvent.click(screen.getByTestId('mcp-token-reveal'));
    expect(screen.getByTestId('mcp-token-display')).toHaveTextContent('super-secret-token');
  });

  it('copies the exact Claude Code config snippet', async () => {
    setupInvoke({ status: enabledStatus({ port: 9001, token: 'tok-abc' }) });
    render(<SettingsView />);
    await openMcpTab();

    const copyBtn = await screen.findByTestId('mcp-claude-copy');
    fireEvent.click(copyBtn);

    expect(writeText).toHaveBeenCalledWith(
      'claude mcp add --transport http mqlens http://127.0.0.1:9001/mcp --header "Authorization: Bearer tok-abc"'
    );
  });

  it('updates the shown token after regenerate', async () => {
    setupInvoke({
      status: enabledStatus({ token: 'old-token' }),
      regenerate: () => enabledStatus({ token: 'brand-new-token' }),
    });
    render(<SettingsView />);
    await openMcpTab();

    fireEvent.click(await screen.findByTestId('mcp-token-reveal'));
    expect(screen.getByTestId('mcp-token-display')).toHaveTextContent('old-token');

    fireEvent.click(screen.getByTestId('mcp-token-regenerate'));

    await waitFor(() => {
      expect(screen.getByTestId('mcp-token-display')).toHaveTextContent('brand-new-token');
    });
    expect(screen.getByTestId('mcp-regenerate-note')).toBeInTheDocument();
  });

  it('renders only the opted-in profiles from load_connection_profiles', async () => {
    setupInvoke({
      status: disabledStatus(),
      profiles: [
        { id: 'p1', name: 'Prod Cluster', uri: 'mongodb://mock1', color_tag: '#ff0000', mcp_enabled: true },
        { id: 'p2', name: 'Local Dev', uri: 'mongodb://mock2', color_tag: '#00ff00', mcp_enabled: false },
        { id: 'p3', name: 'Staging', uri: 'mongodb://mock3', mcp_enabled: true },
      ],
    });
    render(<SettingsView />);
    await openMcpTab();

    expect(await screen.findByTestId('mcp-profile-p1')).toHaveTextContent('Prod Cluster');
    expect(screen.getByTestId('mcp-profile-p3')).toHaveTextContent('Staging');
    expect(screen.queryByTestId('mcp-profile-p2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-profiles-empty')).not.toBeInTheDocument();
  });

  it('shows the empty-state hint when no profiles are opted in', async () => {
    setupInvoke({ status: disabledStatus(), profiles: [] });
    render(<SettingsView />);
    await openMcpTab();

    expect(await screen.findByTestId('mcp-profiles-empty')).toHaveTextContent(
      'No profiles are exposed'
    );
  });

  it('renders call log rows newest-first', async () => {
    setupInvoke({
      status: enabledStatus({
        log: [
          { tsMs: 1_700_000_000_000, tool: 'list_databases', summary: 'first call', ok: true },
          { tsMs: 1_700_000_005_000, tool: 'find', summary: 'second call', ok: false },
          { tsMs: 1_700_000_010_000, tool: 'aggregate', summary: 'third call', ok: true },
        ],
      }),
    });
    render(<SettingsView />);
    await openMcpTab();

    const rows = await screen.findAllByTestId('mcp-log-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('aggregate');
    expect(rows[0]).toHaveTextContent('third call');
    expect(rows[1]).toHaveTextContent('find');
    expect(rows[1]).toHaveTextContent('ERR');
    expect(rows[2]).toHaveTextContent('list_databases');
  });

  it('shows the empty call-log state when there are no entries yet', async () => {
    setupInvoke({ status: disabledStatus() });
    render(<SettingsView />);
    await openMcpTab();

    expect(await screen.findByTestId('mcp-log-empty')).toHaveTextContent('No tool calls yet.');
  });
});
