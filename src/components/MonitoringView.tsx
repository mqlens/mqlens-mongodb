import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Activity,
  RefreshCw,
  Skull,
  Lock,
  Network,
  Gauge,
  MemoryStick,
  Database,
  ArrowDownUp,
  Search,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DraggableDialogContent } from '@/components/ui/draggable-dialog-content';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatBytes } from '../lib/format';
import { useEscapeClose } from '../lib/useEscapeClose';
import {
  serverStatus,
  currentOps,
  killOp,
  getProfilingStatus,
  setProfilingLevel,
  readProfile,
  replSetStatus,
  type ServerStatus,
  type CurrentOp,
  type ProfilingStatus,
  type ProfileEntry,
  type ReplSetStatus,
} from '../lib/monitoringApi';
import { lagText, lagClass, memberUnhealthy, memberDotClass, fmtMemberUptime } from '@/lib/clusterHealth';

interface MonitoringViewProps {
  connectionId: string;
}

const REFRESH_OPTIONS: { label: string; ms: number }[] = [
  { label: '5s', ms: 5000 },
  { label: '10s', ms: 10000 },
  { label: '30s', ms: 30000 },
  { label: '1m', ms: 60000 },
  { label: 'Off', ms: 0 },
];
const DEFAULT_POLL_MS = 10000;
const MAX_SAMPLES = 30;
const TABLE_CMD_CHARS = 120;

type Section = 'ops' | 'profiler' | 'cluster';

/** Lean time-series point — avoids retaining full ServerStatus per sample. */
interface MetricSample {
  t: number;
  connections: number;
  residentMb: number;
  cachePct: number;
  totalOps: number;
  netBytes: number;
}

const totalOps = (s: ServerStatus): number => {
  const o = s.opcounters;
  return o.insert + o.query + o.update + o.delete + o.getmore + o.command;
};

const sampleFromStatus = (t: number, s: ServerStatus): MetricSample => ({
  t,
  connections: s.connections.current,
  residentMb: s.memory.residentMb,
  cachePct:
    s.cache && s.cache.maxBytes > 0 ? (s.cache.bytesInCache / s.cache.maxBytes) * 100 : 0,
  totalOps: totalOps(s),
  netBytes: s.network.bytesIn + s.network.bytesOut,
});

const SparklineSvg: React.FC<{ data: number[]; color: string; className?: string }> = ({
  data,
  color,
  className,
}) => {
  const path = useMemo(() => {
    if (data.length < 2) return '';
    const w = 120;
    const h = 32;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const step = w / (data.length - 1);
    return data
      .map((v, i) => {
        const x = i * step;
        const y = h - ((v - min) / range) * (h - 4) - 2;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [data]);

  if (data.length < 2) {
    return <div className={cn('h-8 rounded bg-muted/40', className)} />;
  }

  return (
    <svg viewBox="0 0 120 32" className={cn('h-8 w-full', className)} preserveAspectRatio="none" aria-hidden>
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

const MetricTile: React.FC<{
  label: string;
  value: string;
  sub?: string;
  series: number[];
  color: string;
  icon: React.ReactNode;
}> = ({ label, value, sub, series, color, icon }) => (
  <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card/50 px-2.5 py-1.5">
    <span className="shrink-0" style={{ color }}>{icon}</span>
    <div className="min-w-0 flex-1">
      <div className="truncate text-[10px] text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-semibold tabular-nums leading-tight">{value}</div>
      {sub && <div className="truncate text-[9px] text-muted-foreground">{sub}</div>}
    </div>
    <div className="hidden w-16 shrink-0 sm:block">
      <SparklineSvg data={series} color={color} className="h-6" />
    </div>
  </div>
);

const OP_COLORS: Record<string, string> = {
  query: '#38bdf8',
  command: '#94a3b8',
  getmore: '#22d3ee',
  insert: '#34d399',
  update: '#f59e0b',
  remove: '#f87171',
  delete: '#f87171',
  none: '#64748b',
};
const opColor = (op: string): string => OP_COLORS[op?.toLowerCase()] ?? '#a78bfa';

const OpBadge: React.FC<{ op: string }> = ({ op }) => (
  <Badge
    variant="outline"
    className="font-mono text-[10px] uppercase"
    style={{ borderColor: opColor(op), color: opColor(op) }}
  >
    {op}
  </Badge>
);

const truncateCmd = (text: string, max = TABLE_CMD_CHARS): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
};

const HighlightedCommand: React.FC<{ text: string }> = ({ text }) => {
  const nodes = useMemo<React.ReactNode[]>(() => {
    const out: React.ReactNode[] = [];
    const n = text.length;
    let i = 0;
    let k = 0;
    const span = (cls: string | undefined, s: string) =>
      out.push(cls ? <span key={k++} className={cls}>{s}</span> : <React.Fragment key={k++}>{s}</React.Fragment>);
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        let j = i + 1;
        while (j < n) {
          if (text[j] === '\\') { j += 2; continue; }
          if (text[j] === '"') { j++; break; }
          j++;
        }
        const str = text.slice(i, j);
        let p = j;
        while (p < n && /\s/.test(text[p])) p++;
        span(text[p] === ':' ? 'text-syntax-key' : 'text-syntax-string', str);
        i = j;
        continue;
      }
      if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(text[i + 1] || ''))) {
        let j = i + 1;
        while (j < n && /[0-9.]/.test(text[j])) j++;
        span('text-syntax-number', text.slice(i, j));
        i = j;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$]/.test(text[j])) j++;
        const word = text.slice(i, j);
        if (word === 'true' || word === 'false') span('text-syntax-boolean', word);
        else if (word === 'null') span('text-syntax-null', word);
        else {
          let p = j;
          while (p < n && /\s/.test(text[p])) p++;
          span(text[p] === '(' ? 'text-syntax-boolean' : undefined, word);
        }
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n && !/["0-9A-Za-z_$-]/.test(text[j])) j++;
      span('text-muted-foreground', text.slice(i, j));
      i = j;
    }
    return out;
  }, [text]);
  return <>{nodes}</>;
};

