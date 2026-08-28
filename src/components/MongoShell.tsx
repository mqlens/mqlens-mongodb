import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import Editor from '@monaco-editor/react';
import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AlertCircle, Braces, CornerDownLeft, Eraser, Play, RotateCcw, Sparkles, Terminal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AIChatPanel, type ChatMessage } from './AIChatPanel';
import { buildRunnableCommand, guardScriptRun, type GeneratedQuery } from '../lib/mongoCommand';
import { DataGrid } from './DataGrid';
import { registerMongoCompletionProvider, setModelMeta, clearModelMeta } from '../lib/monacoMongo';
import { useMonacoTheme, useMonacoFontSize } from '../lib/useMonacoTheme';
import { registerMqlensMonacoThemes } from '../lib/monacoAppTheme';
import { formatShortcut, shortcutById } from '@/lib/shortcuts';
import { windowLabel } from '../workspace/workspaceStore';

type ShellTab = 'console' | 'viewer';

import {
  dropPendingShellStart,
  loadShellSession,
  readShellSession,
  shareShellStart,
  shellSessionEpoch,
  watchShellSession,
  stopShellSessionProcess,
  writeShellSession,
  type ShellEntry,
  type ShellSession,
} from '../lib/mongoshSession';

interface AppSettings {
  mongosh_path?: string;
}

interface MongoshSessionInfo {
  session_id: string;
  stdout: string[];
  stderr: string[];
}

interface MongoshCommandOutput {
  stdout: string[];
  stderr: string[];
}

interface MongoShellProps {
  connectionId: string;
  connectionName: string;
  connectionUri: string;
  databaseName: string;
  collectionName?: string;
  initialCommand?: string;
  density?: 'roomy' | 'cozy' | 'compact';
  onOpenSettings?: () => void;
  onInstallTools?: () => void;
  /** Bump this (e.g. after a tool install completes) to re-attempt the mongosh session. */
  reconnectSignal?: number;
  /** Identifies this shell across unmounts so its mongosh process and
   *  scrollback survive a tab switch (#240). Without it the shell falls back
   *  to the old behaviour: a session per mount. */
  sessionKey?: string;
}

interface ParsedCall {
  name: string;
  argText: string;
}

// Keys into shell:mongoShell.help — translated at the call site (`help` command
// handler below) rather than here, since this module-level constant can't call
// the useTranslation hook. A blank string renders as a blank line unchanged.
const HELP_LINE_KEYS = [
  'help.title',
  'help.showDbs',
  'help.showCollections',
  'help.useDb',
  '',
  'help.collectionMethodsHeader',
  'help.findSyntax',
  'help.findOneSyntax',
  'help.aggregateSyntax',
  'help.countDocumentsSyntax',
  'help.getIndexesSyntax',
  '',
  'help.jsHeader',
  'help.jsMultiline',
  'help.printjson',
  'help.load',
  '',
  'help.clsClear',
];

