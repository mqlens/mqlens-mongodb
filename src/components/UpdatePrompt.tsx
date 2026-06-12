import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
import { Download, X, RefreshCw, CheckCircle2, AlertTriangle, ArrowUpCircle } from 'lucide-react';
import { useEscapeClose } from '../lib/useEscapeClose';

// Event other components (e.g. Settings) dispatch to trigger a manual check.
export const CHECK_UPDATE_EVENT = 'mqlens:check-update';

// Mirrors the Rust updater::UpdateMeta returned by the `update_check` command.
interface UpdateMeta {
  version: string;
  current_version: string;
  notes: string | null;
  date: string | null;
}

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'uptodate' | 'error';

/** The user's selected update channel, read from app settings. */
async function currentChannel(): Promise<string> {
  try {
    const s = await invoke<{ update_channel?: string }>('load_app_settings');
    return s.update_channel === 'dev' ? 'dev' : 'stable';
  } catch {
    return 'stable';
  }
}

// Auto-checks for an update a few seconds after launch (silent), and on demand
// via the CHECK_UPDATE_EVENT. The check + install run against the channel the
// user picked in Settings (stable | dev) via the Rust updater commands — Tauri's
// static endpoints can't be switched at runtime. An available update is only ever
// downloaded and installed after the user clicks "Update now".
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
    // Silent check shortly after startup so it doesn't compete with launch work.
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

  // The approval modal no longer closes on backdrop click; Escape still
  // dismisses it (except mid-download, like the disabled close button).
  useEscapeClose(phase === 'available', dismiss);

  // Transient toasts (manual feedback) ────────────────────────────────────────
  if (phase === 'checking' && manual) {
    return (
      <div className="mql-update-toast" data-testid="update-toast">
        <RefreshCw size={14} className="animate-spin" /> Checking for updates…
      </div>
    );
  }
  if (phase === 'uptodate') {
    return (
      <div className="mql-update-toast" data-testid="update-toast">
        <CheckCircle2 size={14} style={{ color: '#34d399' }} /> You’re on the latest version.
        <button type="button" className="mql-update-toast-x" onClick={dismiss} aria-label="Dismiss"><X size={12} /></button>
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <div className="mql-update-toast is-error" data-testid="update-toast" title={error ?? undefined}>
        <AlertTriangle size={14} /> Update check failed.
        <button type="button" className="mql-update-toast-x" onClick={dismiss} aria-label="Dismiss"><X size={12} /></button>
      </div>
    );
  }

  // Available / downloading → approval modal ───────────────────────────────────
  if (phase !== 'available' && phase !== 'downloading') return null;

  const downloading = phase === 'downloading';
  return (
    <div className="nested-modal-overlay" data-testid="update-dialog">
      <div className="index-modal-container" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 92vw)' }}>
        <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-3 mb-4">
          <div className="flex items-center gap-2">
            <ArrowUpCircle size={16} className="text-[var(--accent-blue)]" />
            <h2 className="text-sm font-semibold text-[var(--text-main)]">Update available</h2>
          </div>
          {!downloading && (
            <button type="button" onClick={dismiss} aria-label="Close" className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-item-hover)]">
              <X size={14} />
            </button>
          )}
        </div>

        <p className="text-[13px] text-[var(--text-main)]" data-testid="update-version">
          MQLens <strong>{update?.version}</strong> is available
          {update?.current_version ? <> (you have {update.current_version})</> : null}.
        </p>
        {update?.notes && (
          <pre className="mql-update-notes">{update.notes}</pre>
        )}

        {downloading ? (
          <div className="mql-update-progress" data-testid="update-progress">
            <div className="mql-update-progress-bar"><span style={{ width: `${pct}%` }} /></div>
            <span className="mql-update-progress-pct">{pct}% — downloading, the app will restart when done…</span>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--border-color)] pt-3 mt-4">
            <button type="button" onClick={dismiss} className="index-modal-btn-secondary" data-testid="update-later">
              Later
            </button>
            <button type="button" onClick={install} className="index-modal-btn-primary" data-testid="update-now">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Download size={13} /> Update now</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
