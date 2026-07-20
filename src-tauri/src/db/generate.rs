//! Data-generation template engine: a small JSON DSL ("$name", "$email",
//! `{"$int": {...}}`, …) parsed into a validated AST and then rendered into
//! real BSON documents under a caller-supplied seeded RNG, so runs are
//! reproducible (golden tests, "same seed → same data").
//!
//! See `docs/superpowers/specs/2026-07-19-data-generation-design.md` for the
//! DSL table — that table is the contract this module implements.
//!
//! Determinism note: ObjectId/UUID values are NOT built via
//! `bson::oid::ObjectId::new()` / `bson::Uuid::new()` — those draw from
//! system time / the OS RNG and would make the same seed produce different
//! ids on every run. Instead we draw the raw bytes from our own `StdRng` and
//! construct the BSON value from bytes (`ObjectId::from_bytes`,
//! `bson::Uuid::from_bytes`), keeping everything downstream of one seed.
//!
//! Schema-seeded inference (Task 2): `infer_template_from_schema` turns a
//! `SchemaReport` (from `crate::db::schema::analyze_schema_impl`) into a
//! template `serde_json::Value` of the same DSL `parse_template` accepts —
//! opening the generator on an existing collection pre-fills the builder
//! instead of starting blank. `preview_generated_documents_impl` and
//! `infer_generate_template_impl` are the pure/async halves behind the
//! `preview_generated_documents` / `infer_generate_template` Tauri commands
//! (thin wrappers in `lib.rs`).
//!
//! The `start_generate_task` background-insert command (Task 3) still isn't
//! wired up, so this module remains otherwise-dead-code from rustc's
//! staticlib/cdylib reachability analysis (it doesn't count `#[cfg(test)]`
//! callers) until then, hence the blanket allow below rather than a
//! per-item one.
#![allow(dead_code)]

use crate::db::schema::{SchemaReport, TypeCount};
use mongodb::bson::{self, Bson, Document};
use rand::rngs::StdRng;
use rand::{Rng, RngCore, SeedableRng};
use serde_json::{Map, Value};

/// One generator/literal node in a parsed template.
#[derive(Debug, Clone, PartialEq)]
pub enum Spec {
    Name,
    FirstName,
    LastName,
    Email,
    ObjectId,
    Uuid,
    Bool,
    Int { min: i64, max: i64 },
    Float { min: f64, max: f64, decimals: u8 },
    Date(DateSpec),
    Lorem { words: u32 },
    /// Uniform choice among literal (unvalidated-as-BSON-at-parse-time is
    /// false — each element is checked in `parse_pick`) values.
    Pick(Vec<Value>),
    Array { of: Box<Spec>, min: u32, max: u32 },
    /// A literal value copied verbatim (Extended JSON allowed), including
    /// real strings that happen to start with `$` (via `{"$literal": "..."}`).
    Literal(Value),
    Object(Vec<(String, Spec)>),
}

/// The two `$date` forms from the DSL table.
#[derive(Debug, Clone, PartialEq)]
pub enum DateSpec {
    PastDays(u32),
    /// Pre-parsed at `parse_template` time (fail fast on bad ISO strings
    /// rather than at every `generate_doc` call).
    Range { from: bson::DateTime, to: bson::DateTime },
}

/// A validated template: an ordered list of top-level field specs. The DSL
/// requires the template root to be a JSON object (a document shape), so
/// this is deliberately not just `Spec` — `generate_doc` can build a
/// `bson::Document` from it without a runtime variant check.
#[derive(Debug, Clone, PartialEq)]
pub struct Template(Vec<(String, Spec)>);

/// Parse and validate a JSON template string into a `Template`.
///
/// Errors carry the JSON path of the offending node, e.g.
/// `"users[0].email: unknown generator $emial"` — `[N]` for `$array`'s `of`
/// (always index 0, since `of` describes one representative element, not an
/// actual generated index) and `.field` for object nesting.
pub fn parse_template(json: &str) -> Result<Template, String> {
    let value: Value = serde_json::from_str(json).map_err(|e| format!("invalid JSON: {e}"))?;
    if !value.is_object() {
        return Err("template root must be a JSON object".to_string());
    }
    match parse_spec("", value)? {
        Spec::Object(fields) => Ok(Template(fields)),
        // Reachable when the top-level object is itself a single-key `$…`
        // wrapper (e.g. `{"$literal": {...}}`) — the DSL only allows that
        // shape for leaf values, not the document root.
        _ => Err("template root must be a JSON object".to_string()),
    }
}

fn join_field(base: &str, field: &str) -> String {
    if base.is_empty() {
        field.to_string()
    } else {
        format!("{base}.{field}")
    }
}

/// Bare `"$…"` string generators (no options object).
fn string_generator(s: &str) -> Option<Spec> {
    match s {
        "$name" => Some(Spec::Name),
        "$firstName" => Some(Spec::FirstName),
        "$lastName" => Some(Spec::LastName),
        "$email" => Some(Spec::Email),
        "$objectId" => Some(Spec::ObjectId),
        "$uuid" => Some(Spec::Uuid),
        "$bool" => Some(Spec::Bool),
        _ => None,
    }
}

fn parse_spec(path: &str, value: Value) -> Result<Spec, String> {
    match value {
        Value::String(s) => {
            if let Some(spec) = string_generator(&s) {
                Ok(spec)
            } else if s.starts_with('$') {
                Err(format!("{path}: unknown generator {s}"))
            } else {
                Ok(Spec::Literal(Value::String(s)))
            }
        }
        Value::Object(map) => {
            let dollar_count = map.keys().filter(|k| k.starts_with('$')).count();
            if dollar_count == 0 {
                let mut fields = Vec::with_capacity(map.len());
                for (k, v) in map {
                    let child_path = join_field(path, &k);
                    let spec = parse_spec(&child_path, v)?;
                    fields.push((k, spec));
                }
                Ok(Spec::Object(fields))
            } else if map.len() == 1 {
                let (key, inner) = map.into_iter().next().expect("len == 1");
                match key.as_str() {
                    "$int" => parse_int(path, inner),
                    "$float" => parse_float(path, inner),
                    "$date" => parse_date(path, inner),
                    "$lorem" => parse_lorem(path, inner),
                    "$pick" => parse_pick(path, inner),
                    "$array" => parse_array(path, inner),
                    "$literal" => Ok(Spec::Literal(inner)),
                    other => Err(format!("{path}: unknown generator {other}")),
                }
            } else {
                // Multiple keys, at least one `$`-prefixed: never a valid
                // literal object (bare literal objects have zero `$` keys)
                // and never a valid wrapper (wrappers are single-key) — a
                // typo'd/ambiguous generator, so error rather than guess.
                let bad = map
                    .keys()
                    .find(|k| k.starts_with('$'))
                    .cloned()
                    .expect("dollar_count > 0");
                Err(format!("{path}: unknown generator {bad}"))
            }
        }
        other => Ok(Spec::Literal(other)),
    }
}

