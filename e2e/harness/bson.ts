// BSON for the fake backend's exports and imports (#396), between BSON bytes
// and the relaxed Extended JSON the app works in. Encoding reads Extended JSON
// the way the backend's `Bson::try_from` does, and decoding writes it the way
// `Bson::into_relaxed_extjson` does (bson 2.15): every BSON type either can
// hold. A JSON integer that fits becomes an int32, a larger one an int64, and
// any other number a double.
import type { Doc } from './seed';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const big = BigInt;

function fixed(size: number, write: (view: DataView) => void): number[] {
  const view = new DataView(new ArrayBuffer(size));
  write(view);
  return [...new Uint8Array(view.buffer)];
}

const int32 = (value: number) => fixed(4, (view) => view.setInt32(0, value, true));
const uint32 = (value: number) => fixed(4, (view) => view.setUint32(0, value, true));
const int64 = (value: bigint) => fixed(8, (view) => view.setBigInt64(0, value, true));
const double = (value: number) => fixed(8, (view) => view.setFloat64(0, value, true));
const cstring = (text: string) => [...encoder.encode(text), 0];
const stringBytes = (text: string) => {
  const bytes = encoder.encode(text);
  return [...int32(bytes.length + 1), ...bytes, 0];
};
const hexBytes = (hex: string) => (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
const hexOf = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

function base64Of(bytes: Uint8Array | number[]): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  return btoa(binary);
}

function base64Bytes(text: string): number[] {
  try {
    return [...atob(text)].map((char) => char.charCodeAt(0));
  } catch {
    throw `Invalid document: invalid value: string ${JSON.stringify(text)}, expected base64 encoded bytes`;
  }
}

/** Binary data with its length and subtype; subtype 2, the old binary, repeats the length inside. */
function binary(bytes: number[], subtype: number): number[] {
  const payload = subtype === 2 ? [...int32(bytes.length), ...bytes] : bytes;
  return [...int32(payload.length), subtype, ...payload];
}

function dateMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  if (isObject(value) && '$numberLong' in value) return Number(value.$numberLong);
  const millis = Date.parse(String(value));
  if (Number.isNaN(millis)) throw `Invalid document: invalid value: string ${JSON.stringify(value)}, expected rfc3339 formatted utc datetime`;
  return millis;
}

// Decimal128, as src/decimal128.rs in the bson crate packs and prints it.
const DECIMAL_BIAS = 6176;
const DECIMAL_TINY = -6176;
const DECIMAL_MAX_EXPONENT = 6111;
const DECIMAL_MAX_DIGITS = 34;
const DECIMAL_MAX_COEFFICIENT = big('9999999999999999999999999999999999');

/** Digits cut to `precision`, refused when a digit cut away isn't zero (`round_decimal_str`). */
function roundDigits(digits: string, precision: number): string {
  if ([...digits.slice(precision)].some((digit) => digit !== '0')) throw 'inexact rounding';
  return digits.slice(0, precision);
}

/** A `$numberDecimal` string as Decimal128's 16 bytes (`Decimal128::from_str`). */
function decimalBytes(text: string): number[] {
  let rest = text;
  let sign = false;
  if (rest.startsWith('-') || rest.startsWith('+')) {
    sign = rest.startsWith('-');
    rest = rest.slice(1);
  }
  const lower = rest.toLowerCase();
  let bits: bigint;
  if (lower === 'nan' || lower === 'snan') {
    bits = (big(0b11111) << big(122)) | (lower === 'snan' ? big(1) << big(121) : big(0));
  } else if (lower === 'infinity' || lower === 'inf') {
    bits = big(0b11110) << big(122);
  } else {
    const at = lower.indexOf('e');
    let digits = at < 0 ? lower : lower.slice(0, at);
    const exponentText = at < 0 ? '0' : lower.slice(at + 1);
    if (at >= 0 && exponentText === '') throw 'empty exponent';
    if (!/^[+-]?\d+$/.test(exponentText) || Number(exponentText) < -32_768 || Number(exponentText) > 32_767) {
      throw `invalid exponent: ${exponentText}`;
    }
    let exponent = Number(exponentText);
    const dot = digits.indexOf('.');
    if (dot >= 0) {
      exponent -= digits.length - dot - 1;
      if (exponent < -32_768) throw 'underflow';
      digits = digits.slice(0, dot) + digits.slice(dot + 1);
    }
    digits = digits.replace(/^0+/, '') || '0';
    if (digits.length > DECIMAL_MAX_DIGITS) {
      const length = digits.length;
      digits = roundDigits(digits, DECIMAL_MAX_DIGITS);
      exponent += length - digits.length;
    }
    if (exponent < DECIMAL_TINY) {
      if (digits !== '0') {
        const precision = digits.length - (DECIMAL_TINY - exponent);
        if (precision < 0) throw 'underflow';
        digits = roundDigits(digits, precision);
      }
      exponent = DECIMAL_TINY;
    }
    if (exponent > DECIMAL_MAX_EXPONENT) {
      if (digits !== '0') {
        const delta = exponent - DECIMAL_MAX_EXPONENT;
        if (digits.length + delta > DECIMAL_MAX_DIGITS) throw 'overflow';
        digits += '0'.repeat(delta);
      }
      exponent = DECIMAL_MAX_EXPONENT;
    }
    if (!/^\d+$/.test(digits)) throw `invalid coefficient: ${digits}`;
    bits = (big(exponent + DECIMAL_BIAS) << big(113)) | big(digits);
  }
  if (sign) bits |= big(1) << big(127);
  return Array.from({ length: 16 }, (_, i) => Number((bits >> big(8 * i)) & big(0xff)));
}

