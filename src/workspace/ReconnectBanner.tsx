// Rendered by App.tsx's renderTabContent INSTEAD of a tab's normal content
// whenever its connectionId is still in `profile:<profileId>` space — i.e. a
// tab restored from a session-restore snapshot (see persistence.ts /
// toDisconnectedSnapshot) whose connection hasn't been re-established yet.

import React from 'react';
import { Loader2, PlugZap } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ReconnectBannerProps {
  profileName: string;
  /** db[.collection[.indexName]] the disconnected tab points at, for context
   *  when several disconnected tabs share the same profile. */
  namespace: string;
  onReconnect: () => void;
  busy: boolean;
  /** Last reconnect failure for this tab's profile (missing profile, vault
   *  locked, connect_db failure) — surfaced verbatim from the invoke error. */
  error?: string | null;
}

export const ReconnectBanner: React.FC<ReconnectBannerProps> = ({
  profileName,
  namespace,
  onReconnect,
  busy,
  error,
}) => (
  <div
    className="flex h-full flex-col items-center justify-center gap-3 bg-background p-8 text-center"
    data-testid="reconnect-banner"
  >
    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
      <PlugZap size={20} className="text-muted-foreground" />
    </div>
    <div>
      <p className="text-sm font-medium text-foreground">Disconnected</p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">
        {namespace ? <>{namespace} was</> : 'This tab was'} restored from your last session.
        Reconnect to {profileName} to load it.
      </p>
    </div>
    <Button onClick={onReconnect} disabled={busy} size="sm">
      {busy ? (
        <Loader2 size={14} className="mr-1.5 animate-spin" />
      ) : (
        <PlugZap size={14} className="mr-1.5" />
      )}
      Reconnect {profileName}
    </Button>
    {error && (
      <p className="max-w-xs text-ui-2xs text-destructive" data-testid="reconnect-error">
        {error}
      </p>
    )}
  </div>
);