fn expect_object<'a>(
    path: &str,
    name: &str,
    value: &'a Value,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{path}: {name} requires an object"))
}

fn parse_int(path: &str, inner: Value) -> Result<Spec, String> {
    let obj = expect_object(path, "$int", &inner)?;
    let min = match obj.get("min") {
        Some(v) => v
            .as_i64()
            .ok_or_else(|| format!("{path}: $int min must be an integer"))?,
        None => 0,
    };
    let max = match obj.get("max") {
        Some(v) => v
            .as_i64()
            .ok_or_else(|| format!("{path}: $int max must be an integer"))?,
        None => 1000,
    };
    if min > max {
        return Err(format!("{path}: $int min must be <= max"));
    }
    Ok(Spec::Int { min, max })
}

fn parse_float(path: &str, inner: Value) -> Result<Spec, String> {
    let obj = expect_object(path, "$float", &inner)?;
    let min = obj
        .get("min")
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{path}: $float requires a numeric min"))?;
    let max = obj
        .get("max")
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{path}: $float requires a numeric max"))?;
    let decimals = match obj.get("decimals") {
        Some(v) => v
            .as_u64()
            .ok_or_else(|| format!("{path}: $float decimals must be a non-negative integer"))?,
        None => 2,
    };
    if min > max {
        return Err(format!("{path}: $float min must be <= max"));
    }
    if decimals > 10 {
        return Err(format!("{path}: $float decimals must be <= 10"));
    }
    Ok(Spec::Float {
        min,
        max,
        decimals: decimals as u8,
    })
}

fn parse_date(path: &str, inner: Value) -> Result<Spec, String> {
    let obj = expect_object(path, "$date", &inner)?;
    if let Some(pd) = obj.get("past_days") {
        let days = pd
            .as_u64()
            .ok_or_else(|| format!("{path}: $date past_days must be a non-negative integer"))?;
        let days: u32 = days
            .try_into()
            .map_err(|_| format!("{path}: $date past_days out of range"))?;
        return Ok(Spec::Date(DateSpec::PastDays(days)));
    }
    if let (Some(from), Some(to)) = (obj.get("from"), obj.get("to")) {
        let from_s = from
            .as_str()
            .ok_or_else(|| format!("{path}: $date from must be an ISO date string"))?;
        let to_s = to
            .as_str()
            .ok_or_else(|| format!("{path}: $date to must be an ISO date string"))?;
        let from_dt = bson::DateTime::parse_rfc3339_str(from_s)
            .map_err(|e| format!("{path}: $date from: {e}"))?;
        let to_dt = bson::DateTime::parse_rfc3339_str(to_s)
            .map_err(|e| format!("{path}: $date to: {e}"))?;
        if from_dt > to_dt {
            return Err(format!("{path}: $date from must be <= to"));
        }
        return Ok(Spec::Date(DateSpec::Range {
            from: from_dt,
            to: to_dt,
        }));
    }
    Err(format!("{path}: $date requires past_days or from/to"))
}

fn parse_lorem(path: &str, inner: Value) -> Result<Spec, String> {
    let obj = expect_object(path, "$lorem", &inner)?;
    let words = obj
        .get("words")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{path}: $lorem requires words"))?;
    let words: u32 = words
        .try_into()
        .map_err(|_| format!("{path}: $lorem words out of range"))?;
    Ok(Spec::Lorem { words })
}

fn parse_pick(path: &str, inner: Value) -> Result<Spec, String> {
    let arr = match inner {
        Value::Array(a) => a,
        _ => return Err(format!("{path}: $pick requires a non-empty array")),
    };
    if arr.is_empty() {
        return Err(format!("{path}: $pick requires a non-empty array"));
    }
    for v in &arr {
        Bson::try_from(v.clone()).map_err(|e| format!("{path}: $pick invalid value: {e}"))?;
    }
    Ok(Spec::Pick(arr))
}

fn parse_array(path: &str, inner: Value) -> Result<Spec, String> {
    let obj = expect_object(path, "$array", &inner)?;
    let of_value = obj
        .get("of")
        .cloned()
        .ok_or_else(|| format!("{path}: $array requires of"))?;
    let of_path = format!("{path}[0]");
    let of_spec = parse_spec(&of_path, of_value)?;
    let min = obj
        .get("min")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{path}: $array requires min"))?;
    let max = obj
        .get("max")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{path}: $array requires max"))?;
    if min > max {
        return Err(format!("{path}: $array min must be <= max"));
    }
    let min: u32 = min
        .try_into()
        .map_err(|_| format!("{path}: $array min out of range"))?;
    let max: u32 = max
        .try_into()
        .map_err(|_| format!("{path}: $array max out of range"))?;
    Ok(Spec::Array {
        of: Box::new(of_spec),
        min,
        max,
    })
}

/// Generate one document from a validated template.
///
/// `now` is injected (rather than read via `bson::DateTime::now()` inside)
/// so `$date { past_days }` is reproducible under a fixed seed — the whole
/// point of the golden/determinism tests.
pub fn generate_doc(t: &Template, rng: &mut StdRng, now: bson::DateTime) -> Document {
    let mut doc = Document::new();
    for (k, spec) in &t.0 {
        doc.insert(k.clone(), generate_value(spec, rng, now));
    }
    doc
}

fn random_bytes<const N: usize>(rng: &mut StdRng) -> [u8; N] {
    let mut bytes = [0u8; N];
    // `fill_bytes` (from `RngCore`, which `Rng: RngCore`) takes a plain
    // `&mut [u8]` slice — unlike `Rng::fill`, it has no `Fill` trait bound,
    // so it works for a const-generic `N` without a per-size impl.
    rng.fill_bytes(&mut bytes);
    bytes
}

