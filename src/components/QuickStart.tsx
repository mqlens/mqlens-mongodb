import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { appConfigDir } from '@tauri-apps/api/path';
import { Plus, Download, Settings, ExternalLink, Search, FolderOpen, Database, Activity, Code2 } from 'lucide-react';
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

const DOCS_URL = 'https://mqlens.com';
const GITHUB_URL = 'https://github.com/mqlens/mqlens-mongodb';

export const QuickStart: React.FC<QuickStartProps> = ({
  onConnect, onOpenSettings, onQuickConnect, onLoadSampleData, activeConnections, profilesRefreshKey,
}) => {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string>('');

  useEffect(() => { appConfigDir().then(setDataDir).catch(() => {}); }, []);

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
        {/* ---------- Main column ---------- */}
        <div className="mql-qs-main">
          {/* Hero + stats */}
          <section className="mql-qs-panel mql-qs-hero-panel">
            <div className="mql-qs-hero">
              <img src={brandMark} alt="" className="mql-qs-logo" />
              <div>
                <h1 className="mql-qs-title">Welcome to MQLens</h1>
                <p className="mql-qs-subtitle">Your local MongoDB IDE. Fast, private, and powerful.</p>
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
          </section>

          {/* Saved connections */}
          <section className="mql-qs-panel">
            <div className="mql-qs-panel-head">
              <h2 className="mql-qs-h">Saved connections</h2>
              <button className="mql-qs-link" onClick={onConnect}>Manage <ExternalLink size={12} /></button>
            </div>

            {isEmpty ? (
              <div className="mql-qs-empty">
                <div className="mql-qs-empty-ico"><Search size={22} /></div>
                <div className="mql-qs-empty-title">No saved connections yet</div>
                <div className="mql-qs-empty-sub">
                  Add a MongoDB cluster, or explore the built-in sample dataset from Quick start.
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
                <button className="mql-qs-card mql-qs-card-add" onClick={onConnect}>
                  <span className="mql-qs-add-ico"><Plus size={20} /></span>
                  <span className="mql-qs-add-label">New connection</span>
                  <span className="mql-qs-card-foot">Add a MongoDB connection</span>
                </button>
              </div>
            )}
          </section>
        </div>

        {/* ---------- Sidebar ---------- */}
        <aside className="mql-qs-side">
          {/* Quick start actions */}
          <section className="mql-qs-panel">
            <h2 className="mql-qs-h">Quick start</h2>
            <div className="mql-qs-actions">
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
              <a className="mql-qs-action" href={GITHUB_URL} target="_blank" rel="noreferrer">
                <Code2 size={16} /> <span>GitHub</span>
              </a>
            </div>
          </section>

          {/* Tips */}
          <section className="mql-qs-panel">
            <h2 className="mql-qs-h">Tips &amp; shortcuts</h2>
            <div className="mql-qs-tips">
              <div className="mql-qs-tip"><kbd className="mql-qs-kbd">⌘ ↵</kbd><span>Run the current query</span></div>
              <div className="mql-qs-tip"><kbd className="mql-qs-kbd">⌘ F</kbd><span>Search the sidebar tree</span></div>
              <div className="mql-qs-tip"><FolderOpen size={14} /><span>Open a collection for indexes &amp; plans</span></div>
            </div>
          </section>

          {/* Local storage */}
          <section className="mql-qs-panel">
            <h2 className="mql-qs-h">Local storage</h2>
            <p className="mql-qs-muted">MQLens stores everything locally on your machine.</p>
            <div className="mql-qs-store">
              <div className="mql-qs-store-row">
                <FolderOpen size={15} />
                <div className="mql-qs-store-body">
                  <div className="mql-qs-store-k">Data directory</div>
                  <div className="mql-qs-store-path" title={dataDir}>{dataDir || '—'}</div>
                </div>
              </div>
              <div className="mql-qs-store-row">
                <Database size={15} />
                <div className="mql-qs-store-body"><div className="mql-qs-store-k">Saved connections</div></div>
                <span className="mql-qs-store-v">{sorted.length}</span>
              </div>
              <div className="mql-qs-store-row">
                <Activity size={15} />
                <div className="mql-qs-store-body"><div className="mql-qs-store-k">Active now</div></div>
                <span className="mql-qs-store-v">{activeCount}</span>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
};
