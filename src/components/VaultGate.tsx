import React, { useEffect, useState } from 'react';
import { PasswordInput } from './PasswordInput';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  getVaultStatus,
  initializeVault,
  unlockVault,
  resetVault,
  biometricStatus,
  biometricUnlock,
  notifyVaultUnlocked,
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

  useEffect(() => {
    if (status === 'unlocked') {
      notifyVaultUnlocked();
    }
  }, [status]);

  if (status === 'loading') {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-background text-muted-foreground"
        data-testid="vault-loading"
      >
        Loading…
      </div>
    );
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
    <div
      className="flex min-h-screen items-center justify-center bg-background p-4"
      data-testid={isSetup ? 'vault-setup' : 'vault-unlock'}
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{isSetup ? 'Create a master password' : 'Unlock MQLens'}</CardTitle>
          <CardDescription>
            {isSetup
              ? 'Your saved connections and API keys are encrypted with this password. There is no recovery if you forget it.'
              : 'Enter your master password to decrypt your saved credentials.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
            <div className="text-sm text-destructive" data-testid="vault-error">
              {error}
            </div>
          )}
          <Button
            type="button"
            className="w-full"
            data-testid={isSetup ? 'vault-setup-btn' : 'vault-unlock-btn'}
            disabled={busy}
            onClick={submit}
          >
            {isSetup ? 'Create & unlock' : 'Unlock'}
          </Button>
          {!isSetup && bio?.available && bio?.enrolled && (
            <Button
              type="button"
              variant="link"
              className="h-auto w-full p-0 text-sm"
              data-testid="vault-biometric-btn"
              onClick={tryBiometric}
            >
              {biometryLabel(bio.biometryType)}
            </Button>
          )}
          {!isSetup && (
            <Button
              type="button"
              variant="link"
              className="h-auto w-full p-0 text-sm text-muted-foreground"
              data-testid="vault-reset-btn"
              onClick={doReset}
            >
              Forgot password? Reset (deletes all saved credentials)
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
