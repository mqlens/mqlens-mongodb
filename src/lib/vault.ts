import { invoke } from '@tauri-apps/api/core';

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

export const getVaultStatus = () => invoke<VaultStatus>('vault_status');
export const initializeVault = (password: string) =>
  invoke<void>('vault_initialize', { password });
export const unlockVault = (password: string) =>
  invoke<VaultStatus>('vault_unlock', { password });
export const lockVault = () => invoke<void>('vault_lock');
export const changeVaultPassword = (oldPassword: string, newPassword: string) =>
  invoke<void>('vault_change_password', { oldPassword, newPassword });
export const resetVault = () => invoke<void>('vault_reset');