const fmtTs = (ms: number): string => {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
};

const DetailRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-border py-2 text-xs last:border-b-0">
    <span className="text-muted-foreground">{label}</span>
    <span className="min-w-0 text-foreground">{children}</span>
  </div>
);

const MonitoringDetail: React.FC<{
  detail: { kind: 'op'; data: CurrentOp } | { kind: 'profile'; data: ProfileEntry };
  onClose: () => void;
}> = ({ detail, onClose }) => {
  useEscapeClose(true, onClose);
  return (
    <Dialog open onOpenChange={() => {}}>
      <DraggableDialogContent
        defaultWidth={720}
        defaultHeight={480}
        minWidth={480}
        minHeight={320}
        hideClose
        className="flex min-h-0 flex-col gap-0 overflow-hidden p-0"
        data-testid="monitoring-detail"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <DialogHeader
          data-dialog-drag-handle
          className="flex shrink-0 cursor-grab flex-row items-center justify-between border-b border-border px-4 py-3 active:cursor-grabbing"
        >
          <DialogTitle className="text-sm">
            {detail.kind === 'op' ? 'Operation details' : 'Profiled operation'}
          </DialogTitle>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close">
            <X size={14} />
          </Button>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 py-2">
          {detail.kind === 'op' ? (
            <>
              <DetailRow label="opid">{detail.data.opid}</DetailRow>
              <DetailRow label="op"><OpBadge op={detail.data.op} /></DetailRow>
              <DetailRow label="ns">{detail.data.ns}</DetailRow>
              <DetailRow label="running">{detail.data.secsRunning}s</DetailRow>
              <DetailRow label="client">{detail.data.client}</DetailRow>
              <DetailRow label="desc">{detail.data.desc || '—'}</DetailRow>
            </>
          ) : (
            <>
              <DetailRow label="op"><OpBadge op={detail.data.op} /></DetailRow>
              <DetailRow label="ns">{detail.data.ns}</DetailRow>
              <DetailRow label="duration">{detail.data.millis} ms</DetailRow>
              <DetailRow label="plan">{detail.data.planSummary || '—'}</DetailRow>
              <DetailRow label="time">{fmtTs(detail.data.tsMs)}</DetailRow>
            </>
          )}
        </div>
        <div className="border-t border-border px-4 py-2 text-xs font-medium text-muted-foreground">Command</div>
        <pre
          className="mx-4 mb-4 max-h-48 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-[11px] text-foreground"
          data-testid="monitoring-detail-cmd"
        >
          <HighlightedCommand text={detail.data.command} />
        </pre>
        </div>
      </DraggableDialogContent>
    </Dialog>
  );
};

const isAuthError = (msg: string): boolean =>
  /not authorized|unauthorized|requires authentication|\(13\)|code 13/i.test(msg);

const AccessNote: React.FC<{ what: string; role?: string }> = ({ what, role = 'clusterMonitor' }) => (
  <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm" data-testid="access-required">
    <Lock size={15} className="mt-0.5 flex-shrink-0 text-warning" />
    <div>
      <strong className="text-foreground">Access required</strong>
      <p className="mt-1 text-xs text-muted-foreground">
        This connection&apos;s user isn&apos;t authorized to {what}. Grant the{' '}
        <code className="rounded bg-muted px-1 font-mono text-[11px]">{role}</code> role
        (or equivalent privilege) to enable it.
      </p>
    </div>
  </div>
);

