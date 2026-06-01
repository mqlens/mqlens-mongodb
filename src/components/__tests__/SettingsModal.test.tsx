import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsView } from '../SettingsModal';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

const mockChangeVaultPassword = vi.fn();
const mockResetVault = vi.fn();
const mockBiometricStatus = vi.fn();
const mockBiometricEnable = vi.fn();
const mockBiometricDisable = vi.fn();
vi.mock('../../lib/vault', () => ({
  changeVaultPassword: (...args: any[]) => mockChangeVaultPassword(...args),
  resetVault: () => mockResetVault(),
  biometricStatus: () => mockBiometricStatus(),
  biometricEnable: () => mockBiometricEnable(),
  biometricDisable: () => mockBiometricDisable(),
}));

describe('SettingsView Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Safe default: biometrics unavailable so existing tests are unaffected
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

  it('renders density and mongosh settings', async () => {
    render(
      <SettingsView
        density="cozy"
        onChangeDensity={() => {}}
      />
    );

    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('roomy')).toBeInTheDocument();
    expect(screen.getByText('cozy')).toBeInTheDocument();
    expect(screen.getByText('compact')).toBeInTheDocument();
    expect(screen.getByText('Balanced padding and standard grid heights (recommended).')).toBeInTheDocument();
    expect(screen.getByTestId('density-check-cozy')).toBeInTheDocument();

    const pathInput = await screen.findByTestId('mongosh-path-input') as HTMLInputElement;
    expect(pathInput.value).toBe('/usr/local/bin/mongosh');
  });

  it('calls onChangeDensity when options are clicked', () => {
    const handleChangeDensity = vi.fn();
    render(
      <SettingsView
        density="cozy"
        onChangeDensity={handleChangeDensity}
      />
    );

    fireEvent.click(screen.getByTestId('density-option-roomy'));
    expect(handleChangeDensity).toHaveBeenCalledWith('roomy');

    fireEvent.click(screen.getByTestId('density-option-compact'));
    expect(handleChangeDensity).toHaveBeenCalledWith('compact');
  });

  it('saves and tests mongosh path through backend settings commands', async () => {
    render(
      <SettingsView
        density="cozy"
        onChangeDensity={() => {}}
      />
    );

    const pathInput = await screen.findByTestId('mongosh-path-input') as HTMLInputElement;
    fireEvent.change(pathInput, { target: { value: '/opt/homebrew/bin/mongosh' } });

    fireEvent.click(screen.getByRole('button', { name: /test path/i }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('test_mongosh_path', { path: '/opt/homebrew/bin/mongosh' });
    });

    // Two "Save" buttons (mongosh + AI sections) both persist all settings.
    fireEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);
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
    render(<SettingsView density="cozy" onChangeDensity={() => {}} />);

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
    render(<SettingsView density="cozy" onChangeDensity={() => {}} />);

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
    render(<SettingsView density="cozy" onChangeDensity={() => {}} />);
    const toggle = await screen.findByTestId('sec-biometric-toggle');
    fireEvent.click(toggle);
    await waitFor(() => expect(mockBiometricEnable).toHaveBeenCalledTimes(1));
  });

  it('hides the biometric toggle when unavailable', async () => {
    mockBiometricStatus.mockResolvedValue({ available: false, biometryType: 0, enrolled: false });
    render(<SettingsView density="cozy" onChangeDensity={() => {}} />);
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

    render(<SettingsView density="cozy" onChangeDensity={() => {}} />);

    const select = await screen.findByTestId('ai-provider-select');

    // Cloud provider shows key + model.
    fireEvent.change(select, { target: { value: 'openai' } });
    expect(screen.getByTestId('openai-key-input')).toBeInTheDocument();
    expect(screen.getByTestId('openai-model-input')).toBeInTheDocument();

    // Local provider shows a command template + detection badge.
    fireEvent.change(select, { target: { value: 'claude-code' } });
    expect(screen.getByTestId('local-command-input')).toBeInTheDocument();
    expect(await screen.findByTestId('agent-availability')).toHaveTextContent(/installed/i);
  });
});
