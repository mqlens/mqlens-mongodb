import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VaultGate } from '../VaultGate';

vi.mock('../../lib/vault', () => ({
  getVaultStatus: vi.fn(),
  initializeVault: vi.fn(),
  unlockVault: vi.fn(),
  resetVault: vi.fn(),
  biometricStatus: vi.fn(),
  biometricUnlock: vi.fn(),
  biometricEnable: vi.fn(),
  notifyVaultUnlocked: vi.fn(),
}));
import * as vault from '../../lib/vault';

describe('VaultGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vault.biometricStatus as any).mockResolvedValue({
      available: false,
      biometryType: 0,
      enrolled: false,
    });
  });

  it('shows the setup form when uninitialized', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('uninitialized');
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);
    expect(await screen.findByTestId('vault-setup')).toBeInTheDocument();
    expect(screen.queryByText('WORKSPACE')).not.toBeInTheDocument();
  });

  it('renders children once unlocked', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('unlocked');
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);
    expect(await screen.findByText('WORKSPACE')).toBeInTheDocument();
  });

  it('shows an inline error on wrong password', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('locked');
    (vault.unlockVault as any).mockRejectedValue('incorrect master password');
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);
    fireEvent.change(await screen.findByTestId('vault-password'), {
      target: { value: 'nope' },
    });
    fireEvent.click(screen.getByTestId('vault-unlock-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('vault-error')).toHaveTextContent('incorrect master password'),
    );
  });

  it('auto-unlocks with biometrics when enrolled', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('locked');
    (vault.biometricStatus as any).mockResolvedValue({
      available: true,
      biometryType: 2,
      enrolled: true,
    });
    (vault.biometricUnlock as any).mockResolvedValue('unlocked');
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);
    expect(await screen.findByText('WORKSPACE')).toBeInTheDocument();
    expect(vault.biometricUnlock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the password form when biometrics are cancelled', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('locked');
    (vault.biometricStatus as any).mockResolvedValue({
      available: true,
      biometryType: 2,
      enrolled: true,
    });
    (vault.biometricUnlock as any).mockRejectedValue('User cancelled');
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);
    expect(await screen.findByTestId('vault-unlock')).toBeInTheDocument();
    expect(screen.getByTestId('vault-biometric-btn')).toBeInTheDocument();
  });

  it('hides the biometric button when unavailable', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('locked');
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);
    await screen.findByTestId('vault-unlock');
    expect(screen.queryByTestId('vault-biometric-btn')).not.toBeInTheDocument();
  });

  it('requires confirmation before allowing a locked recovery reset', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('locked');
    (vault.resetVault as any).mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);

    fireEvent.click(await screen.findByTestId('vault-reset-btn'));

    await waitFor(() => expect(vault.resetVault).toHaveBeenCalledWith(true));
    confirm.mockRestore();
  });

  it('shows the reset warning and moves to setup when a session may remain active', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('locked');
    (vault.resetVault as any).mockResolvedValue(
      'Vault reset completed, but one MQLens Server session may still be active.',
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);

    fireEvent.click(await screen.findByTestId('vault-reset-btn'));

    expect(await screen.findByTestId('vault-setup')).toBeInTheDocument();
    expect(await screen.findByTestId('vault-error')).toHaveTextContent(
      'one MQLens Server session may still be active',
    );
    confirm.mockRestore();
  });

  it('unlocks when the biometric retry button is clicked', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('locked');
    (vault.biometricStatus as any).mockResolvedValue({
      available: true,
      biometryType: 2,
      enrolled: true,
    });
    // Auto-prompt is cancelled; the user then clicks the retry button, which succeeds.
    (vault.biometricUnlock as any)
      .mockRejectedValueOnce('User cancelled')
      .mockResolvedValueOnce('unlocked');
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);
    const btn = await screen.findByTestId('vault-biometric-btn');
    fireEvent.click(btn);
    expect(await screen.findByText('WORKSPACE')).toBeInTheDocument();
    expect(vault.biometricUnlock).toHaveBeenCalledTimes(2);
  });

  it('submits the setup form when Enter is pressed in either field', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('uninitialized');
    (vault.initializeVault as any).mockResolvedValue(undefined);
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);
    fireEvent.change(await screen.findByTestId('vault-password'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByTestId('vault-confirm'), { target: { value: 'pw' } });
    fireEvent.keyDown(screen.getByTestId('vault-confirm'), { key: 'Enter' });
    expect(await screen.findByText('WORKSPACE')).toBeInTheDocument();
    expect(vault.initializeVault).toHaveBeenCalledWith('pw');
  });

  it('focuses the master password field', async () => {
    (vault.getVaultStatus as any).mockResolvedValue('uninitialized');
    render(<VaultGate><div>WORKSPACE</div></VaultGate>);
    await waitFor(() => expect(screen.getByTestId('vault-password')).toHaveFocus());
  });

  describe('biometric offer after setup', () => {
    const setUp = async () => {
      (vault.getVaultStatus as any).mockResolvedValue('uninitialized');
      (vault.initializeVault as any).mockResolvedValue(undefined);
      render(<VaultGate><div>WORKSPACE</div></VaultGate>);
      fireEvent.change(await screen.findByTestId('vault-password'), { target: { value: 'pw' } });
      fireEvent.change(screen.getByTestId('vault-confirm'), { target: { value: 'pw' } });
      fireEvent.click(screen.getByTestId('vault-setup-btn'));
    };

    it('offers biometric unlock when the device has it, and turns it on', async () => {
      (vault.biometricStatus as any).mockResolvedValue({ available: true, biometryType: 1, enrolled: false });
      (vault.biometricEnable as any).mockResolvedValue(undefined);
      await setUp();
      expect(await screen.findByTestId('vault-biometric-offer')).toBeInTheDocument();
      expect(screen.queryByText('WORKSPACE')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('vault-biometric-enable'));
      expect(await screen.findByText('WORKSPACE')).toBeInTheDocument();
      expect(vault.biometricEnable).toHaveBeenCalledTimes(1);
    });

    it('lets the user skip the offer', async () => {
      (vault.biometricStatus as any).mockResolvedValue({ available: true, biometryType: 2, enrolled: false });
      await setUp();
      fireEvent.click(await screen.findByTestId('vault-biometric-skip'));
      expect(await screen.findByText('WORKSPACE')).toBeInTheDocument();
      expect(vault.biometricEnable).not.toHaveBeenCalled();
    });

    it('keeps the offer open with the error when turning it on fails', async () => {
      (vault.biometricStatus as any).mockResolvedValue({ available: true, biometryType: 1, enrolled: false });
      (vault.biometricEnable as any).mockRejectedValue('Windows Hello was cancelled');
      await setUp();
      fireEvent.click(await screen.findByTestId('vault-biometric-enable'));
      expect(await screen.findByTestId('vault-error')).toHaveTextContent('Windows Hello was cancelled');
      expect(screen.getByTestId('vault-biometric-offer')).toBeInTheDocument();
    });

    it('goes straight in when the device has no biometrics', async () => {
      await setUp();
      expect(await screen.findByText('WORKSPACE')).toBeInTheDocument();
      expect(screen.queryByTestId('vault-biometric-offer')).not.toBeInTheDocument();
    });
  });
});
