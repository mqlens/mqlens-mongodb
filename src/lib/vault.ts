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

export interface BiometricStatus {
  available: boolean;
  biometryType: number; // 0=none, 1=auto, 2=TouchID, 3=FaceID
  enrolled: boolean;
}

export const biometricStatus = () => invoke<BiometricStatus>('biometric_status');
export const biometricEnable = () => invoke<void>('biometric_enable');
export const biometricUnlock = () => invoke<VaultStatus>('biometric_unlock');
export const biometricDisable = () => invoke<void>('biometric_disable');

export const VAULT_UNLOCKED_EVENT = 'mqlens-vault-unlocked';

export function notifyVaultUnlocked(): void {
  window.dispatchEvent(new Event(VAULT_UNLOCKED_EVENT));
}