const errLine = (msg: string): string => {
  const first = msg.split('\n')[0];
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
};

const OpRow = React.memo<{
  op: CurrentOp;
  onSelect: (op: CurrentOp) => void;
  onKill: (op: CurrentOp) => void;
}>(({ op, onSelect, onKill }) => (
  <tr
    className="cursor-pointer border-t border-border hover:bg-accent/50"
    data-testid={`op-row-${op.opid}`}
    onClick={() => onSelect(op)}
  >
    <td className="px-3 py-1.5 tabular-nums">{op.opid}</td>
    <td className="px-3 py-1.5"><OpBadge op={op.op} /></td>
    <td className="max-w-[140px] truncate px-3 py-1.5 font-mono">{op.ns}</td>
    <td className={cn('px-3 py-1.5 tabular-nums', op.secsRunning >= 5 && 'text-warning')}>{op.secsRunning}</td>
    <td className="px-3 py-1.5">{op.client}</td>
    <td className="max-w-[280px] truncate px-3 py-1.5 font-mono text-muted-foreground" title={op.command}>
      {truncateCmd(op.command)}
    </td>
    <td className="px-3 py-1.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-destructive hover:text-destructive"
        title="Kill operation"
        data-testid={`kill-op-${op.opid}`}
        onClick={(e) => { e.stopPropagation(); onKill(op); }}
      >
        <Skull size={12} />
      </Button>
    </td>
  </tr>
));
OpRow.displayName = 'OpRow';

const ProfileRow = React.memo<{
  entry: ProfileEntry;
  index: number;
  onSelect: (entry: ProfileEntry) => void;
}>(({ entry, index, onSelect }) => (
  <tr
    className="cursor-pointer border-t border-border hover:bg-accent/50"
    data-testid={`profile-row-${index}`}
    onClick={() => onSelect(entry)}
  >
    <td className={cn('px-3 py-1.5 tabular-nums', entry.millis >= 100 && 'text-warning')}>{entry.millis}</td>
    <td className="px-3 py-1.5"><OpBadge op={entry.op} /></td>
    <td className="max-w-[140px] truncate px-3 py-1.5 font-mono">{entry.ns}</td>
    <td className="px-3 py-1.5">{entry.planSummary}</td>
    <td className="max-w-[280px] truncate px-3 py-1.5 font-mono text-muted-foreground" title={entry.command}>
      {truncateCmd(entry.command)}
    </td>
  </tr>
));
ProfileRow.displayName = 'ProfileRow';

const FILTER_ALL = '__all__';

const filterBarSelectClass =
  'h-8 w-[108px] shrink-0 rounded-none border-0 border-l border-border bg-transparent text-xs shadow-none focus:ring-0 focus:ring-offset-0';

const FilterCount: React.FC<{ shown: number; total: number }> = ({ shown, total }) => (
  <div className="flex h-8 shrink-0 items-center border-l border-border bg-muted/40 px-3 tabular-nums text-muted-foreground">
    <span className="font-medium text-foreground">{shown}</span>
    <span className="mx-1">/</span>
    <span>{total}</span>
  </div>
);

const OpsFilterBar: React.FC<{
  search: string;
  onSearchChange: (v: string) => void;
  opType: string;
  onOpTypeChange: (v: string) => void;
  opTypes: string[];
  db: string;
  onDbChange: (v: string) => void;
  dbs: string[];
  minSecs: number;
  onMinSecsChange: (n: number) => void;
  shown: number;
  total: number;
}> = ({
  search,
  onSearchChange,
  opType,
  onOpTypeChange,
  opTypes,
  db,
  onDbChange,
  dbs,
  minSecs,
  onMinSecsChange,
  shown,
  total,
}) => (
  <div className="mb-2 flex h-8 overflow-hidden rounded-lg border border-border bg-background text-xs shadow-sm">
    <div className="relative flex min-w-[12rem] flex-1 items-center">
      <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        className="h-8 border-0 bg-transparent pl-8 text-xs shadow-none focus-visible:ring-0"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Filter ns, client, command…"
        data-testid="ops-search"
      />
    </div>
    <Select value={opType || FILTER_ALL} onValueChange={(v) => onOpTypeChange(v === FILTER_ALL ? '' : v)}>
      <SelectTrigger className={filterBarSelectClass} data-testid="ops-type-filter">
        <SelectValue placeholder="Op type" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL} className="text-xs">All ops</SelectItem>
        {opTypes.map((t) => (
          <SelectItem key={t} value={t} className="text-xs font-mono uppercase">{t}</SelectItem>
        ))}
      </SelectContent>
    </Select>
    <Select value={db || FILTER_ALL} onValueChange={(v) => onDbChange(v === FILTER_ALL ? '' : v)}>
      <SelectTrigger className={filterBarSelectClass} data-testid="ops-db-filter">
        <SelectValue placeholder="Database" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL} className="text-xs">All databases</SelectItem>
        {dbs.map((d) => (
          <SelectItem key={d} value={d} className="text-xs font-mono">{d}</SelectItem>
        ))}
      </SelectContent>
    </Select>
    <div className="flex h-8 shrink-0 items-center border-l border-border">
      <span className="px-2 text-muted-foreground">≥</span>
      <Input
        type="number"
        min={0}
        className="h-8 w-11 border-0 bg-transparent px-0 text-center text-xs tabular-nums shadow-none focus-visible:ring-0"
        value={minSecs}
        onChange={(e) => onMinSecsChange(Number(e.target.value) || 0)}
        data-testid="ops-min-secs"
        aria-label="Minimum seconds running"
      />
      <span className="border-l border-border px-2 text-muted-foreground">sec</span>
    </div>
    <FilterCount shown={shown} total={total} />
  </div>
);

