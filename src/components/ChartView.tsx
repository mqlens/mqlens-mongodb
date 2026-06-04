import React, { useMemo, useRef, useState, useEffect } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { Download } from 'lucide-react';
import {
  inferFields, buildChartData, type ChartMode, type Measure, type ChartType, type FieldInfo,
} from '../lib/chartData';
import { exportSvgToPng } from '../lib/exportPng';

interface ChartViewProps {
  documents: Array<Record<string, any>>;
  columns: string[];
  density?: 'roomy' | 'cozy' | 'compact';
}

const ACCENT_VARS = ['--accent-blue', '--accent-teal', '--accent-green', '--accent-amber', '--accent-purple', '--accent-red'];
const MEASURES: Measure[] = ['count', 'sum', 'avg', 'min', 'max'];
const TYPES: ChartType[] = ['bar', 'line', 'area', 'pie', 'scatter'];

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const selectCls =
  'bg-[var(--bg-base)] border border-[var(--border-color)] rounded text-[11px] text-[var(--text-main)] px-1.5 py-1';
const tabCls = (active: boolean) =>
  `px-2 py-1 rounded text-[11px] font-medium transition-all cursor-pointer ${active ? 'bg-[var(--bg-item-active)] text-[var(--accent-blue)]' : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'}`;