/** Decimal128's 16 bytes as the bson crate displays them. */
function decimalText(bytes: Uint8Array): string {
  let bits = big(0);
  for (let i = 15; i >= 0; i -= 1) bits = (bits << big(8)) | big(bytes[i]);
  const bit = (n: number) => ((bits >> big(n)) & big(1)) === big(1);
  const field = (from: number, width: number) => Number((bits >> big(from)) & ((big(1) << big(width)) - big(1)));
  const sign = bit(127);
  if (bit(126) && bit(125) && bit(124) && bit(123)) {
    // MongoDB prints NaN without a sign.
    if (bit(122)) return 'NaN';
    return sign ? '-Infinity' : 'Infinity';
  }
  let exponent: number;
  let coefficient: bigint;
  if (bit(126) && bit(125)) {
    // This form's coefficient is always past the largest one, which reads as zero.
    exponent = field(111, 14) - DECIMAL_BIAS;
    coefficient = big(0);
  } else {
    exponent = field(113, 14) - DECIMAL_BIAS;
    coefficient = bits & ((big(1) << big(113)) - big(1));
    if (coefficient > DECIMAL_MAX_COEFFICIENT) coefficient = big(0);
  }
  return formatDecimal(sign, coefficient, exponent);
}

/** A finite decimal's text as the bson crate displays it: plain notation near zero, scientific otherwise. */
export function formatDecimal(negative: boolean, coefficient: bigint, exponent: number): string {
  const digits = coefficient.toString();
  const adjusted = exponent + digits.length - 1;
  let text: string;
  if (exponent <= 0 && adjusted >= -6) {
    if (exponent === 0) text = digits;
    else if (-exponent >= digits.length) text = `0.${'0'.repeat(-exponent - digits.length)}${digits}`;
    else text = `${digits.slice(0, digits.length + exponent)}.${digits.slice(digits.length + exponent)}`;
  } else {
    text = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}E${adjusted > 0 ? '+' : ''}${adjusted}`;
  }
  return `${negative ? '-' : ''}${text}`;
}

/**
 * The element for an Extended JSON wrapper, or null for a plain document. The
 * wrapper is recognised by its key, in `Bson::try_from`'s order, and any other
 * key beside it is refused.
 */
function wrapperElement(name: number[], value: Record<string, unknown>): number[] | null {
  const only = (...keys: string[]) => {
    const extra = Object.keys(value).find((key) => !keys.includes(key));
    if (extra !== undefined) throw `Invalid document: unknown field \`${extra}\`, expected \`${keys.join('`, `')}\``;
  };
  const decimal = (text: string) => {
    try {
      return decimalBytes(text);
    } catch (reason) {
      throw `Invalid document: ${String(reason)}`;
    }
  };
  if ('$oid' in value) {
    only('$oid');
    if (!/^[0-9a-fA-F]{24}$/.test(String(value.$oid))) throw `Invalid document: invalid ObjectId ${JSON.stringify(value.$oid)}`;
    return [0x07, ...name, ...hexBytes(String(value.$oid))];
  }
  if ('$symbol' in value) {
    only('$symbol');
    return [0x0e, ...name, ...stringBytes(String(value.$symbol))];
  }
  if ('$regularExpression' in value) {
    only('$regularExpression');
    const body = value.$regularExpression as { pattern?: unknown; options?: unknown };
    // The crate keeps a regular expression's options sorted.
    return [0x0b, ...name, ...cstring(String(body.pattern)), ...cstring([...String(body.options ?? '')].sort().join(''))];
  }
  if ('$numberInt' in value) {
    only('$numberInt');
    return [0x10, ...name, ...int32(Number(value.$numberInt))];
  }
  if ('$numberLong' in value) {
    only('$numberLong');
    return [0x12, ...name, ...int64(big(String(value.$numberLong)))];
  }
  if ('$numberDouble' in value) {
    only('$numberDouble');
    return [0x01, ...name, ...double(Number(value.$numberDouble))];
  }
  if ('$numberDecimal' in value) {
    only('$numberDecimal');
    return [0x13, ...name, ...decimal(String(value.$numberDecimal))];
  }
  if ('$binary' in value) {
    only('$binary');
    const body = value.$binary as { base64?: unknown; subType?: unknown };
    const subtype = String(body.subType ?? '');
    if (!/^[0-9a-fA-F]{2}$/.test(subtype)) throw `Invalid document: invalid value: string ${JSON.stringify(subtype)}, expected one byte subtype`;
    return [0x05, ...name, ...binary(base64Bytes(String(body.base64)), parseInt(subtype, 16))];
  }
  if ('$uuid' in value) {
    only('$uuid');
    const hex = String(value.$uuid).replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
      throw `Invalid document: invalid value: string ${JSON.stringify(value.$uuid)}, expected $uuid value does not follow RFC 4122 format regarding length and hyphens`;
    }
    return [0x05, ...name, ...binary(hexBytes(hex), 4)];
  }
  if ('$code' in value) {
    only('$code', '$scope');
    const code = stringBytes(String(value.$code));
    if (value.$scope === undefined) return [0x0d, ...name, ...code];
    const scope = document(value.$scope as Record<string, unknown>);
    return [0x0f, ...name, ...int32(4 + code.length + scope.length), ...code, ...scope];
  }
  if ('$timestamp' in value) {
    only('$timestamp');
    const body = value.$timestamp as { t?: unknown; i?: unknown };
    // The increment comes first, then the seconds.
    return [0x11, ...name, ...uint32(Number(body.i)), ...uint32(Number(body.t))];
  }
  if ('$date' in value) {
    only('$date');
    return [0x09, ...name, ...int64(big(dateMillis(value.$date)))];
  }
  if ('$minKey' in value) {
    only('$minKey');
    return [0xff, ...name];
  }
  if ('$maxKey' in value) {
    only('$maxKey');
    return [0x7f, ...name];
  }
  if ('$dbPointer' in value) {
    only('$dbPointer');
    const body = value.$dbPointer as { $ref?: unknown; $id?: { $oid?: unknown } };
    return [0x0c, ...name, ...stringBytes(String(body.$ref)), ...hexBytes(String(body.$id?.$oid))];
  }
  if ('$undefined' in value) {
    only('$undefined');
    return [0x06, ...name];
  }
  return null;
}

