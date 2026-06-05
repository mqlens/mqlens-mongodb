import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Plus, Download, Settings, ExternalLink, Search, FolderOpen, Database, Activity } from 'lucide-react';
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
  const [connectingId, setConnectingId] = useState<string | null>(null);

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
  const activeCount = sorted.filter((p) => activeIds.has(p.id)).length;

  const handleQuickConnect = async (p: ConnectionProfile) => {
    setConnectingId(p.id);
    try {
      await onQuickConnect(p);
    } finally {
      setConnectingId((id) => (id === p.id ? null : id));
    }
  };

  return (
    <div className="mql-quickstart" data-testid="quickstart-tab">
      <div className="mql-qs-page">
        {/* Hero panel: welcome + stats + quick actions */}
        <section className="mql-qs-panel mql-qs-hero-panel">
          <div className="mql-qs-hero-main">
            <div className="mql-qs-hero">
              <img src={brandMark} alt="" className="mql-qs-logo" />
              <div>
                <h1 className="mql-qs-title">Welcome to MQLens</h1>
                <p className="mql-qs-subtitle">Browse clusters, inspect indexes, and run queries.</p>
              </div>
            </div>

            <div className="mql-qs-stats">
              <div className="mql-qs-stat">
                <span className="mql-qs-stat-ico"><Database size={18} /></span>
                <span className="mql-qs-stat-body">
                  <span className="mql-qs-stat-num">{sorted.length}</span>
                  <span className="mql-qs-stat-label">Saved connections</span>
                </span>
              </div>
              <div className="mql-qs-stat">
                <span className="mql-qs-stat-ico"><Activity size={18} /></span>
                <span className="mql-qs-stat-body">
                  <span className="mql-qs-stat-num">{activeCount}</span>
                  <span className="mql-qs-stat-label">Active now</span>
                </span>
              </div>
            </div>
          </div>

          <div className="mql-qs-quick">
            <div className="mql-qs-quick-h">Quick actions</div>
            <button className="mql-qs-action" onClick={onConnect}>
              <Plus size={16} /> <span>New Connection</span>
            </button>
            {isEmpty && (
              <button className="mql-qs-action" data-testid="qs-load-sample" onClick={onLoadSampleData}>
                <Download size={16} /> <span>Load Sample Data</span>
              </button>
            )}
            <button className="mql-qs-action" onClick={onOpenSettings}>
              <Settings size={16} /> <span>Settings</span>
            </button>
            <a className="mql-qs-action" href={DOCS_URL} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> <span>Documentation</span>
            </a>
          </div>
        </section>

        {/* Saved connections panel */}
        <section className="mql-qs-panel">
          <div className="mql-qs-panel-head">
            <h2 className="mql-qs-h">Saved connections</h2>
            <button className="mql-qs-link" onClick={onConnect}>
              Manage <ExternalLink size={12} />
            </button>
          </div>

          {isEmpty ? (
            <div className="mql-qs-empty">
              <div className="mql-qs-empty-ico"><Search size={22} /></div>
              <div className="mql-qs-empty-title">No saved connections yet</div>
              <div className="mql-qs-empty-sub">
                Add a MongoDB cluster, or explore the built-in sample dataset from Quick actions.
              </div>
            </div>
          ) : (
            <div className="mql-qs-conns-grid">
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

        {/* Getting started panel */}
        <section className="mql-qs-panel mql-qs-start-panel">
          <div className="mql-qs-start-tips">
            <h2 className="mql-qs-h">Getting started</h2>
            <div className="mql-qs-tips">
              <div className="mql-qs-tip"><kbd className="mql-qs-kbd">⌘ ↵</kbd><span>Run the current query</span></div>
              <div className="mql-qs-tip"><kbd className="mql-qs-kbd">⌘ F</kbd><span>Search the sidebar tree</span></div>
              <div className="mql-qs-tip"><FolderOpen size={14} /><span>Open a collection for indexes &amp; plans</span></div>
            </div>
          </div>

          <a className="mql-qs-banner" href={DOCS_URL} target="_blank" rel="noreferrer">
            <div className="mql-qs-banner-kicker">MQLens</div>
            <div className="mql-qs-banner-title">Quick-start guide</div>
            <div className="mql-qs-banner-sub">Docs, tips &amp; keyboard shortcuts <ExternalLink size={12} /></div>
          </a>
        </section>
      </div>
    </div>
  );
};
