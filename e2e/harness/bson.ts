// BSON encoding for the fake backend's exports (#396), from the relaxed
// Extended JSON the app works in, the way the backend's `Bson::try_from`
// reads it: an integer that fits becomes an int32, a larger one an int64, and
// any other number a double.
import type { Doc } from './seed';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const encoder = new TextEncoder();

function fixed(size: number, write: (view: DataView) => void): number[] {
  const view = new DataView(new ArrayBuffer(size));
  write(view);
  return [...new Uint8Array(view.buffer)];
}

const int32 = (value: number) => fixed(4, (view) => view.setInt32(0, value, true));
const int64 = (value: bigint) => fixed(8, (view) => view.setBigInt64(0, value, true));
const double = (value: number) => fixed(8, (view) => view.setFloat64(0, value, true));
const cstring = (text: string) => [...encoder.encode(text), 0];

function dateMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  if (isObject(value) && '$numberLong' in value) return Number(value.$numberLong);
  const millis = Date.parse(String(value));
  if (Number.isNaN(millis)) throw `e2e fake backend cannot encode the date ${JSON.stringify(value)} as BSON`;
  return millis;
}

function element(key: string, value: unknown): number[] {
  const name = cstring(key);
  if (value === null || value === undefined) return [0x0a, ...name];
  if (typeof value === 'boolean') return [0x08, ...name, value ? 1 : 0];
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff) return [0x10, ...name, ...int32(value)];
    if (Number.isSafeInteger(value)) return [0x12, ...name, ...int64(BigInt(value))];
    return [0x01, ...name, ...double(value)];
  }
  if (typeof value === 'string') {
    const text = encoder.encode(value);
    return [0x02, ...name, ...int32(text.length + 1), ...text, 0];
  }
  if (Array.isArray(value)) return [0x04, ...name, ...document(Object.fromEntries(value.map((item, i) => [String(i), item])))];
  if (isObject(value)) {
    if (typeof value.$oid === 'string') return [0x07, ...name, ...(value.$oid.match(/../g) ?? []).map((pair) => parseInt(pair, 16))];
    if ('$date' in value) return [0x09, ...name, ...int64(BigInt(dateMillis(value.$date)))];
    if ('$numberLong' in value) return [0x12, ...name, ...int64(BigInt(String(value.$numberLong)))];
    if ('$numberInt' in value) return [0x10, ...name, ...int32(Number(value.$numberInt))];
    if ('$numberDouble' in value) return [0x01, ...name, ...double(Number(value.$numberDouble))];
    const wrapper = Object.keys(value).find((key) => key.startsWith('$'));
    if (wrapper) throw `e2e fake backend cannot encode ${wrapper} as BSON`;
    return [0x03, ...name, ...document(value)];
  }
  throw `e2e fake backend cannot encode a ${typeof value} as BSON`;
}

function document(doc: Record<string, unknown>): number[] {
  const body = Object.entries(doc).flatMap(([key, value]) => element(key, value));
  return [...int32(body.length + 5), ...body, 0];
}

/**
 * The documents as a `.bson` file holds them, one after another, as base64:
 * the fake records written files as text.
 */
export function toBsonBase64(docs: Doc[]): string {
  const bytes = docs.flatMap((doc) => document(doc));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  return btoa(binary);
}
