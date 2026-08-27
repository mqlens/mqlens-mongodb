/**
 * How the results grid displays a value, as data rather than as JSX.
 *
 * The grid renders values through React (`renderBsonValueNode`,
 * `renderColoredCell`), which is fine for painting but useless for anything that
 * needs the *text* — local find (#279) has to search what the user can see. The
 * first cut of find borrowed `copyValueToText`, and that was wrong: "copy value"
 * deliberately yields the bare scalar (`603d…` for an ObjectId) so it pastes into
 * a query, while the grid displays the constructor call (`ObjectId("603d…")`).
 * Searching for `ObjectId`, `ISODate` or a quoted string therefore found nothing
 * even though those exact characters were on screen.
 *
 * So the display shape lives here once, as a descriptor. The renderers build
 * their spans from it and the text builders join it into a string, which means
 * the two cannot disagree about what is displayed — only about how it is
 * coloured.
 */
import { Binary, Decimal128, Double, Int32, Long, ObjectId, Timestamp } from "bson";

/** Whether an argument is painted with the string or the number colour. */
export type BsonArgKind = "string" | "number";

export interface BsonCallArg {
  /** The argument exactly as displayed, quotes included where the grid quotes it. */
  text: string;
  kind: BsonArgKind;
}

/** A BSON value displayed as a mongosh-style constructor call. */
export interface BsonCall {
  ctor: string;
  args: BsonCallArg[];
}

/**
 * A string as the JSON views display it: quoted, with escapes made visible.
 *
 * Escaping is why find must use this — a newline inside a value is on screen as
 * the two characters `\n`, so that is what a search for `\n` has to match.
 */
export function jsonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/**
 * One BSON type the grid knows how to display, and everything it displays about
 * it: the constructor call in the value column, and the type name in the tree's
 * Type column.
 *
 * A single ordered list because the order is load-bearing and was got wrong
 * twice. `Timestamp extends Long` and `UUID extends Binary` in the driver, so a
 * base class tested first swallows its subclass — which is how a timestamp came
 * to render as `NumberLong(…)`. Splitting the call and the label into two
 * separately-ordered functions let the value column say `Timestamp(…)` while the
 * Type column said `Int64` about the same row. Matching once, here, means they
 * cannot disagree.
 */
interface BsonKind {
  /** BSON type name, as the tree's Type column shows it. */
  label: string;
  matches: (val: unknown) => boolean;
  call: (val: any) => BsonCall;
}

const BSON_KINDS: readonly BsonKind[] = [
  {
    label: "ObjectId",
    matches: (v) => v instanceof ObjectId,
    call: (v: ObjectId) => ({
      ctor: "ObjectId",
      args: [{ text: jsonStringLiteral(v.toString()), kind: "string" }],
    }),
  },
  {
    label: "Date",
    matches: (v) => v instanceof Date,
    call: (v: Date) => ({
      ctor: "ISODate",
      args: [{ text: jsonStringLiteral(v.toISOString()), kind: "string" }],
    }),
  },
  {
    label: "Decimal128",
    matches: (v) => v instanceof Decimal128,
    call: (v: Decimal128) => ({
      ctor: "NumberDecimal",
      args: [{ text: jsonStringLiteral(v.toString()), kind: "string" }],
    }),
  },
  // Before Long: Timestamp extends it.
  {
    label: "Timestamp",
    matches: (v) => v instanceof Timestamp,
    call: (v: Timestamp) => ({
      ctor: "Timestamp",
      args: [{ text: v.toString(), kind: "number" }],
    }),
  },
  {
    label: "Int64",
    matches: (v) => v instanceof Long,
    call: (v: Long) => ({ ctor: "NumberLong", args: [{ text: v.toString(), kind: "number" }] }),
  },
  {
    label: "Int32",
    matches: (v) => v instanceof Int32,
    call: (v: Int32) => ({ ctor: "NumberInt", args: [{ text: v.toString(), kind: "number" }] }),
  },
  {
    label: "Double",
    matches: (v) => v instanceof Double,
    call: (v: Double) => ({ ctor: "Double", args: [{ text: v.toString(), kind: "number" }] }),
  },
  {
    label: "Binary",
    matches: (v) => v instanceof Binary,
    call: (v: Binary) => ({
      ctor: "BinData",
      args: [
        { text: String(v.sub_type), kind: "number" },
        { text: jsonStringLiteral(v.toString("base64")), kind: "string" },
      ],
    }),
  },
];

