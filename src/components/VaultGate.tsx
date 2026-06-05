import React, { useEffect, useState } from 'react';
import { PasswordInput } from './PasswordInput';
import {
  getVaultStatus,
  initializeVault,
  unlockVault,
  resetVault,
  biometricStatus,
  biometricUnlock,
  type VaultStatus,
  type BiometricStatus,
} from '../lib/vault';

function biometryLabel(type: number): string {
  if (type === 2) return 'Use Touch ID';
  if (type === 3) return 'Use Face ID';
  return 'Use biometrics';
}

interface VaultGateProps {
  children: React.ReactNode;
}

export const VaultGate: React.FC<VaultGateProps> = ({ children }) => {
  const [status, setStatus] = useState<VaultStatus | 'loading'>('loading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bio, setBio] = useState<BiometricStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getVaultStatus();
        if (cancelled) return;
        setStatus(s);
        if (s === 'locked') {
          // Biometrics may be unavailable on this device; fall back to the password form.
          const b = await biometricStatus().catch(() => null);
          if (cancelled || !b) return;
          setBio(b);
          if (b.available && b.enrolled) {
            try {
              const next = await biometricUnlock();
              if (!cancelled) setStatus(next);
            } catch {
              // Cancelled or stale key: silently stay on the password form.
            }
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'loading') {
    return <div className="mql-vault-loading" data-testid="vault-loading">Loading…</div>;
  }
  if (status === 'unlocked') {
    return <>{children}</>;
  }

  const isSetup = status === 'uninitialized';

  const submit = async () => {
    setError('');
    if (!password) {
      setError('Master password is required');
      return;
    }
    if (isSetup && password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      if (isSetup) {
        await initializeVault(password);
        setStatus('unlocked');
      } else {
        const next = await unlockVault(password);
        setStatus(next);
      }
      setPassword('');
      setConfirm('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const tryBiometric = async () => {
    setError('');
    try {
      const next = await biometricUnlock();
      setStatus(next);
    } catch (e) {
      setError(String(e));
    }
  };

  const doReset = async () => {
    if (!window.confirm('Reset deletes ALL saved connections and API keys. Continue?')) return;
    setError('');
    try {
      await resetVault();
      setStatus('uninitialized');
      setPassword('');
      setConfirm('');
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="mql-vault-gate" data-testid={isSetup ? 'vault-setup' : 'vault-unlock'}>
      <div className="mql-vault-card">
        <h2>{isSetup ? 'Create a master password' : 'Unlock MQLens'}</h2>
        <p className="mql-vault-copy">
          {isSetup
            ? 'Your saved connections and API keys are encrypted with this password. There is no recovery if you forget it.'
            : 'Enter your master password to decrypt your saved credentials.'}
        </p>
        <PasswordInput
          data-testid="vault-password"
          placeholder="Master password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !isSetup && submit()}
        />
        {isSetup && (
          <PasswordInput
            data-testid="vault-confirm"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
        {error && (
          <div className="mql-vault-error" data-testid="vault-error">
            {error}
          </div>
        )}
        <button
          type="button"
          data-testid={isSetup ? 'vault-setup-btn' : 'vault-unlock-btn'}
          disabled={busy}
          onClick={submit}
        >
          {isSetup ? 'Create & unlock' : 'Unlock'}
        </button>
        {!isSetup && bio?.available && bio?.enrolled && (
          <button
            type="button"
            className="mql-vault-link"
            data-testid="vault-biometric-btn"
            onClick={tryBiometric}
          >
            {biometryLabel(bio.biometryType)}
          </button>
        )}
        {!isSetup && (
          <button type="button" className="mql-vault-link" data-testid="vault-reset-btn" onClick={doReset}>
            Forgot password? Reset (deletes all saved credentials)
          </button>
        )}
      </div>
    </div>
  );
};
