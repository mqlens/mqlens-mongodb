import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { invoke } from '@tauri-apps/api/core';
import { AlertCircle, Braces, CornerDownLeft, Eraser, Play, Sparkles, Terminal } from 'lucide-react';
import { AIChatPanel } from './AIChatPanel';
import { buildRunnableCommand, guardScriptRun, type GeneratedQuery } from '../lib/mongoCommand';
import { DataGrid } from './DataGrid';
import { registerMongoCompletionProvider, setModelMeta, clearModelMeta } from '../lib/monacoMongo';

type ShellTab = 'console' | 'viewer';

type ShellEntry =
  | { kind: 'input'; db: string; text: string }
  | { kind: 'text'; lines: string[] }
  | { kind: 'value'; value: unknown }
  | { kind: 'note'; text: string }
  | { kind: 'error'; message: string };

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
}

interface ParsedCall {
  name: string;
  argText: string;
}

const HELP_LINES = [
  'Shell helpers',
  '  show dbs                 list databases',
  '  show collections         list collections in current db',
  '  use <db>                 switch current database',
  '',
  'Collection methods (rendered in the Data Viewer)',
  '  db.<coll>.find(<query>).sort(<sort>).skip(n).limit(n)',
  '  db.<coll>.findOne(<query>)',
  '  db.<coll>.aggregate([{ $match }, { $sort }, { $skip }, { $limit }])',
  '  db.<coll>.countDocuments(<query>)',
  '  db.<coll>.getIndexes()',
  '',
  'JavaScript scripts (run via mongosh)',
  '  Write multi-line JS: variables, loops, functions, try/catch.',
  '  printjson(db.<coll>.find().toArray())   print results',
  '  load("script.js")                       run a .js file',
  '',
  '  cls / clear              clear this console',
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

const parseLoose = (source: string, fallback: unknown = {}) => {
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
      throw new Error(`Invalid mongosh JSON literal: ${trimmed}`);
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
  <pre className="mql-shell-pre">{stringifyShellValue(value)}</pre>
);

const createLogId = () => {
  const alphabet = '0123456789abcdef';
  return Array.from({ length: 24 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
};

const extractVersion = (value: unknown) => {
  const text = typeof value === 'string' ? value : '';
  return text.match(/\d+\.\d+\.\d+(?:[-\w.]*)?/)?.[0] || text || 'unavailable';
};

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
}) => {
  const [currentDb, setCurrentDb] = useState(databaseName);
  const startupLogId = useMemo(createLogId, []);
  // Display the connection name in the startup banner, never the URI — the URI
  // can contain credentials (e.g. user:password@host) that must not be logged.
  const connectionTarget = connectionName || connectionUri;
  const defaultCommand = useMemo(
    () => initialCommand || (collectionName ? `db.${collectionName}.find({}).limit(50)` : 'show collections'),
    [collectionName, initialCommand]
  );
  const [command, setCommand] = useState(defaultCommand);
  const [isAIOpen, setIsAIOpen] = useState(false);
  const [pendingDestructive, setPendingDestructive] =
    useState<{ command: string; operation: string } | null>(null);
  const [entries, setEntries] = useState<ShellEntry[]>([
    { kind: 'text', lines: buildStartupLines(startupLogId, connectionTarget) },
  ]);
  const [viewer, setViewer] = useState<{ docs: Record<string, any>[]; label: string; ms: number } | null>(null);
  const [tab, setTab] = useState<ShellTab>('console');
  const [running, setRunning] = useState(false);
  const [topHeight, setTopHeight] = useState<number | null>(null);
  const [mongoshPath, setMongoshPath] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionAttempted, setSessionAttempted] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<() => void>(() => {});
  const autoRunRef = useRef(false);
  // Tracks the latest result docs so the Monaco completion provider (registered
  // once in onMount) can derive field names from the current results.
  const viewerRef = useRef<{ docs: Record<string, any>[] } | null>(null);
  // Collection names for the current db, for `db.<coll>` completions in the shell.
  const collectionsRef = useRef<string[]>([]);
  useEffect(() => {
    let alive = true;
    invoke<string[]>('list_collections', { id: connectionId, db: currentDb })
      .then((cols) => { if (alive) collectionsRef.current = cols; })
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

  const appendCommandOutput = (output: MongoshCommandOutput) => {
    const nextEntries: ShellEntry[] = [];
    if (output.stdout.length > 0) nextEntries.push({ kind: 'text', lines: output.stdout });
    if (output.stderr.length > 0) nextEntries.push({ kind: 'error', message: output.stderr.join('\n') });
    if (nextEntries.length > 0) {
      setEntries((prev) => [...prev, ...nextEntries]);
    }
  };

  useEffect(() => {
    if (mongoshPath === null) return;
    if (!connectionUri) {
      setSessionAttempted(true);
      return;
    }
    let cancelled = false;
    let openedSessionId: string | null = null;
    setSessionId(null);
    setSessionAttempted(false);

    const startSession = async () => {
      try {
        const session = await invoke<MongoshSessionInfo>('start_mongosh_session', {
          connectionId,
          uri: connectionUri,
          database: currentDb,
          mongoshPath,
        });
        if (cancelled) {
          await invoke('stop_mongosh_session', { sessionId: session.session_id }).catch(() => undefined);
          return;
        }
        openedSessionId = session.session_id;
        setSessionId(session.session_id);
        if (session.stdout.length > 0 || session.stderr.length > 0) {
          appendCommandOutput({ stdout: session.stdout, stderr: session.stderr });
        }
        setEntries((prev) => [...prev, { kind: 'note', text: 'mongosh session attached' }]);
      } catch (err: any) {
        if (!cancelled) {
          setSessionId(null);
          setEntries((prev) => [
            ...prev,
            { kind: 'error', message: `mongosh session unavailable: ${err.message || String(err)}` },
          ]);
        }
      } finally {
        if (!cancelled) setSessionAttempted(true);
      }
    };

    startSession();

    return () => {
      cancelled = true;
      if (openedSessionId) {
        invoke('stop_mongosh_session', { sessionId: openedSessionId }).catch(() => undefined);
      }
    };
    // The session is started once per shell tab. currentDb is intentionally used only as startup database.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, connectionUri, mongoshPath, retryNonce]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, tab]);

  const executeFind = async (
    collName: string,
    calls: ParsedCall[],
    label: string,
    forceLimit?: number
  ) => {
    const op = calls[0];
    const call = (name: string) => calls.find((candidate) => candidate.name === name);
    const filter = parseLoose(firstArg(op.argText), {});
    const sort = call('sort') ? parseLoose(call('sort')!.argText, {}) : {};
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
    setEntries((prev) => [
      ...prev,
      {
        kind: 'note',
        text: `${docs.length} document${docs.length === 1 ? '' : 's'} -> Data Viewer`,
      },
    ]);
  };

  const executeAggregate = async (collName: string, calls: ParsedCall[]) => {
    const pipeline = parseLoose(calls[0].argText, []) as Array<Record<string, unknown>>;
    if (!Array.isArray(pipeline)) throw new Error('aggregate() expects a pipeline array');
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
    setEntries((prev) => [
      ...prev,
      {
        kind: 'note',
        text: `${docs.length} document${docs.length === 1 ? '' : 's'} -> Data Viewer`,
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
    setEntries((prev) => [...prev, { kind: 'note', text: 'Destructive command cancelled.' }]);
  };

  const runCommand = async (commandOverride?: string) => {
    const raw = (commandOverride ?? command).trim().replace(/;$/, '');
    if (!raw || running) return;
    setEntries((prev) => [...prev, { kind: 'input', db: currentDb, text: raw }]);
    setRunning(true);
    try {
      if (/^(cls|clear)$/i.test(raw)) {
        setEntries([]);
        setTab('console');
        return;
      }
      if (/^help$/i.test(raw)) {
        setEntries((prev) => [...prev, { kind: 'text', lines: HELP_LINES }]);
        setTab('console');
        return;
      }
      const ranExternally = await runExternalMongoshCommand(raw);

      if (raw === 'db') {
        if (ranExternally) return;
        setEntries((prev) => [...prev, { kind: 'text', lines: [currentDb] }]);
        setTab('console');
        return;
      }
      const useMatch = raw.match(/^use\s+([A-Za-z0-9_.-]+)$/);
      if (useMatch) {
        setCurrentDb(useMatch[1]);
        if (!ranExternally) {
          setEntries((prev) => [...prev, { kind: 'note', text: `switched to db ${useMatch[1]}` }]);
        }
        setTab('console');
        return;
      }
      if (/^show\s+(dbs|databases)$/i.test(raw)) {
        if (ranExternally) return;
        const dbs = await invoke<string[]>('list_databases', { id: connectionId });
        setEntries((prev) => [...prev, { kind: 'text', lines: dbs }]);
        setTab('console');
        return;
      }
      if (/^show\s+(collections|tables)$/i.test(raw)) {
        if (ranExternally) return;
        const collections = await invoke<{ name: string }[]>('list_collections', { id: connectionId, db: currentDb });
        setEntries((prev) => [...prev, { kind: 'text', lines: collections.map((c) => c.name) }]);
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
            filter: JSON.stringify(parseLoose(firstArg(calls[0].argText), {})),
          });
          setEntries((prev) => [...prev, { kind: 'value', value: count }, { kind: 'note', text: `${Math.round((performance.now() - started) * 10) / 10} ms` }]);
          setTab('console');
        } else if (op === 'getIndexes') {
          const indexes = await invoke<string[]>('list_indexes', { id: connectionId, db: currentDb, collection: collName });
          setEntries((prev) => [...prev, { kind: 'value', value: indexes.map((name) => ({ name })) }]);
          setTab('console');
        }
        return;
      }

      // Anything else is a JavaScript script. With a live session it already ran
      // via runExternalMongoshCommand above (console output shown). The shell is
      // gated behind a session, so the no-session case is unreachable in practice;
      // guard defensively.
      if (ranExternally) return;
      throw new Error('mongosh session required to run scripts');
    } catch (err: any) {
      setEntries((prev) => [...prev, { kind: 'error', message: err.message || String(err) }]);
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
    runCommand(initialCommand);
    // Run exactly once for the command that opened this shell tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCommand, sessionAttempted, sessionId]);

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
      <div className="mql-shell" data-testid="shell-session-gate" style={{ height: '100%' }}>
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 p-8 h-full select-none">
          {!sessionAttempted ? (
            <>
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent-blue)]" />
              <span className="text-sm text-[var(--text-muted)]">Starting mongosh session…</span>
            </>
          ) : (
            <>
              <Terminal size={28} className="text-[var(--text-dim)]" />
              <div className="text-sm font-semibold text-[var(--text-main)]">MongoShell requires mongosh</div>
              <div className="text-[12px] text-[var(--text-dim)] max-w-sm leading-relaxed">
                A live mongosh session is required to run queries and scripts here.
                Install mongosh and set its path in Settings, then retry.
              </div>
              <div className="flex items-center gap-2 mt-1">
                {onOpenSettings && (
                  <button
                    className="mql-btn mql-btn-primary"
                    onClick={onOpenSettings}
                    data-testid="gate-open-settings"
                  >
                    Open Settings
                  </button>
                )}
                <button
                  className="mql-btn mql-btn-ghost mql-btn-outlined"
                  onClick={() => setRetryNonce((n) => n + 1)}
                  data-testid="gate-retry"
                >
                  Retry
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mql-shell-with-ai" style={{ display: 'flex', flexDirection: 'row', height: '100%' }}>
    <div className="mql-shell" ref={wrapRef} data-testid="mongo-shell" style={{ flex: 1, minWidth: 0 }}>
      <div className="mql-shell-editor" style={topHeight != null ? { height: topHeight, flex: 'none' } : undefined}>
        <div className="mql-shell-toolbar">
          <Terminal size={12} color="var(--accent-green)" />
          <span className="mql-shell-toolbar-title">mongosh</span>
          <span className="mql-mono mql-shell-toolbar-ns">{connectionName} · {currentDb}</span>
          <span style={{ flex: 1 }} />
          <span className="mql-shell-run-hint mql-mono">Ctrl/⌘↵</span>
          <button className="mql-btn mql-btn-primary" onClick={() => runRef.current()} disabled={running}>
            <Play size={11} fill="white" />
            Run
          </button>
          <button
            className="mql-btn mql-btn-ghost mql-btn-outlined"
            onClick={() => setIsAIOpen((v) => !v)}
            data-testid="shell-ai-toggle"
            title="AI assistant"
          >
            <Sparkles size={11} />
            AI
          </button>
        </div>
        <div className="mql-shell-monaco">
          <Editor
            value={command}
            onChange={(value) => setCommand(value || '')}
            defaultLanguage="javascript"
            theme="vs-dark"
            options={{
              fontFamily: 'JetBrains Mono, SF Mono, Consolas, monospace',
              fontSize: 13,
              lineHeight: 21,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbersMinChars: 3,
              glyphMargin: false,
              folding: false,
              wordWrap: 'on',
              automaticLayout: true,
              tabSize: 2,
              contextmenu: false,
            }}
            onMount={(editor, monaco) => {
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
              editor.focus();
              registerMongoCompletionProvider(monaco);
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
              <div className="mql-shell-monaco-loading">
                <Terminal size={22} color="var(--text-dim)" />
                <span>Loading editor...</span>
              </div>
            }
          />
        </div>
      </div>

      <div
        className="mql-shell-divider"
        onMouseDown={() => {
          dragging.current = true;
          document.body.style.cursor = 'row-resize';
        }}
      >
        <span className="mql-shell-divider-grip" />
      </div>

      <div className="mql-shell-output">
        <div className="mql-shell-tabs">
          <button className={`mql-shell-tab ${tab === 'console' ? 'is-active' : ''}`} onClick={() => setTab('console')}>
            <Terminal size={12} color={tab === 'console' ? 'var(--accent-green)' : 'currentColor'} />
            <span>Console</span>
          </button>
          {viewer && (
            <button className={`mql-shell-tab ${tab === 'viewer' ? 'is-active' : ''}`} onClick={() => setTab('viewer')}>
              <Braces size={12} color={tab === 'viewer' ? 'var(--accent-blue)' : 'currentColor'} />
              <span>Data Viewer</span>
              <span className="mql-shell-tab-count">{viewer.docs.length}</span>
            </button>
          )}
          <span style={{ flex: 1 }} />
          {tab === 'console' ? (
            <button className="mql-icon-btn" title="Clear console" onClick={() => setEntries([])}>
              <Eraser size={12} />
            </button>
          ) : (
            viewer && <span className="mql-mono mql-shell-viewer-src">{viewer.label} · {viewer.ms} ms</span>
          )}
        </div>

        {tab === 'console' ? (
          <div className="mql-shell-scroll" ref={scrollRef}>
            {entries.length === 0 && <div className="mql-shell-empty">Console cleared - run a command above.</div>}
            {entries.map((entry, index) => {
              if (entry.kind === 'input') {
                return (
                  <div className="mql-shell-line mql-shell-input-echo" key={index}>
                    <span className="mql-shell-prompt">{entry.db}&gt;</span>
                    <span className="mql-shell-cmd">{entry.text}</span>
                  </div>
                );
              }
              if (entry.kind === 'note') {
                return (
                  <div className="mql-shell-line mql-shell-note" key={index}>
                    <CornerDownLeft size={12} />
                    <span>{entry.text}</span>
                  </div>
                );
              }
              if (entry.kind === 'error') {
                return (
                  <div className="mql-shell-line mql-shell-err" key={index}>
                    <AlertCircle size={12} />
                    <span>{entry.message}</span>
                  </div>
                );
              }
              if (entry.kind === 'text') {
                return <pre className="mql-shell-pre mql-shell-text" key={index}>{entry.lines.join('\n')}</pre>;
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
      databaseName={currentDb}
      collectionName={aiCollection}
      isOpen={isAIOpen}
      onClose={() => setIsAIOpen(false)}
      onInsertQuery={handleAIInsert}
      onInsertAndRunQuery={handleAIInsertAndRun}
    />
    {pendingDestructive && (
      <div
        className="mql-modal-overlay"
        data-testid="destructive-confirm"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 50,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          className="mql-modal"
          style={{
            background: 'var(--bg-panel, #1e1e1e)',
            border: '1px solid var(--border, #333)',
            borderRadius: 8,
            padding: 20,
            maxWidth: 520,
            width: '90%',
            boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <AlertCircle size={18} color="var(--accent-red, #f87171)" />
            <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>Destructive operation</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
            This script runs <strong>{pendingDestructive.operation}</strong>, which can permanently
            delete data. Review it before running.
          </p>
          <pre
            className="mql-shell-pre"
            style={{
              maxHeight: 200,
              overflow: 'auto',
              marginBottom: 16,
              padding: 10,
              background: 'var(--bg-code, #111)',
              borderRadius: 6,
            }}
          >
            {pendingDestructive.command}
          </pre>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              className="mql-btn mql-btn-ghost mql-btn-outlined"
              onClick={cancelDestructive}
              data-testid="destructive-cancel"
            >
              Cancel
            </button>
            <button
              className="mql-btn mql-btn-primary"
              onClick={confirmDestructive}
              data-testid="destructive-run"
            >
              <Play size={11} fill="white" />
              Run anyway
            </button>
          </div>
        </div>
      </div>
    )}
    </div>
  );
};
