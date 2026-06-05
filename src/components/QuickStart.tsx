import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { Plus, Download, Settings, ExternalLink, Search, FolderOpen } from 'lucide-react';
import logoMark from '../assets/logo-mark.svg';
import type { ConnectionProfile } from '../lib/connection';
import { ConnectionCard } from './ConnectionCard';

interface QuickStartProps {
  onConnect: () => void;
  onOpenSettings: () => void;
  onQuickConnect: (profile: ConnectionProfile) => Promise<void>;
  onLoadSampleData: () => void;
  activeConnections: { profileId: string }[];
  /** Bumped by App after the connection manager adds/removes a profile, to force a reload. */
  profilesRefreshKey: number;
}

const DOCS_URL = 'https://github.com/mqlens/mqlens';

export const QuickStart: React.FC<QuickStartProps> = ({
  onConnect, onOpenSettings, onQuickConnect, onLoadSampleData, activeConnections, profilesRefreshKey,
}) => {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [version, setVersion] = useState<string>('');
  const [connectingId, setConnectingId] = useState<string | null>(null);

  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);

  useEffect(() => {
    let alive = true;
    invoke<ConnectionProfile[]>('load_connection_profiles')
      .then((list) => { if (alive) setProfiles(list); })
      .catch(() => { if (alive) setProfiles([]); });
    return () => { alive = false; };
  }, [profilesRefreshKey]);

  const sorted = [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  const isEmpty = sorted.length === 0;
  const activeIds = new Set(activeConnections.map((c) => c.profileId));

  const handleQuickConnect = async (p: ConnectionProfile) => {
    setConnectingId(p.id);
    try {
      await onQuickConnect(p);
    } finally {
      // On success the card becomes `connected` via activeConnections; on failure
      // this clears the spinner immediately instead of leaving it stuck.
      setConnectingId((id) => (id === p.id ? null : id));
    }
  };

  return (
    <div className="mql-quickstart" data-testid="quickstart-tab">
      <div className="mql-qs-grid">
        {/* Left rail */}
        <aside className="mql-qs-rail">
          <div className="mql-qs-brand">
            <img src={logoMark} alt="" className="mql-qs-logo" />
            <div>
              <div className="mql-qs-brand-name">MQLens</div>
              {version && <div className="mql-qs-brand-ver">v{version}</div>}
            </div>
          </div>
          <p className="mql-qs-tagline">
            Browse clusters, inspect indexes, run queries.
          </p>

          <button className="mql-qs-btn is-primary" onClick={onConnect}>
            <Plus size={14} /> New Connection
          </button>
          {isEmpty && (
            <button className="mql-qs-btn is-ghost" data-testid="qs-load-sample" onClick={onLoadSampleData}>
              <Download size={14} /> Load Sample Data
            </button>
          )}

          <div className="mql-qs-rail-section">
            <div className="mql-qs-label">Tips &amp; shortcuts</div>
            <div className="mql-qs-tip"><kbd className="mql-qs-kbd">⌘ ↵</kbd><span>Run the current query</span></div>
            <div className="mql-qs-tip"><kbd className="mql-qs-kbd">⌘ F</kbd><span>Search the sidebar tree</span></div>
            <div className="mql-qs-tip"><FolderOpen size={13} /><span>Open a collection for indexes &amp; plans</span></div>
          </div>

          <div className="mql-qs-rail-links">
            <a className="mql-qs-link" href={DOCS_URL} target="_blank" rel="noreferrer">
              Docs <ExternalLink size={11} />
            </a>
            <button className="mql-qs-link" onClick={onOpenSettings}>
              <Settings size={11} /> Settings
            </button>
          </div>
        </aside>

        {/* Right column */}
        <section className="mql-qs-conns">
          <div className="mql-qs-conns-head">
            <span className="mql-qs-label">Saved connections</span>
            {!isEmpty && <span className="mql-qs-count">{sorted.length} saved</span>}
          </div>

          {isEmpty ? (
            <div className="mql-qs-empty">
              <div className="mql-qs-empty-ico"><Search size={22} /></div>
              <div className="mql-qs-empty-title">No saved connections yet</div>
              <div className="mql-qs-empty-sub">
                Add a MongoDB cluster, or explore the built-in sample dataset — both are on the left.
              </div>
            </div>
          ) : (
            <div className="mql-qs-conns-list">
              {sorted.map((p) => (
                <ConnectionCard
                  key={p.id}
                  profile={p}
                  connected={activeIds.has(p.id)}
                  connecting={connectingId === p.id}
                  onConnect={handleQuickConnect}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
