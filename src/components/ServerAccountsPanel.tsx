import React, { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogIn, LogOut, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { PasswordInput } from './PasswordInput';
import { useDialogs } from './dialogs/DialogProvider';
import {
  connectToServer,
  deleteServerAccount,
  listServerAccounts,
  listServerConnections,
  saveServerAccount,
  serverProfileId,
  signInToServer,
  signOutOfServer,
  type RemoteConnectionView,
  type ServerAccountInput,
  type ServerAccountView,
} from '@/lib/serverMode';

interface Props {
  /** A server connection is open under `id`; remember it by `profileId`. */
  onConnect: (id: string, name: string, profileId: string) => void;
}

const EMPTY: ServerAccountInput = { name: '', url: '', tenant: '', email: '', allowInsecureHttp: false, extraCaPem: null };

// MQLens Server accounts: add, sign in, and open one of a server's connections.
export const ServerAccountsPanel: React.FC<Props> = ({ onConnect }) => {
  const { t } = useTranslation('connections');
  const { confirm } = useDialogs();
  const [accounts, setAccounts] = useState<ServerAccountView[]>([]);
  const [remotes, setRemotes] = useState<Record<string, RemoteConnectionView[]>>({});
  const [form, setForm] = useState<ServerAccountInput | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadRemotes = useCallback(async (accountId: string) => {
    const list = await listServerConnections(accountId);
    setRemotes((prev) => ({ ...prev, [accountId]: list }));
  }, []);

  const refresh = useCallback(async () => {
    const list = await listServerAccounts();
    setAccounts(list);
    setRemotes({});
    await Promise.all(list.filter((a) => a.signedIn).map((a) => loadRemotes(a.id)));
  }, [loadRemotes]);

  useEffect(() => {
    refresh().catch((err) => setError(String(err)));
  }, [refresh]);

  const save = () =>
    run(async () => {
      if (!form) return;
      await saveServerAccount({ ...form, extraCaPem: form.extraCaPem?.trim() ? form.extraCaPem : null });
      setForm(null);
      await refresh();
    });

  const signIn = (account: ServerAccountView) =>
    run(async () => {
      const pw = password;
      setPassword('');
      const view = await signInToServer(account.id, pw);
      setSigningIn(null);
      setWarning(view.warning ?? null);
      setAccounts((prev) => prev.map((a) => (a.id === view.id ? view : a)));
      await loadRemotes(account.id);
    });

  const signOut = (account: ServerAccountView) =>
    run(async () => {
      const result = await signOutOfServer(account.id);
      setWarning(result.endedOnServer ? null : t('serverAccounts.signOutNotConfirmed'));
      await refresh();
    });

  const remove = async (account: ServerAccountView) => {
    const ok = await confirm({
      title: t('serverAccounts.deleteTitle'),
      message: t('serverAccounts.deleteMessage', { name: account.name }),
      confirmLabel: t('actions.delete'),
      destructive: true,
    });
    if (!ok) return;
    await run(async () => {
      await deleteServerAccount(account.id);
      await refresh();
    });
  };

  const connect = (account: ServerAccountView, remote: RemoteConnectionView) =>
    run(async () => {
      const result = await connectToServer(account.id, remote.id);
      onConnect(result.id, remote.name, serverProfileId(account.id, remote.id));
    });

  return (
    <section className="space-y-3" aria-label={t('serverAccounts.title')}>
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Server size={14} /> {t('serverAccounts.title')}
        </h3>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setForm({ ...EMPTY })}>
          <Plus size={13} /> {t('serverAccounts.add')}
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {warning && <p className="text-xs text-amber-600">{warning}</p>}
      {form && <AccountForm value={form} busy={busy} onChange={setForm} onSave={save} onCancel={() => setForm(null)} />}
      {accounts.length === 0 && !form && (
        <p className="text-xs text-muted-foreground">{t('serverAccounts.empty')}</p>
      )}
      <ul className="space-y-2">
        {accounts.map((account) => (
          <li key={account.id} className="rounded-md border p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{account.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {account.email} · {account.url}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {account.signedIn ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => signOut(account)}>
                    <LogOut size={13} /> {t('serverAccounts.signOut')}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPassword(''); setSigningIn(account.id); }}>
                    <LogIn size={13} /> {t('serverAccounts.signIn')}
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('serverAccounts.editAccount', { name: account.name })}
                  onClick={() => setForm({ ...account })}
                >
                  <Pencil size={13} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('serverAccounts.deleteAccount', { name: account.name })}
                  onClick={() => remove(account)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            </div>
            {signingIn === account.id && !account.signedIn && (
              <SignInRow
                password={password}
                busy={busy}
                accountName={account.name}
                onPassword={setPassword}
                onSubmit={() => signIn(account)}
                onCancel={() => { setPassword(''); setSigningIn(null); }}
              />
            )}
            {account.signedIn && (
              <ul className="mt-2 space-y-1">
                {(remotes[account.id] ?? []).map((remote) => (
                  <li key={remote.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{remote.name}</span>
                      {remote.opClasses.map((c) => (
                        <Badge key={c} variant="secondary" className="text-[10px]">{c}</Badge>
                      ))}
                    </span>
                    <Button
                      size="sm"
                      disabled={busy}
                      aria-label={t('serverAccounts.connectTo', { name: remote.name })}
                      onClick={() => connect(account, remote)}
                    >
                      {t('serverAccounts.connect')}
                    </Button>
                  </li>
                ))}
                {remotes[account.id]?.length === 0 && (
                  <li className="text-xs text-muted-foreground">{t('serverAccounts.noConnections')}</li>
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};

const SignInRow: React.FC<{
  password: string;
  busy: boolean;
  accountName: string;
  onPassword: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}> = ({ password, busy, accountName, onPassword, onSubmit, onCancel }) => {
  const { t } = useTranslation('connections');
  const id = useId();
  return (
    <form
      className="mt-2 flex items-end gap-2"
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
    >
      <div className="flex-1 space-y-1">
        <Label htmlFor={id} className="text-xs">{t('serverAccounts.password')}</Label>
        <PasswordInput id={id} autoFocus autoComplete="current-password" value={password} onChange={(e) => onPassword(e.target.value)} />
      </div>
      <Button type="submit" size="sm" disabled={busy || !password} aria-label={t('serverAccounts.signInTo', { name: accountName })}>
        {t('serverAccounts.signIn')}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t('common:cancel')}</Button>
    </form>
  );
};

const AccountForm: React.FC<{
  value: ServerAccountInput;
  busy: boolean;
  onChange: (v: ServerAccountInput) => void;
  onSave: () => void;
  onCancel: () => void;
}> = ({ value, busy, onChange, onSave, onCancel }) => {
  const { t } = useTranslation('connections');
  const id = useId();
  const field = (key: 'name' | 'url' | 'tenant' | 'email', label: string, placeholder?: string) => (
    <div className="space-y-1">
      <Label htmlFor={`${id}-${key}`} className="text-xs">{label}</Label>
      <Input
        id={`${id}-${key}`}
        value={value[key]}
        placeholder={placeholder}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      />
    </div>
  );
  const complete = value.name.trim() && value.url.trim() && value.tenant.trim() && value.email.trim();
  return (
    <form
      className="space-y-2 rounded-md border p-3"
      onSubmit={(e) => { e.preventDefault(); onSave(); }}
    >
      {field('name', t('serverAccounts.name'))}
      {field('url', t('serverAccounts.url'), 'https://mqlens.example.com')}
      {field('tenant', t('serverAccounts.tenant'))}
      {field('email', t('serverAccounts.email'))}
      <div className="flex items-center gap-2">
        <Switch
          id={`${id}-http`}
          checked={value.allowInsecureHttp}
          onCheckedChange={(checked) => onChange({ ...value, allowInsecureHttp: checked })}
        />
        <Label htmlFor={`${id}-http`} className="text-xs">{t('serverAccounts.allowInsecureHttp')}</Label>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-ca`} className="text-xs">{t('serverAccounts.extraCa')}</Label>
        <textarea
          id={`${id}-ca`}
          className="h-16 w-full rounded-md border bg-background p-2 font-mono text-xs"
          value={value.extraCaPem ?? ''}
          placeholder="-----BEGIN CERTIFICATE-----"
          onChange={(e) => onChange({ ...value, extraCaPem: e.target.value })}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t('common:cancel')}</Button>
        <Button type="submit" size="sm" disabled={busy || !complete}>{t('serverAccounts.save')}</Button>
      </div>
    </form>
  );
};