function element(key: string, value: unknown): number[] {
  const name = cstring(key);
  if (value === null || value === undefined) return [0x0a, ...name];
  if (typeof value === 'boolean') return [0x08, ...name, value ? 1 : 0];
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff) return [0x10, ...name, ...int32(value)];
    if (Number.isSafeInteger(value)) return [0x12, ...name, ...int64(big(value))];
    return [0x01, ...name, ...double(value)];
  }
  if (typeof value === 'string') return [0x02, ...name, ...stringBytes(value)];
  if (Array.isArray(value)) return [0x04, ...name, ...document(Object.fromEntries(value.map((item, i) => [String(i), item])))];
  if (isObject(value)) return wrapperElement(name, value) ?? [0x03, ...name, ...document(value)];
  throw `e2e fake backend cannot encode a ${typeof value} as BSON`;
}

function document(doc: Record<string, unknown>): number[] {
  const body = Object.entries(doc).flatMap(([key, value]) => element(key, value));
  return [...int32(body.length + 5), ...body, 0];
}

/**
 * The documents in a `.bson` file, as relaxed Extended JSON: the reverse of
 * `toBsonBase64`, for a BSON import. The fake's files are text, so the bytes
 * arrive base64-encoded. A type tag BSON doesn't define is refused.
 */
