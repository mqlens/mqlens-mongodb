import React from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import type { ConnectionProfile } from '../lib/connection';
import { hostFromUri, avatarColor, initial } from '../lib/quickStartUtils';

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
  const interactive = !connected && !connecting;

  return (
    <button
      type="button"
      data-testid={`conn-card-${profile.id}`}
      className={`mql-qs-card ${connected ? 'is-connected' : ''}`}
      disabled={!interactive}
      onClick={() => onConnect(profile)}
      title={connected ? 'Already connected' : `Connect to ${profile.name}`}
      aria-label={connected ? `${profile.name} – already connected` : `Connect to ${profile.name}`}
    >
      <span className="mql-qs-card-av" style={{ background: avatarColor(profile.name) }}>
        {initial(profile.name)}
      </span>
      <span className="mql-qs-card-main">
        <span className="mql-qs-card-name">
          {profile.name}
          {connected && <span className="mql-qs-badge is-live">Connected</span>}
          {isSrv && <span className="mql-qs-badge is-srv" title="MongoDB SRV record">SRV</span>}
          {hasSsh && <span className="mql-qs-badge is-ssh">SSH</span>}
        </span>
        <span className="mql-qs-card-host">{host}</span>
      </span>
      {connecting && !connected
        ? <Loader2 size={14} className="mql-qs-spin" />
        : !connected && <ChevronRight size={14} className="mql-qs-card-go" />}
    </button>
  );
};
