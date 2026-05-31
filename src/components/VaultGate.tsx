import React, { useEffect, useState } from 'react';
import {
  getVaultStatus,
  initializeVault,
  unlockVault,
  resetVault,
  type VaultStatus,
} from '../lib/vault';

interface VaultGateProps {
  children: React.ReactNode;
}

export const VaultGate: React.FC<VaultGateProps> = ({ children }) => {
  const [status, setStatus] = useState<VaultStatus | 'loading'>('loading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getVaultStatus().then(setStatus).catch((e) => setError(String(e)));
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
        <input
          type="password"
          data-testid="vault-password"
          placeholder="Master password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !isSetup && submit()}
        />
        {isSetup && (
          <input
            type="password"
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
        {!isSetup && (
          <button type="button" className="mql-vault-link" data-testid="vault-reset-btn" onClick={doReset}>
            Forgot password? Reset (deletes all saved credentials)
          </button>
        )}
      </div>
    </div>
  );
};