fn generate_value(spec: &Spec, rng: &mut StdRng, now: bson::DateTime) -> Bson {
    use fake::Fake;

    match spec {
        Spec::Name => Bson::String(fake::faker::name::en::Name().fake_with_rng::<String, _>(rng)),
        Spec::FirstName => {
            Bson::String(fake::faker::name::en::FirstName().fake_with_rng::<String, _>(rng))
        }
        Spec::LastName => {
            Bson::String(fake::faker::name::en::LastName().fake_with_rng::<String, _>(rng))
        }
        Spec::Email => {
            Bson::String(fake::faker::internet::en::SafeEmail().fake_with_rng::<String, _>(rng))
        }
        Spec::ObjectId => {
            let bytes: [u8; 12] = random_bytes(rng);
            Bson::ObjectId(bson::oid::ObjectId::from_bytes(bytes))
        }
        Spec::Uuid => {
            let mut bytes: [u8; 16] = random_bytes(rng);
            // RFC 4122 v4: version nibble = 4, variant bits = 10xxxxxx.
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            Bson::String(bson::Uuid::from_bytes(bytes).to_string())
        }
        Spec::Bool => Bson::Boolean(rng.gen()),
        Spec::Int { min, max } => Bson::Int64(rng.gen_range(*min..=*max)),
        Spec::Float {
            min,
            max,
            decimals,
        } => {
            let raw: f64 = rng.gen_range(*min..=*max);
            let factor = 10f64.powi(*decimals as i32);
            Bson::Double((raw * factor).round() / factor)
        }
        Spec::Date(date_spec) => {
            let millis = match date_spec {
                DateSpec::PastDays(days) => {
                    let span_ms = (*days as i64).saturating_mul(86_400_000);
                    let offset_ms = if span_ms == 0 {
                        0
                    } else {
                        rng.gen_range(0..=span_ms)
                    };
                    now.timestamp_millis() - offset_ms
                }
                DateSpec::Range { from, to } => {
                    rng.gen_range(from.timestamp_millis()..=to.timestamp_millis())
                }
            };
            Bson::DateTime(bson::DateTime::from_millis(millis))
        }
        Spec::Lorem { words } => {
            let n = *words as usize;
            let words: Vec<String> =
                fake::faker::lorem::en::Words(n..(n + 1)).fake_with_rng(rng);
            Bson::String(words.join(" "))
        }
        Spec::Pick(values) => {
            let idx = rng.gen_range(0..values.len());
            // Validated convertible in `parse_pick`; a fresh `try_from` here
            // (rather than caching pre-converted Bson) keeps `Spec` cheap to
            // clone/compare and the DSL's "literal" surface (serde_json
            // `Value`) uniform between `Pick` and `Literal`.
            Bson::try_from(values[idx].clone()).unwrap_or(Bson::Null)
        }
        Spec::Array { of, min, max } => {
            let len = rng.gen_range(*min..=*max) as usize;
            let items = (0..len).map(|_| generate_value(of, rng, now)).collect();
            Bson::Array(items)
        }
        Spec::Literal(value) => Bson::try_from(value.clone()).unwrap_or(Bson::Null),
        Spec::Object(fields) => {
            let mut doc = Document::new();
            for (k, spec) in fields {
                doc.insert(k.clone(), generate_value(spec, rng, now));
            }
            Bson::Document(doc)
        }
    }
}

// ---------------------------------------------------------------------------
// Schema-seeded inference
// ---------------------------------------------------------------------------

/// Turn a `SchemaReport` into a template `Value` of the same shape
/// `parse_template` accepts. Pure and deterministic (the report's `fields`
/// are already sorted by path — see `infer_schema`).
///
/// Heuristics, in order, per field:
/// 1. `enum_values` present and non-empty → `{"$pick": [...values]}`. Wins
///    over every name-based rule below. `enum_values` are always stored as
///    their canonical string form (`infer_schema`'s `enum_scalar`) even for
///    numeric/bool fields, so a `$pick`-seeded int field will read back as a
///    string generator — a known, documented lossy step (see plan Task 2),
///    not a bug: the alternative (re-typing each value from its original
///    BSON type) isn't information the schema report carries per-value.
/// 2. Name-based, case-insensitive substring match on the LAST dotted path
///    segment (`a.b.c` → `c`): `email` → `$email`; `first`+`name` →
///    `$firstName`; `last`+`name` → `$lastName`; `name` → `$name`; ends with
///    `_at` or contains `date`/`created`/`updated` → `$date past_days 365`;
///    ends with `id` AND the field's dominant type is `objectId` →
///    `$objectId`. These are deliberately naive substring/suffix checks
///    (e.g. a field literally named "valid" ends with "id" too) — false
///    positives are a cosmetic seeding annoyance, not a correctness bug,
///    since the builder/raw editor always lets a user fix a wrong guess.
/// 3. Dominant-type fallback (highest `count` in `types`; ties keep the
///    alphabetically-first type name, since `infer_schema` populates `types`
///    from a `BTreeMap`): string → `{"$lorem":{"words":2}}`; int/long →
///    `{"$int":{"min":0,"max":1000}}`; double/decimal →
///    `{"$float":{"min":0,"max":1000,"decimals":2}}`; bool → `"$bool"`;
///    date → `$date past_days 365`; objectId → `"$objectId"`; array →
///    `{"$array":{"of":{"$lorem":{"words":2}},"min":1,"max":3}}` (the
///    schema report doesn't descend into array elements, so this is a fixed
///    guess, not shape-aware); anything else (null, regex, binary,
///    timestamp, javascript, symbol, minKey, maxKey, undefined, dbPointer)
///    → the field is omitted entirely (no sensible generator maps to it).
///
/// `object`-typed fields are a deliberate exception to rule ordering: they
/// always recurse via their `parent.child` `FieldStat` entries (built
/// automatically as those child paths are inserted — see `insert_path`)
/// regardless of what their own name looks like. Applying the name-based
/// rules to an object field first (as the plan's literal rule ordering would
/// suggest — e.g. a subdocument named `createdBy`) would silently replace
/// real nested structure with a scalar generator and drop its children; the
/// object recursion note ("the parent's own object entry emits nothing
/// itself") is the actual intent, so the object check short-circuits ahead
/// of the name-based rules here. No such guard is needed for `array`, since
/// the array fallback doesn't use per-element schema anyway.
///
/// `_id` (top-level, or nested under an `_id.` prefix) is always omitted —
/// the server generates it. Field coverage/presence is intentionally
/// ignored: v1 always generates every field on every document (per spec,
/// optional-field probability is out of scope).
pub fn infer_template_from_schema(report: &SchemaReport) -> Value {
    let mut root = Map::new();
    for field in &report.fields {
        if field.path == "_id" || field.path.starts_with("_id.") {
            continue;
        }
        let dominant = dominant_type(&field.types);
        if dominant == Some("object") {
            // Recurse only: children (`field.path`-prefixed FieldStats)
            // build the nested object as their own paths are inserted.
            continue;
        }
        let spec = field
            .enum_values
            .as_ref()
            .filter(|values| !values.is_empty())
            .map(|values| serde_json::json!({ "$pick": values }))
            .or_else(|| name_heuristic(&field.path, dominant))
            .or_else(|| dominant.and_then(type_fallback));
        if let Some(value) = spec {
            insert_path(&mut root, &field.path, value);
        }
    }
    Value::Object(root)
}

