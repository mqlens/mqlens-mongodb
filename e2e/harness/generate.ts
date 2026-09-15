// The data-generation template DSL (#91) for the fake backend (#396).
//
// Generators, options and defaults follow src-tauri/src/db/generate.rs and
// src/lib/generateTemplate.ts. A template the fake can't make sense of is
// rejected with an error, never guessed at. Generation draws from a seeded
// PRNG, so a seed repeats its preview as it does in the backend.
import type { inferSchema } from './mongo';
import type { Doc } from './seed';

type BareKind = 'name' | 'firstName' | 'lastName' | 'email' | 'objectId' | 'uuid' | 'bool';

type Spec =
  | { kind: 'literal'; value: unknown }
  | { kind: 'object'; fields: Array<[string, Spec]> }
  | { kind: BareKind }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'float'; min: number; max: number; decimals: number }
  | { kind: 'date'; from: number; to: number }
  | { kind: 'lorem'; words: number }
  | { kind: 'pick'; values: unknown[] }
  | { kind: 'array'; of: Spec; min: number; max: number };

const BARE_GENERATORS: Record<string, BareKind> = {
  $name: 'name',
  $firstName: 'firstName',
  $lastName: 'lastName',
  $email: 'email',
  $objectId: 'objectId',
  $uuid: 'uuid',
  $bool: 'bool',
};

const DAY_MS = 86_400_000;
const PREVIEW_DEFAULT_DOCS = 3;
const PREVIEW_MAX_DOCS = 10;

const FIRST_NAMES = ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Dennis'];
const LAST_NAMES = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Hamilton', 'Thompson', 'Liskov', 'Ritchie'];
const LOREM = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function numberAt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw `${what} must be a number`;
  return value;
}

function optionsAt(value: unknown, what: string): Record<string, unknown> {
  if (!isObject(value)) throw `${what} takes an options object`;
  return value;
}

/** A range's bounds, refused when they are the wrong way round as the backend refuses them. */
function range(options: Record<string, unknown>, what: string, defaults: { min?: number; max?: number } = {}) {
  const min = numberAt(options.min ?? defaults.min, `${what}.min`);
  const max = numberAt(options.max ?? defaults.max, `${what}.max`);
  if (min > max) throw `${what} min must be <= max`;
  return { min, max };
}

function parseSpec(value: unknown, path: string): Spec {
  if (typeof value === 'string') {
    if (!value.startsWith('$')) return { kind: 'literal', value };
    const kind = BARE_GENERATORS[value];
    if (!kind) throw `unknown generator "${value}" at ${path}`;
    return { kind };
  }
  // Bare arrays and scalars pass through; only {"$array": …} generates.
  if (!isObject(value)) return { kind: 'literal', value };

  const keys = Object.keys(value);
  const generators = keys.filter((key) => key.startsWith('$'));
  if (generators.length === 0) {
    return {
      kind: 'object',
      fields: keys.map((key) => [key, parseSpec(value[key], path ? `${path}.${key}` : key)]),
    };
  }
  if (keys.length > 1) throw `${path}: a generator takes exactly one "$" key, got ${keys.join(', ')}`;

  const key = generators[0];
  const inner = value[key];
  const what = `${path}: ${key}`;
  switch (key) {
    case '$literal':
      return { kind: 'literal', value: inner };
    case '$int':
      return { kind: 'int', ...range(optionsAt(inner, what), what, { min: 0, max: 1000 }) };
    case '$float': {
      const options = optionsAt(inner, what);
      return { kind: 'float', ...range(options, what), decimals: numberAt(options.decimals ?? 2, `${what}.decimals`) };
    }
    case '$date': {
      const options = optionsAt(inner, what);
      if ('past_days' in options) {
        const now = Date.now();
        return { kind: 'date', from: now - numberAt(options.past_days, `${what}.past_days`) * DAY_MS, to: now };
      }
      const from = typeof options.from === 'string' ? Date.parse(options.from) : NaN;
      const to = typeof options.to === 'string' ? Date.parse(options.to) : NaN;
      if (Number.isNaN(from) || Number.isNaN(to)) throw `${what} needs past_days, or from and to as ISO dates`;
      if (from > to) throw `${what} from must be <= to`;
      return { kind: 'date', from, to };
    }
    case '$lorem':
      return { kind: 'lorem', words: numberAt(optionsAt(inner, what).words, `${what}.words`) };
    case '$pick':
      if (!Array.isArray(inner) || inner.length === 0) throw `${what} needs at least one value`;
      return { kind: 'pick', values: inner };
    case '$array': {
      const options = optionsAt(inner, what);
      if (!('of' in options)) throw `${what} needs "of"`;
      return { kind: 'array', of: parseSpec(options.of, `${path}[0]`), ...range(options, what) };
    }
    default:
      throw `unknown generator "${key}" at ${path}`;
  }
}

function parseTemplate(template: string): Spec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch (error) {
    throw `Invalid template JSON: ${String(error)}`;
  }
  if (!isObject(parsed) || Object.keys(parsed).some((key) => key.startsWith('$'))) {
    throw 'template root must be a JSON object';
  }
  return parseSpec(parsed, '');
}

