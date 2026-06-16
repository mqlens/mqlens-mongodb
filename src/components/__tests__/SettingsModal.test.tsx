import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsView } from '../SettingsModal';
import { writeUpdateCheckSnapshot } from '../../lib/updateCheckState';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('../theme/AppearanceSettings', () => ({
  AppearanceSettings: () => <div data-testid="appearance-settings">Theme preset</div>,
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

function renderSettings() {
  return render(<SettingsView />);
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
      if (cmd === 'save_app_settings') {
        return Promise.resolve();
      }
      if (cmd === 'test_mongosh_path') {
        return Promise.resolve('2.1.1');
      }
      if (cmd === 'detect_local_agents') {
        return Promise.resolve([]);
      }
      return Promise.resolve();
    });
  });

  it('renders appearance and mongosh settings', async () => {
    renderSettings();

    expect(await screen.findByText('Settings')).toBeInTheDocument();
    expect(await screen.findByText('Theme preset')).toBeInTheDocument();

    await openTab('settings-tab-mongosh');
    const pathInput = await screen.findByTestId('mongosh-path-input') as HTMLInputElement;
    expect(pathInput.value).toBe('/usr/local/bin/mongosh');
  });

  it('saves and tests mongosh path through backend settings commands', async () => {
    renderSettings();

    await openTab('settings-tab-mongosh');
    const pathInput = await screen.findByTestId('mongosh-path-input') as HTMLInputElement;
    fireEvent.change(pathInput, { target: { value: '/opt/homebrew/bin/mongosh' } });

    fireEvent.click(screen.getByRole('button', { name: /test path/i }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('test_mongosh_path', { path: '/opt/homebrew/bin/mongosh' });
    });

    fireEvent.click(screen.getByTestId('settings-save-btn'));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('save_app_settings', {
        settings: expect.objectContaining({
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
});