const ProfileFilterBar: React.FC<{
  search: string;
  onSearchChange: (v: string) => void;
  op: string;
  onOpChange: (v: string) => void;
  opTypes: string[];
  minMs: number;
  onMinMsChange: (n: number) => void;
  shown: number;
  total: number;
}> = ({
  search,
  onSearchChange,
  op,
  onOpChange,
  opTypes,
  minMs,
  onMinMsChange,
  shown,
  total,
}) => (
  <div className="mb-2 flex h-8 overflow-hidden rounded-lg border border-border bg-background text-xs shadow-sm">
    <div className="relative flex min-w-[12rem] flex-1 items-center">
      <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        className="h-8 border-0 bg-transparent pl-8 text-xs shadow-none focus-visible:ring-0"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Filter ns, plan, command…"
        data-testid="profiler-search"
      />
    </div>
    <Select value={op || FILTER_ALL} onValueChange={(v) => onOpChange(v === FILTER_ALL ? '' : v)}>
      <SelectTrigger className={filterBarSelectClass} data-testid="profiler-type-filter">
        <SelectValue placeholder="Op type" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL} className="text-xs">All ops</SelectItem>
        {opTypes.map((t) => (
          <SelectItem key={t} value={t} className="text-xs font-mono uppercase">{t}</SelectItem>
        ))}
      </SelectContent>
    </Select>
    <div className="flex h-8 shrink-0 items-center border-l border-border">
      <span className="px-2 text-muted-foreground">≥</span>
      <Input
        type="number"
        min={0}
        className="h-8 w-11 border-0 bg-transparent px-0 text-center text-xs tabular-nums shadow-none focus-visible:ring-0"
        value={minMs}
        onChange={(e) => onMinMsChange(Number(e.target.value) || 0)}
        data-testid="profiler-min-ms"
        aria-label="Minimum duration in milliseconds"
      />
      <span className="border-l border-border px-2 text-muted-foreground">ms</span>
    </div>
    <FilterCount shown={shown} total={total} />
  </div>
);