/// The type with the highest `count`; ties keep whichever came first in
/// `types` (alphabetically first, per `infer_schema`'s `BTreeMap` iteration
/// order) for deterministic output.
fn dominant_type(types: &[TypeCount]) -> Option<&str> {
    let mut best: Option<&TypeCount> = None;
    for t in types {
        if best.is_none_or(|b| t.count > b.count) {
            best = Some(t);
        }
    }
    best.map(|t| t.type_name.as_str())
}

/// Name-based heuristics on the last dotted path segment. `dominant` gates
/// only the `id`-suffix → `$objectId` rule (an ObjectId-typed field named
/// `userId`/`user_id`); every other rule fires on name alone.
fn name_heuristic(path: &str, dominant: Option<&str>) -> Option<Value> {
    let last = path.rsplit('.').next().unwrap_or(path).to_lowercase();
    if last.contains("email") {
        return Some(Value::String("$email".to_string()));
    }
    if last.contains("first") && last.contains("name") {
        return Some(Value::String("$firstName".to_string()));
    }
    if last.contains("last") && last.contains("name") {
        return Some(Value::String("$lastName".to_string()));
    }
    if last.contains("name") {
        return Some(Value::String("$name".to_string()));
    }
    if last.ends_with("_at") || last.contains("date") || last.contains("created") || last.contains("updated") {
        return Some(serde_json::json!({ "$date": { "past_days": 365 } }));
    }
    if last.ends_with("id") && dominant == Some("objectId") {
        return Some(Value::String("$objectId".to_string()));
    }
    None
}

/// Dominant-type fallback generator for a field with no enum/name match.
/// `"object"` is never passed in — `infer_template_from_schema` short-
/// circuits it before this is called.
fn type_fallback(type_name: &str) -> Option<Value> {
    match type_name {
        "string" => Some(serde_json::json!({ "$lorem": { "words": 2 } })),
        "int" | "long" => Some(serde_json::json!({ "$int": { "min": 0, "max": 1000 } })),
        "double" | "decimal" => {
            Some(serde_json::json!({ "$float": { "min": 0, "max": 1000, "decimals": 2 } }))
        }
        "bool" => Some(Value::String("$bool".to_string())),
        "date" => Some(serde_json::json!({ "$date": { "past_days": 365 } })),
        "objectId" => Some(Value::String("$objectId".to_string())),
        "array" => Some(serde_json::json!({
            "$array": { "of": { "$lorem": { "words": 2 } }, "min": 1, "max": 3 }
        })),
        // null, regex, binary, timestamp, javascript, symbol, minKey,
        // maxKey, undefined, dbPointer: no sensible generator — omit.
        _ => None,
    }
}

/// Insert `value` at a dotted `path` (`"a.b.c"`) into `root`, creating
/// intermediate JSON objects as needed. Parent segments are never inserted
/// directly by `infer_template_from_schema` (object-typed fields are
/// skipped, not given a leaf value), so the only writer of an intermediate
/// node is this function auto-vivifying it on the way to a leaf.
fn insert_path(root: &mut Map<String, Value>, path: &str, value: Value) {
    let segments: Vec<&str> = path.split('.').collect();
    insert_segments(root, &segments, value);
}