export const ChartView: React.FC<ChartViewProps> = ({ documents, columns }) => {
  const fields = useMemo<FieldInfo[]>(() => inferFields(documents, columns), [documents, columns]);
  const numericFields = useMemo(() => fields.filter((f) => f.kind === 'numeric').map((f) => f.name), [fields]);
  const firstCategorical = fields.find((f) => f.kind !== 'numeric')?.name ?? columns[0] ?? '';

  const [mode, setMode] = useState<ChartMode>('aggregate');
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [xField, setXField] = useState<string>(firstCategorical);
  const [measure, setMeasure] = useState<Measure>('count');
  const [measureField, setMeasureField] = useState<string>(numericFields[0] ?? '');
  const [rawYField, setRawYField] = useState<string>(numericFields[0] ?? '');
  const chartRef = useRef<HTMLDivElement>(null);

  // Reset invalid selections when the result set (fields) changes.
  useEffect(() => {
    if (!columns.includes(xField)) setXField(firstCategorical);
    if (measureField && !numericFields.includes(measureField)) setMeasureField(numericFields[0] ?? '');
    if (rawYField && !numericFields.includes(rawYField)) setRawYField(numericFields[0] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.join(','), numericFields.join(',')]);

  const palette = useMemo(
    () => ACCENT_VARS.map((v, i) => cssVar(v, ['#38bdf8', '#14b8a6', '#22c55e', '#f59e0b', '#a855f7', '#ef4444'][i])),
    [],
  );
  const axisColor = cssVar('--text-muted', '#9aa4b2');
  const gridColor = cssVar('--border-color', '#2a2f3a');

  const effectiveType: ChartType = mode === 'raw' && chartType === 'pie' ? 'bar' : chartType;
  const data = useMemo(
    () => buildChartData(documents, { mode, xField, measure, measureField, rawYField }),
    [documents, mode, xField, measure, measureField, rawYField],
  );

  if (!documents || documents.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-dim)] p-8" data-testid="chart-view">
        Run a query to chart its results.
      </div>
    );
  }

  const needsNumeric =
    (mode === 'raw' && !rawYField) ||
    (mode === 'aggregate' && measure !== 'count' && !measureField);
  const noNumericAtAll = numericFields.length === 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0" data-testid="chart-view">
      {/* Control bar */}
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-[var(--border-color)] text-[var(--text-muted)]">
        <div className="flex items-center bg-[var(--bg-base)] border border-[var(--border-color)] rounded-md p-0.5">
          <button aria-label="Aggregate" className={tabCls(mode === 'aggregate')} onClick={() => setMode('aggregate')}>Aggregate</button>
          <button aria-label="Raw" className={tabCls(mode === 'raw')} onClick={() => setMode('raw')}>Raw</button>
        </div>

        <label className="flex items-center gap-1 text-[11px]">X axis
          <select aria-label="X axis" className={selectCls} value={xField} onChange={(e) => setXField(e.target.value)}>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>

        {mode === 'aggregate' ? (
          <>
            <label className="flex items-center gap-1 text-[11px]">Measure
              <select aria-label="Measure" className={selectCls} value={measure} onChange={(e) => setMeasure(e.target.value as Measure)}>
                {MEASURES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            {measure !== 'count' && (
              <label className="flex items-center gap-1 text-[11px]">Field
                <select aria-label="Measure field" className={selectCls} value={measureField} onChange={(e) => setMeasureField(e.target.value)}>
                  <option value="">—</option>
                  {numericFields.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
          </>
        ) : (
          <label className="flex items-center gap-1 text-[11px]">Y axis
            <select aria-label="Y axis" className={selectCls} value={rawYField} onChange={(e) => setRawYField(e.target.value)}>
              <option value="">—</option>
              {numericFields.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}

        <label className="flex items-center gap-1 text-[11px]">Type
          <select aria-label="Chart type" className={selectCls} value={chartType} onChange={(e) => setChartType(e.target.value as ChartType)}>
            {TYPES.map((t) => <option key={t} value={t} disabled={mode === 'raw' && t === 'pie'}>{t}</option>)}
          </select>
        </label>

        <button
          aria-label="Export PNG"
          className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-[var(--border-color)] hover:text-[var(--text-main)]"
          onClick={() => {
            const svg = chartRef.current?.querySelector('svg');
            if (svg) exportSvgToPng(svg as SVGSVGElement, 'chart.png', cssVar('--bg-base', '#0a0e14'));
          }}
        >
          <Download size={12} /> PNG
        </button>
      </div>

      {/* Chart area */}
      <div ref={chartRef} className="flex-1 min-h-0 min-w-0 p-3">
        {noNumericAtAll && mode === 'raw' ? (
          <div className="h-full flex items-center justify-center text-[var(--text-dim)]">No numeric field in these results to plot.</div>
        ) : needsNumeric ? (
          <div className="h-full flex items-center justify-center text-[var(--text-dim)]">Pick a numeric field to chart.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {renderChart(effectiveType, data.points, palette, axisColor, gridColor)}
          </ResponsiveContainer>
        )}
      </div>

      {/* Caveat */}
      <div className="px-3 py-1.5 border-t border-[var(--border-color)] text-[10px] text-[var(--text-dim)]">
        Charting {data.total} loaded document{data.total === 1 ? '' : 's'} — increase the page-size limit to chart more.
        {data.truncated > 0 && ` (+${data.truncated} more ${mode === 'aggregate' ? 'categories' : 'points'} not shown)`}
      </div>
    </div>
  );
};

function renderChart(
  type: ChartType,
  points: Array<{ x: string | number; y: number }>,
  palette: string[],
  axisColor: string,
  gridColor: string,
): React.ReactElement {
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
      <XAxis dataKey="x" stroke={axisColor} tick={{ fill: axisColor, fontSize: 11 }} />
      <YAxis stroke={axisColor} tick={{ fill: axisColor, fontSize: 11 }} />
      <Tooltip contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }} />
    </>
  );
  if (type === 'line') return <LineChart data={points}>{axes}<Line type="monotone" dataKey="y" stroke={palette[0]} dot={false} /></LineChart>;
  if (type === 'area') return <AreaChart data={points}>{axes}<Area type="monotone" dataKey="y" stroke={palette[0]} fill={palette[0]} fillOpacity={0.3} /></AreaChart>;
  if (type === 'scatter') {
    const numericX = points.length > 0 && points.every((p) => typeof p.x === 'number');
    return (
      <ScatterChart>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis dataKey="x" type={numericX ? 'number' : 'category'} stroke={axisColor} tick={{ fill: axisColor, fontSize: 11 }} />
        <YAxis dataKey="y" type="number" stroke={axisColor} tick={{ fill: axisColor, fontSize: 11 }} />
        <Tooltip contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }} />
        <Scatter data={points} dataKey="y" fill={palette[0]} />
      </ScatterChart>
    );
  }
  if (type === 'pie') {
    return (
      <PieChart>
        <Tooltip contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', color: 'var(--text-main)' }} />
        <Legend />
        <Pie data={points} dataKey="y" nameKey="x" outerRadius="80%" label>
          {points.map((_, i) => <Cell key={i} fill={palette[i % palette.length]} />)}
        </Pie>
      </PieChart>
    );
  }
  return <BarChart data={points}>{axes}<Bar dataKey="y" fill={palette[0]} /></BarChart>;
}