export function fromBsonBase64(base64: string): Doc[] {
  const bytes = Uint8Array.from(atob(base64.trim()), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);

  const readString = (at: number): [string, number] => {
    const length = view.getInt32(at, true);
    return [decoder.decode(bytes.subarray(at + 4, at + 4 + length - 1)), at + 4 + length];
  };
  const readCString = (at: number): [string, number] => {
    const end = bytes.indexOf(0, at);
    return [decoder.decode(bytes.subarray(at, end)), end + 1];
  };

  const readDocument = (at: number): [Doc, number] => {
    if (at + 5 > bytes.length) throw 'Invalid BSON: truncated document';
    const size = view.getInt32(at, true);
    if (size < 5 || at + size > bytes.length) throw 'Invalid BSON: truncated document';
    const doc: Doc = {};
    let pos = at + 4;
    while (pos < at + size - 1) {
      const type = bytes[pos];
      const [name, afterName] = readCString(pos + 1);
      pos = afterName;
      let value: unknown;
      switch (type) {
        case 0x01: {
          const number = view.getFloat64(pos, true);
          if (Number.isNaN(number)) value = { $numberDouble: 'NaN' };
          else if (!Number.isFinite(number)) value = { $numberDouble: number < 0 ? '-Infinity' : 'Infinity' };
          else value = number;
          pos += 8;
          break;
        }
        case 0x02:
          [value, pos] = readString(pos);
          break;
        case 0x03:
        case 0x04: {
          const [inner, next] = readDocument(pos);
          value = type === 0x04 ? Object.values(inner) : inner;
          pos = next;
          break;
        }
        case 0x05: {
          const length = view.getInt32(pos, true);
          const subtype = bytes[pos + 4];
          let data = bytes.subarray(pos + 5, pos + 5 + length);
          // The old binary subtype repeats the length before its bytes.
          if (subtype === 2) data = data.subarray(4, 4 + view.getInt32(pos + 5, true));
          value = { $binary: { base64: base64Of(data), subType: subtype.toString(16).padStart(2, '0') } };
          pos += 5 + length;
          break;
        }
        case 0x06:
          value = { $undefined: true };
          break;
        case 0x07:
          value = { $oid: hexOf(bytes.subarray(pos, pos + 12)) };
          pos += 12;
          break;
        case 0x08:
          value = bytes[pos] === 1;
          pos += 1;
          break;
        case 0x09: {
          const millis = Number(view.getBigInt64(pos, true));
          const year = new Date(millis).getUTCFullYear();
          // Relaxed Extended JSON writes a date from 1970 to 9999 as ISO text.
          value = millis >= 0 && year <= 9999 ? { $date: new Date(millis).toISOString() } : { $date: { $numberLong: String(millis) } };
          pos += 8;
          break;
        }
        case 0x0a:
          value = null;
          break;
        case 0x0b: {
          const [pattern, afterPattern] = readCString(pos);
          const [options, afterOptions] = readCString(afterPattern);
          value = { $regularExpression: { pattern, options: [...options].sort().join('') } };
          pos = afterOptions;
          break;
        }
        case 0x0c: {
          const [namespace, afterNamespace] = readString(pos);
          value = { $dbPointer: { $ref: namespace, $id: { $oid: hexOf(bytes.subarray(afterNamespace, afterNamespace + 12)) } } };
          pos = afterNamespace + 12;
          break;
        }
        case 0x0d: {
          const [code, next] = readString(pos);
          value = { $code: code };
          pos = next;
          break;
        }
        case 0x0e: {
          const [symbol, next] = readString(pos);
          value = { $symbol: symbol };
          pos = next;
          break;
        }
        case 0x0f: {
          const [code, afterCode] = readString(pos + 4);
          const [scope, next] = readDocument(afterCode);
          value = { $code: code, $scope: scope };
          pos = next;
          break;
        }
        case 0x10:
          value = view.getInt32(pos, true);
          pos += 4;
          break;
        case 0x11:
          value = { $timestamp: { t: view.getUint32(pos + 4, true), i: view.getUint32(pos, true) } };
          pos += 8;
          break;
        case 0x12: {
          const long = view.getBigInt64(pos, true);
          value = Number.isSafeInteger(Number(long)) ? Number(long) : { $numberLong: long.toString() };
          pos += 8;
          break;
        }
        case 0x13:
          value = { $numberDecimal: decimalText(bytes.subarray(pos, pos + 16)) };
          pos += 16;
          break;
        case 0x7f:
          value = { $maxKey: 1 };
          break;
        case 0xff:
          value = { $minKey: 1 };
          break;
        default:
          throw `Invalid BSON: unrecognized element type 0x${type.toString(16)}`;
      }
      // Defined rather than assigned, so a field named __proto__ stays a plain field.
      Object.defineProperty(doc, name, { value, enumerable: true, writable: true, configurable: true });
    }
    return [doc, at + size];
  };

  const docs: Doc[] = [];
  for (let at = 0; at < bytes.length; ) {
    const [doc, next] = readDocument(at);
    docs.push(doc);
    at = next;
  }
  return docs;
}

/**
 * The documents as a `.bson` file holds them, one after another, as base64:
 * the fake records written files as text.
 */
export function toBsonBase64(docs: Doc[]): string {
  return base64Of(docs.flatMap((doc) => document(doc)));
}