fn insert_segments(root: &mut Map<String, Value>, segments: &[&str], value: Value) {
    if segments.len() == 1 {
        root.insert(segments[0].to_string(), value);
        return;
    }
    let entry = root
        .entry(segments[0].to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    if let Value::Object(sub) = entry {
        insert_segments(sub, &segments[1..], value);
    }
}

// ---------------------------------------------------------------------------
// preview_generated_documents / infer_generate_template command impls
// ---------------------------------------------------------------------------

/// `preview_generated_documents` caps out at this many documents regardless
/// of what the caller asks for — it's a human-eyeballing sandbox, never a
/// bulk path (that's `start_generate_task`, Task 3).
const PREVIEW_MAX_DOCS: u8 = 10;
const PREVIEW_DEFAULT_DOCS: u8 = 3;

/// Stringify a generated document the same way `execute_mql_query_impl`
/// stringifies query results (`serde_json::to_value` then
/// `serde_json::to_string`) — not `into_relaxed_extjson()` — so previewed
/// documents render through the same EJSON-ish viewer path the rest of the
/// app already uses for query/document output.
fn doc_to_json_string(doc: &Document) -> Result<String, String> {
    let json_val: Value =
        serde_json::to_value(doc).map_err(|e| format!("BSON to JSON error: {}", e))?;
    serde_json::to_string(&json_val).map_err(|e| format!("Serialization error: {}", e))
}

/// Parse `template`, then generate `count` documents (capped at
/// [`PREVIEW_MAX_DOCS`], default [`PREVIEW_DEFAULT_DOCS`]) under a single
/// seeded RNG — same seed (+ same template) ⇒ same preview every time, an
/// unseeded call draws a fresh seed from the OS RNG. No connection/state is
/// needed: this only exercises the pure template engine.
pub fn preview_generated_documents_impl(
    template: &str,
    count: Option<u8>,
    seed: Option<u64>,
) -> Result<Vec<String>, String> {
    let parsed = parse_template(template)?;
    let n = count.unwrap_or(PREVIEW_DEFAULT_DOCS).min(PREVIEW_MAX_DOCS);
    let mut rng = StdRng::seed_from_u64(seed.unwrap_or_else(rand::random));
    let now = bson::DateTime::now();
    (0..n)
        .map(|_| doc_to_json_string(&generate_doc(&parsed, &mut rng, now)))
        .collect()
}

/// Sample the collection's schema (`analyze_schema_impl` — handles mock vs.
/// real connections and normalizes/caps `sample_size` internally, default
/// 100) and infer a starter template from it. Returns pretty-printed JSON so
/// it's immediately usable as the raw-editor's starting text.
pub async fn infer_generate_template_impl(
    state: &crate::AppState,
    id: &str,
    database: &str,
    collection: &str,
    sample_size: Option<i64>,
) -> Result<String, String> {
    let report_json = crate::db::schema::analyze_schema_impl(
        state,
        id,
        database,
        collection,
        sample_size.unwrap_or(0),
    )
    .await?;
    let report: SchemaReport = serde_json::from_str(&report_json)
        .map_err(|e| format!("Schema report parse error: {}", e))?;
    let template = infer_template_from_schema(&report);
    serde_json::to_string_pretty(&template).map_err(|e| format!("Serialization error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn rng(seed: u64) -> StdRng {
        StdRng::seed_from_u64(seed)
    }

    fn fixed_now() -> bson::DateTime {
        // 2026-07-19T00:00:00Z, a fixed instant so past_days math is
        // reproducible independent of wall-clock time.
        bson::DateTime::parse_rfc3339_str("2026-07-19T00:00:00Z").unwrap()
    }

    // ---- golden ----------------------------------------------------------

    #[test]
    fn golden_kitchen_sink() {
        let template = r#"{
            "name": "$name",
            "firstName": "$firstName",
            "lastName": "$lastName",
            "email": "$email",
            "id": "$objectId",
            "uid": "$uuid",
            "active": "$bool",
            "age": {"$int": {"min": 18, "max": 65}},
            "score": {"$float": {"min": 0, "max": 100, "decimals": 2}},
            "joined": {"$date": {"past_days": 365}},
            "eventAt": {"$date": {"from": "2020-01-01T00:00:00Z", "to": "2020-01-02T00:00:00Z"}},
            "bio": {"$lorem": {"words": 5}},
            "tier": {"$pick": ["free", "pro", "enterprise"]},
            "tags": {"$array": {"of": {"$lorem": {"words": 1}}, "min": 2, "max": 2}},
            "literalWithDollar": {"$literal": "$notAGenerator"},
            "nested": {
                "city": {"$lorem": {"words": 1}},
                "zip": {"$int": {"min": 10000, "max": 99999}}
            },
            "constant": 42,
            "flag": true,
            "nothing": null
        }"#;
        let t = parse_template(template).expect("valid template");
        let mut r = rng(42);
        let doc = generate_doc(&t, &mut r, fixed_now());
        let ejson = Bson::Document(doc).into_canonical_extjson().to_string();

        // Sanity checks before locking the golden string in (a golden that
        // encodes a bug is worse than no golden at all).
        assert!(ejson.contains("\"name\":\""));
        assert!(ejson.contains("\"$oid\""), "objectId must be a real BSON ObjectId");
        assert!(ejson.contains("\"$date\""), "date fields must be real BSON dates");
        assert!(ejson.contains("\"tier\":\"free\"") || ejson.contains("\"tier\":\"pro\"") || ejson.contains("\"tier\":\"enterprise\""));
        assert!(ejson.contains("\"literalWithDollar\":\"$notAGenerator\""));
        assert!(ejson.contains("\"constant\":{\"$numberInt\":\"42\"}") || ejson.contains("\"constant\":42"));

        let expected = golden_expected();
        assert_eq!(ejson, expected, "golden EJSON changed — got:\n{ejson}");
    }

    // Generated once from the template above with seed 42 and the fixed
    // `now` above, then eyeballed field-by-field against the sanity checks
    // above before being pasted here.
    fn golden_expected() -> String {
        include_str!("generate_golden.ejson.txt").trim_end().to_string()
    }

    // ---- determinism / distribution ---------------------------------------

    #[test]
    fn same_seed_same_doc() {
        let t = parse_template(r#"{"a": "$name", "b": {"$int": {"min": 0, "max": 1000000}}}"#)
            .unwrap();
        let now = fixed_now();
        let d1 = generate_doc(&t, &mut rng(7), now);
        let d2 = generate_doc(&t, &mut rng(7), now);
        assert_eq!(d1, d2);
    }

    #[test]
    fn many_docs_from_one_rng_are_not_all_identical() {
        let t = parse_template(r#"{"a": {"$int": {"min": 0, "max": 1000000}}}"#).unwrap();
        let mut r = rng(1);
        let now = fixed_now();
        let docs: Vec<Document> = (0..100).map(|_| generate_doc(&t, &mut r, now)).collect();
        let unique: std::collections::HashSet<String> = docs
            .iter()
            .map(|d| Bson::Document(d.clone()).into_canonical_extjson().to_string())
            .collect();
        assert!(unique.len() > 1, "expected varied output across 100 draws");
    }

    // ---- per-generator ------------------------------------------------------

    #[test]
    fn int_within_range() {
        let t = parse_template(r#"{"a": {"$int": {"min": -5, "max": 5}}}"#).unwrap();
        let mut r = rng(2);
        let now = fixed_now();
        for _ in 0..1000 {
            let doc = generate_doc(&t, &mut r, now);
            let v = doc.get_i64("a").unwrap();
            assert!((-5..=5).contains(&v), "{v} out of range");
        }
    }

    #[test]
    fn int_defaults_to_0_1000() {
        let t = parse_template(r#"{"a": {"$int": {}}}"#).unwrap();
        assert_eq!(t.0[0].1, Spec::Int { min: 0, max: 1000 });
    }

    #[test]
    fn float_within_range_and_decimals_honored() {
        let t = parse_template(r#"{"a": {"$float": {"min": 0, "max": 10, "decimals": 3}}}"#)
            .unwrap();
        let mut r = rng(3);
        let now = fixed_now();
        for _ in 0..1000 {
            let doc = generate_doc(&t, &mut r, now);
            let v = doc.get_f64("a").unwrap();
            assert!((0.0..=10.0).contains(&v), "{v} out of range");
            let scaled = v * 1000.0;
            assert!(
                (scaled - scaled.round()).abs() < 1e-6,
                "{v} has more than 3 decimals"
            );
        }
    }

    #[test]
    fn date_past_days_within_window() {
        let t = parse_template(r#"{"a": {"$date": {"past_days": 30}}}"#).unwrap();
        let mut r = rng(4);
        let now = fixed_now();
        let floor = now.timestamp_millis() - 30 * 86_400_000;
        for _ in 0..1000 {
            let doc = generate_doc(&t, &mut r, now);
            let dt = doc.get_datetime("a").unwrap();
            let ms = dt.timestamp_millis();
            assert!(ms >= floor && ms <= now.timestamp_millis(), "{ms} outside window");
        }
    }

    #[test]
    fn date_range_within_bounds() {
        let t = parse_template(
            r#"{"a": {"$date": {"from": "2021-06-01T00:00:00Z", "to": "2021-06-02T00:00:00Z"}}}"#,
        )
        .unwrap();
        let mut r = rng(5);
        let now = fixed_now();
        let from = bson::DateTime::parse_rfc3339_str("2021-06-01T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let to = bson::DateTime::parse_rfc3339_str("2021-06-02T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        for _ in 0..1000 {
            let doc = generate_doc(&t, &mut r, now);
            let ms = doc.get_datetime("a").unwrap().timestamp_millis();
            assert!(ms >= from && ms <= to);
        }
    }

    #[test]
    fn pick_only_yields_listed_values() {
        let t = parse_template(r#"{"a": {"$pick": ["x", "y", "z"]}}"#).unwrap();
        let mut r = rng(6);
        let now = fixed_now();
        for _ in 0..200 {
            let doc = generate_doc(&t, &mut r, now);
            let v = doc.get_str("a").unwrap();
            assert!(["x", "y", "z"].contains(&v));
        }
    }

    #[test]
    fn array_length_within_bounds() {
        let t = parse_template(r#"{"a": {"$array": {"of": "$bool", "min": 1, "max": 4}}}"#)
            .unwrap();
        let mut r = rng(8);
        let now = fixed_now();
        for _ in 0..200 {
            let doc = generate_doc(&t, &mut r, now);
            let arr = doc.get_array("a").unwrap();
            assert!((1..=4).contains(&arr.len()), "{} out of range", arr.len());
        }
    }

    #[test]
    fn object_id_and_uuid_types_and_uniqueness() {
        let t = parse_template(r#"{"oid": "$objectId", "uid": "$uuid"}"#).unwrap();
        let mut r = rng(9);
        let now = fixed_now();
        let mut oids = std::collections::HashSet::new();
        let mut uuids = std::collections::HashSet::new();
        for _ in 0..200 {
            let doc = generate_doc(&t, &mut r, now);
            let oid = doc.get_object_id("oid").expect("real ObjectId type");
            let uid = doc.get_str("uid").expect("uuid is a BSON string");
            assert_eq!(uid.len(), 36, "not a canonical UUID string: {uid}");
            assert_eq!(uid.as_bytes()[14], b'4', "not a v4 UUID: {uid}");
            oids.insert(oid.to_hex());
            uuids.insert(uid.to_string());
        }
        assert_eq!(oids.len(), 200, "ObjectId collisions");
        assert_eq!(uuids.len(), 200, "UUID collisions");
    }

    #[test]
    fn lorem_word_count() {
        let t = parse_template(r#"{"a": {"$lorem": {"words": 7}}}"#).unwrap();
        let mut r = rng(10);
        let now = fixed_now();
        let doc = generate_doc(&t, &mut r, now);
        let text = doc.get_str("a").unwrap();
        assert_eq!(text.split_whitespace().count(), 7);
    }

    // ---- parse errors -----------------------------------------------------

    #[test]
    fn unknown_generator_string_error_has_exact_path_format() {
        let err = parse_template(r#"{"users": [{"email": "$emial"}]}"#);
        // Arrays of literal objects are literal passthrough (not `$array`),
        // so index this via a real `$array`/`of` template to hit the `[0]`
        // path convention described in the spec.
        assert!(err.is_ok(), "bare JSON arrays are literal, not validated per-element");

        let err = parse_template(
            r#"{"users": {"$array": {"of": {"email": "$emial"}, "min": 1, "max": 1}}}"#,
        )
        .unwrap_err();
        assert_eq!(err, "users[0].email: unknown generator $emial");
    }

    #[test]
    fn unknown_generator_top_level() {
        let err = parse_template(r#"{"email": "$emial"}"#).unwrap_err();
        assert_eq!(err, "email: unknown generator $emial");
    }

    #[test]
    fn unknown_generator_object_key() {
        let err = parse_template(r#"{"a": {"$notreal": {}}}"#).unwrap_err();
        assert_eq!(err, "a: unknown generator $notreal");
    }

    #[test]
    fn pick_requires_non_empty_array() {
        let err = parse_template(r#"{"a": {"$pick": []}}"#).unwrap_err();
        assert_eq!(err, "a: $pick requires a non-empty array");

        let err = parse_template(r#"{"a": {"$pick": "not-an-array"}}"#).unwrap_err();
        assert_eq!(err, "a: $pick requires a non-empty array");
    }

    #[test]
    fn array_requires_of() {
        let err = parse_template(r#"{"a": {"$array": {"min": 1, "max": 2}}}"#).unwrap_err();
        assert_eq!(err, "a: $array requires of");
    }

    #[test]
    fn array_min_max_validation() {
        let err =
            parse_template(r#"{"a": {"$array": {"of": "$bool", "min": 5, "max": 1}}}"#)
                .unwrap_err();
        assert_eq!(err, "a: $array min must be <= max");
    }

    #[test]
    fn int_min_max_validation() {
        let err = parse_template(r#"{"a": {"$int": {"min": 10, "max": 1}}}"#).unwrap_err();
        assert_eq!(err, "a: $int min must be <= max");
    }

    #[test]
    fn float_min_max_validation() {
        let err = parse_template(r#"{"a": {"$float": {"min": 10, "max": 1, "decimals": 2}}}"#)
            .unwrap_err();
        assert_eq!(err, "a: $float min must be <= max");
    }

    #[test]
    fn float_decimals_cap() {
        let err = parse_template(
            r#"{"a": {"$float": {"min": 0, "max": 1, "decimals": 11}}}"#,
        )
        .unwrap_err();
        assert_eq!(err, "a: $float decimals must be <= 10");
    }

    #[test]
    fn date_range_min_max_validation() {
        let err = parse_template(
            r#"{"a": {"$date": {"from": "2021-06-02T00:00:00Z", "to": "2021-06-01T00:00:00Z"}}}"#,
        )
        .unwrap_err();
        assert_eq!(err, "a: $date from must be <= to");
    }

    #[test]
    fn date_requires_a_form() {
        let err = parse_template(r#"{"a": {"$date": {}}}"#).unwrap_err();
        assert_eq!(err, "a: $date requires past_days or from/to");
    }

    #[test]
    fn non_object_top_level_rejected() {
        assert!(parse_template("[1,2,3]").is_err());
        assert!(parse_template("\"hello\"").is_err());
        assert!(parse_template("42").is_err());
        assert_eq!(
            parse_template("[1,2,3]").unwrap_err(),
            "template root must be a JSON object"
        );
    }

    #[test]
    fn literal_round_trip() {
        // A real string that happens to start with `$` is expressible only
        // via `{"$literal": "..."}` — a bare `"$foo"` string is a parse
        // error (typo protection), never silently literal.
        let t = parse_template(r#"{"a": {"$literal": "$foo"}}"#).unwrap();
        assert_eq!(t.0[0].1, Spec::Literal(Value::String("$foo".to_string())));

        let mut r = rng(11);
        let doc = generate_doc(&t, &mut r, fixed_now());
        assert_eq!(doc.get_str("a").unwrap(), "$foo");

        let err = parse_template(r#"{"a": "$foo"}"#).unwrap_err();
        assert_eq!(err, "a: unknown generator $foo");
    }

    // ---- schema inference ---------------------------------------------------

    use crate::db::schema::FieldStat;

    fn tc(type_name: &str, count: usize) -> TypeCount {
        TypeCount {
            type_name: type_name.to_string(),
            count,
        }
    }

    fn field(path: &str, types: Vec<TypeCount>, enum_values: Option<Vec<String>>) -> FieldStat {
        let presence = types.iter().map(|t| t.count).sum();
        FieldStat {
            path: path.to_string(),
            types,
            presence,
            coverage: 1.0,
            enum_values,
        }
    }

    fn schema_report(fields: Vec<FieldStat>) -> SchemaReport {
        SchemaReport { sampled: 10, fields }
    }

    #[test]
    fn enum_wins_over_name_heuristic() {
        // "email" would normally hit the $email name rule, but a present
        // enum short-circuits straight to $pick — enum wins per the spec'd
        // rule order.
        let r = schema_report(vec![field(
            "email",
            vec![tc("string", 10)],
            Some(vec!["a@x.com".to_string(), "b@x.com".to_string()]),
        )]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["email"], serde_json::json!({"$pick": ["a@x.com", "b@x.com"]}));
    }

    #[test]
    fn name_heuristic_email() {
        let r = schema_report(vec![field("contactEmail", vec![tc("string", 10)], None)]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["contactEmail"], serde_json::json!("$email"));
    }

    #[test]
    fn name_heuristic_first_name() {
        let r = schema_report(vec![field("firstName", vec![tc("string", 10)], None)]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["firstName"], serde_json::json!("$firstName"));
    }

    #[test]
    fn name_heuristic_last_name() {
        let r = schema_report(vec![field("lastName", vec![tc("string", 10)], None)]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["lastName"], serde_json::json!("$lastName"));
    }

    #[test]
    fn name_heuristic_generic_name() {
        let r = schema_report(vec![field("displayName", vec![tc("string", 10)], None)]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["displayName"], serde_json::json!("$name"));
    }

    #[test]
    fn name_heuristic_date_variants() {
        let expected = serde_json::json!({"$date": {"past_days": 365}});
        for path in ["createdAt", "eventDate", "created", "lastUpdated"] {
            let r = schema_report(vec![field(path, vec![tc("string", 10)], None)]);
            let t = infer_template_from_schema(&r);
            assert_eq!(t[path], expected, "path {path} did not match $date");
        }
    }

    #[test]
    fn name_heuristic_id_suffix_requires_object_id_type() {
        // "userId" ends with "id" and is dominant-typed objectId -> $objectId.
        let r = schema_report(vec![field("userId", vec![tc("objectId", 10)], None)]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["userId"], serde_json::json!("$objectId"));

        // Same name, but dominant type is string -> the id-suffix rule does
        // NOT fire (gated on objectId type); falls through to the string
        // fallback instead.
        let r = schema_report(vec![field("userId", vec![tc("string", 10)], None)]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["userId"], serde_json::json!({"$lorem": {"words": 2}}));
    }

    #[test]
    fn type_fallback_string() {
        let r = schema_report(vec![field("bio", vec![tc("string", 10)], None)]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["bio"], serde_json::json!({"$lorem": {"words": 2}}));
    }

    #[test]
    fn type_fallback_int_and_long() {
        let expected = serde_json::json!({"$int": {"min": 0, "max": 1000}});
        let r = schema_report(vec![field("qty", vec![tc("int", 10)], None)]);
        assert_eq!(infer_template_from_schema(&r)["qty"], expected);

        let r = schema_report(vec![field("qty", vec![tc("long", 10)], None)]);
        assert_eq!(infer_template_from_schema(&r)["qty"], expected);
    }

    #[test]
    fn type_fallback_double_and_decimal() {
        let expected = serde_json::json!({"$float": {"min": 0, "max": 1000, "decimals": 2}});
        let r = schema_report(vec![field("weight", vec![tc("double", 10)], None)]);
        assert_eq!(infer_template_from_schema(&r)["weight"], expected);

        let r = schema_report(vec![field("weight", vec![tc("decimal", 10)], None)]);
        assert_eq!(infer_template_from_schema(&r)["weight"], expected);
    }

    #[test]
    fn type_fallback_bool() {
        let r = schema_report(vec![field("active", vec![tc("bool", 10)], None)]);
        assert_eq!(infer_template_from_schema(&r)["active"], serde_json::json!("$bool"));
    }

    #[test]
    fn type_fallback_date() {
        // "occurredOn" matches none of the name-based rules — this exercises
        // the dominant-type fallback path for `date`, not the name rule.
        let r = schema_report(vec![field("occurredOn", vec![tc("date", 10)], None)]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["occurredOn"], serde_json::json!({"$date": {"past_days": 365}}));
    }

    #[test]
    fn type_fallback_object_id() {
        // "ref" doesn't end with "id", so this exercises the dominant-type
        // fallback, not the name-based id-suffix rule.
        let r = schema_report(vec![field("ref", vec![tc("objectId", 10)], None)]);
        assert_eq!(infer_template_from_schema(&r)["ref"], serde_json::json!("$objectId"));
    }

    #[test]
    fn type_fallback_array() {
        let r = schema_report(vec![field("tags", vec![tc("array", 10)], None)]);
        let t = infer_template_from_schema(&r);
        assert_eq!(
            t["tags"],
            serde_json::json!({"$array": {"of": {"$lorem": {"words": 2}}, "min": 1, "max": 3}})
        );
    }

    #[test]
    fn unknown_type_omitted() {
        for bad_type in ["regex", "binary", "timestamp", "javascript", "symbol", "null"] {
            let r = schema_report(vec![field("weird", vec![tc(bad_type, 10)], None)]);
            let t = infer_template_from_schema(&r);
            assert!(
                t.get("weird").is_none(),
                "expected {bad_type} field to be omitted, got {t:?}"
            );
        }
    }

    #[test]
    fn id_field_always_omitted() {
        let r = schema_report(vec![
            field("_id", vec![tc("objectId", 10)], None),
            field("name", vec![tc("string", 10)], None),
        ]);
        let t = infer_template_from_schema(&r);
        assert!(t.get("_id").is_none());
        assert!(t.get("name").is_some());
    }

    #[test]
    fn nested_object_assembly() {
        // a.b.c: two levels of object parents, neither of which should emit
        // a value of its own — only the leaf `c` does.
        let r = schema_report(vec![
            field("a", vec![tc("object", 10)], None),
            field("a.b", vec![tc("object", 10)], None),
            field("a.b.c", vec![tc("string", 10)], None),
        ]);
        let t = infer_template_from_schema(&r);
        assert_eq!(
            t,
            serde_json::json!({"a": {"b": {"c": {"$lorem": {"words": 2}}}}})
        );
    }

    #[test]
    fn object_field_recurses_even_if_its_own_name_looks_like_a_date() {
        // A pathological but real case: a subdocument field literally named
        // "createdAt" (dominant type object). The name-based $date rule must
        // NOT fire here — object fields always recurse via their children,
        // never get flattened into a scalar.
        let r = schema_report(vec![
            field("createdAt", vec![tc("object", 10)], None),
            field("createdAt.iso", vec![tc("string", 10)], None),
        ]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["createdAt"], serde_json::json!({"iso": {"$lorem": {"words": 2}}}));
    }

    #[test]
    fn full_realistic_schema_report_template_snapshot() {
        let r = schema_report(vec![
            field("_id", vec![tc("objectId", 20)], None),
            field("active", vec![tc("bool", 20)], None),
            field("address", vec![tc("object", 20)], None),
            field("address.city", vec![tc("string", 20)], None),
            field("address.zip", vec![tc("int", 20)], None),
            field(
                "createdAt",
                vec![tc("date", 20)],
                None,
            ),
            field("email", vec![tc("string", 20)], None),
            field("name", vec![tc("string", 20)], None),
            field(
                "tier",
                vec![tc("string", 20)],
                Some(vec!["free".to_string(), "pro".to_string()]),
            ),
            field("balance", vec![tc("double", 20)], None),
            field("tags", vec![tc("array", 15), tc("null", 5)], None),
            field("notes", vec![tc("regex", 20)], None),
        ]);
        let t = infer_template_from_schema(&r);
        let expected = serde_json::json!({
            "active": "$bool",
            "address": {
                "city": {"$lorem": {"words": 2}},
                "zip": {"$int": {"min": 0, "max": 1000}}
            },
            "createdAt": {"$date": {"past_days": 365}},
            "email": "$email",
            "name": "$name",
            "tier": {"$pick": ["free", "pro"]},
            "balance": {"$float": {"min": 0, "max": 1000, "decimals": 2}},
            "tags": {"$array": {"of": {"$lorem": {"words": 2}}, "min": 1, "max": 3}}
            // "notes" (regex) and "_id" are both omitted.
        });
        assert_eq!(t, expected);
        // Locks the actual invariant this whole feature depends on: whatever
        // comes out of inference must be a template `parse_template` accepts.
        parse_template(&t.to_string()).expect("inferred template must parse");
    }

    #[test]
    fn dominant_type_breaks_ties_toward_first_seen() {
        // Equal counts for "int" and "string" — types are populated in
        // alphabetical order by infer_schema (BTreeMap iteration), so "int"
        // (alphabetically first) should win the tie, not "string".
        let r = schema_report(vec![field(
            "mixed",
            vec![tc("int", 5), tc("string", 5)],
            None,
        )]);
        let t = infer_template_from_schema(&r);
        assert_eq!(t["mixed"], serde_json::json!({"$int": {"min": 0, "max": 1000}}));
    }

    // ---- preview_generated_documents_impl -----------------------------------

    #[test]
    fn preview_is_deterministic_under_a_fixed_seed() {
        let template = r#"{"a": "$name", "b": {"$int": {"min": 0, "max": 1000000}}}"#;
        let d1 = preview_generated_documents_impl(template, Some(3), Some(99)).unwrap();
        let d2 = preview_generated_documents_impl(template, Some(3), Some(99)).unwrap();
        assert_eq!(d1, d2);
    }

    #[test]
    fn preview_defaults_to_3_and_caps_at_10() {
        let template = r#"{"a": "$bool"}"#;
        let default = preview_generated_documents_impl(template, None, Some(1)).unwrap();
        assert_eq!(default.len(), 3);

        let capped = preview_generated_documents_impl(template, Some(11), Some(1)).unwrap();
        assert_eq!(capped.len(), 10);

        let under_cap = preview_generated_documents_impl(template, Some(5), Some(1)).unwrap();
        assert_eq!(under_cap.len(), 5);
    }

    #[test]
    fn preview_propagates_parse_errors() {
        let err = preview_generated_documents_impl(r#"{"a": "$emial"}"#, Some(1), Some(1))
            .unwrap_err();
        assert_eq!(err, "a: unknown generator $emial");
    }

    #[test]
    fn preview_documents_are_valid_json_with_expected_shape() {
        let out = preview_generated_documents_impl(
            r#"{"id": "$objectId", "n": {"$int": {"min": 1, "max": 1}}}"#,
            Some(2),
            Some(1),
        )
        .unwrap();
        assert_eq!(out.len(), 2);
        for s in &out {
            let v: Value = serde_json::from_str(s).expect("preview doc must be valid JSON");
            assert_eq!(v["n"].as_i64(), Some(1));
            assert!(v["id"].is_object(), "objectId should serialize as an object ({{$oid:..}})");
        }
    }

    // ---- infer_generate_template_impl (mock connection, end-to-end) --------

    #[tokio::test]
    async fn infer_over_mock_connection_round_trips_through_parse_template() {
        let state = crate::AppState::new();
        let conn_id = crate::connect_db_impl(&state, "mongodb://mock", None)
            .await
            .expect("mock connect");

        let template_json =
            infer_generate_template_impl(&state, &conn_id, "sales_db", "customers", None)
                .await
                .expect("infer over mock schema");

        // The core invariant: inference output must always be a valid
        // template, regardless of what the sampled schema looks like.
        let parsed = parse_template(&template_json).expect("inferred template must parse");

        let value: Value = serde_json::from_str(&template_json).unwrap();
        assert!(value.get("_id").is_none(), "_id must never be seeded");
        // The mock `sales_db.customers` dataset has only 3 rows, so `email`
        // (3 distinct values) qualifies as a low-cardinality enum and $pick
        // wins over the $email name heuristic — exactly the "enum wins"
        // rule, just exercised end-to-end instead of via a hand-built
        // SchemaReport.
        assert!(value["email"]["$pick"].is_array(), "email should infer as $pick (enum wins)");
        // Same story for "name" (3 distinct values across the 3-row mock
        // sample) and "tier" (2 distinct values) — all qualify as enums.
        assert!(value["name"]["$pick"].is_array(), "low-cardinality name should infer as $pick");
        assert!(value["tier"]["$pick"].is_array(), "low-cardinality tier should infer as $pick");
        assert!(value["address"].is_object(), "address should recurse into a nested object");
        assert!(value["address"]["city"].is_object() || value["address"]["city"].is_string());

        // Sanity: generating from the inferred template actually works.
        let mut r = StdRng::seed_from_u64(1);
        let now = bson::DateTime::now();
        let _doc = generate_doc(&parsed, &mut r, now);
    }
}
