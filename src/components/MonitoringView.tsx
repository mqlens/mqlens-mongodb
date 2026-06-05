import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { Activity, RefreshCw, Skull, Lock } from 'lucide-react';
import { formatBytes } from '../lib/format';
import {
  serverStatus,
  currentOps,
  killOp,
  getProfilingStatus,
  setProfilingLevel,
  readProfile,
  type ServerStatus,
  type CurrentOp,
  type ProfilingStatus,
  type ProfileEntry,
} from '../lib/monitoringApi';

interface MonitoringViewProps {
  connectionId: string;
}

const POLL_MS = 3000;
const MAX_SAMPLES = 40;

interface Sample {
  t: number;
  status: ServerStatus;
}

const totalOps = (s: ServerStatus): number => {
  const o = s.opcounters;
  return o.insert + o.query + o.update + o.delete + o.getmore + o.command;
};

const Sparkline: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  if (data.length < 2) return <div className="mql-mon-spark-empty" />;
  return (
    <ResponsiveContainer width="100%" height={34}>
      <LineChart data={data.map((v, i) => ({ i, v }))} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
};

const MetricCard: React.FC<{ label: string; value: string; sub?: string; series: number[]; color: string }> = ({
  label,
  value,
  sub,
  series,
  color,
}) => (
  <div className="mql-mon-card">
    <div className="mql-mon-card-label">{label}</div>
    <div className="mql-mon-card-value">{value}</div>
    {sub && <div className="mql-mon-card-sub">{sub}</div>}
    <div className="mql-mon-spark">
      <Sparkline data={series} color={color} />
    </div>
  </div>
);

// MongoDB error 13 / "not authorized" → the user lacks the privilege.
const isAuthError = (msg: string): boolean =>
  /not authorized|unauthorized|requires authentication|\(13\)|code 13/i.test(msg);

const AccessNote: React.FC<{ what: string; role?: string }> = ({ what, role = 'clusterMonitor' }) => (
  <div className="mql-mon-denied" data-testid="access-required">
    <Lock size={15} />
    <div>
      <strong>Access required</strong>
      <p>
        This connection&apos;s user isn&apos;t authorized to {what}. Grant the <code>{role}</code> role
        (or equivalent privilege) to enable it.
      </p>
    </div>
  </div>
);

const errLine = (msg: string): string => {
  const first = msg.split('\n')[0];
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
};

