// The result of the backend's `analyze_schema` sample (src-tauri/src/db/schema.rs).
import type { SchemaReport } from './schemaExport';
export type { TypeCount, FieldStat, SchemaReport } from './schemaExport';

interface JsonSchemaNode {
  bsonType: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
}

// The sampler's type labels as $jsonSchema bsonType aliases. It labels both
// BSON code types `javascript`, so that one allows either.
const bsonTypeAliases = (t: string): string[] =>
  t === 'binary' ? ['binData'] : t === 'javascript' ? ['javascript', 'javascriptWithScope'] : [t];

/**
 * A `{ $jsonSchema }` validator describing the sample: every field's observed
 * types, nested documents as nested properties, and a field required when it
 * appears in every document that has its parent.
 * ponytail: keys that themselves contain "." are split like nested paths.
 */
export function validatorFromSchemaReport(report: SchemaReport): { $jsonSchema: JsonSchemaNode } {
  const root: JsonSchemaNode = { bsonType: 'object' };
  const top = { node: root, presence: report.sampled };
  // Field paths only: a field may be named with the empty string, so the top
  // level is kept apart rather than under the '' key.
  const nodes = new Map<string, { node: JsonSchemaNode; presence: number }>();
  // Parents sort before their children.
  const fields = [...report.fields].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of fields) {
    const dot = f.path.lastIndexOf('.');
    const parent = dot < 0 ? top : nodes.get(f.path.slice(0, dot));
    if (!parent) continue;
    const key = f.path.slice(dot + 1);
    const types = f.types.flatMap((t) => bsonTypeAliases(t.type));
    const node: JsonSchemaNode = { bsonType: types.length === 1 ? types[0] : types };
    // No prototype, so a field named `__proto__` is just a property.
    (parent.node.properties ??= Object.create(null) as Record<string, JsonSchemaNode>)[key] = node;
    if (f.presence === parent.presence) (parent.node.required ??= []).push(key);
    nodes.set(f.path, { node, presence: f.presence });
  }
  return { $jsonSchema: root };
}
