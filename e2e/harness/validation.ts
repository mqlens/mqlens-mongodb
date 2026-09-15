// Collection validators in the fake backend (#396): what MongoDB checks a
// document against before an insert or an update, and how it refuses one.
//
// A validator is a `$jsonSchema` and any query operators beside it. The fake
// understands the `$jsonSchema` keywords the app's rules use; any other keyword
// is rejected with a clear message rather than ignored.
import { bsonType, jsonEqual, matches } from './mongo';
import { compareNumbers, parseExactJson } from './numeric';
import type { Doc } from './seed';
import type { Collection } from './state';

type Schema = Record<string, unknown>;

const NUMBER_TYPES = ['int', 'long', 'double', 'decimal'];

const unsupported = (what: string): never => {
  throw `Unsupported $jsonSchema ${what} in the e2e fake backend`;
};

/**
 * Whether a value has one of the named types. BSON type names are exact, as
 * MongoDB matches them: an integer is an int, or a long past 32 bits, and any
 * other number a double. Only `number` takes every numeric type.
 */
function hasType(value: unknown, wanted: unknown, keyword: 'bsonType' | 'type'): boolean {
  const actual = bsonType(value);
  return (Array.isArray(wanted) ? wanted : [wanted]).some((raw) => {
    const name = String(raw);
    if (name === 'number') return NUMBER_TYPES.includes(actual);
    if (keyword === 'type') {
      if (name === 'boolean') return actual === 'bool';
      if (['object', 'array', 'string', 'null'].includes(name)) return actual === name;
      return unsupported(`type "${name}"`);
    }
    return actual === name;
  });
}

function accepts(value: unknown, schema: Schema): boolean {
  const isDocument = bsonType(value) === 'object';
  const fields = value as Doc;
  for (const [keyword, rule] of Object.entries(schema)) {
    switch (keyword) {
      case 'title':
      case 'description':
        break;
      case 'bsonType':
      case 'type':
        if (!hasType(value, rule, keyword)) return false;
        break;
      case 'required':
        if (isDocument && !(rule as string[]).every((field) => field in fields)) return false;
        break;
      case 'properties':
        if (isDocument) {
          for (const [field, sub] of Object.entries(rule as Record<string, Schema>)) {
            if (field in fields && !accepts(fields[field], sub)) return false;
          }
        }
        break;
      case 'additionalProperties': {
        if (rule === true) break;
        if (rule !== false) return unsupported('additionalProperties schema');
        const allowed = Object.keys((schema.properties ?? {}) as Schema);
        if (isDocument && Object.keys(fields).some((field) => !allowed.includes(field))) return false;
        break;
      }
      case 'enum':
        if (!(rule as unknown[]).some((choice) => jsonEqual(choice, value))) return false;
        break;
      // Bounds apply to every numeric BSON type, Extended JSON wrappers such as $numberLong included.
      // Compared exactly, so a long or a decimal can't slip past a bound by rounding to it.
      case 'minimum':
        if (NUMBER_TYPES.includes(bsonType(value)) && compareNumbers(value, rule) < 0) return false;
        break;
      case 'maximum':
        if (NUMBER_TYPES.includes(bsonType(value)) && compareNumbers(value, rule) > 0) return false;
        break;
      case 'minLength':
        if (typeof value === 'string' && value.length < Number(rule)) return false;
        break;
      case 'maxLength':
        if (typeof value === 'string' && value.length > Number(rule)) return false;
        break;
      case 'pattern':
        if (typeof value === 'string' && !new RegExp(String(rule)).test(value)) return false;
        break;
      case 'items':
        if (Array.isArray(value) && !value.every((item) => accepts(item, rule as Schema))) return false;
        break;
      case 'minItems':
        if (Array.isArray(value) && value.length < Number(rule)) return false;
        break;
      case 'maxItems':
        if (Array.isArray(value) && value.length > Number(rule)) return false;
        break;
      default:
        return unsupported(`keyword ${keyword}`);
    }
  }
  return true;
}

/**
 * MongoDB's refusal when a collection's validator rejects `doc`, or null when
 * the write may go ahead. A `warn` action or an `off` level never refuses.
 * `stored` is the document an update replaces: under the `moderate` level, a
 * document that already failed validation may still be updated.
 */
export function validationError(target: Collection, doc: Doc, stored?: Doc): string | null {
  const rules = target.validation;
  if (!rules) return null;
  if ((rules.validationLevel || 'strict') === 'off' || (rules.validationAction || 'error') === 'warn') return null;
  // Parsed exactly, so a bound past 2^53 isn't rounded before it's compared.
  const { $jsonSchema, ...query } = parseExactJson(rules.validator) as Doc;
  const valid = (candidate: Doc) =>
    ($jsonSchema === undefined || accepts(candidate, $jsonSchema as Schema)) && matches(candidate, query);
  if (rules.validationLevel === 'moderate' && stored !== undefined && !valid(stored)) return null;
  return valid(doc) ? null : 'Document failed validation';
}
