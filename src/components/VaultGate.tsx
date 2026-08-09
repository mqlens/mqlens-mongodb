import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

// Takes `t` as a parameter rather than calling useTranslation itself — this is
// a module-level helper (not a component), so it can't call hooks directly.
function biometryLabel(t: (key: string) => string, type: number): string {
  if (type === 2) return t('shell:vaultGate.biometry.touchId');
  if (type === 3) return t('shell:vaultGate.biometry.faceId');
  return t('shell:vaultGate.biometry.generic');
}

interface VaultGateProps {
  children: React.ReactNode;
}

export const VaultGate: React.FC<VaultGateProps> = ({ children }) => {
  const { t } = useTranslation('shell');
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
        {t('vaultGate.loading')}
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
      setError(t('vaultGate.errors.passwordRequired'));
      return;
    }
    if (isSetup && password !== confirm) {
      setError(t('vaultGate.errors.passwordMismatch'));
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
    if (!window.confirm(t('vaultGate.confirmReset'))) return;
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
          <CardTitle>{isSetup ? t('vaultGate.titles.setup') : t('vaultGate.titles.unlock')}</CardTitle>
          <CardDescription>
            {isSetup ? t('vaultGate.descriptions.setup') : t('vaultGate.descriptions.unlock')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <PasswordInput
            data-testid="vault-password"
            placeholder={t('vaultGate.placeholders.masterPassword')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isSetup && submit()}
          />
          {isSetup && (
            <PasswordInput
              data-testid="vault-confirm"
              placeholder={t('vaultGate.placeholders.confirmPassword')}
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
            {isSetup ? t('vaultGate.actions.setup') : t('vaultGate.actions.unlock')}
          </Button>
          {!isSetup && bio?.available && bio?.enrolled && (
            <Button
              type="button"
              variant="link"
              className="h-auto w-full p-0 text-sm"
              data-testid="vault-biometric-btn"
              onClick={tryBiometric}
            >
              {biometryLabel(t, bio.biometryType)}
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
              {t('vaultGate.actions.resetLink')}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