function bsonKindOf(val: unknown): BsonKind | undefined {
  if (val === null || val === undefined) return undefined;
  return BSON_KINDS.find((kind) => kind.matches(val));
}

/**
 * The constructor call for a BSON instance, or null when `val` is not one.
 *
 * Only real `bson` instances qualify. The table view holds the backend's plain
 * extended-JSON shapes instead and the grid displays those differently — see
 * [`plainBsonShape`].
 */
export function bsonCallOf(val: unknown): BsonCall | null {
  const kind = bsonKindOf(val);
  return kind ? kind.call(val) : null;
}

/**
 * The BSON type name for an instance, or null when `val` is not one.
 *
 * The grid's own labeller handles the rest (Array, Object, the JavaScript
 * primitives); this covers only the types whose display order matters.
 */
export function bsonInstanceTypeLabel(val: unknown): string | null {
  return bsonKindOf(val)?.label ?? null;
}

/** The call as one string, matching the spans the renderer emits for it. */
export function bsonCallText(call: BsonCall): string {
  return `${call.ctor}(${call.args.map((a) => a.text).join(", ")})`;
}

/** True for the BSON instances the grid gives a constructor call. */
export function isBsonInstance(val: unknown): boolean {
  return bsonKindOf(val) !== undefined;
}

/**
 * A value as the JSON and tree views display it.
 *
 * Mirrors `renderBsonValueNode`: `null`/booleans/numbers bare, strings quoted and
 * escaped, BSON as a constructor call. An object or array reaching here is the
 * renderer's own `String(val)` fallback — the views normally expand containers
 * into their own rows rather than printing them.
 */
export function bsonValueText(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") return jsonStringLiteral(val);
  const call = bsonCallOf(val);
  if (call) return bsonCallText(call);
  return String(val);
}

/** How the table view displays one of the backend's extended-JSON shapes. */
export interface PlainShapeDisplay {
  text: string;
  /** `raw` is the muted JSON fallback for a shape with no special display. */
  kind: "string" | "number" | "raw";
}

/**
 * The display for a canonical extended-JSON shape, or null when `val` is an
 * ordinary object.
 *
 * The table view renders the backend documents as they arrive, so an `_id`
 * arrives as `{$oid: "…"}` and is displayed as the bare hex — not as
 * `ObjectId("…")`, which is what the parsed views show. Both are mirrored, each
 * for the view that produces it.
 */
export function plainBsonShape(val: Record<string, any>): PlainShapeDisplay | null {
  if (typeof val.$oid === "string") return { text: val.$oid, kind: "string" };
  if (val.$date !== undefined) {
    if (typeof val.$date === "string") return { text: val.$date, kind: "string" };
    if (val.$date?.$numberLong) {
      return { text: new Date(Number(val.$date.$numberLong)).toISOString(), kind: "string" };
    }
    return { text: JSON.stringify(val.$date), kind: "string" };
  }
  if (val.$numberLong !== undefined) return { text: String(val.$numberLong), kind: "number" };
  if (val.$numberDecimal !== undefined) {
    return { text: String(val.$numberDecimal), kind: "number" };
  }
  if (val.$numberInt !== undefined) return { text: String(val.$numberInt), kind: "number" };
  if (val.$numberDouble !== undefined) return { text: String(val.$numberDouble), kind: "number" };
  return null;
}

/**
 * A value as the table view displays it.
 *
 * Mirrors `renderColoredCell`. Strings are *unquoted* here — the table shows the
 * raw text in a fixed-width cell — so the same value reads differently in the
 * table than in the JSON view, and find follows whichever view is on screen.
 */
export function tableValueText(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "object") {
    const call = bsonCallOf(val);
    if (call) return bsonCallText(call);
    const plain = plainBsonShape(val as Record<string, any>);
    if (plain) return plain.text;
    return JSON.stringify(val);
  }
  return String(val);
}