const splitCalls = (source: string): { calls: ParsedCall[]; rest: string } => {
  const calls: ParsedCall[] = [];
  let i = 0;
  while (i < source.length) {
    const match = source.slice(i).match(/^\.?([A-Za-z][A-Za-z0-9]*)\(/);
    if (!match) break;
    i += match[0].length;
    let depth = 1;
    let quote: string | null = null;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (quote) {
        if (ch === quote && source[i - 1] !== '\\') quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    calls.push({ name: match[1], argText: source.slice(start, i).trim() });
    i++;
  }
  return { calls, rest: source.slice(i) };
};

// Pure, module-scope helper — can't call the useTranslation hook. Every call
// site is inside the component, where the real `t` is in scope, so it's
// threaded through as a required parameter instead; the thrown message ends
// up in a shell `error` entry the user reads, so it must be translated like
// any other visible copy.
const parseLoose = (source: string, fallback: unknown, t: (key: string, opts?: any) => string) => {
  const trimmed = source.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      const normalized = trimmed
        .replace(/([{,]\s*)(\$?[A-Za-z_][\w$]*)\s*:/g, '$1"$2":')
        .replace(/'/g, '"')
        .replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(normalized);
    } catch {
      throw new Error(t('shell:mongoShell.errors.invalidJsonLiteral', { value: trimmed }));
    }
  }
};

const firstArg = (argText: string) => {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i];
    if (quote) {
      if (ch === quote && argText[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      return argText.slice(0, i);
    }
  }
  return argText;
};

const stringifyShellValue = (value: unknown, indent = 0): string => {
  const pad = '  '.repeat(indent);
  const padNext = '  '.repeat(indent + 1);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${padNext}${stringifyShellValue(item, indent + 1)}`).join(',\n')}\n${pad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{\n${entries
      .map(([key, val]) => `${padNext}${key}: ${stringifyShellValue(val, indent + 1)}`)
      .join(',\n')}\n${pad}}`;
  }
  return String(value);
};

const HighlightedValue: React.FC<{ value: unknown }> = ({ value }) => (
  <pre className="m-0 whitespace-pre-wrap font-mono text-xs text-foreground">{stringifyShellValue(value)}</pre>
);

const createLogId = () => {
  const alphabet = '0123456789abcdef';
  return Array.from({ length: 24 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
};

const extractVersion = (value: unknown) => {
  const text = typeof value === 'string' ? value : '';
  return text.match(/\d+\.\d+\.\d+(?:[-\w.]*)?/)?.[0] || text || 'unavailable';
};

// Reproduces mongosh's own startup banner verbatim (same convention as
// HELP_LINE_KEYS' findSyntax/aggregateSyntax/etc. below: real mongosh output
// is English-only regardless of the host OS locale, so translating this
// would misrepresent what the actual CLI tool prints). Not UI copy — i18n
// out of scope by design, kept as an exempt literal.
const buildStartupLines = (
  logId: string,
  target: string,
  mongodbVersion = 'detecting...',
  mongoshVersion = 'detecting...'
) => [
  `Current Mongosh Log ID: ${logId}`,
  `Connecting to: ${target}`,
  `Using MongoDB: ${mongodbVersion}    Using Mongosh: ${mongoshVersion}`,
  '',
];

export const MongoShell: React.FC<MongoShellProps> = ({
  connectionId,
  connectionName,
  connectionUri,
  databaseName,
  collectionName,
  initialCommand,
  density = 'cozy',
  onOpenSettings,
  onInstallTools,
  reconnectSignal,
  sessionKey,
}) => {
  const { t } = useTranslation('shell');
  // Restored transcript/session for this tab, if it survived an unmount (#240).
  const storedSession = sessionKey ? readShellSession(sessionKey) : undefined;
  // Captured once, at mount. Every write below carries it, so if this tab is
  // closed or moved to another window while a command is still running, the
  // completion that lands afterwards is dropped instead of resurrecting a
  // discarded session or overwriting the destination window's newer state.
  const epochRef = useRef(sessionKey ? shellSessionEpoch(sessionKey) : 0);
  const persistSession = (patch: Partial<ShellSession>) => {
    if (sessionKey) writeShellSession(sessionKey, patch, epochRef.current);
  };
  const [currentDb, setCurrentDb] = useState(storedSession?.currentDb || databaseName);
  const startupLogId = useMemo(createLogId, []);
  // Display the connection name in the startup banner, never the URI — the URI
  // can contain credentials (e.g. user:password@host) that must not be logged.
  const connectionTarget = connectionName || connectionUri;
  const defaultCommand = useMemo(
    () => initialCommand || (collectionName ? `db.${collectionName}.find({}).limit(50)` : 'show collections'),
    [collectionName, initialCommand]
  );
  const [command, setCommand] = useState(defaultCommand);
  const monacoTheme = useMonacoTheme();
  const monacoFontSize = useMonacoFontSize(13);
  const [isAIOpen, setIsAIOpenState] = useState(storedSession?.aiOpen ?? false);
  const [aiMessages, setAiMessages] = useState<ChatMessage[]>(storedSession?.aiMessages ?? []);
  const setIsAIOpen = (open: boolean) => {
    setIsAIOpenState(open);
    persistSession({ aiOpen: open });
  };
  const handleAiMessagesChange = (messages: ChatMessage[]) => {
    setAiMessages(messages);
    persistSession({ aiMessages: messages });
  };
  // Which stored conversation this shell tab has open. The transcript lives in
  // the backend chat store; the tab only remembers which one it is looking at.
  // Held in state rather than read from `storedSession`, which is a mount-time
  // snapshot and is empty after a renderer refresh — the tab would then forget
  // which conversation it was on and adopt the collection's most recent.
  const [aiChatId, setAiChatId] = useState<string | undefined>(storedSession?.aiChatId);
  const handleAiChatIdChange = (id: string) => {
    setAiChatId(id);
    persistSession({ aiChatId: id });
  };
  const [pendingDestructive, setPendingDestructive] =
    useState<{ command: string; operation: string } | null>(null);
  // Restored transcript wins over a fresh banner: returning to this tab should
  // look like the session was never interrupted.
  const [entries, setEntries] = useState<ShellEntry[]>(
    // Presence of a stored session, NOT the length of its transcript: `clear`
    // legitimately leaves it empty, and treating that as "nothing stored"
    // resurrected the startup banner on the next tab switch.
    storedSession
      ? storedSession.entries
      : [{ kind: 'text', lines: buildStartupLines(startupLogId, connectionTarget) }]
  );
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [viewer, setViewer] = useState<{ docs: Record<string, any>[]; label: string; ms: number } | null>(null);
  const [tab, setTab] = useState<ShellTab>('console');
  const [running, setRunning] = useState(false);
  const [topHeight, setTopHeight] = useState<number | null>(null);
  const [mongoshPath, setMongoshPath] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(storedSession?.sessionId ?? null);
  const [sessionAttempted, setSessionAttempted] = useState(Boolean(storedSession?.sessionId));
  // Which retry generation we are already attached for. Seeded to 0 when a
  // session was restored, so the start effect reattaches instead of respawning.
  const attachedNonce = useRef<number | null>(storedSession?.sessionId ? 0 : null);
  /** Counts start attempts, so a completion can tell whether a newer attempt
   *  has already replaced it. See the start effect. */
  const startRunRef = useRef(0);

  // After a hot reload or a window refresh the in-memory cache is empty, but the
  // backend still holds this tab's state and its mongosh child is still running.
  // Pull it back before the start effect can decide there is nothing to attach
  // to and spawn a duplicate.
  const [hydrated, setHydrated] = useState(Boolean(storedSession) || !sessionKey);
  useEffect(() => {
    if (hydrated || !sessionKey) return;
    let alive = true;
    void loadShellSession(sessionKey).then((restored) => {
      if (!alive) return;
      if (restored) {
        setEntries(restored.entries);
        if (restored.currentDb) setCurrentDb(restored.currentDb);
        setAiMessages(restored.aiMessages);
        setIsAIOpenState(restored.aiOpen);
        setAiChatId(restored.aiChatId);
        autoRunRef.current = restored.autoRanCommand;
        if (restored.sessionId) {
          setSessionId(restored.sessionId);
          setSessionAttempted(true);
          attachedNonce.current = 0;
        }
      }
      setHydrated(true);
    });
    return () => {
      alive = false;
    };
  }, [hydrated, sessionKey]);
  const [retryNonce, setRetryNonce] = useState(0);

  // Restart the session without losing the scrollback: stop the process, note
  // it in the transcript, then let the start effect attach a fresh one. Bumping
  // `retryNonce` is what makes that effect skip its reattach shortcut.
  const [restarting, setRestarting] = useState(false);
  const restartSession = async () => {
    setRestarting(true);
    try {
      if (sessionKey) await stopShellSessionProcess(sessionKey);
      else if (sessionId) await invoke('stop_mongosh_session', { sessionId }).catch(() => undefined);
      setSessionId(null);
      setSessionAttempted(false);
      appendEntries([{ kind: 'note', text: t('mongoShell.notes.sessionRestarting') }]);
      setRetryNonce((n) => n + 1);
    } finally {
      setRestarting(false);
    }
  };

  // Mirror the transcript and current database into the session registry.
  // `sessionId` is deliberately NOT mirrored here: the start path sets it to
  // null before spawning, and persisting that transient null would make a
  // remount think there is nothing to reattach to.
  useEffect(() => {
    if (!sessionKey) return;
    persistSession({ entries, currentDb });
  }, [sessionKey, entries, currentDb]);

  // ...and the other direction: pick up writes made by SOMEONE ELSE. A command
  // that was still running when the user switched away completes against the
  // registry, and that instance has no way to reach this one — so without this
  // its output sat in storage, invisible until the next local append or tab
  // switch. Assigning the same array back is a no-op for React, which is what
  // keeps this from looping against the mirror effect above.
  useEffect(() => {
    if (!sessionKey) return;
    return watchShellSession(sessionKey, (session) => {
      setEntries((prev) => (session.entries === prev ? prev : session.entries));
      entriesRef.current = session.entries;
      if (session.currentDb) setCurrentDb(session.currentDb);
    });
  }, [sessionKey]);
  // Guided setup on session failure: a working mongosh found outside the
  // configured path (offered as one click), or null when nothing was found.
  const [detectedMongosh, setDetectedMongosh] = useState<
    { path: string; version: string; source: string } | null
  >(null);
  // Reuses the retry-nonce mechanism above: when a parent-driven reconnect signal
  // changes (e.g. the guided tool-install dialog finished), re-attempt the session
  // the same way the gate's own Retry button does.
  const reconnectSignalRef = useRef(reconnectSignal);
  useEffect(() => {
    if (reconnectSignal !== undefined && reconnectSignal !== reconnectSignalRef.current) {
      reconnectSignalRef.current = reconnectSignal;
      // The signal fires after ANY tool install completes — only re-attempt
      // when no session is attached (failed/not running). A healthy session
      // must not be restarted; that would drop its state mid-work.
      if (sessionId === null) setRetryNonce((n) => n + 1);
    }
    // sessionId is only read when the signal actually changed; including it
    // keeps the read fresh without re-triggering (the ref guard above).
  }, [reconnectSignal, sessionId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<() => void>(() => {});
  // Seeded from the tab's session: the opening command must run once per TAB,
  // not once per mount, or switching tabs re-executes it (#240).
  const autoRunRef = useRef(storedSession?.autoRanCommand ?? false);
  // Tracks the latest result docs so the Monaco completion provider (registered
  // once in onMount) can derive field names from the current results.
  const viewerRef = useRef<{ docs: Record<string, any>[] } | null>(null);
  // Collection names for the current db, for `db.<coll>` completions in the shell.
  const collectionsRef = useRef<string[]>([]);
  useEffect(() => {
    let alive = true;
    invoke<Array<{ name: string }>>('list_collections', { id: connectionId, db: currentDb })
      .then((cols) => { if (alive) collectionsRef.current = cols.map((c) => c.name); })
      .catch(() => { if (alive) collectionsRef.current = []; });
    return () => { alive = false; };
  }, [connectionId, currentDb]);

  useEffect(() => {
    setCommand(defaultCommand);
  }, [defaultCommand]);

  useEffect(() => {
    let cancelled = false;

    const updateStartupEntry = (mongodbVersion: string, mongoshVersion: string) => {
      if (cancelled) return;
      setEntries((prev) => {
        if (prev.length === 0 || prev[0].kind !== 'text') return prev;
        const next = [...prev];
        next[0] = {
          kind: 'text',
          lines: buildStartupLines(startupLogId, connectionTarget, mongodbVersion, mongoshVersion),
        };
        return next;
      });
    };

    updateStartupEntry('detecting...', 'detecting...');

    const loadStartupVersions = async () => {
      const [mongodbResult, settingsResult] = await Promise.allSettled([
        invoke<string>('get_mongodb_version', { id: connectionId }),
        invoke<AppSettings>('load_app_settings'),
      ]);

      const mongodbVersion =
        mongodbResult.status === 'fulfilled' ? extractVersion(mongodbResult.value) : 'unavailable';
      const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : { mongosh_path: '' };
      if (!cancelled) setMongoshPath(settings.mongosh_path || '');
      const mongoshResult = await invoke<string>('test_mongosh_path', {
        path: settings.mongosh_path || '',
      }).then(
        (value) => extractVersion(value),
        () => 'unavailable'
      );

      updateStartupEntry(mongodbVersion, mongoshResult);
    };

    loadStartupVersions();

    return () => {
      cancelled = true;
    };
  }, [connectionId, connectionTarget, startupLogId, retryNonce]);

  // Appends that must land even if the tab was switched away mid-command.
  // While mounted, setEntries drives the mirror effect as usual; once unmounted
  // that effect is gone, so the transcript is written straight to the tab's
  // session — otherwise the command runs, the backend answers, and the output
  // is discarded because there is no component left to hold it.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const appendEntries = (added: ShellEntry[]) => {
    if (added.length === 0) return;
    if (!sessionKey) {
      // No tab identity: this instance's state is the only transcript there is.
      if (mountedRef.current) {
        setEntries((prev) => {
          const next = [...prev, ...added];
          entriesRef.current = next;
          return next;
        });
      }
      return;
    }
    // Append against the REGISTRY, mounted or not. A slow command can still be
    // running when the tab is switched away and back, leaving two MongoShell
    // instances alive with two independent `entriesRef`s. Basing either one on
    // its own snapshot means the later completion silently drops whatever the
    // other appended — and doing it only off-screen is not enough: when the old
    // command finishes after the remount, the mounted instance's next append
    // (and the mirror effect behind it) would overwrite the registry with a
    // `prev` that never saw that output.
    const base = readShellSession(sessionKey)?.entries ?? entriesRef.current;
    const next = [...base, ...added];
    entriesRef.current = next;
    // Also show it here, so the visible console reflects everything the tab has
    // accumulated rather than only what this instance witnessed.
    if (mountedRef.current) setEntries(next);
    persistSession({ entries: next });
  };

  const appendCommandOutput = (output: MongoshCommandOutput) => {
    const nextEntries: ShellEntry[] = [];
    if (output.stdout.length > 0) nextEntries.push({ kind: 'text', lines: output.stdout });
    if (output.stderr.length > 0) nextEntries.push({ kind: 'error', message: output.stderr.join('\n') });
    appendEntries(nextEntries);
  };

  useEffect(() => {
    // Waiting on the backend lookup above: starting before it lands would spawn
    // a second child for a tab that already has one.
    if (!hydrated) return;
    if (mongoshPath === null) return;
    if (!connectionUri) {
      setSessionAttempted(true);
      return;
    }
    // A session already attached to this tab is still running — the process
    // outlives the unmount now, so reattach instead of spawning a second one.
    // `retryNonce` is the deliberate exception: Retry means start fresh (it
    // clears the stored id first, so `attachedSessionId` is null by then).
    //
    // Read live rather than from the mount-time snapshot: an instance that
    // mounted DURING a start has `attachedNonce.current === null`, and against
    // a snapshot the check could never match afterwards — so it started a
    // second child even once the first had recorded its id.
    const attachedSessionId = sessionKey ? readShellSession(sessionKey)?.sessionId : null;
    if (attachedSessionId && (attachedNonce.current === null || retryNonce === attachedNonce.current)) {
      attachedNonce.current = retryNonce;
      // Adopt it: this instance may have mounted before the id existed, and
      // would otherwise sit behind the starting gate forever.
      setSessionId(attachedSessionId);
      setSessionAttempted(true);
      return;
    }
    attachedNonce.current = retryNonce;
    // Retry/reconnect means start fresh: drop any in-flight start so the next
    // call issues its own rather than joining the attempt being replaced.
    if (sessionKey && retryNonce > 0) dropPendingShellStart(sessionKey);

    // Which start attempt this is. A dependency change (a Retry, or
    // `reconnectSignal` firing when a tool install finishes) tears this effect
    // down and immediately starts another, so "cancelled" alone cannot tell a
    // real unmount from a supersession — and treating a superseded attempt as
    // an unmount retains its child, whose id the replacement then overwrites,
    // leaving the first mongosh process untracked.
    const thisRun = ++startRunRef.current;
    const superseded = () => startRunRef.current !== thisRun;

    let cancelled = false;
    let openedSessionId: string | null = null;
    setSessionId(null);
    setSessionAttempted(false);

    const startSession = async () => {
      try {
        const runStart = () =>
          invoke<MongoshSessionInfo>('start_mongosh_session', {
            connectionId,
            uri: connectionUri,
            database: currentDb,
            mongoshPath,
            // So the backend can stop this child itself if the window closes
            // before the start returns — at that point this renderer is gone and
            // cannot cancel anything, and the id it would have recorded never
            // reaches the tab state the close sweep reads.
            windowId: windowLabel(),
          });
        // Joins the start already running for this tab, if there is one. A
        // start is slow and records nothing until it returns, so a remount
        // partway through used to see an unattached tab and spawn a rival
        // child — after which the two ids overwrote each other and one process
        // was left with nothing pointing at it.
        const session = sessionKey ? await shareShellStart(sessionKey, runStart) : await runStart();
        // Record it before the cancellation check: the tab owns the session, so
        // it must be findable by `disposeShellSession` even if this mount is
        // already gone.
        if (superseded()) {
          // A newer attempt is already running for this same tab. Recording
          // this id would only get overwritten by that attempt, so stop the
          // child here — this is the one case where a keyed session must NOT
          // outlive its start.
          await invoke('stop_mongosh_session', { sessionId: session.session_id }).catch(
            () => undefined
          );
          return;
        }
        if (sessionKey) {
          if (shellSessionEpoch(sessionKey) !== epochRef.current) {
            // This tab stopped belonging to this renderer while mongosh was
            // starting — closed, or moved to another window. Either way nobody
            // is coming back for this particular child: a closed tab has
            // nothing left to read its id, and a moved tab is served by the
            // destination window's own session. Recording it would be worse
            // than useless, since the write re-stamps this window as the owner
            // and can overwrite the mapping the destination is using — so
            // closing this window would then kill the process it is showing.
            await invoke('stop_mongosh_session', { sessionId: session.session_id }).catch(
              () => undefined
            );
            return;
          }
          // The backend has already drained the startup output; if this mount is
          // gone, appending it to state would vanish, so fold it into the stored
          // transcript instead of losing warnings and errors.
          const startupEntries: ShellEntry[] = [];
          if (session.stdout.length > 0) startupEntries.push({ kind: 'text', lines: session.stdout });
          if (session.stderr.length > 0)
            startupEntries.push({ kind: 'error', message: session.stderr.join('\n') });
          startupEntries.push({ kind: 'note', text: t('mongoShell.notes.sessionAttached') });
          // Past the epoch check above, so this tab is still ours; the write
          // carries the epoch anyway, since nothing guarantees it stays ours
          // between here and the next line.
          writeShellSession(sessionKey, {
            sessionId: session.session_id,
            // Against the registry, like every other append: by the time a
            // slow start returns, the tab may have been remounted and another
            // completion may already have landed. Building this from
            // `entriesRef` would erase it.
            ...(cancelled
              ? {
                  entries: [
                    ...(readShellSession(sessionKey)?.entries ?? entriesRef.current),
                    ...startupEntries,
                  ],
                }
              : {}),
          }, epochRef.current);
        }
        if (cancelled) {
          // Unmounting means the user switched tabs mid-startup. With a tab
          // identity the session survives that; without one there is nothing to
          // reattach to later, so it has to be stopped.
          if (!sessionKey) {
            await invoke('stop_mongosh_session', { sessionId: session.session_id }).catch(() => undefined);
          }
          return;
        }
        openedSessionId = session.session_id;
        setSessionId(session.session_id);
        if (session.stdout.length > 0 || session.stderr.length > 0) {
          appendCommandOutput({ stdout: session.stdout, stderr: session.stderr });
        }
        appendEntries([{ kind: 'note', text: t('mongoShell.notes.sessionAttached') }]);
      } catch (err: any) {
        persistSession({ sessionId: null });
        if (!cancelled) {
          setSessionId(null);
          appendEntries([
            {
              kind: 'error',
              message: t('mongoShell.notes.sessionUnavailable', { detail: err.message || String(err) }),
            },
          ]);
        }
      } finally {
        if (!cancelled) setSessionAttempted(true);
      }
    };

    startSession();

    return () => {
      cancelled = true;
      // Deliberately does NOT stop the session. Unmounting means the user
      // switched tabs, not that they are done with the shell; the process is
      // now owned by the tab and torn down by `disposeShellSession` when the
      // tab closes (#240). Without a `sessionKey` there is nothing to reattach
      // to later, so keep the old behaviour and clean up.
      if (!sessionKey && openedSessionId) {
        invoke('stop_mongosh_session', { sessionId: openedSessionId }).catch(() => undefined);
      }
    };
    // The session is started once per shell tab. currentDb is intentionally used only as startup database.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, connectionUri, mongoshPath, retryNonce, sessionKey, hydrated]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, tab]);

  // When the session failed to attach, probe for a usable mongosh (managed
  // install, PATH, well-known locations) so the gate can offer a one-click
  // fix instead of only pointing at Settings.
  useEffect(() => {
    if (!sessionAttempted || sessionId !== null || mongoshPath === null) return;
    let alive = true;
    invoke<{ path: string; version: string; source: string } | null>('detect_mongosh_binary', {
      configured: mongoshPath || '',
    })
      .then((found) => {
        if (!alive) return;
        // A hit at the configured path means the session failure has some
        // other cause — offering "use this path" would be a no-op.
        setDetectedMongosh(found && found.source !== 'configured' ? found : null);
      })
      .catch(() => {
        if (alive) setDetectedMongosh(null);
      });
    return () => {
      alive = false;
    };
  }, [sessionAttempted, sessionId, mongoshPath, retryNonce]);

  // Persist a newly chosen mongosh path and re-attempt the session. The
  // retry-nonce bump matters when the picked path equals the current one
  // (setMongoshPath alone would be a no-op state update, so no re-attempt).
  const saveMongoshPath = async (path: string) => {
    try {
      await invoke('patch_app_settings', {
        patch: { mongosh_path: path },
      });
    } catch {
      /* settings persistence is best-effort — still try the new path below */
    }
    setDetectedMongosh(null);
    setMongoshPath(path);
    setRetryNonce((n) => n + 1);
  };

  const browseForMongosh = async () => {
    try {
      const picked = await openFileDialog({ multiple: false, title: t('mongoShell.gate.browseDialogTitle') });
      if (typeof picked === 'string' && picked) await saveMongoshPath(picked);
    } catch {
      /* user cancelled */
    }
  };

  // OS-specific manual install hint for the gate card. The commands themselves
  // are literal shell input the user copies verbatim, so only the parenthetical
  // notes around them are translated (Global Constraint 2).
  const installHint = useMemo(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/mac/i.test(ua)) return 'brew install mongosh';
    if (/win/i.test(ua)) return `winget install MongoDB.Shell (${t('mongoShell.gate.installNote.windows')})`;
    if (/linux/i.test(ua)) return `sudo apt install mongodb-mongosh (${t('mongoShell.gate.installNote.linux')})`;
    return t('mongoShell.gate.installNote.generic');
  }, [t]);

  const executeFind = async (
    collName: string,
    calls: ParsedCall[],
    label: string,
    forceLimit?: number
  ) => {
    const op = calls[0];
    const call = (name: string) => calls.find((candidate) => candidate.name === name);
    const filter = parseLoose(firstArg(op.argText), {}, t);
    const sort = call('sort') ? parseLoose(call('sort')!.argText, {}, t) : {};
    const skip = call('skip') ? Number.parseInt(call('skip')!.argText, 10) || 0 : 0;
    const limit = forceLimit ?? (call('limit') ? Number.parseInt(call('limit')!.argText, 10) || 50 : 50);
    const started = performance.now();
    const result = await invoke<string[]>('execute_mql_query', {
      id: connectionId,
      database: currentDb,
      collection: collName,
      filter: JSON.stringify(filter),
      sort: JSON.stringify(sort),
      limit,
      skip,
    });
    const docs = result.map((doc) => JSON.parse(doc));
    setViewer({ docs, label, ms: Math.round((performance.now() - started) * 10) / 10 });
    setTab('viewer');
    appendEntries([
      {
        kind: 'note',
        text: t('mongoShell.notes.resultToDataViewer', { count: docs.length }),
      },
    ]);
  };

  const executeAggregate = async (collName: string, calls: ParsedCall[]) => {
    const pipeline = parseLoose(calls[0].argText, [], t) as Array<Record<string, unknown>>;
    if (!Array.isArray(pipeline)) throw new Error(t('mongoShell.errors.aggregateExpectsPipeline'));
    // Run the real pipeline (every stage — $group, $project, $unwind, …) via the
    // driver, rather than collapsing it down to a find().
    const started = performance.now();
    const result = await invoke<string[]>('execute_aggregate', {
      id: connectionId,
      database: currentDb,
      collection: collName,
      pipeline: JSON.stringify(pipeline),
    });
    const docs = result.map((doc) => JSON.parse(doc));
    setViewer({ docs, label: `db.${collName}.aggregate()`, ms: Math.round((performance.now() - started) * 10) / 10 });
    setTab('viewer');
    appendEntries([
      {
        kind: 'note',
        text: t('mongoShell.notes.resultToDataViewer', { count: docs.length }),
      },
    ]);
  };

  const runExternalMongoshCommand = async (raw: string) => {
    if (!sessionId) return false;
    const output = await invoke<MongoshCommandOutput>('run_mongosh_command', {
      sessionId,
      command: raw,
    });
    appendCommandOutput(output);
    setTab('console');
    return true;
  };

  // The shell's current collection context for AI-generated commands.
  const aiCollection = collectionName ?? 'collection';

  const handleAIInsert = (query: GeneratedQuery) => {
    setCommand(buildRunnableCommand(query, aiCollection));
    setIsAIOpen(false);
  };

  const handleAIInsertAndRun = (query: GeneratedQuery) => {
    const cmd = buildRunnableCommand(query, aiCollection);
    setCommand(cmd);
    setIsAIOpen(false);
    const decision = guardScriptRun(query, cmd);
    if (decision.action === 'confirm') {
      // Hold the command and ask before running a destructive script.
      setPendingDestructive({ command: cmd, operation: decision.operation });
      return;
    }
    runCommand(cmd);
  };

  const confirmDestructive = () => {
    if (!pendingDestructive) return;
    const cmd = pendingDestructive.command;
    setPendingDestructive(null);
    runCommand(cmd);
  };

  const cancelDestructive = () => {
    setPendingDestructive(null);
    appendEntries([{ kind: 'note', text: t('mongoShell.notes.destructiveCancelled') }]);
  };

  const runCommand = async (commandOverride?: string) => {
    const raw = (commandOverride ?? command).trim().replace(/;$/, '');
    if (!raw || running) return;
    appendEntries([{ kind: 'input', db: currentDb, text: raw }]);
    setRunning(true);
    try {
      if (/^(cls|clear)$/i.test(raw)) {
        setEntries([]);
        setTab('console');
        return;
      }
      if (/^help$/i.test(raw)) {
        const helpLines = HELP_LINE_KEYS.map((key) => (key ? t(`mongoShell.${key}`) : ''));
        appendEntries([{ kind: 'text', lines: helpLines }]);
        setTab('console');
        return;
      }
      const ranExternally = await runExternalMongoshCommand(raw);

      if (raw === 'db') {
        if (ranExternally) return;
        appendEntries([{ kind: 'text', lines: [currentDb] }]);
        setTab('console');
        return;
      }
      const useMatch = raw.match(/^use\s+([A-Za-z0-9_.-]+)$/);
      if (useMatch) {
        setCurrentDb(useMatch[1]);
        // Persist directly, not just via the mirroring effect: the switch is
        // awaited above, so the tab may already have been switched away and
        // this instance unmounted. `setCurrentDb` would then be a no-op and the
        // mongosh child would sit on the new database while the remounted UI
        // restored the old one — with the prompt and the driver-backed
        // commands aimed somewhere the raw shell commands are not.
        persistSession({ currentDb: useMatch[1] });
        if (!ranExternally) {
          appendEntries([
            { kind: 'note', text: t('mongoShell.notes.switchedToDb', { db: useMatch[1] }) },
          ]);
        }
        setTab('console');
        return;
      }
      if (/^show\s+(dbs|databases)$/i.test(raw)) {
        if (ranExternally) return;
        const dbs = await invoke<string[]>('list_databases', { id: connectionId });
        appendEntries([{ kind: 'text', lines: dbs }]);
        setTab('console');
        return;
      }
      if (/^show\s+(collections|tables)$/i.test(raw)) {
        if (ranExternally) return;
        const collections = await invoke<{ name: string }[]>('list_collections', { id: connectionId, db: currentDb });
        appendEntries([{ kind: 'text', lines: collections.map((c) => c.name) }]);
        setTab('console');
        return;
      }

      const collMatch =
        raw.match(/^db\.getCollection\(["']([^"']+)["']\)\.([\s\S]+)$/) ||
        raw.match(/^db\.([A-Za-z_$][\w$]*)\.([\s\S]+)$/);

      const { calls, rest } = collMatch
        ? splitCalls(collMatch[2])
        : { calls: [] as ParsedCall[], rest: '' };

      const STRUCTURED_OPS = ['find', 'findOne', 'aggregate', 'countDocuments', 'count', 'getIndexes'];
      const isSingleStructured =
        !!collMatch && calls.length > 0 && rest.trim() === '' && STRUCTURED_OPS.includes(calls[0].name);

      if (isSingleStructured) {
        const collName = collMatch![1];
        const op = calls[0].name;
        if (op === 'find') {
          await executeFind(collName, calls, `db.${collName}.find()`);
        } else if (op === 'findOne') {
          await executeFind(collName, calls, `db.${collName}.findOne()`, 1);
        } else if (op === 'aggregate') {
          await executeAggregate(collName, calls);
        } else if (op === 'countDocuments' || op === 'count') {
          const started = performance.now();
          const count = await invoke<number>('count_documents', {
            id: connectionId,
            database: currentDb,
            collection: collName,
            filter: JSON.stringify(parseLoose(firstArg(calls[0].argText), {}, t)),
          });
          appendEntries([{ kind: 'value', value: count }, { kind: 'note', text: `${Math.round((performance.now() - started) * 10) / 10} ms` }]);
          setTab('console');
        } else if (op === 'getIndexes') {
          const indexes = await invoke<string[]>('list_indexes', { id: connectionId, db: currentDb, collection: collName });
          appendEntries([{ kind: 'value', value: indexes.map((name) => ({ name })) }]);
          setTab('console');
        }
        return;
      }

      // Anything else is a JavaScript script. With a live session it already ran
      // via runExternalMongoshCommand above (console output shown). The shell is
      // gated behind a session, so the no-session case is unreachable in practice;
      // guard defensively.
      if (ranExternally) return;
      throw new Error(t('mongoShell.errors.sessionRequiredForScripts'));
    } catch (err: any) {
      appendEntries([{ kind: 'error', message: err.message || String(err) }]);
      setTab('console');
    } finally {
      setRunning(false);
    }
  };

  runRef.current = () => runCommand();
  viewerRef.current = viewer;

  useEffect(() => {
    if (!initialCommand || autoRunRef.current || !sessionAttempted || !sessionId) return;
    autoRunRef.current = true;
    persistSession({ autoRanCommand: true });
    runCommand(initialCommand);
    // Run exactly once for the command that opened this shell tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCommand, sessionAttempted, sessionId, sessionKey]);

  const dragging = useRef(false);
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!dragging.current || !wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      setTopHeight(Math.max(120, Math.min(rect.height - 180, event.clientY - rect.top)));
    };
    const up = () => {
      dragging.current = false;
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  // The shell requires a live mongosh session. Until one is attached, gate the
  // body with a starting spinner or a setup screen (Open Settings / Retry).
  if (!sessionId) {
    return (
      <div className="flex h-full flex-col bg-background" data-testid="shell-session-gate">
        <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 p-8 text-center select-none">
          {!sessionAttempted ? (
            <>
              <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
              <span className="text-sm text-muted-foreground">{t('mongoShell.gate.startingSession')}</span>
            </>
          ) : (
            <>
              <Terminal size={28} className="text-muted-foreground" />
              <div className="text-sm font-semibold text-foreground">{t('mongoShell.gate.requiresMongosh')}</div>
              <div className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                {t('mongoShell.gate.requiresMongoshBody')}
              </div>
              {detectedMongosh && (
                <div
                  className="max-w-sm rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs"
                  data-testid="shell-detected-mongosh"
                >
                  <div className="text-foreground">
                    {t('mongoShell.gate.found')}{' '}
                    <span className="font-semibold">
                      {t('mongoShell.gate.foundMongoshVersion', { version: detectedMongosh.version })}
                    </span>
                  </div>
                  <div className="truncate font-mono text-ui-2xs text-muted-foreground" title={detectedMongosh.path}>
                    {detectedMongosh.path}
                  </div>
                  <Button
                    size="sm"
                    className="mt-1.5"
                    onClick={() => void saveMongoshPath(detectedMongosh.path)}
                    data-testid="shell-use-detected-btn"
                  >
                    {t('mongoShell.gate.useThisBinary')}
                  </Button>
                </div>
              )}
              <div className="mt-1 flex items-center gap-2">
                {onInstallTools && (
                  <Button onClick={onInstallTools} data-testid="shell-install-tools-btn">
                    {t('mongoShell.gate.installTools')}
                  </Button>
                )}
                <Button variant="outline" onClick={() => void browseForMongosh()} data-testid="shell-browse-mongosh-btn">
                  {t('mongoShell.gate.browseForBinary')}
                </Button>
                {onOpenSettings && (
                  <Button variant="outline" onClick={onOpenSettings} data-testid="gate-open-settings">
                    {t('mongoShell.gate.openSettings')}
                  </Button>
                )}
                <Button variant="outline" onClick={() => setRetryNonce((n) => n + 1)} data-testid="gate-retry">
                  {t('mongoShell.gate.retry')}
                </Button>
              </div>
              <div className="max-w-sm text-ui-2xs text-muted-foreground" data-testid="shell-install-hint">
                <Trans i18nKey="shell:mongoShell.gate.installHint" t={t} values={{ hint: installHint }}>
                  Or install it yourself:{' '}
                  <code className="font-mono">{{ hint: installHint } as unknown as string}</code>{' '}
                  — see the{' '}
                  <button
                    type="button"
                    className="text-primary underline-offset-2 hover:underline"
                    onClick={() => void openUrl('https://www.mongodb.com/docs/mongodb-shell/install/')}
                    data-testid="shell-mongosh-docs-link"
                  >
                    mongosh install docs
                  </button>
                  .
                </Trans>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-row">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" ref={wrapRef} data-testid="mongo-shell">
      <div
        className="flex min-h-0 flex-col border-b border-border"
        style={topHeight != null ? { height: topHeight, flex: 'none' } : { flex: 1 }}
      >
        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
          <Terminal size={12} className="text-success" />
          <span className="text-xs font-semibold text-foreground">mongosh</span>
          <span className="font-mono text-[11px] text-muted-foreground">{connectionName} · {currentDb}</span>
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-muted-foreground">
            {formatShortcut(shortcutById('run-query')!)}
          </span>
          <Button size="sm" onClick={() => runRef.current()} disabled={running}>
            <Play size={11} />
            {t('mongoShell.toolbar.run')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void restartSession()}
            disabled={restarting || running}
            data-testid="shell-restart-session"
            title={t('mongoShell.toolbar.restartSessionTitle')}
          >
            <RotateCcw size={11} />
            {t('mongoShell.toolbar.restartSession')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAIOpen(!isAIOpen)}
            data-testid="shell-ai-toggle"
            title={t('mongoShell.toolbar.aiToggleTitle')}
          >
            <Sparkles size={11} />
            {t('mongoShell.toolbar.aiToggleLabel')}
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <Editor
            value={command}
            onChange={(value) => setCommand(value || '')}
            defaultLanguage="javascript"
            theme={monacoTheme}
            options={{
              fontFamily: 'JetBrains Mono, SF Mono, Consolas, monospace',
              fontSize: monacoFontSize,
              // Must follow the font: Monaco treats lineHeight >= 8 as absolute px, so
              // a fixed 21 clips descenders once the font scales past it.
              lineHeight: Math.round(monacoFontSize * 1.6),
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbersMinChars: 3,
              glyphMargin: false,
              folding: false,
              wordWrap: 'on',
              automaticLayout: true,
              tabSize: 2,
              contextmenu: false,
              // Enter accepts an open suggestion; otherwise inserts a newline.
              acceptSuggestionOnEnter: 'on',
            }}
            onMount={(editor, monaco) => {
              registerMqlensMonacoThemes(monaco);
              monaco.editor.setTheme(monacoTheme);
              // Enter accepts an open suggestion, else newline. Ctrl/Cmd+Enter
              // runs — scoped via onKeyDown (not addCommand, which leaks globally).
              editor.onKeyDown((e) => {
                if ((e.ctrlKey || e.metaKey) && e.keyCode === monaco.KeyCode.Enter) {
                  e.preventDefault();
                  e.stopPropagation();
                  runRef.current();
                }
              });
              editor.focus();
              registerMongoCompletionProvider(monaco);
              // mongosh is a REPL, not a linter: like the real shell we don't
              // statically red-squiggle in-progress JS (errors surface on run).
              // Explicit here so the behavior is intentional and independent of
              // whether a query editor (which disables diagnostics globally) has
              // mounted first.
              monaco.languages.typescript?.javascriptDefaults?.setDiagnosticsOptions({
                noSemanticValidation: true,
                noSyntaxValidation: true,
                noSuggestionDiagnostics: true,
              });
              const model = editor.getModel();
              if (model) {
                const uri = model.uri.toString();
                setModelMeta(uri, {
                  surface: 'shell',
                  getFields: () => {
                    const docs = viewerRef.current?.docs ?? [];
                    const keys = new Set<string>(['_id']);
                    docs.forEach((d) => {
                      if (d && typeof d === 'object') Object.keys(d).forEach((k) => keys.add(k));
                    });
                    return Array.from(keys);
                  },
                  getSchema: () => undefined,
                  getCollections: () => collectionsRef.current,
                });
                editor.onDidDispose(() => clearModelMeta(uri));
              }
            }}
            loading={
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <Terminal size={22} />
                <span>{t('mongoShell.editor.loading')}</span>
              </div>
            }
          />
        </div>
      </div>

      <div
        className="flex h-1 flex-shrink-0 cursor-row-resize items-center justify-center bg-border/50 hover:bg-primary/30"
        onMouseDown={() => {
          dragging.current = true;
          document.body.style.cursor = 'row-resize';
        }}
      >
        <span className="h-0.5 w-8 rounded-full bg-muted-foreground/40" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border bg-card px-2 py-1">
          <Tabs value={tab} onValueChange={(v) => setTab(v as ShellTab)}>
            <TabsList className="h-8 bg-transparent p-0">
              <TabsTrigger
                value="console"
                className="gap-1.5 rounded-none border-b-2 border-transparent text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent"
                onClick={() => setTab('console')}
              >
                <Terminal size={12} className={tab === 'console' ? 'text-success' : ''} />
                {t('mongoShell.console.tabLabel')}
              </TabsTrigger>
              {viewer && (
                <TabsTrigger
                  value="viewer"
                  className="gap-1.5 rounded-none border-b-2 border-transparent text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent"
                  onClick={() => setTab('viewer')}
                >
                  <Braces size={12} className={tab === 'viewer' ? 'text-primary' : ''} />
                  {t('mongoShell.console.dataViewerTabLabel')}
                  <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">{viewer.docs.length}</Badge>
                </TabsTrigger>
              )}
            </TabsList>
          </Tabs>
          <span className="flex-1" />
          {tab === 'console' ? (
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" title={t('mongoShell.console.clearTitle')} onClick={() => setEntries([])}>
              <Eraser size={12} />
            </Button>
          ) : (
            viewer && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {viewer.label} · {viewer.ms} ms
              </span>
            )
          )}
        </div>

        {tab === 'console' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-xs" ref={scrollRef}>
            {entries.length === 0 && (
              <div className="py-4 text-center text-muted-foreground">{t('mongoShell.console.cleared')}</div>
            )}
            {entries.map((entry, index) => {
              if (entry.kind === 'input') {
                return (
                  <div className="flex gap-2 py-0.5 text-foreground" key={index}>
                    <span className="text-success">{entry.db}&gt;</span>
                    <span>{entry.text}</span>
                  </div>
                );
              }
              if (entry.kind === 'note') {
                return (
                  <div className="flex items-center gap-1.5 py-0.5 text-muted-foreground" key={index}>
                    <CornerDownLeft size={12} />
                    <span>{entry.text}</span>
                  </div>
                );
              }
              if (entry.kind === 'error') {
                return (
                  <div className="flex items-center gap-1.5 py-0.5 text-destructive" key={index}>
                    <AlertCircle size={12} />
                    <span>{entry.message}</span>
                  </div>
                );
              }
              if (entry.kind === 'text') {
                return (
                  <pre className="m-0 whitespace-pre-wrap py-0.5 text-muted-foreground" key={index}>
                    {entry.lines.join('\n')}
                  </pre>
                );
              }
              return <HighlightedValue key={index} value={entry.value} />;
            })}
          </div>
        ) : (
          viewer && <DataGrid documents={viewer.docs} density={density} />
        )}
      </div>
    </div>
    <AIChatPanel
      variant="shell"
      connectionId={connectionId}
      connectionName={connectionName}
      databaseName={currentDb}
      collectionName={aiCollection}
      isOpen={isAIOpen}
      onClose={() => setIsAIOpen(false)}
      onInsertQuery={handleAIInsert}
      onInsertAndRunQuery={handleAIInsertAndRun}
      sessionKey={sessionKey}
      chatId={aiChatId}
      onChatIdChange={handleAiChatIdChange}
      initialMessages={aiMessages}
      onMessagesChange={handleAiMessagesChange}
    />
    {pendingDestructive && (
      <Dialog open onOpenChange={() => {}}>
        <DialogContent
          className="sm:max-w-[520px] [&>button.absolute]:hidden"
          data-testid="destructive-confirm"
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            cancelDestructive();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <AlertCircle size={18} className="text-destructive" />
              {t('mongoShell.destructiveDialog.title')}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <Trans i18nKey="shell:mongoShell.destructiveDialog.body" t={t} values={{ operation: pendingDestructive.operation }}>
              This script runs <strong className="text-foreground">{{ operation: pendingDestructive.operation } as unknown as string}</strong>, which can permanently
              delete data. Review it before running.
            </Trans>
          </p>
          <pre className="max-h-[200px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">
            {pendingDestructive.command}
          </pre>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={cancelDestructive} data-testid="destructive-cancel">
              {t('mongoShell.destructiveDialog.cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDestructive} data-testid="destructive-run">
              <Play size={11} />
              {t('mongoShell.destructiveDialog.runAnyway')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
    </div>
  );
};
