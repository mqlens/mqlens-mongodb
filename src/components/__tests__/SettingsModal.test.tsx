import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsView, MONGO_TOOLS_DIR_KEY } from '../SettingsModal';
import { writeUpdateCheckSnapshot } from '../../lib/updateCheckState';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('../theme/AppearanceSettings', () => ({
  AppearanceSettings: () => <div data-testid="appearance-settings">Theme preset</div>,
}));

// SettingsView reads/writes the active locale through useLocale(), whose real
// implementation is I18nProvider's context — a provider this suite doesn't
// mount (see the file-level note on why: the async "ready" gate would break
// every synchronous openTab() call already written below). Mock it the same
// way AppearanceSettings and lib/vault are mocked above, rather than
// wrapping renderSettings() in a real I18nProvider.
const mockSetLocale = vi.fn();
vi.mock('@/components/i18n/I18nProvider', () => ({
  useLocale: () => ({ locale: 'en', setLocale: mockSetLocale }),
}));

const mockChangeVaultPassword = vi.fn();
const mockResetVault = vi.fn();
const mockBiometricStatus = vi.fn();
const mockBiometricEnable = vi.fn();
const mockBiometricDisable = vi.fn();
vi.mock('../../lib/vault', () => ({
  changeVaultPassword: (...args: unknown[]) => mockChangeVaultPassword(...args),
  resetVault: () => mockResetVault(),
  biometricStatus: () => mockBiometricStatus(),
  biometricEnable: () => mockBiometricEnable(),
  biometricDisable: () => mockBiometricDisable(),
}));

function renderSettings(props: Partial<ComponentProps<typeof SettingsView>> = {}) {
  return render(<SettingsView {...props} />);
}

async function openTab(tabId: string) {
  fireEvent.click(screen.getByTestId(tabId));
}

