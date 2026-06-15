import React, { useMemo, useRef, useState, useEffect } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTheme } from '@/hooks/use-theme';
import { getChartColors, getTokenValue } from '@/lib/themes/apply-theme';
import {
  inferFields, buildChartData, type ChartMode, type Measure, type ChartType, type FieldInfo,
} from '../lib/chartData';
import { exportSvgToPng } from '../lib/exportPng';

interface ChartViewProps {
  documents: Array<Record<string, any>>;
  columns: string[];
  density?: 'roomy' | 'cozy' | 'compact';
}

const MEASURES: Measure[] = ['count', 'sum', 'avg', 'min', 'max'];
const TYPES: ChartType[] = ['bar', 'line', 'area', 'pie', 'scatter'];

export const ChartView: React.FC<ChartViewProps> = ({ documents, columns }) => {
  const { config, resolvedMode } = useTheme();
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

  useEffect(() => {
    if (!columns.includes(xField)) setXField(firstCategorical);
    if (measureField && !numericFields.includes(measureField)) setMeasureField(numericFields[0] ?? '');
    if (rawYField && !numericFields.includes(rawYField)) setRawYField(numericFields[0] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.join(','), numericFields.join(',')]);

  const palette = useMemo(() => getChartColors(), [config, resolvedMode]);
  const axisColor = useMemo(() => `hsl(${getTokenValue('muted-foreground')})`, [config, resolvedMode]);
  const gridColor = useMemo(() => `hsl(${getTokenValue('border')})`, [config, resolvedMode]);
  const panelBg = useMemo(() => `hsl(${getTokenValue('card')})`, [config, resolvedMode]);
  const textMain = useMemo(() => `hsl(${getTokenValue('foreground')})`, [config, resolvedMode]);
  const bgBase = useMemo(() => `hsl(${getTokenValue('background')})`, [config, resolvedMode]);

  const effectiveType: ChartType = mode === 'raw' && chartType === 'pie' ? 'bar' : chartType;
  const data = useMemo(
    () => buildChartData(documents, { mode, xField, measure, measureField, rawYField }),
    [documents, mode, xField, measure, measureField, rawYField],
  );

  if (!documents || documents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground" data-testid="chart-view">
        Run a query to chart its results.
      </div>
    );
  }

  const needsNumeric =
    (mode === 'raw' && !rawYField) ||
    (mode === 'aggregate' && measure !== 'count' && !measureField);
  const noNumericAtAll = numericFields.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="chart-view">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-muted-foreground">
        <Tabs value={mode} onValueChange={(v) => setMode(v as ChartMode)}>
          <TabsList className="h-8">
            <TabsTrigger
              value="aggregate"
              aria-label="Aggregate"
              className="text-xs px-2 py-1"
              onClick={() => setMode('aggregate')}
            >
              Aggregate
            </TabsTrigger>
            <TabsTrigger
              value="raw"
              aria-label="Raw"
              className="text-xs px-2 py-1"
              onClick={() => setMode('raw')}
            >
              Raw
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <label className="flex items-center gap-1 text-[11px]">
          X axis
          <Select value={xField} onValueChange={setXField}>
            <SelectTrigger className="h-7 w-[120px] text-[11px]" aria-label="X axis">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {mode === 'aggregate' ? (
          <>
            <label className="flex items-center gap-1 text-[11px]">
              Measure
              <Select value={measure} onValueChange={(v) => setMeasure(v as Measure)}>
                <SelectTrigger className="h-7 w-[100px] text-[11px]" aria-label="Measure">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEASURES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {measure !== 'count' && (
              <label className="flex items-center gap-1 text-[11px]">
                Field
                <Select
                  value={measureField || '__none__'}
                  onValueChange={(v) => setMeasureField(v === '__none__' ? '' : v)}
                >
                  <SelectTrigger className="h-7 w-[120px] text-[11px]" aria-label="Measure field">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">—</SelectItem>
                    {numericFields.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
          </>
        ) : (
          <label className="flex items-center gap-1 text-[11px]">
            Y axis
            <Select
              value={rawYField || '__none__'}
              onValueChange={(v) => setRawYField(v === '__none__' ? '' : v)}
            >
              <SelectTrigger className="h-7 w-[120px] text-[11px]" aria-label="Y axis">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">—</SelectItem>
                {numericFields.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}

        <label className="flex items-center gap-1 text-[11px]">
          Type
          <Select value={chartType} onValueChange={(v) => setChartType(v as ChartType)}>
            <SelectTrigger className="h-7 w-[90px] text-[11px]" aria-label="Chart type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t} disabled={mode === 'raw' && t === 'pie'}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-7 text-[11px]"
          aria-label="Export PNG"
          onClick={() => {
            const svg = chartRef.current?.querySelector('svg');
            if (svg) exportSvgToPng(svg as SVGSVGElement, 'chart.png', bgBase);
          }}
        >
          <Download size={12} /> PNG
        </Button>
      </div>

      <div ref={chartRef} className="min-h-0 min-w-0 flex-1 p-3">
        {noNumericAtAll && mode === 'raw' ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            No numeric field in these results to plot.
          </div>
        ) : needsNumeric ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Pick a numeric field to chart.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {renderChart(effectiveType, data.points, palette, axisColor, gridColor, panelBg, textMain)}
          </ResponsiveContainer>
        )}
      </div>

      <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
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
  panelBg: string,
  textMain: string,
): React.ReactElement {
  const tooltipStyle = { background: panelBg, border: `1px solid ${gridColor}`, color: textMain };
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
      <XAxis dataKey="x" stroke={axisColor} tick={{ fill: axisColor, fontSize: 11 }} />
      <YAxis stroke={axisColor} tick={{ fill: axisColor, fontSize: 11 }} />
      <Tooltip contentStyle={tooltipStyle} />
    </>
  );
  if (type === 'line') return <LineChart data={points}>{axes}<Line type="monotone" dataKey="y" stroke={palette[0]} dot={false} isAnimationActive={false} /></LineChart>;
  if (type === 'area') return <AreaChart data={points}>{axes}<Area type="monotone" dataKey="y" stroke={palette[0]} fill={palette[0]} fillOpacity={0.3} isAnimationActive={false} /></AreaChart>;
  if (type === 'scatter') {
    const numericX = points.length > 0 && points.every((p) => typeof p.x === 'number');
    return (
      <ScatterChart>
        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
        <XAxis dataKey="x" type={numericX ? 'number' : 'category'} stroke={axisColor} tick={{ fill: axisColor, fontSize: 11 }} />
        <YAxis dataKey="y" type="number" stroke={axisColor} tick={{ fill: axisColor, fontSize: 11 }} />
        <Tooltip contentStyle={tooltipStyle} />
        <Scatter data={points} dataKey="y" fill={palette[0]} isAnimationActive={false} />
      </ScatterChart>
    );
  }
  if (type === 'pie') {
    return (
      <PieChart>
        <Tooltip contentStyle={tooltipStyle} />
        <Legend />
        <Pie data={points} dataKey="y" nameKey="x" outerRadius="80%" label isAnimationActive={false}>
          {points.map((_, i) => <Cell key={i} fill={palette[i % palette.length]} />)}
        </Pie>
      </PieChart>
    );
  }
  return <BarChart data={points}>{axes}<Bar dataKey="y" fill={palette[0]} isAnimationActive={false} /></BarChart>;
}
