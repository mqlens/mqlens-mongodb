import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { Plus, Download, Settings, ExternalLink, Search, FolderOpen } from 'lucide-react';
import brandMark from '../assets/mqlens-mark.png';
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
      <div className="mql-qs-page">
        {/* Hero */}
        <header className="mql-qs-hero">
          <img src={brandMark} alt="" className="mql-qs-logo" />
          <div>
            <h1 className="mql-qs-title">Welcome to MQLens</h1>
            <p className="mql-qs-subtitle">
              Browse clusters, inspect indexes, and run queries{version ? ` · v${version}` : ''}.
            </p>
          </div>
        </header>

        <div className="mql-qs-cols">
          {/* Left: connections */}
          <section className="mql-qs-col">
            <div className="mql-qs-conns-head">
              <h2 className="mql-qs-h">Saved connections</h2>
              {!isEmpty && <span className="mql-qs-count">{sorted.length} saved</span>}
            </div>
            <p className="mql-qs-coldesc">Reconnect to a saved cluster, or add a new one.</p>

            {isEmpty ? (
              <div className="mql-qs-empty">
                <div className="mql-qs-empty-ico"><Search size={22} /></div>
                <div className="mql-qs-empty-title">No saved connections yet</div>
                <div className="mql-qs-empty-sub">
                  Add a MongoDB cluster, or explore the built-in sample dataset.
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

            <div className="mql-qs-actions-list">
              <button className="mql-qs-action" onClick={onConnect}>
                <Plus size={16} /> <span>New Connection</span>
              </button>
              {isEmpty && (
                <button className="mql-qs-action" data-testid="qs-load-sample" onClick={onLoadSampleData}>
                  <Download size={16} /> <span>Load Sample Data</span>
                </button>
              )}
            </div>
          </section>

          {/* Right: getting started */}
          <aside className="mql-qs-col">
            <h2 className="mql-qs-h">Getting started</h2>
            <div className="mql-qs-tips">
              <div className="mql-qs-tip"><kbd className="mql-qs-kbd">⌘ ↵</kbd><span>Run the current query</span></div>
              <div className="mql-qs-tip"><kbd className="mql-qs-kbd">⌘ F</kbd><span>Search the sidebar tree</span></div>
              <div className="mql-qs-tip"><FolderOpen size={14} /><span>Open a collection for indexes &amp; plans</span></div>
            </div>

            <a className="mql-qs-banner" href={DOCS_URL} target="_blank" rel="noreferrer">
              <div className="mql-qs-banner-kicker">MQLens</div>
              <div className="mql-qs-banner-title">Quick-start guide</div>
              <div className="mql-qs-banner-sub">Docs, tips &amp; keyboard shortcuts <ExternalLink size={12} /></div>
            </a>

            <button className="mql-qs-action" onClick={onOpenSettings}>
              <Settings size={16} /> <span>Settings</span>
            </button>
          </aside>
        </div>
      </div>
    </div>
  );
};
