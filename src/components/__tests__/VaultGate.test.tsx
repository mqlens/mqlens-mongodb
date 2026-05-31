import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VaultGate } from '../VaultGate';

vi.mock('../../lib/vault', () => ({
  getVaultStatus: vi.fn(),
  initializeVault: vi.fn(),
  unlockVault: vi.fn(),
  resetVault: vi.fn(),
}));
import * as vault from '../../lib/vault';

describe('VaultGate', () => {
  beforeEach(() => vi.clearAllMocks());

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
});
