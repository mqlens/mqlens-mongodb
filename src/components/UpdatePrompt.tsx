import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
import { Download, X, RefreshCw, CheckCircle2, AlertTriangle, ArrowUpCircle } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useEscapeClose } from '../lib/useEscapeClose';

export const CHECK_UPDATE_EVENT = 'mqlens:check-update';

interface UpdateMeta {
  version: string;
  current_version: string;
  notes: string | null;
  date: string | null;
}

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'uptodate' | 'error';

const renderInline = (text: string): React.ReactNode[] => {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`')) {
      out.push(<code key={k++} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{tok.slice(1, -1)}</code>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const url = link[2];
      out.push(
        <a key={k++} href={url} className="text-primary underline-offset-2 hover:underline" onClick={(e) => { e.preventDefault(); void openUrl(url); }}>
          {link[1]}
        </a>
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

const ReleaseNotes: React.FC<{ markdown: string }> = ({ markdown }) => {
  const blocks: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  let k = 0;
  const flushList = () => {
    if (listItems.length) {
      blocks.push(<ul key={k++} className="ml-4 list-disc space-y-1">{listItems}</ul>);
      listItems = [];
    }
  };
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      blocks.push(<h4 key={k++} className="text-sm font-semibold text-foreground">{renderInline(heading[1])}</h4>);
    } else if (bullet) {
      listItems.push(<li key={k++}>{renderInline(bullet[1])}</li>);
    } else if (line === '') {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={k++} className="text-sm text-muted-foreground">{renderInline(line)}</p>);
    }
  }
  flushList();
  return (
    <div className="max-h-48 space-y-2 overflow-y-auto text-sm" data-testid="update-notes">
      {blocks}
    </div>
  );
};

async function currentChannel(): Promise<string> {
  try {
    const s = await invoke<{ update_channel?: string }>('load_app_settings');
    return s.update_channel === 'dev' ? 'dev' : 'stable';
  } catch {
    return 'stable';
  }
}

export const UpdatePrompt: React.FC = () => {
  const [update, setUpdate] = useState<UpdateMeta | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [manual, setManual] = useState(false);

  const runCheck = useCallback(async (isManual: boolean) => {
    setManual(isManual);
    setError(null);
    setPhase('checking');
    try {
      const channel = await currentChannel();
      const meta = await invoke<UpdateMeta | null>('update_check', { channel });
      if (meta) {
        setUpdate(meta);
        setPhase('available');
      } else {
        setPhase(isManual ? 'uptodate' : 'idle');
      }
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase(isManual ? 'error' : 'idle');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void runCheck(false), 4000);
    const onManual = () => void runCheck(true);
    window.addEventListener(CHECK_UPDATE_EVENT, onManual);
    return () => {
      clearTimeout(t);
      window.removeEventListener(CHECK_UPDATE_EVENT, onManual);
    };
  }, [runCheck]);

  const install = async () => {
    if (!update) return;
    setPhase('downloading');
    setPct(0);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<{ downloaded: number; total: number | null }>(
        'update://progress',
        (ev) => {
          const { downloaded, total } = ev.payload;
          if (total && total > 0) setPct(Math.min(100, Math.round((downloaded / total) * 100)));
        }
      );
      const channel = await currentChannel();
      await invoke('update_install', { channel });
      await relaunch();
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase('error');
    } finally {
      unlisten?.();
    }
  };

  const dismiss = () => {
    setPhase('idle');
    setError(null);
  };

  useEscapeClose(phase === 'available', dismiss);

  const toastClassName = cn(
    'fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm shadow-lg'
  );

  if (phase === 'checking' && manual) {
    return (
      <div className={toastClassName} data-testid="update-toast">
        <RefreshCw size={14} className="animate-spin text-primary" /> Checking for updates…
      </div>
    );
  }
  if (phase === 'uptodate') {
    return (
      <div className={toastClassName} data-testid="update-toast">
        <CheckCircle2 size={14} className="text-success" /> You’re on the latest version.
        <Button type="button" variant="ghost" size="icon" className="ml-1 h-6 w-6" onClick={dismiss} aria-label="Dismiss">
          <X size={12} />
        </Button>
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <div className={cn(toastClassName, 'border-destructive/30 text-destructive')} data-testid="update-toast" title={error ?? undefined}>
        <AlertTriangle size={14} /> Update check failed.
        <Button type="button" variant="ghost" size="icon" className="ml-1 h-6 w-6" onClick={dismiss} aria-label="Dismiss">
          <X size={12} />
        </Button>
      </div>
    );
  }

  if (phase !== 'available' && phase !== 'downloading') return null;

  const downloading = phase === 'downloading';
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-[520px] [&>button.absolute]:hidden"
        data-testid="update-dialog"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          if (!downloading) {
            e.preventDefault();
            dismiss();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ArrowUpCircle size={16} className="text-primary" />
            Update available
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-foreground" data-testid="update-version">
          MQLens <strong>{update?.version}</strong> is available
          {update?.current_version ? <> (you have {update.current_version})</> : null}.
        </p>
        {update?.notes && <ReleaseNotes markdown={update.notes} />}

        {downloading ? (
          <div className="space-y-2" data-testid="update-progress">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-muted-foreground">
              {pct}% — downloading, the app will restart when done…
            </span>
          </div>
        ) : (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={dismiss} data-testid="update-later">
              Later
            </Button>
            <Button type="button" onClick={install} data-testid="update-now">
              <Download size={13} />
              Update now
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