/** Mulberry32: small, fast and deterministic for a given seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** `count` bytes from the seeded generator. */
const randomBytes = (random: () => number, count: number) => Array.from({ length: count }, () => Math.floor(random() * 256));
const hex = (bytes: number[]) => bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');

function generate(spec: Spec, random: () => number): unknown {
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const oneOf = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  switch (spec.kind) {
    case 'literal':
      return structuredClone(spec.value);
    case 'object':
      return Object.fromEntries(spec.fields.map(([key, field]) => [key, generate(field, random)]));
    case 'name':
      return `${oneOf(FIRST_NAMES)} ${oneOf(LAST_NAMES)}`;
    case 'firstName':
      return oneOf(FIRST_NAMES);
    case 'lastName':
      return oneOf(LAST_NAMES);
    case 'email':
      return `${oneOf(FIRST_NAMES)}.${oneOf(LAST_NAMES)}${between(1, 99)}@example.com`.toLowerCase();
    case 'objectId':
      // All twelve bytes come from the seeded generator, as in the backend, so a seed repeats its ids.
      return { $oid: hex(randomBytes(random, 12)) };
    case 'uuid': {
      // A version 4 UUID: the version nibble is 4 and the variant bits are 10.
      const bytes = randomBytes(random, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const text = hex(bytes);
      return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
    }
    case 'bool':
      return random() < 0.5;
    case 'int':
      return between(spec.min, spec.max);
    case 'float':
      return Number((spec.min + random() * (spec.max - spec.min)).toFixed(spec.decimals));
    case 'date':
      return { $date: new Date(spec.from + Math.floor(random() * (spec.to - spec.from))).toISOString() };
    case 'lorem':
      return Array.from({ length: spec.words }, () => oneOf(LOREM)).join(' ');
    case 'pick':
      return structuredClone(oneOf(spec.values));
    case 'array':
      return Array.from({ length: between(spec.min, spec.max) }, () => generate(spec.of, random));
  }
}

/** `count` documents from `template`; an absent seed draws a fresh one. */
export function generateDocuments(template: string, count: number, seed?: number): Doc[] {
  const spec = parseTemplate(template);
  const random = seededRandom(seed ?? Math.floor(Math.random() * 4_294_967_296));
  return Array.from({ length: count }, () => generate(spec, random) as Doc);
}

/** What `preview_generated_documents` returns: a few documents, each as a JSON string. */
export function previewDocuments(template: string, count?: number, seed?: number): string[] {
  const n = Math.min(count ?? PREVIEW_DEFAULT_DOCS, PREVIEW_MAX_DOCS);
  return generateDocuments(template, n, seed).map((doc) => JSON.stringify(doc));
}

function nameHeuristic(path: string, dominant: string | undefined): unknown {
  const last = (path.split('.').pop() ?? path).toLowerCase();
  if (last.includes('email')) return '$email';
  if (last.includes('first') && last.includes('name')) return '$firstName';
  if (last.includes('last') && last.includes('name')) return '$lastName';
  if (last.includes('name')) return '$name';
  if (last.endsWith('_at') || last.includes('date') || last.includes('created') || last.includes('updated')) {
    return { $date: { past_days: 365 } };
  }
  if (last.endsWith('id') && dominant === 'objectId') return '$objectId';
  return undefined;
}

function typeFallback(type: string): unknown {
  switch (type) {
    case 'string':
      return { $lorem: { words: 2 } };
    case 'int':
    case 'long':
      return { $int: { min: 0, max: 1000 } };
    case 'double':
    case 'decimal':
      return { $float: { min: 0, max: 1000, decimals: 2 } };
    case 'bool':
    case 'boolean':
      return '$bool';
    case 'date':
      return { $date: { past_days: 365 } };
    case 'objectId':
      return '$objectId';
    case 'array':
      return { $array: { of: { $lorem: { words: 2 } }, min: 1, max: 3 } };
    default:
      return undefined;
  }
}

/**
 * A starter template inferred from a schema report, by the rules of
 * `infer_template_from_schema`: skip `_id`, build objects from their children's
 * paths, then a generator from the field name or else its dominant type. The
 * backend also turns a low-cardinality field into a `$pick`; the fake leaves
 * that step out.
 */
export function inferTemplate(report: ReturnType<typeof inferSchema>): string {
  const root: Record<string, unknown> = {};
  for (const field of report.fields) {
    if (field.path === '_id' || field.path.startsWith('_id.')) continue;
    const dominant = field.types[0]?.type;
    if (dominant === 'object') continue;
    const spec = nameHeuristic(field.path, dominant) ?? (dominant === undefined ? undefined : typeFallback(dominant));
    if (spec === undefined) continue;

    const segments = field.path.split('.');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      if (!isObject(node[segment])) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    node[segments[segments.length - 1]] = spec;
  }
  return JSON.stringify(root, null, 2);
}
