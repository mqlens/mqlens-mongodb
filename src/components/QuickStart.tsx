import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { appConfigDir } from '@tauri-apps/api/path';
import {
  Plus,
  Download,
  Settings,
  ExternalLink,
  Search,
  FolderOpen,
  Database,
  Activity,
  Code2,
  Sparkles,
  BookOpen,
  ArrowRight,
} from 'lucide-react';
import brandMark from '../assets/mqlens-mark.png';
import type { ConnectionProfile } from '../lib/connection';
import { primaryShortcutModifier } from '../lib/quickStartUtils';
import { ConnectionCard } from './ConnectionCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

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

const QUICK_ACTIONS: {
  id: string;
  label: string;
  icon: typeof Plus;
  onClickKey: 'onConnect' | 'onLoadSampleData' | 'onOpenSettings';
  emptyOnly?: boolean;
}[] = [
  { id: 'connect', label: 'New connection', icon: Plus, onClickKey: 'onConnect' as const },
  { id: 'sample', label: 'Load sample data', icon: Download, onClickKey: 'onLoadSampleData' as const, emptyOnly: true },
  { id: 'settings', label: 'Settings', icon: Settings, onClickKey: 'onOpenSettings' },
];

export const QuickStart: React.FC<QuickStartProps> = ({
  onConnect,
  onOpenSettings,
  onQuickConnect,
  onLoadSampleData,
  activeConnections,
  profilesRefreshKey,
}) => {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string>('');

  useEffect(() => {
    appConfigDir().then(setDataDir).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    invoke<ConnectionProfile[]>('load_connection_profiles')
      .then((list) => {
        if (alive) setProfiles(list);
      })
      .catch(() => {
        if (alive) setProfiles([]);
      });
    return () => {
      alive = false;
    };
  }, [profilesRefreshKey]);

  const sorted = [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  const isEmpty = sorted.length === 0;
  const activeIds = new Set(activeConnections.map((c) => c.profileId));
  const activeCount = sorted.filter((p) => activeIds.has(p.id)).length;
  const modifier = primaryShortcutModifier();
  const shortcuts = [
    { keys: `${modifier} ↵`, label: 'Run the current query' },
    { keys: `${modifier} F`, label: 'Search the sidebar tree' },
    { keys: `${modifier} K`, label: 'Open command palette' },
    { keys: `${modifier} + / −`, label: 'Zoom interface in or out' },
  ] as const;

  const handleQuickConnect = async (p: ConnectionProfile) => {
    setConnectingId(p.id);
    try {
      await onQuickConnect(p);
    } finally {
      setConnectingId((id) => (id === p.id ? null : id));
    }
  };

  const actionHandlers = {
    onConnect,
    onOpenSettings,
    onLoadSampleData,
  };

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background"
      data-testid="quickstart-tab"
    >
      <header className="relative shrink-0 overflow-hidden border-b border-border bg-gradient-to-br from-primary/10 via-background to-background px-6 py-8 lg:px-10 lg:py-10">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <img
              src={brandMark}
              alt=""
              className="h-14 w-14 shrink-0 rounded-2xl shadow-sm ring-1 ring-border/60 lg:h-16 lg:w-16"
            />
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-primary">
                <Sparkles className="h-3.5 w-3.5" />
                Quick start
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground lg:text-3xl">
                Welcome to MQLens
              </h1>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground lg:text-base">
                Your local MongoDB IDE — connect to a cluster, explore collections, and run queries
                without leaving your machine.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-[140px] flex-1 items-center gap-3 rounded-xl border border-border/80 bg-card px-4 py-3 sm:flex-none">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Database className="h-5 w-5" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-2xl font-bold leading-none text-foreground">{sorted.length}</span>
                <span className="text-xs text-muted-foreground">Saved connections</span>
              </span>
            </div>
            <div className="flex min-w-[140px] flex-1 items-center gap-3 rounded-xl border border-border/80 bg-card px-4 py-3 sm:flex-none">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
                <Activity className="h-5 w-5" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-2xl font-bold leading-none text-foreground">{activeCount}</span>
                <span className="text-xs text-muted-foreground">Active now</span>
              </span>
            </div>
          </div>
        </div>

        <div className="relative mt-6 flex flex-wrap gap-2">
          <Button onClick={onConnect} className="gap-2">
            <Plus className="h-4 w-4" />
            New connection
          </Button>
          {isEmpty && (
            <Button variant="outline" onClick={onLoadSampleData} className="gap-2">
              <Download className="h-4 w-4" />
              Load sample data
            </Button>
          )}
          <Button variant="outline" onClick={onOpenSettings} className="gap-2">
            <Settings className="h-4 w-4" />
            Settings
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_20rem] 2xl:grid-cols-[minmax(0,1fr)_22rem]">
        <ScrollArea className="min-h-0 min-w-0">
          <div className="px-6 py-6 lg:px-10 lg:py-8">
            <section>
              <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">Saved connections</h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {isEmpty
                      ? 'Add your first cluster or try the built-in sample dataset.'
                      : 'Click a connection to open it in the workspace.'}
                  </p>
                </div>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={onConnect}>
                  Manage connections
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </div>

              {isEmpty ? (
                <Card className="border-dashed bg-muted/20">
                  <CardContent className="flex flex-col items-center px-6 py-14 text-center">
                    <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                      <Search className="h-6 w-6" />
                    </div>
                    <h3 className="text-base font-semibold text-foreground">No saved connections yet</h3>
                    <p className="mt-2 max-w-md text-sm text-muted-foreground">
                      Add a MongoDB cluster from Atlas or localhost, or load the sample dataset to
                      explore MQLens with demo collections.
                    </p>
                    <div className="mt-6 flex flex-wrap justify-center gap-2">
                      <Button onClick={onConnect} className="gap-2">
                        <Plus className="h-4 w-4" />
                        Add connection
                      </Button>
                      <Button
                        variant="outline"
                        onClick={onLoadSampleData}
                        data-testid="qs-load-sample"
                        className="gap-2"
                      >
                        <Download className="h-4 w-4" />
                        Load sample data
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-4">
                  {sorted.map((p) => (
                    <ConnectionCard
                      key={p.id}
                      profile={p}
                      connected={activeIds.has(p.id)}
                      connecting={connectingId === p.id}
                      onConnect={handleQuickConnect}
                    />
                  ))}
                  <button
                    type="button"
                    className="flex min-h-[168px] w-full cursor-pointer flex-col items-start justify-between gap-3 rounded-xl border border-dashed border-border bg-card/50 p-5 text-left transition-all hover:border-primary hover:bg-accent/40 hover:shadow-sm"
                    onClick={onConnect}
                  >
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Plus className="h-5 w-5" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold text-foreground">New connection</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Add another MongoDB cluster
                      </span>
                    </span>
                    <span className="flex items-center gap-1 text-xs font-medium text-primary">
                      Configure <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </button>
                </div>
              )}
            </section>
          </div>
        </ScrollArea>

        <aside className="hidden min-h-0 min-w-0 flex-col overflow-y-auto border-l border-border bg-sidebar/30 xl:flex">
          <div className="flex w-full flex-col gap-5 px-5 py-6 lg:px-6 lg:py-8">
              <Card className="w-full shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Quick actions</CardTitle>
                  <CardDescription>Common tasks from the home screen.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-1 pt-0">
                  {QUICK_ACTIONS.filter((a) => !a.emptyOnly || isEmpty).map(({ id, label, icon: Icon, onClickKey }) => (
                    <button
                      key={id}
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent cursor-pointer"
                      onClick={actionHandlers[onClickKey]}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1">{label}</span>
                    </button>
                  ))}
                  <Separator className="my-1" />
                  <a
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                    href={DOCS_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <BookOpen className="h-4 w-4 shrink-0 text-primary" />
                    Documentation
                  </a>
                  <a
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Code2 className="h-4 w-4 shrink-0 text-primary" />
                    GitHub
                  </a>
                </CardContent>
              </Card>

              <Card className="w-full shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Keyboard shortcuts</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 pt-0">
                  {shortcuts.map(({ keys, label }) => (
                    <div key={keys} className="flex items-start gap-2.5 text-xs text-muted-foreground">
                      <kbd className="mt-0.5 shrink-0 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[10px] text-foreground">
                        {keys}
                      </kbd>
                      <span className="min-w-0 flex-1 leading-snug">{label}</span>
                    </div>
                  ))}
                  <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
                    <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 leading-snug">
                      Open a collection for indexes &amp; explain plans
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card className="w-full shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Local storage</CardTitle>
                  <CardDescription>Everything stays on your machine.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <div className="rounded-lg border border-border bg-background/60 p-3">
                    <div className="text-[11px] font-medium text-muted-foreground">Data directory</div>
                    <div
                      className="mt-1 break-all font-mono text-[11px] leading-relaxed text-foreground"
                      title={dataDir}
                    >
                      {dataDir || '—'}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Saved connections</span>
                    <span className="font-semibold text-foreground">{sorted.length}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Active now</span>
                    <span className="font-semibold text-foreground">{activeCount}</span>
                  </div>
                </CardContent>
              </Card>
          </div>
        </aside>
      </div>
    </div>
  );
};