describe('SettingsView Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockBiometricStatus.mockResolvedValue({ available: false, biometryType: 0, enrolled: false });
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_app_settings') {
        return Promise.resolve({ mongosh_path: '/usr/local/bin/mongosh' });
      }
      if (cmd === 'patch_app_settings' || cmd === 'save_app_settings') {
        return Promise.resolve();
      }
      if (cmd === 'test_mongosh_path') {
        return Promise.resolve('2.1.1');
      }
      if (cmd === 'detect_local_agents') {
        return Promise.resolve([]);
      }
      if (cmd === 'managed_tools_status') {
        return Promise.resolve([
          { name: 'database-tools', version: '100.9.4', installed: false, path: null },
          { name: 'mongosh', version: '2.3.1', installed: true, path: '/data/tools/mongosh/bin/mongosh' },
        ]);
      }
      return Promise.resolve();
    });
  });

  it('renders appearance and mongosh settings', async () => {
    renderSettings();

    expect(await screen.findByText('Settings')).toBeInTheDocument();
    expect(await screen.findByText('Theme preset')).toBeInTheDocument();

    await openTab('settings-tab-tools');
    const pathInput = await screen.findByTestId('mongosh-path-input') as HTMLInputElement;
    expect(pathInput.value).toBe('/usr/local/bin/mongosh');
  });

  it('round-trips the MongoDB Database Tools directory through localStorage', async () => {
    localStorage.setItem(MONGO_TOOLS_DIR_KEY, '/opt/homebrew/bin');
    renderSettings();

    await openTab('settings-tab-tools');
    const dirInput = await screen.findByTestId('mongo-tools-dir-input') as HTMLInputElement;
    expect(dirInput.value).toBe('/opt/homebrew/bin');

    fireEvent.change(dirInput, { target: { value: '/usr/local/mongodb-tools/bin' } });
    expect(dirInput.value).toBe('/usr/local/mongodb-tools/bin');
    expect(localStorage.getItem(MONGO_TOOLS_DIR_KEY)).toBe('/usr/local/mongodb-tools/bin');
  });

  it('shows managed tool versions and wires the Install tools button', async () => {
    const onInstallTools = vi.fn();
    renderSettings({ onInstallTools });

    await openTab('settings-tab-tools');

    expect(await screen.findByTestId('settings-managed-tool-database-tools')).toHaveTextContent(
      'not installed'
    );
    expect(screen.getByTestId('settings-managed-tool-mongosh')).toHaveTextContent(
      'v2.3.1 installed'
    );

    fireEvent.click(screen.getByTestId('settings-install-tools-btn'));
    expect(onInstallTools).toHaveBeenCalled();
  });

  it('refreshes the managed tools card when toolStatusRefreshNonce changes (regression: stale card after install)', async () => {
    let call = 0;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '' });
      if (cmd === 'detect_local_agents') return Promise.resolve([]);
      if (cmd === 'managed_tools_status') {
        call += 1;
        if (call === 1) {
          return Promise.resolve([
            { name: 'database-tools', version: '100.9.4', installed: false, path: null },
            { name: 'mongosh', version: '2.3.1', installed: false, path: null },
          ]);
        }
        return Promise.resolve([
          { name: 'database-tools', version: '100.9.4', installed: true, path: '/data/tools/database-tools/bin' },
          { name: 'mongosh', version: '2.3.1', installed: true, path: '/data/tools/mongosh/bin/mongosh' },
        ]);
      }
      return Promise.resolve();
    });

    const { rerender } = renderSettings({ toolStatusRefreshNonce: 0 });
    await openTab('settings-tab-tools');

    expect(await screen.findByTestId('settings-managed-tool-mongosh')).toHaveTextContent('not installed');

    // Simulate the App-level ToolSetupDialog "Done" handler bumping the nonce
    // after an install completes while Settings is still mounted.
    rerender(<SettingsView toolStatusRefreshNonce={1} />);

    await waitFor(() => {
      expect(screen.getByTestId('settings-managed-tool-mongosh')).toHaveTextContent('v2.3.1 installed');
    });
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it('saves and tests mongosh path through backend settings commands', async () => {
    renderSettings();

    await openTab('settings-tab-tools');
    const pathInput = await screen.findByTestId('mongosh-path-input') as HTMLInputElement;
    fireEvent.change(pathInput, { target: { value: '/opt/homebrew/bin/mongosh' } });

    fireEvent.click(screen.getByRole('button', { name: /test path/i }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('test_mongosh_path', { path: '/opt/homebrew/bin/mongosh' });
    });

    fireEvent.click(screen.getByTestId('settings-save-btn'));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('patch_app_settings', {
        patch: expect.objectContaining({
          mongosh_path: '/opt/homebrew/bin/mongosh',
          ai_provider: 'anthropic',
          anthropic_api_key: '',
          anthropic_model: 'claude-opus-4-8',
          openai_api_key: '',
          openai_model: 'gpt-4o',
          gemini_api_key: '',
          gemini_model: 'gemini-1.5-flash',
          ai_custom_instructions: '',
        }),
      });
    });
  });

  it('changes master password via the Security section (H7)', async () => {
    mockChangeVaultPassword.mockResolvedValue(undefined);
    renderSettings();

    await openTab('settings-tab-security');
    fireEvent.change(await screen.findByTestId('sec-old-pw'), { target: { value: 'oldpass' } });
    fireEvent.change(screen.getByTestId('sec-new-pw'), { target: { value: 'newpass' } });
    fireEvent.change(screen.getByTestId('sec-new-pw2'), { target: { value: 'newpass' } });
    fireEvent.click(screen.getByTestId('sec-change-pw-btn'));

    await waitFor(() => {
      expect(mockChangeVaultPassword).toHaveBeenCalledWith('oldpass', 'newpass');
    });
    expect(await screen.findByTestId('sec-msg')).toHaveTextContent('Master password changed');
  });

  it('shows error when new passwords do not match (H7)', async () => {
    renderSettings();

    await openTab('settings-tab-security');
    fireEvent.change(await screen.findByTestId('sec-old-pw'), { target: { value: 'oldpass' } });
    fireEvent.change(screen.getByTestId('sec-new-pw'), { target: { value: 'newpass' } });
    fireEvent.change(screen.getByTestId('sec-new-pw2'), { target: { value: 'different' } });
    fireEvent.click(screen.getByTestId('sec-change-pw-btn'));

    expect(await screen.findByTestId('sec-msg')).toHaveTextContent('New passwords do not match');
    expect(mockChangeVaultPassword).not.toHaveBeenCalled();
  });

  it('shows the biometric toggle when available and enables it', async () => {
    mockBiometricStatus.mockResolvedValue({ available: true, biometryType: 2, enrolled: false });
    mockBiometricEnable.mockResolvedValue(undefined);
    renderSettings();
    await openTab('settings-tab-security');
    const toggle = await screen.findByTestId('sec-biometric-toggle');
    fireEvent.click(toggle);
    await waitFor(() => expect(mockBiometricEnable).toHaveBeenCalledTimes(1));
  });

  it('hides the biometric toggle when unavailable', async () => {
    mockBiometricStatus.mockResolvedValue({ available: false, biometryType: 0, enrolled: false });
    renderSettings();
    await openTab('settings-tab-security');
    await screen.findByTestId('sec-change-pw-btn');
    expect(screen.queryByTestId('sec-biometric-toggle')).not.toBeInTheDocument();
  });

  it('switches AI provider and shows the relevant config fields', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_app_settings') return Promise.resolve({ mongosh_path: '' });
      if (cmd === 'detect_local_agents') {
        return Promise.resolve([
          { id: 'claude-code', binary: 'claude', available: true, version: 'claude 1.2.3' },
          { id: 'codex', binary: 'codex', available: false, version: '' },
          { id: 'cursor', binary: 'cursor-agent', available: false, version: '' },
          { id: 'antigravity', binary: 'antigravity', available: false, version: '' },
        ]);
      }
      return Promise.resolve(undefined);
    });

    renderSettings();

    await openTab('settings-tab-ai');

    fireEvent.click(await screen.findByTestId('ai-provider-select'));
    fireEvent.click(screen.getByRole('option', { name: /OpenAI/i }));
    expect(screen.getByTestId('openai-key-input')).toBeInTheDocument();
    expect(screen.getByTestId('openai-model-input')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-provider-select'));
    fireEvent.click(screen.getByRole('option', { name: /Claude Code/i }));
    expect(screen.getByTestId('local-command-input')).toBeInTheDocument();
    expect(await screen.findByTestId('agent-availability')).toHaveTextContent(/installed/i);
  });

  it('loads and saves AI Helper history retention duration', async () => {
    mockInvoke.mockImplementation((cmd: string, args?: { patch?: { ai_history_retention_months?: number } }) => {
      if (cmd === 'load_app_settings') {
        return Promise.resolve({ mongosh_path: '', ai_history_retention_months: 6 });
      }
      if (cmd === 'patch_app_settings' || cmd === 'save_app_settings') {
        expect(args?.patch?.ai_history_retention_months).toBe(12);
        return Promise.resolve();
      }
      if (cmd === 'detect_local_agents') return Promise.resolve([]);
      if (cmd === 'managed_tools_status') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    renderSettings();
    await openTab('settings-tab-ai');

    // `waitFor` on the CONTENT, not `findBy` on the element. The trigger is
    // rendered immediately showing the default "3 months", so waiting for the
    // element to exist proves nothing — it is already there before the saved
    // settings have loaded. This passed locally and failed on CI, where the
    // load lands a beat later.
    const trigger = await screen.findByTestId('ai-history-retention-select');
    await waitFor(() => expect(trigger).toHaveTextContent(/6 months/i));

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /12 months/i }));
    fireEvent.click(screen.getByTestId('settings-save-btn'));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('patch_app_settings', expect.any(Object)));
    expect(localStorage.getItem('mqlens_ai_history_retention_months')).toBe('12');
  });

  it('loads and saves audit logging settings', async () => {
    let auditPatch: Record<string, unknown> | undefined;
    mockInvoke.mockImplementation(
      (
        cmd: string,
        args?: { patch?: Record<string, unknown> }
      ) => {
        if (cmd === 'load_app_settings') {
          return Promise.resolve({
            mongosh_path: '',
            audit_enabled: true,
            audit_level: 'A',
            audit_retention_days: 30,
            audit_include_payloads: false,
          });
        }
        if (cmd === 'patch_app_settings' || cmd === 'save_app_settings') {
          // Recorded, not asserted here: an `expect` that throws inside the mock
          // is swallowed by the component's own catch, so the test would pass
          // whatever the values were. Checked after the await instead.
          auditPatch = args?.patch;
          return Promise.resolve();
        }
        if (cmd === 'detect_local_agents') return Promise.resolve([]);
        if (cmd === 'managed_tools_status') return Promise.resolve([]);
        return Promise.resolve(undefined);
      }
    );

    renderSettings();
    await openTab('settings-tab-audit');

    const levelTrigger = await screen.findByTestId('audit-level-select');
    await waitFor(() => expect(levelTrigger).toHaveTextContent(/A\b|writes/i));

    fireEvent.click(levelTrigger);
    fireEvent.click(screen.getByRole('option', { name: /C\b|all/i }));

    const retentionTrigger = screen.getByTestId('audit-retention-select');
    fireEvent.click(retentionTrigger);
    fireEvent.click(screen.getByRole('option', { name: /90/i }));

    fireEvent.click(screen.getByTestId('audit-include-payloads-toggle'));
    fireEvent.click(screen.getByTestId('settings-save-btn'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('patch_app_settings', expect.any(Object))
    );
    await waitFor(() => expect(auditPatch).toBeTruthy());
    expect(auditPatch).toMatchObject({
      audit_enabled: true,
      audit_level: 'C',
      audit_retention_days: 90,
      audit_include_payloads: true,
    });
  });

  it('shows last update check status on the updates tab', async () => {
    writeUpdateCheckSnapshot({
      checkedAt: '2026-06-15T12:00:00.000Z',
      result: 'offline',
    });
    renderSettings();
    await openTab('settings-tab-updates');
    expect(await screen.findByTestId('update-last-checked')).toHaveTextContent(/Offline/i);
    expect(screen.getByTestId('update-last-checked')).toHaveTextContent(/Last checked:/i);
  });

  it('lists keyboard shortcuts with search on the shortcuts tab', async () => {
    renderSettings();
    await openTab('settings-tab-shortcuts');
    expect(await screen.findByTestId('shortcuts-group-command-palette')).toBeInTheDocument();
    expect(screen.getByTestId('shortcut-row-palette-open')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('shortcuts-filter'), { target: { value: 'sidebar' } });
    expect(screen.getByTestId('shortcut-row-sidebar-search')).toBeInTheDocument();
    expect(screen.queryByTestId('shortcut-row-palette-open')).not.toBeInTheDocument();
  });

  it('opens the shortcuts tab when initialTab is shortcuts', async () => {
    render(<SettingsView initialTab="shortcuts" />);
    expect(await screen.findByTestId('shortcuts-group-zoom')).toBeInTheDocument();
  });

  // Nested (not a sibling top-level describe) so these inherit this file's
  // beforeEach above — the mockInvoke/mockBiometricStatus implementations
  // installed there are what let SettingsView render at all. A separate
  // top-level describe here previously only passed in a whole-file run
  // because those implementations leaked in from this block; run in
  // isolation (`-t 'language section'`) it threw on the missing invoke mock.
  describe('SettingsModal — language section (#123)', () => {
    it('offers a Language section listing every shipped locale', async () => {
      renderSettings();
      await openTab('settings-tab-language');
      // SelectContent (Radix) only mounts once the Select is opened; open it
      // the way a keyboard user would instead of forcing it open in prod code.
      const trigger = await screen.findByRole('combobox');
      fireEvent.keyDown(trigger, { key: 'Enter' });
      expect(screen.getByRole('option', { name: 'English' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Deutsch' })).toBeInTheDocument();
    });

    it('explains that untranslated text falls back to English', async () => {
      renderSettings();
      await openTab('settings-tab-language');
      expect(await screen.findByText(/falls back to English/i)).toBeInTheDocument();
    });
  });

  describe('configurable AI providers (#283)', () => {
    const deepseek = {
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'openai-compatible',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'k',
      model: 'deepseek-chat',
      command: '',
    };

    it('offers a saved provider alongside the built-ins', async () => {
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === 'load_app_settings') {
          return Promise.resolve({ ai_provider: 'deepseek', ai_providers: [deepseek] });
        }
        if (cmd === 'ai_provider_presets') return Promise.resolve([]);
        return Promise.resolve();
      });
      renderSettings();
      await openTab('settings-tab-ai');

      // Listed for management...
      expect(await screen.findByTestId('ai-provider-row-deepseek')).toHaveTextContent('DeepSeek');
      // ...and selectable as the active provider.
      expect(await screen.findByTestId('ai-provider-select')).toHaveTextContent('DeepSeek');
    });

    it('saves the provider list back into settings', async () => {
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === 'load_app_settings') return Promise.resolve({ ai_providers: [deepseek] });
        if (cmd === 'ai_provider_presets') return Promise.resolve([]);
        if (cmd === 'validate_ai_provider') return Promise.resolve('ok');
        return Promise.resolve();
      });
      renderSettings();
      await openTab('settings-tab-ai');
      await screen.findByTestId('ai-provider-row-deepseek');

      fireEvent.click(screen.getByTestId('settings-save-btn'));
      await waitFor(() => {
        const save = mockInvoke.mock.calls.find(([cmd]) => cmd === 'patch_app_settings');
        expect(save).toBeTruthy();
        expect(save![1].patch.ai_providers).toEqual([deepseek]);
      });
    });

    it('persists the list as soon as a provider is saved or removed, not only on the form Save', async () => {
      // The reported bug: providers added, window closed, providers gone.
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === 'load_app_settings') return Promise.resolve({ ai_provider: 'anthropic', ai_providers: [deepseek] });
        if (cmd === 'ai_provider_presets') return Promise.resolve([]);
        return Promise.resolve();
      });
      renderSettings();
      await openTab('settings-tab-ai');
      await screen.findByTestId('ai-provider-row-deepseek');

      fireEvent.click(screen.getByTestId('ai-provider-remove-deepseek'));
      await waitFor(() => {
        const patch = mockInvoke.mock.calls.find(([cmd]) => cmd === 'patch_app_settings');
        expect(patch).toBeTruthy();
        expect(patch![1].patch.ai_providers).toEqual([]);
      });
    });

    it('writes only the fields it owns, so a concurrent theme or locale change survives', async () => {
      // The form used to load the whole settings object and write it back, which
      // undid an appearance or locale change made while it was open. Ordering is
      // no longer a frontend concern either: each write is one backend call that
      // loads, merges and saves under a lock.
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === 'load_app_settings') return Promise.resolve({ ai_providers: [deepseek] });
        if (cmd === 'ai_provider_presets') return Promise.resolve([]);
        return Promise.resolve();
      });
      renderSettings();
      await openTab('settings-tab-ai');
      await screen.findByTestId('ai-provider-row-deepseek');

      fireEvent.click(screen.getByTestId('settings-save-btn'));
      await waitFor(() => {
        const patch = mockInvoke.mock.calls.find(([cmd]) => cmd === 'patch_app_settings');
        expect(patch).toBeTruthy();
        const fields = Object.keys(patch![1].patch);
        expect(fields).toContain('ai_providers');
        expect(fields).toContain('mongosh_path');
        // Fields owned by other components are absent, so they cannot be echoed
        // back over a newer value.
        expect(fields).not.toContain('appearance');
        expect(fields).not.toContain('locale');
      });
      // And nothing writes the whole object any more.
      expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'save_app_settings')).toBe(false);
    });

    it('applies rapid provider writes in the order they were made', async () => {
      // The backend mutex gives mutual exclusion, not ordering: add-then-remove
      // could finish with the add last and the provider back.
      const patches: any[] = [];
      let releaseFirst: (v?: unknown) => void = () => {};
      let calls = 0;
      mockInvoke.mockImplementation((cmd, args: any) => {
        if (cmd === 'load_app_settings') return Promise.resolve({ ai_providers: [] });
        if (cmd === 'ai_provider_presets') return Promise.resolve([]);
        if (cmd === 'validate_ai_provider') return Promise.resolve('ok');
        if (cmd === 'patch_app_settings') {
          patches.push(args.patch.ai_providers);
          calls += 1;
          // The first write is slow; the second must wait for it regardless.
          if (calls === 1) return new Promise((res) => { releaseFirst = res; });
          return Promise.resolve();
        }
        return Promise.resolve();
      });
      renderSettings();
      await openTab('settings-tab-ai');

      // Add one...
      fireEvent.click(await screen.findByTestId('ai-provider-add'));
      fireEvent.change(screen.getByTestId('ai-provider-name-input'), { target: { value: 'DeepSeek' } });
      fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'https://api.deepseek.com/v1' } });
      fireEvent.change(screen.getByTestId('ai-provider-key-input'), { target: { value: 'k' } });
      fireEvent.change(screen.getByTestId('ai-provider-model-input'), { target: { value: 'deepseek-chat' } });
      fireEvent.click(screen.getByTestId('ai-provider-save'));
      await waitFor(() => expect(patches).toHaveLength(1));

      // ...then remove it before the add has finished writing.
      fireEvent.click(await screen.findByTestId('ai-provider-remove-deepseek'));
      await new Promise((r) => setTimeout(r, 20));
      expect(patches).toHaveLength(1);            // the removal is queued behind it
      releaseFirst();
      await waitFor(() => expect(patches).toHaveLength(2));

      // The last write wins, and it is the removal.
      expect(patches[0]).toHaveLength(1);
      expect(patches[1]).toEqual([]);
    });

    it('holds the main Save behind a provider write still in flight', async () => {
      // Both patch `ai_provider` and `ai_providers`, so a Save issued directly
      // could overtake a queued provider patch carrying the *previous* active
      // provider — and that older patch would land last and revert the choice
      // just saved.
      const patches: any[] = [];
      let releaseFirst: (v?: unknown) => void = () => {};
      let calls = 0;
      mockInvoke.mockImplementation((cmd, args: any) => {
        if (cmd === 'load_app_settings') return Promise.resolve({ ai_providers: [] });
        if (cmd === 'ai_provider_presets') return Promise.resolve([]);
        if (cmd === 'validate_ai_provider') return Promise.resolve('ok');
        if (cmd === 'patch_app_settings') {
          patches.push(args.patch);
          calls += 1;
          if (calls === 1) return new Promise((res) => { releaseFirst = res; });
          return Promise.resolve();
        }
        return Promise.resolve();
      });
      renderSettings();
      await openTab('settings-tab-ai');

      // A provider write starts and does not finish.
      fireEvent.click(await screen.findByTestId('ai-provider-add'));
      fireEvent.change(screen.getByTestId('ai-provider-name-input'), { target: { value: 'DeepSeek' } });
      fireEvent.change(screen.getByTestId('ai-provider-url-input'), { target: { value: 'https://api.deepseek.com/v1' } });
      fireEvent.change(screen.getByTestId('ai-provider-key-input'), { target: { value: 'k' } });
      fireEvent.change(screen.getByTestId('ai-provider-model-input'), { target: { value: 'deepseek-chat' } });
      fireEvent.click(screen.getByTestId('ai-provider-save'));
      await waitFor(() => expect(patches).toHaveLength(1));

      // Save is pressed while it is still in flight.
      fireEvent.click(screen.getByTestId('settings-save-btn'));
      await new Promise((r) => setTimeout(r, 20));
      expect(patches).toHaveLength(1); // queued behind the provider write

      releaseFirst();
      await waitFor(() => expect(patches).toHaveLength(2));
      // Save is second, so its `ai_provider` is the value that survives.
      expect(patches[1]).toHaveProperty('mongosh_path');
    });

    it('does not leave a removed provider selected', async () => {
      // The backend rejects an unknown id, and that error would otherwise only
      // appear the next time the user asked for a query.
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === 'load_app_settings') {
          return Promise.resolve({ ai_provider: 'deepseek', ai_providers: [deepseek] });
        }
        if (cmd === 'ai_provider_presets') return Promise.resolve([]);
        return Promise.resolve();
      });
      renderSettings();
      await openTab('settings-tab-ai');
      await screen.findByTestId('ai-provider-row-deepseek');
      expect(screen.getByTestId('ai-provider-select')).toHaveTextContent('DeepSeek');

      fireEvent.click(screen.getByTestId('ai-provider-remove-deepseek'));
      await waitFor(() =>
        expect(screen.getByTestId('ai-provider-select')).not.toHaveTextContent('DeepSeek')
      );
    });
  });

  describe('MCP agent instructions (#283)', () => {
    it('shows the instructions the server sends, for pasting elsewhere', async () => {
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === 'load_app_settings') return Promise.resolve({});
        if (cmd === 'mcp_agent_instructions') {
          return Promise.resolve('WORK IN THIS ORDER. 1. `ping`');
        }
        if (cmd === 'mcp_status') {
          return Promise.resolve({ enabled: false, port: 8765, token: '', running: false });
        }
        return Promise.resolve();
      });
      renderSettings();
      await openTab('settings-tab-mcp');

      const prompt = await screen.findByTestId('mcp-agent-prompt');
      expect(prompt).toHaveTextContent('WORK IN THIS ORDER');
      expect(screen.getByTestId('mcp-agent-prompt-copy')).toBeInTheDocument();
    });

    it('hides the panel rather than showing an empty box when they cannot be read', async () => {
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === 'load_app_settings') return Promise.resolve({});
        if (cmd === 'mcp_agent_instructions') return Promise.reject('nope');
        if (cmd === 'mcp_status') {
          return Promise.resolve({ enabled: false, port: 8765, token: '', running: false });
        }
        return Promise.resolve();
      });
      renderSettings();
      await openTab('settings-tab-mcp');

      await waitFor(() => expect(screen.queryByTestId('mcp-agent-prompt')).not.toBeInTheDocument());
    });
  });
});