export const MonitoringView: React.FC<MonitoringViewProps> = ({ connectionId }) => {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [ops, setOps] = useState<CurrentOp[]>([]);
  const [samples, setSamples] = useState<MetricSample[]>([]);
  const [metricsErr, setMetricsErr] = useState<string | null>(null);
  const [opsErr, setOpsErr] = useState<string | null>(null);
  const [profilerErr, setProfilerErr] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('ops');
  const [detail, setDetail] = useState<
    { kind: 'op'; data: CurrentOp } | { kind: 'profile'; data: ProfileEntry } | null
  >(null);

  const [opsSearch, setOpsSearch] = useState('');
  const [opsType, setOpsType] = useState('');
  const [opsDb, setOpsDb] = useState('');
  const [opsMinSecs, setOpsMinSecs] = useState(0);
  const [profSearch, setProfSearch] = useState('');
  const [profMinMs, setProfMinMs] = useState(0);
  const [profOp, setProfOp] = useState('');

  const [dbs, setDbs] = useState<string[]>([]);
  const [profilerDb, setProfilerDb] = useState('');
  const [profiling, setProfiling] = useState<ProfilingStatus | null>(null);
  const [profile, setProfile] = useState<ProfileEntry[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const profilerLoadedRef = useRef(false);

  const [cluster, setCluster] = useState<ReplSetStatus | null>(null);
  const [clusterErr, setClusterErr] = useState<string | null>(null);

  const [pollMs, setPollMs] = useState(DEFAULT_POLL_MS);
  const aliveRef = useRef(true);

  // Read by pollOnce so its identity stays stable across tab switches (the
  // interval effect resets the samples history whenever pollOnce changes).
  const sectionRef = useRef(section);
  useEffect(() => {
    sectionRef.current = section;
  }, [section]);

  const pollOnce = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    const [sRes, oRes, cRes] = await Promise.allSettled([
      serverStatus(connectionId),
      currentOps(connectionId),
      sectionRef.current === 'cluster' ? replSetStatus(connectionId) : Promise.resolve(null),
    ]);
    if (!aliveRef.current) return;
    if (sRes.status === 'fulfilled') {
      const s = sRes.value;
      setStatus(s);
      setMetricsErr(null);
      setSamples((prev) => [...prev, sampleFromStatus(Date.now(), s)].slice(-MAX_SAMPLES));
    } else {
      setMetricsErr(String((sRes.reason as Error)?.message || sRes.reason));
    }
    if (oRes.status === 'fulfilled') {
      setOps(oRes.value);
      setOpsErr(null);
    } else {
      setOpsErr(String((oRes.reason as Error)?.message || oRes.reason));
    }
    if (cRes.status === 'fulfilled') {
      if (cRes.value) {
        setCluster(cRes.value);
        setClusterErr(null);
      }
    } else {
      setClusterErr(String((cRes.reason as Error)?.message || cRes.reason));
    }
  }, [connectionId]);

  useEffect(() => {
    aliveRef.current = true;
    setSamples([]);
    setStatus(null);
    profilerLoadedRef.current = false;
    void pollOnce();
    if (pollMs <= 0) {
      return () => { aliveRef.current = false; };
    }
    const iv = setInterval(() => void pollOnce(), pollMs);
    return () => {
      aliveRef.current = false;
      clearInterval(iv);
    };
  }, [pollOnce, pollMs, connectionId]);

  // Entering the Cluster tab fetches right away; pollOnce reads the section
  // from a ref, so this does not disturb the interval or the sample history.
  useEffect(() => {
    if (section === 'cluster') void pollOnce();
  }, [section, pollOnce]);

  const refreshProfiler = useCallback(async () => {
    if (!profilerDb) return;
    setProfileLoading(true);
    try {
      const [st, entries] = await Promise.all([
        getProfilingStatus(connectionId, profilerDb),
        readProfile(connectionId, profilerDb, 50),
      ]);
      setProfiling(st);
      setProfile(entries);
      setProfilerErr(null);
    } catch (e: unknown) {
      setProfilerErr(String((e as Error)?.message || e));
    } finally {
      setProfileLoading(false);
    }
  }, [connectionId, profilerDb]);

  useEffect(() => {
    if (section !== 'profiler') return;
    let alive = true;
    if (!profilerLoadedRef.current) {
      profilerLoadedRef.current = true;
      invoke<string[]>('list_databases', { id: connectionId })
        .then((list) => {
          if (!alive) return;
          setDbs(list);
          setProfilerDb((cur) => cur || list.find((d) => !['admin', 'config', 'local'].includes(d)) || list[0] || '');
        })
        .catch(() => undefined);
    }
    return () => { alive = false; };
  }, [section, connectionId]);

  useEffect(() => {
    if (section !== 'profiler' || !profilerDb) return;
    void refreshProfiler();
  }, [section, profilerDb, refreshProfiler]);

  const handleKill = useCallback(async (op: CurrentOp) => {
    if (!window.confirm(`Kill operation ${op.opid} on ${op.ns || 'server'}?`)) return;
    try {
      await killOp(connectionId, op.opid);
      setOps(await currentOps(connectionId));
    } catch (e: unknown) {
      setOpsErr(String((e as Error)?.message || e));
    }
  }, [connectionId]);

  const handleSetLevel = async (level: number) => {
    try {
      const st = await setProfilingLevel(connectionId, profilerDb, level, profiling?.slowMs ?? 100);
      setProfiling(st);
      void refreshProfiler();
    } catch (e: unknown) {
      setProfilerErr(String((e as Error)?.message || e));
    }
  };

  const series = useMemo(() => {
    const conns = samples.map((s) => s.connections);
    const resident = samples.map((s) => s.residentMb);
    const cachePct = samples.map((s) => s.cachePct);
    const opsPerSec: number[] = [];
    const netPerSec: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = (samples[i].t - samples[i - 1].t) / 1000 || 1;
      opsPerSec.push(Math.max(0, (samples[i].totalOps - samples[i - 1].totalOps) / dt));
      netPerSec.push(Math.max(0, (samples[i].netBytes - samples[i - 1].netBytes) / dt));
    }
    return { conns, resident, cachePct, opsPerSec, netPerSec };
  }, [samples]);

  const dbOf = (ns: string) => ns.split('.')[0] || '';
  const opTypes = useMemo(() => Array.from(new Set(ops.map((o) => o.op))).sort(), [ops]);
  const opsDbs = useMemo(() => Array.from(new Set(ops.map((o) => dbOf(o.ns)).filter(Boolean))).sort(), [ops]);
  const profOpTypes = useMemo(() => Array.from(new Set(profile.map((p) => p.op))).sort(), [profile]);

  const filteredOps = useMemo(() => {
    const q = opsSearch.trim().toLowerCase();
    return ops.filter(
      (o) =>
        (!opsType || o.op === opsType) &&
        (!opsDb || dbOf(o.ns) === opsDb) &&
        o.secsRunning >= opsMinSecs &&
        (!q || `${o.ns} ${o.client} ${o.op} ${o.command}`.toLowerCase().includes(q)),
    );
  }, [ops, opsSearch, opsType, opsDb, opsMinSecs]);

  const filteredProfile = useMemo(() => {
    const q = profSearch.trim().toLowerCase();
    return profile.filter(
      (p) =>
        p.millis >= profMinMs &&
        (!profOp || p.op === profOp) &&
        (!q || `${p.ns} ${p.op} ${p.planSummary} ${p.command}`.toLowerCase().includes(q)),
    );
  }, [profile, profSearch, profMinMs, profOp]);

  const latestOpsPerSec = series.opsPerSec.length ? series.opsPerSec[series.opsPerSec.length - 1] : 0;
  const latestNetPerSec = series.netPerSec.length ? series.netPerSec[series.netPerSec.length - 1] : 0;
  const cachePctNow = status?.cache && status.cache.maxBytes > 0
    ? (status.cache.bytesInCache / status.cache.maxBytes) * 100
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-testid="monitoring-view">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Activity size={14} className="shrink-0 text-primary" />
          <span className="text-sm font-semibold">Monitoring</span>
          {status && (
            <span className="hidden truncate text-xs text-muted-foreground md:inline">
              {status.host}
              {' · '}
              MongoDB {status.version}
              {status.replSet ? ` · ${status.replSet}` : ''}
              {' · '}
              up {Math.floor(status.uptimeSeconds / 3600)}h
            </span>
          )}
        </div>

        <Tabs
          value={section}
          onValueChange={(v) => setSection(v as Section)}
          className="min-w-0"
        >
          <TabsList className="h-8 bg-muted/50 p-0.5">
            <TabsTrigger
              value="ops"
              className="h-7 px-3 text-xs"
              data-testid="mon-tab-ops"
              onClick={() => setSection('ops')}
            >
              Current operations{ops.length > 0 ? ` (${ops.length})` : ''}
            </TabsTrigger>
            <TabsTrigger
              value="profiler"
              className="h-7 px-3 text-xs"
              data-testid="mon-tab-profiler"
              onClick={() => setSection('profiler')}
            >
              Profiler
            </TabsTrigger>
            <TabsTrigger
              value="cluster"
              className="h-7 px-3 text-xs"
              data-testid="mon-tab-cluster"
              onClick={() => setSection('cluster')}
            >
              Cluster
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void pollOnce()}
            title="Refresh now"
            aria-label="Refresh now"
            data-testid="monitoring-refresh-now"
          >
            <RefreshCw size={13} />
          </Button>
          <Select value={String(pollMs)} onValueChange={(v) => setPollMs(Number(v))}>
            <SelectTrigger className="h-7 w-[108px] text-xs" data-testid="monitoring-refresh-interval">
              <SelectValue placeholder="Refresh" />
            </SelectTrigger>
            <SelectContent>
              {REFRESH_OPTIONS.map((o) => (
                <SelectItem key={o.label} value={String(o.ms)} className="text-xs">
                  {o.label === 'Off' ? 'Off' : o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {section === 'ops' && (
        <>
          {metricsErr && isAuthError(metricsErr) ? (
            <div className="shrink-0 px-3 py-2">
              <AccessNote what="read server metrics (serverStatus)" />
            </div>
          ) : (
            <div className="shrink-0 border-b border-border px-3 py-2">
              {metricsErr && (
                <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive" data-testid="monitoring-error">
                  {errLine(metricsErr)}
                </div>
              )}
              <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-5">
                <MetricTile
                  label="Connections"
                  icon={<Network size={12} />}
                  value={status ? String(status.connections.current) : '—'}
                  sub={status ? `${status.connections.available.toLocaleString()} avail` : undefined}
                  series={series.conns}
                  color="hsl(var(--primary))"
                />
                <MetricTile
                  label="Ops / sec"
                  icon={<Gauge size={12} />}
                  value={status ? Math.round(latestOpsPerSec).toLocaleString() : '—'}
                  sub="opcounters"
                  series={series.opsPerSec}
                  color="#34d399"
                />
                <MetricTile
                  label="Resident mem"
                  icon={<MemoryStick size={12} />}
                  value={status ? `${status.memory.residentMb.toLocaleString()} MB` : '—'}
                  sub={status ? `${status.memory.virtualMb.toLocaleString()} MB virt` : undefined}
                  series={series.resident}
                  color="#f59e0b"
                />
                <MetricTile
                  label="Cache"
                  icon={<Database size={12} />}
                  value={cachePctNow != null ? `${cachePctNow.toFixed(0)}%` : 'n/a'}
                  sub={status?.cache ? `${formatBytes(status.cache.bytesInCache)} / ${formatBytes(status.cache.maxBytes)}` : undefined}
                  series={series.cachePct}
                  color="#a78bfa"
                />
                <MetricTile
                  label="Network"
                  icon={<ArrowDownUp size={12} />}
                  value={status ? `${formatBytes(latestNetPerSec)}/s` : '—'}
                  sub={status ? `${formatBytes(status.network.bytesIn + status.network.bytesOut)} total` : undefined}
                  series={series.netPerSec}
                  color="#22d3ee"
                />
              </div>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2" data-testid="mon-panel-ops">
              {opsErr && isAuthError(opsErr) ? (
                <AccessNote what="inspect current operations ($currentOp)" role="inprog / clusterMonitor" />
              ) : opsErr ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{errLine(opsErr)}</div>
              ) : ops.length === 0 ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No active operations.</div>
              ) : (
                <>
                  <OpsFilterBar
                    search={opsSearch}
                    onSearchChange={setOpsSearch}
                    opType={opsType}
                    onOpTypeChange={setOpsType}
                    opTypes={opTypes}
                    db={opsDb}
                    onDbChange={setOpsDb}
                    dbs={opsDbs}
                    minSecs={opsMinSecs}
                    onMinSecsChange={setOpsMinSecs}
                    shown={filteredOps.length}
                    total={ops.length}
                  />
                  {filteredOps.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No operations match the filter.</div>
                  ) : (
                    <ScrollArea className="min-h-0 flex-1 rounded-md border border-border">
                      <table className="w-full border-collapse text-xs" data-testid="current-ops-table">
                        <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
                          <tr className="text-left text-muted-foreground">
                            <th className="px-3 py-2 font-medium">opid</th>
                            <th className="px-3 py-2 font-medium">op</th>
                            <th className="px-3 py-2 font-medium">ns</th>
                            <th className="px-3 py-2 font-medium">secs</th>
                            <th className="px-3 py-2 font-medium">client</th>
                            <th className="px-3 py-2 font-medium">command</th>
                            <th className="px-3 py-2 font-medium" />
                          </tr>
                        </thead>
                        <tbody>
                          {filteredOps.map((op) => (
                            <OpRow key={op.opid} op={op} onSelect={(o) => setDetail({ kind: 'op', data: o })} onKill={handleKill} />
                          ))}
                        </tbody>
                      </table>
                    </ScrollArea>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {section === 'profiler' && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2" data-testid="mon-panel-profiler">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Select value={profilerDb || undefined} onValueChange={setProfilerDb}>
                <SelectTrigger className="h-7 w-[140px] text-xs" data-testid="profiler-db-select">
                  <SelectValue placeholder="Database" />
                </SelectTrigger>
                <SelectContent>
                  {dbs.map((d) => (
                    <SelectItem key={d} value={d} className="text-xs">{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                Level:
                {[0, 1, 2].map((lvl) => (
                  <Button
                    key={lvl}
                    type="button"
                    variant={profiling?.level === lvl ? 'default' : 'outline'}
                    size="sm"
                    className="h-6 w-6 px-0 text-xs"
                    data-testid={`profiler-level-${lvl}`}
                    onClick={() => handleSetLevel(lvl)}
                  >
                    {lvl}
                  </Button>
                ))}
              </span>
              {profiling && <span className="text-xs text-muted-foreground">slow ≥ {profiling.slowMs}ms</span>}
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => void refreshProfiler()} title="Refresh">
                <RefreshCw size={12} className={profileLoading ? 'animate-spin' : ''} />
              </Button>
            </div>
            {profilerErr && isAuthError(profilerErr) ? (
              <AccessNote what="read the profiler for this database (system.profile)" role="dbAdmin / read" />
            ) : profilerErr ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{errLine(profilerErr)}</div>
            ) : profile.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
                {profiling?.level === 0
                  ? 'Profiling is off for this database. Set level 1 (slow ops) or 2 (all ops) to collect entries.'
                  : 'No profiled operations yet.'}
              </div>
            ) : (
              <>
                <ProfileFilterBar
                  search={profSearch}
                  onSearchChange={setProfSearch}
                  op={profOp}
                  onOpChange={setProfOp}
                  opTypes={profOpTypes}
                  minMs={profMinMs}
                  onMinMsChange={setProfMinMs}
                  shown={filteredProfile.length}
                  total={profile.length}
                />
                {filteredProfile.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No entries match the filter.</div>
                ) : (
                  <ScrollArea className="min-h-0 flex-1 rounded-md border border-border">
                    <table className="w-full border-collapse text-xs" data-testid="profile-table">
                      <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
                        <tr className="text-left text-muted-foreground">
                          <th className="px-3 py-2 font-medium">millis</th>
                          <th className="px-3 py-2 font-medium">op</th>
                          <th className="px-3 py-2 font-medium">ns</th>
                          <th className="px-3 py-2 font-medium">plan</th>
                          <th className="px-3 py-2 font-medium">command</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredProfile.map((p, i) => (
                          <ProfileRow
                            key={`${p.tsMs}-${p.ns}-${i}`}
                            entry={p}
                            index={i}
                            onSelect={(entry) => setDetail({ kind: 'profile', data: entry })}
                          />
                        ))}
                      </tbody>
                    </table>
                  </ScrollArea>
                )}
              </>
            )}
          </div>
        )}

      {section === 'cluster' && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3" data-testid="mon-panel-cluster">
          {clusterErr && <div className="text-xs text-red-500">{clusterErr}</div>}
          {!clusterErr && cluster && !cluster.isReplicaSet && cluster.clusterType === 'sharded' && (
            <div
              className="rounded-lg border border-border bg-muted/30 p-4 text-xs text-muted-foreground"
              data-testid="cluster-sharded"
            >
              Sharded cluster — member-level health isn&apos;t available through mongos. Connect directly to a
              shard&apos;s replica set to inspect its members.
            </div>
          )}
          {!clusterErr && cluster && !cluster.isReplicaSet && cluster.clusterType !== 'sharded' && (
            <div
              className="rounded-lg border border-border bg-muted/30 p-4 text-xs text-muted-foreground"
              data-testid="cluster-not-replset"
            >
              This connection is a standalone MongoDB server — replica-set health does not apply here.
            </div>
          )}
          {!clusterErr && cluster && cluster.isReplicaSet && (
            <>
              <div className="text-xs text-muted-foreground" data-testid="cluster-summary">
                Replica set <span className="font-semibold text-foreground">{cluster.set}</span>
                {' · '}
                {cluster.members.length} members
                {cluster.mongoVersion && <> · MongoDB {cluster.mongoVersion}</>}
                {cluster.myStateStr && <> · you: {cluster.myStateStr}</>}
              </div>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs" data-testid="cluster-members-table">
                  <thead className="bg-muted/50 text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Member</th>
                      <th className="px-3 py-1.5 font-medium">State</th>
                      <th className="px-3 py-1.5 font-medium">Uptime</th>
                      <th className="px-3 py-1.5 font-medium">Ping</th>
                      <th className="px-3 py-1.5 font-medium">Sync source</th>
                      <th className="px-3 py-1.5 font-medium">Lag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cluster.members.map((m) => (
                      <tr
                        key={m.name}
                        data-testid={`cluster-member-${m.name}`}
                        title={m.optimeDateMs > 0 ? `optime: ${new Date(m.optimeDateMs).toISOString()}` : undefined}
                        className={cn(
                          'border-t border-border/50',
                          memberUnhealthy(m) && 'bg-destructive/10 text-destructive',
                        )}
                      >
                        <td className="px-3 py-1.5">
                          <span className="flex items-center gap-1.5">
                            <span className={cn('h-2 w-2 shrink-0 rounded-full', memberDotClass(m))} />
                            <span className="font-mono">{m.name}</span>
                            {m.self && <span className="text-ui-2xs text-muted-foreground">(you)</span>}
                          </span>
                        </td>
                        <td className="px-3 py-1.5">{m.stateStr}</td>
                        <td className="px-3 py-1.5">{fmtMemberUptime(m.uptimeSecs)}</td>
                        <td className="px-3 py-1.5">{m.pingMs == null ? '—' : `${m.pingMs}ms`}</td>
                        <td className="px-3 py-1.5 font-mono">{m.syncSource || '—'}</td>
                        <td
                          className={cn('px-3 py-1.5', m.stateStr === 'PRIMARY' ? 'text-muted-foreground' : lagClass(m.lagSecs))}
                          data-testid={`cluster-lag-${m.name}`}
                        >
                          {m.stateStr === 'PRIMARY' ? '—' : lagText(m.lagSecs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!clusterErr && !cluster && (
            <div className="text-xs text-muted-foreground">Loading replica-set status…</div>
          )}
        </div>
      )}

      {detail && <MonitoringDetail detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
};
