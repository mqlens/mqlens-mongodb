// BSON numbers in the fake backend (#396): int, long, double and decimal
// values in any Extended JSON form, compared and added without rounding a long
// or a decimal through a JavaScript double, and giving each result the BSON
// type MongoDB gives it.
import { formatDecimal } from './bson';

const big = BigInt;
const TEN = big(10);
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;
const INT64_MIN = -(big(1) << big(63));
const INT64_MAX = (big(1) << big(63)) - big(1);
const DECIMAL_DIGITS = 34;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A number's exact value as coefficient × 10^exponent, or NaN, or an infinity. */
export type ExactNumber = { nan: true } | { infinity: 1 | -1 } | { coefficient: bigint; exponent: number };

/** A double's exact value: its binary fraction m × 2^p written as m × 5^-p × 10^p. */
function exactDouble(value: number): ExactNumber {
  if (Number.isNaN(value)) return { nan: true };
  if (!Number.isFinite(value)) return { infinity: value < 0 ? -1 : 1 };
  if (Number.isInteger(value)) return { coefficient: big(value), exponent: 0 };
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const biased = (high >>> 20) & 0x7ff;
  let mantissa = (big(high & 0xf_ffff) << big(32)) | big(view.getUint32(4));
  if (biased !== 0) mantissa |= big(1) << big(52);
  const power = (biased === 0 ? 1 : biased) - 1075;
  const coefficient = mantissa * big(5) ** big(-power);
  return { coefficient: high >>> 31 ? -coefficient : coefficient, exponent: power };
}

/** A decimal string's exact value. */
function exactDecimal(text: string): ExactNumber {
  const match = /^([+-]?)(?:(s?nan)|(inf|infinity)|(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?)$/i.exec(text.trim());
  if (!match || match[2]) return { nan: true };
  const negative = match[1] === '-';
  if (match[3]) return { infinity: negative ? -1 : 1 };
  const fraction = match[5] ?? '';
  const coefficient = big(`${match[4] ?? ''}${fraction}` || '0');
  return { coefficient: negative ? -coefficient : coefficient, exponent: Number(match[6] ?? 0) - fraction.length };
}

/** A BSON number with its type: ints and longs as BigInts, doubles as JavaScript numbers, decimals exactly. */
export type Numeric =
  | { kind: 'int' | 'long'; value: bigint }
  | { kind: 'double'; value: number }
  | { kind: 'decimal'; value: ExactNumber };

/**
 * A numeric value's BSON type and value, or null for anything else. A plain
 * JSON integer is an int when it fits in 32 bits and a long otherwise, as
 * `Bson::try_from` reads it; any other number is a double.
 */
export function readNumeric(value: unknown): Numeric | null {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return { kind: 'double', value };
    if (value >= INT32_MIN && value <= INT32_MAX) return { kind: 'int', value: big(value) };
    return Math.abs(value) < 2 ** 63 ? { kind: 'long', value: big(value) } : { kind: 'double', value };
  }
  if (!isObject(value)) return null;
  try {
    if ('$numberInt' in value) return { kind: 'int', value: big(String(value.$numberInt)) };
    if ('$numberLong' in value) return { kind: 'long', value: big(String(value.$numberLong)) };
  } catch {
    return null;
  }
  if ('$numberDouble' in value) return { kind: 'double', value: Number(value.$numberDouble) };
  if ('$numberDecimal' in value) return { kind: 'decimal', value: exactDecimal(String(value.$numberDecimal)) };
  return null;
}

function exact(n: Numeric): ExactNumber {
  if (n.kind === 'decimal') return n.value;
  if (n.kind === 'double') return exactDouble(n.value);
  return { coefficient: n.value, exponent: 0 };
}

/**
 * Two numbers in BSON order, compared exactly whatever their representation,
 * so longs past 2^53 and decimals with more digits than a double holds stay
 * distinct. NaN sorts before every other number and equals itself.
 */