export const MonitoringView: React.FC<MonitoringViewProps> = ({ connectionId }) => {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [ops, setOps] = useState<CurrentOp[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [metricsErr, setMetricsErr] = useState<string | null>(null);
  const [opsErr, setOpsErr] = useState<string | null>(null);
  const [profilerErr, setProfilerErr] = useState<string | null>(null);
  const [section, setSection] = useState<'ops' | 'profiler'>('ops');

  // Profiler state
  const [dbs, setDbs] = useState<string[]>([]);
  const [profilerDb, setProfilerDb] = useState<string>('');
  const [profiling, setProfiling] = useState<ProfilingStatus | null>(null);
  const [profile, setProfile] = useState<ProfileEntry[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);

  // ── Metrics + current-ops polling (paused when the window is hidden) ──────────
  useEffect(() => {
    let alive = true;
    setSamples([]);
    setStatus(null);
    const tick = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      // Independent: a user may have currentOp but not serverStatus (or vice versa).
      const [sRes, oRes] = await Promise.allSettled([serverStatus(connectionId), currentOps(connectionId)]);
      if (!alive) return;
      if (sRes.status === 'fulfilled') {
        setStatus(sRes.value);
        setMetricsErr(null);
        setSamples((prev) => [...prev, { t: Date.now(), status: sRes.value }].slice(-MAX_SAMPLES));
      } else {
        setMetricsErr(String((sRes.reason as any)?.message || sRes.reason));
      }
      if (oRes.status === 'fulfilled') {
        setOps(oRes.value);
        setOpsErr(null);
      } else {
        setOpsErr(String((oRes.reason as any)?.message || oRes.reason));
      }
    };
    tick();
    const iv = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [connectionId]);

  // ── Profiler: load db list once, then status + slow queries for the chosen db ─
  useEffect(() => {
    let alive = true;
    invoke<string[]>('list_databases', { id: connectionId })
      .then((list) => {
        if (!alive) return;
        setDbs(list);
        setProfilerDb((cur) => cur || list.find((d) => !['admin', 'config', 'local'].includes(d)) || list[0] || '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connectionId]);

  const refreshProfiler = React.useCallback(async () => {
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
    } catch (e: any) {
      setProfilerErr(String(e?.message || e));
    } finally {
      setProfileLoading(false);
    }
  }, [connectionId, profilerDb]);

  useEffect(() => {
    void refreshProfiler();
  }, [refreshProfiler]);

  const handleKill = async (op: CurrentOp) => {
    if (!window.confirm(`Kill operation ${op.opid} on ${op.ns || 'server'}?`)) return;
    try {
      await killOp(connectionId, op.opid);
      setOps(await currentOps(connectionId));
    } catch (e: any) {
      setOpsErr(String(e?.message || e));
    }
  };

  const handleSetLevel = async (level: number) => {
    try {
      const st = await setProfilingLevel(connectionId, profilerDb, level, profiling?.slowMs ?? 100);
      setProfiling(st);
      void refreshProfiler();
    } catch (e: any) {
      setProfilerErr(String(e?.message || e));
    }
  };

  // ── Derived sparkline series ──────────────────────────────────────────────────
  const series = useMemo(() => {
    const conns = samples.map((s) => s.status.connections.current);
    const resident = samples.map((s) => s.status.memory.residentMb);
    const cachePct = samples.map((s) =>
      s.status.cache && s.status.cache.maxBytes > 0 ? (s.status.cache.bytesInCache / s.status.cache.maxBytes) * 100 : 0,
    );
    const opsPerSec: number[] = [];
    const netPerSec: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = (samples[i].t - samples[i - 1].t) / 1000 || 1;
      opsPerSec.push(Math.max(0, (totalOps(samples[i].status) - totalOps(samples[i - 1].status)) / dt));
      const net = samples[i].status.network;
      const prevNet = samples[i - 1].status.network;
      netPerSec.push(Math.max(0, (net.bytesIn + net.bytesOut - prevNet.bytesIn - prevNet.bytesOut) / dt));
    }
    return { conns, resident, cachePct, opsPerSec, netPerSec };
  }, [samples]);

  const latestOpsPerSec = series.opsPerSec.length ? series.opsPerSec[series.opsPerSec.length - 1] : 0;
  const latestNetPerSec = series.netPerSec.length ? series.netPerSec[series.netPerSec.length - 1] : 0;
  const cachePctNow = status?.cache && status.cache.maxBytes > 0 ? (status.cache.bytesInCache / status.cache.maxBytes) * 100 : null;

  return (
    <div className="mql-mon" data-testid="monitoring-view">
      <div className="mql-mon-header">
        <Activity size={15} className="text-[var(--accent-blue)]" />
        <span className="mql-mon-title">Monitoring</span>
        {status && (
          <span className="mql-mon-meta">
            {status.host} · MongoDB {status.version}
            {status.replSet ? ` · ${status.replSet}` : ''} · up {Math.floor(status.uptimeSeconds / 3600)}h
          </span>
        )}
      </div>

      {/* Metric cards (or an access-required panel when serverStatus is denied) */}
      {metricsErr && isAuthError(metricsErr) ? (
        <AccessNote what="read server metrics (serverStatus)" />
      ) : (
        <>
          {metricsErr && <div className="mql-mon-error" data-testid="monitoring-error">{errLine(metricsErr)}</div>}
          <div className="mql-mon-cards">
            <MetricCard
              label="Connections"
              value={status ? String(status.connections.current) : '—'}
              sub={status ? `${status.connections.available.toLocaleString()} available` : undefined}
              series={series.conns}
              color="var(--accent-blue)"
            />
            <MetricCard
              label="Ops / sec"
              value={status ? Math.round(latestOpsPerSec).toLocaleString() : '—'}
              sub="all opcounters"
              series={series.opsPerSec}
              color="#34d399"
            />
            <MetricCard
              label="Resident memory"
              value={status ? `${status.memory.residentMb.toLocaleString()} MB` : '—'}
              sub={status ? `${status.memory.virtualMb.toLocaleString()} MB virtual` : undefined}
              series={series.resident}
              color="#f59e0b"
            />
            <MetricCard
              label="Cache used"
              value={cachePctNow != null ? `${cachePctNow.toFixed(0)}%` : 'n/a'}
              sub={status?.cache ? `${formatBytes(status.cache.bytesInCache)} / ${formatBytes(status.cache.maxBytes)}` : undefined}
              series={series.cachePct}
              color="#a78bfa"
            />
            <MetricCard
              label="Network"
              value={status ? `${formatBytes(latestNetPerSec)}/s` : '—'}
              sub={status ? `${formatBytes(status.network.bytesIn + status.network.bytesOut)} total` : undefined}
              series={series.netPerSec}
              color="#22d3ee"
            />
          </div>
        </>
      )}

      {/* Tabs: Current operations | Profiler */}
      <div className="mql-mon-tabs">
        <button
          type="button"
          className={`mql-mon-tab${section === 'ops' ? ' is-active' : ''}`}
          data-testid="mon-tab-ops"
          onClick={() => setSection('ops')}
        >
          Current operations ({ops.length})
        </button>
        <button
          type="button"
          className={`mql-mon-tab${section === 'profiler' ? ' is-active' : ''}`}
          data-testid="mon-tab-profiler"
          onClick={() => setSection('profiler')}
        >
          Profiler &amp; slow queries
        </button>
      </div>

      {section === 'ops' ? (
        <div className="mql-mon-section" data-testid="mon-panel-ops">
          {opsErr && isAuthError(opsErr) ? (
            <AccessNote what="inspect current operations ($currentOp)" role="inprog / clusterMonitor" />
          ) : opsErr ? (
            <div className="mql-mon-error">{errLine(opsErr)}</div>
          ) : ops.length === 0 ? (
            <div className="mql-mon-empty">No active operations.</div>
          ) : (
            <table className="mql-mon-table" data-testid="current-ops-table">
              <thead>
                <tr>
                  <th>opid</th><th>op</th><th>ns</th><th>secs</th><th>client</th><th>command</th><th></th>
                </tr>
              </thead>
              <tbody>
                {ops.map((op) => (
                  <tr key={op.opid}>
                    <td>{op.opid}</td>
                    <td>{op.op}</td>
                    <td className="mql-mon-ns">{op.ns}</td>
                    <td>{op.secsRunning}</td>
                    <td>{op.client}</td>
                    <td className="mql-mon-cmd" title={op.command}>{op.command}</td>
                    <td>
                      <button
                        type="button"
                        className="mql-mon-kill"
                        title="Kill operation"
                        data-testid={`kill-op-${op.opid}`}
                        onClick={() => handleKill(op)}
                      >
                        <Skull size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="mql-mon-section" data-testid="mon-panel-profiler">
          <div className="mql-mon-profiler-controls">
            <select
              value={profilerDb}
              onChange={(e) => setProfilerDb(e.target.value)}
              data-testid="profiler-db-select"
              className="mql-mon-select"
            >
              {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <span className="mql-mon-level">
              Level:
              {[0, 1, 2].map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  className={`mql-mon-level-btn${profiling?.level === lvl ? ' is-active' : ''}`}
                  data-testid={`profiler-level-${lvl}`}
                  onClick={() => handleSetLevel(lvl)}
                >
                  {lvl}
                </button>
              ))}
            </span>
            {profiling && <span className="mql-mon-slowms">slow ≥ {profiling.slowMs}ms</span>}
            <button type="button" className="mql-mon-refresh" onClick={() => void refreshProfiler()} title="Refresh">
              <RefreshCw size={12} className={profileLoading ? 'animate-spin' : ''} />
            </button>
          </div>
          {profilerErr && isAuthError(profilerErr) ? (
            <AccessNote what="read the profiler for this database (system.profile)" role="dbAdmin / read" />
          ) : profilerErr ? (
            <div className="mql-mon-error">{errLine(profilerErr)}</div>
          ) : profile.length === 0 ? (
            <div className="mql-mon-empty">
              {profiling?.level === 0
                ? 'Profiling is off for this database. Set level 1 (slow ops) or 2 (all ops) to collect entries.'
                : 'No profiled operations yet.'}
            </div>
          ) : (
            <table className="mql-mon-table" data-testid="profile-table">
              <thead>
                <tr><th>millis</th><th>op</th><th>ns</th><th>plan</th><th>command</th></tr>
              </thead>
              <tbody>
                {profile.map((p, i) => (
                  <tr key={i}>
                    <td className={p.millis >= 100 ? 'mql-mon-slow' : ''}>{p.millis}</td>
                    <td>{p.op}</td>
                    <td className="mql-mon-ns">{p.ns}</td>
                    <td>{p.planSummary}</td>
                    <td className="mql-mon-cmd" title={p.command}>{p.command}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};
