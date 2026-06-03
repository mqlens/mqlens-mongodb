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
});