export function compareNumbers(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number' && !Number.isNaN(a) && !Number.isNaN(b)) return a < b ? -1 : a > b ? 1 : 0;
  const na = readNumeric(a);
  const nb = readNumeric(b);
  const x: ExactNumber = na ? exact(na) : { nan: true };
  const y: ExactNumber = nb ? exact(nb) : { nan: true };
  if ('nan' in x || 'nan' in y) return ('nan' in x ? 0 : 1) - ('nan' in y ? 0 : 1);
  const infinity = (n: ExactNumber) => ('infinity' in n ? n.infinity : 0);
  if ('infinity' in x || 'infinity' in y) return Math.sign(infinity(x) - infinity(y));
  const { coefficient: c1, exponent: e1 } = x as { coefficient: bigint; exponent: number };
  const { coefficient: c2, exponent: e2 } = y as { coefficient: bigint; exponent: number };
  const left = e1 > e2 ? c1 * TEN ** big(e1 - e2) : c1;
  const right = e2 > e1 ? c2 * TEN ** big(e2 - e1) : c2;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A decimal cut to 34 significant digits, rounding half to even, as Decimal128 arithmetic rounds. */
function roundDecimal(n: ExactNumber): ExactNumber {
  if (!('coefficient' in n)) return n;
  const negative = n.coefficient < 0;
  let magnitude = negative ? -n.coefficient : n.coefficient;
  let exponent = n.exponent;
  while (magnitude >= TEN ** big(DECIMAL_DIGITS)) {
    const dropped = magnitude.toString().length - DECIMAL_DIGITS;
    const divisor = TEN ** big(dropped);
    let quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    const half = divisor / big(2);
    if (remainder > half || (remainder === half && quotient % big(2) === big(1))) quotient += big(1);
    magnitude = quotient;
    exponent += dropped;
  }
  return { coefficient: negative ? -magnitude : magnitude, exponent };
}

/** A number as a decimal: ints and longs exactly, and a double rounded to 15 significant digits, as MongoDB converts one. */
function asDecimal(n: Numeric): ExactNumber {
  if (n.kind === 'decimal') return n.value;
  if (n.kind === 'double') return Number.isFinite(n.value) ? exactDecimal(n.value.toPrecision(15)) : exactDouble(n.value);
  return { coefficient: n.value, exponent: 0 };
}

function addDecimals(a: ExactNumber, b: ExactNumber): ExactNumber {
  if ('nan' in a || 'nan' in b) return { nan: true };
  if ('infinity' in a || 'infinity' in b) {
    const direction = ('infinity' in a ? a.infinity : 0) + ('infinity' in b ? b.infinity : 0);
    return direction === 0 ? { nan: true } : { infinity: direction > 0 ? 1 : -1 };
  }
  const exponent = Math.min(a.exponent, b.exponent);
  const scaled = (n: { coefficient: bigint; exponent: number }) => n.coefficient * TEN ** big(n.exponent - exponent);
  return roundDecimal({ coefficient: scaled(a) + scaled(b), exponent });
}

const asDouble = (n: Numeric): number =>
  n.kind === 'double' ? n.value : n.kind === 'decimal' ? Number(formatExact(n.value)) : Number(n.value);

function formatExact(n: ExactNumber): string {
  if ('nan' in n) return 'NaN';
  if ('infinity' in n) return n.infinity < 0 ? '-Infinity' : 'Infinity';
  const negative = n.coefficient < 0;
  return formatDecimal(negative, negative ? -n.coefficient : n.coefficient, n.exponent);
}

/**
 * The sum of two numbers with the type MongoDB gives it: a decimal when either
 * is one, else a double when either is one, else a long when either is one or
 * two ints overflow 32 bits, else an int. Null when a long sum leaves 64 bits.
 */
export function addNumeric(a: Numeric, b: Numeric): Numeric | null {
  if (a.kind === 'decimal' || b.kind === 'decimal') return { kind: 'decimal', value: addDecimals(asDecimal(a), asDecimal(b)) };
  if (a.kind === 'double' || b.kind === 'double') return { kind: 'double', value: asDouble(a) + asDouble(b) };
  const sum = (a.value as bigint) + (b.value as bigint);
  if (a.kind === 'long' || b.kind === 'long' || sum < big(INT32_MIN) || sum > big(INT32_MAX)) {
    return sum < INT64_MIN || sum > INT64_MAX ? null : { kind: 'long', value: sum };
  }
  return { kind: 'int', value: sum };
}

/** A number in the Extended JSON form that reads back as the same BSON type and value. */
export function numericValue(n: Numeric): unknown {
  switch (n.kind) {
    case 'int':
      return Number(n.value);
    case 'long': {
      const value = Number(n.value);
      // A safe integer outside 32 bits already reads back as a long; anything else keeps its wrapper.
      return Number.isSafeInteger(value) && (value < INT32_MIN || value > INT32_MAX) ? value : { $numberLong: n.value.toString() };
    }
    case 'double':
      // A whole or non-finite double would read back as an int, a long or nothing at all.
      if (Number.isInteger(n.value) && Math.abs(n.value) < 1e21) return { $numberDouble: `${n.value}.0` };
      return Number.isFinite(n.value) ? n.value : { $numberDouble: String(n.value) };
    case 'decimal':
      return { $numberDecimal: formatExact(n.value) };
  }
}

/** `$sum` over a group's values: numbers only, an int total widening to a long, and a long one to a double on overflow. */
export function sumNumbers(values: unknown[]): unknown {
  let total: Numeric = { kind: 'int', value: big(0) };
  for (const value of values) {
    const n = readNumeric(value);
    if (n) total = addNumeric(total, n) ?? { kind: 'double', value: asDouble(total) + asDouble(n) };
  }
  return numericValue(total);
}

/**
 * A decimal total divided by a count: exact at the exponent closest to the
 * ideal one when the quotient fits in 34 digits, and rounded to 34 significant
 * digits otherwise.
 */
function divideDecimal(total: ExactNumber, count: number): ExactNumber {
  if (!('coefficient' in total)) return total;
  const divisor = big(count);
  for (let shift = 0; shift <= DECIMAL_DIGITS; shift += 1) {
    const scaled = total.coefficient * TEN ** big(shift);
    if (scaled % divisor !== big(0)) continue;
    const quotient = scaled / divisor;
    if ((quotient < 0 ? -quotient : quotient).toString().length <= DECIMAL_DIGITS) return { coefficient: quotient, exponent: total.exponent - shift };
    break;
  }
  const precision = 40;
  const scaled = total.coefficient * TEN ** big(precision);
  const negative = scaled < 0;
  const magnitude = negative ? -scaled : scaled;
  // A final sticky digit keeps a remainder from reading as an exact half when rounding.
  const digits = (magnitude / divisor) * TEN + (magnitude % divisor > big(0) ? big(1) : big(0));
  return roundDecimal({ coefficient: negative ? -digits : digits, exponent: total.exponent - precision - 1 });
}

/** `$avg` over a group's values: numbers only; a decimal when any value is one, a double otherwise, and null with no numbers. */
export function averageNumbers(values: unknown[]): unknown {
  const numbers = values.map(readNumeric).filter((n): n is Numeric => n !== null);
  if (numbers.length === 0) return null;
  if (numbers.some((n) => n.kind === 'decimal')) {
    const total = numbers.reduce<ExactNumber>((sum, n) => addDecimals(sum, asDecimal(n)), { coefficient: big(0), exponent: 0 });
    return numericValue({ kind: 'decimal', value: divideDecimal(total, numbers.length) });
  }
  // Integers add exactly before the division, so a long total isn't rounded one value at a time.
  const integers = numbers.reduce((sum, n) => (n.kind === 'double' ? sum : sum + (n.value as bigint)), big(0));
  const doubles = numbers.reduce((sum, n) => (n.kind === 'double' ? sum + n.value : sum), 0);
  return numericValue({ kind: 'double', value: (Number(integers) + doubles) / numbers.length });
}

const NUMBER_TOKEN = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;

/**
 * JSON text parsed with each integer past 2^53 kept exact as `{ $numberLong }`,
 * as the backend's serde_json reads one into an int64; `JSON.parse` would round
 * it to the nearest double. Integers past 64 bits stay doubles, as they do there.
 */
export function parseExactJson(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    NUMBER_TOKEN.lastIndex = i;
    const match = char === '-' || (char >= '0' && char <= '9') ? NUMBER_TOKEN.exec(text) : null;
    if (!match) {
      out += char;
      continue;
    }
    const token = match[0];
    const integral = match[1] === undefined && match[2] === undefined;
    out += integral && !Number.isSafeInteger(Number(token)) && big(token) >= INT64_MIN && big(token) <= INT64_MAX ? `{"$numberLong":"${token}"}` : token;
    i += token.length - 1;
  }
  return JSON.parse(out);
}
