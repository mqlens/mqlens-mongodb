import React from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ConnectionProfile } from '../lib/connection';
import { hostFromUri, avatarColor, initial, topology } from '../lib/quickStartUtils';

interface ConnectionCardProps {
  profile: ConnectionProfile;
  connected: boolean;
  connecting: boolean;
  onConnect: (profile: ConnectionProfile) => void;
}

export const ConnectionCard: React.FC<ConnectionCardProps> = ({ profile, connected, connecting, onConnect }) => {
  const isSrv = /^mongodb\+srv:\/\//i.test(profile.uri);
  const hasSsh = !!profile.ssh?.enabled;
  const host = hostFromUri(profile.uri);
  const topo = topology(profile.uri);
  const interactive = !connected && !connecting;

  return (
    <Card
      className={cn(
        'overflow-hidden transition-colors',
        connected && 'border-success/40 bg-success/5',
        interactive && 'hover:border-primary/50 hover:shadow-sm'
      )}
    >
      <Button
        type="button"
        variant="ghost"
        data-testid={`conn-card-${profile.id}`}
        disabled={!interactive}
        onClick={() => onConnect(profile)}
        title={connected ? 'Already connected' : `Connect to ${profile.name}`}
        aria-label={connected ? `${profile.name} – already connected` : `Connect to ${profile.name}`}
        className="h-auto w-full flex-col items-stretch gap-0 rounded-none p-0 text-left font-normal hover:bg-transparent"
      >
        <div className="flex w-full items-start gap-3 p-4 pb-2">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold text-primary-foreground"
            style={{ background: avatarColor(profile.name) }}
          >
            {initial(profile.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate font-medium text-foreground">{profile.name}</span>
              {isSrv && <Badge variant="outline" title="MongoDB SRV record">SRV</Badge>}
              {hasSsh && <Badge variant="secondary">SSH</Badge>}
            </div>
            <div className="mt-0.5">
              {connected ? (
                <Badge variant="success">Connected</Badge>
              ) : (
                <span className="text-xs text-muted-foreground">{topo}</span>
              )}
            </div>
          </div>
        </div>

        <p className="w-full truncate px-4 font-mono text-xs text-muted-foreground">{host}</p>

        <div className="flex w-full items-center px-4 pb-4 pt-2 text-xs">
          {connecting ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 size={13} className="animate-spin" /> Connecting…
            </span>
          ) : interactive ? (
            <span className="flex items-center gap-0.5 text-primary">
              Connect <ChevronRight size={14} />
            </span>
          ) : null}
        </div>
      </Button>
    </Card>
  );
};
