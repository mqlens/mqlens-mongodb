export interface TypeCount {
  type: string;
  count: number;
}
export interface FieldStat {
  path: string;
  types: TypeCount[];
  presence: number;
  coverage: number;
  enumValues?: string[];
  enumCounts?: Record<string, number>;
}
export interface SchemaReport {
  sampled: number;
  fields: FieldStat[];
}

/** A field's sampled values, most frequent first. */
export function topValues(field: FieldStat): Array<[string, number]> {
  return Object.entries(field.enumCounts ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const pct = (part: number, whole: number) => `${Math.round((part / (whole || 1)) * 100)}%`;
/** Table-cell text: one line, with Markdown's own characters shown literally. */
const cell = (text: string) => text.replace(/\r\n|[\r\n]/g, ' ').replace(/[\\|`*_[\]<>#~]/g, '\\$&');

export function schemaToMarkdown(namespace: string, report: SchemaReport): string {
  const rows = report.fields.map((f) => {
    const total = f.types.reduce((sum, ty) => sum + ty.count, 0);
    const types = f.types
      .map((ty) => (f.types.length > 1 ? `${ty.type} ${pct(ty.count, total)}` : ty.type))
      .join(', ');
    const values = topValues(f)
      .map(([v, n]) => `${v} (${n})`)
      .join(', ');
    return `| ${cell(f.path)} | ${cell(types)} | ${pct(f.coverage, 1)} | ${cell(values)} |`;
  });
  return [
    `# Schema of ${namespace}`,
    '',
    `Sampled ${report.sampled} documents.`,
    '',
    '| Field | Types | Coverage | Values |',
    '|---|---|---:|---|',
    ...rows,
    '',
  ].join('\n');
}
