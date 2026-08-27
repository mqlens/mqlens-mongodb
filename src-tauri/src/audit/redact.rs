//! Scrub secrets and truncate audit payloads (#272).

/// Hard cap for `args_json` / mongosh text stored per event (UTF-8 bytes).
pub const MAX_ARGS_BYTES: usize = 64 * 1024;

/// Redact connection URIs and obvious password fields from free text.
pub fn redact_text(input: &str) -> String {
    let without_uri = scrub_mongodb_uris(input);
    scrub_password_json_fields(&without_uri)
}

fn scrub_mongodb_uris(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let lower = input.to_ascii_lowercase();
    let mut i = 0;
    while i < input.len() {
        let rest_lower = &lower[i..];
        let scheme_len = if rest_lower.starts_with("mongodb+srv://") {
            "mongodb+srv://".len()
        } else if rest_lower.starts_with("mongodb://") {
            "mongodb://".len()
        } else {
            out.push(input[i..].chars().next().unwrap());
            i += input[i..].chars().next().unwrap().len_utf8();
            continue;
        };

        out.push_str(&input[i..i + scheme_len]);
        i += scheme_len;

        // Optional userinfo ending at '@' before host.
        if let Some(at_rel) = input[i..].find('@') {
            let userinfo = &input[i..i + at_rel];
            // Only treat as credentials when it contains ':' (user:pass).
            if userinfo.contains(':')
                && !userinfo.contains('/')
                && !userinfo.contains('?')
                && !userinfo.contains(' ')
            {
                out.push_str("***:***@");
                i += at_rel + 1;
                continue;
            }
        }
        // No credentials (or ambiguous userinfo): keep copying from `i`.
    }
    out
}

fn scrub_password_json_fields(input: &str) -> String {
    const KEYS: &[&str] = &["password", "passwd", "pwd", "secret", "api_key", "api-key", "token"];
    let mut out = input.to_string();
    for key in KEYS {
        out = scrub_secret_key_values(&out, key);
    }
    out
}

/// Quote characters that delimit a JS string value. Backticks included: a
/// template literal is valid mongosh, and treating one as a bare token stopped
/// redaction at the first space inside the secret.
fn is_quote(b: u8) -> bool {
    b == b'"' || b == b'\'' || b == b'`'
}

/// True when `b` can appear inside a bare JS identifier.
fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// End index of a quoted string starting at `open` (the quote byte), honouring
/// backslash escapes. Returns `None` when the string is unterminated.
fn quoted_end(bytes: &[u8], open: usize) -> Option<usize> {
    let quote = bytes[open];
    let mut i = open + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if i + 1 < bytes.len() => i += 2,
            b if b == quote => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// Match `<key><ws>:<ws><value>` at `i`, where the key may be bare (`pwd`),
/// double-quoted (`"pwd"`) or single-quoted (`'pwd'`), and the value may be
/// double-quoted, single-quoted or a bare token. Returns the byte range of the
/// value so the caller can keep the key text verbatim.
fn match_key_value(
    input: &str,
    lower: &str,
    key_lower: &str,
    i: usize,
) -> Option<(usize, usize)> {
    let bytes = input.as_bytes();
    let mut j = i;
    let key_quote = match bytes.get(j) {
        Some(&b) if is_quote(b) => {
            j += 1;
            Some(b)
        }
        _ => None,
    };
    if !lower.get(j..)?.starts_with(key_lower) {
        return None;
    }
    let after_key = j + key_lower.len();
    let mut k = match key_quote {
        Some(q) => {
            if bytes.get(after_key) != Some(&q) {
                return None;
            }
            after_key + 1
        }
        None => {
            // Bare key: must not be a fragment of a longer identifier.
            let before_ok = i == 0 || !is_ident_byte(bytes[i - 1]);
            let after_ok = !bytes.get(after_key).is_some_and(|&b| is_ident_byte(b));
            if !before_ok || !after_ok {
                return None;
            }
            after_key
        }
    };

    while bytes.get(k).is_some_and(|b| b.is_ascii_whitespace()) {
        k += 1;
    }
    if bytes.get(k) != Some(&b':') {
        return None;
    }
    k += 1;
    while bytes.get(k).is_some_and(|b| b.is_ascii_whitespace()) {
        k += 1;
    }

    let value_start = k;
    let &first = bytes.get(value_start)?;
    let value_end = if is_quote(first) {
        quoted_end(bytes, value_start)?
    } else {
        let mut e = value_start;
        while let Some(&b) = bytes.get(e) {
            if b.is_ascii_whitespace() || matches!(b, b',' | b'}' | b')' | b']' | b';') {
                break;
            }
            e += 1;
        }
        if e == value_start {
            return None;
        }
        e
    };
    Some((value_start, value_end))
}

/// Replace the value of every occurrence of `key` with `"***"`, covering both
/// strict JSON and mongosh JavaScript object syntax.
fn scrub_secret_key_values(input: &str, key: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let key_lower = key.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if let Some((value_start, value_end)) = match_key_value(input, &lower, &key_lower, i) {
            out.push_str(&input[i..value_start]);
            out.push_str("\"***\"");
            i = value_end;
            continue;
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Hard cap for a persisted error string (UTF-8 bytes).
pub const MAX_ERROR_BYTES: usize = 2 * 1024;

/// Sanitize a driver error before it is persisted.
///
/// Errors always go through [`redact_text`]. When payload logging is off they
/// additionally have every `{...}` group collapsed, because MongoDB duplicate-key
/// and validation errors embed rejected document values there
/// (`dup key: { email: "..." }`) — that must not reach the log or a plaintext
/// export under the payload-free default.
pub fn redact_error(input: &str, include_payloads: bool) -> String {
    let redacted = redact_text(input);
    let stripped = if include_payloads {
        redacted
    } else {
        collapse_brace_groups(&redacted)
    };
    truncate_args(&stripped, MAX_ERROR_BYTES)
}

/// Replace every balanced `{...}` group (and any unterminated tail) with `{…}`.
///
/// Quote-aware: MongoDB errors embed document values, and those values can
/// themselves contain braces (`dup key: {{ email: "alice}}secret@example" }}`).
/// A brace counter that ignored quoting would stop at the `}}` *inside* the
/// string and copy the rest of the value straight into the log.
fn collapse_brace_groups(input: &str) -> String {
    const PLACEHOLDER: &str = "{…}";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if bytes[i] == b'{' {
            out.push_str(PLACEHOLDER);
            i = end_of_brace_group(bytes, i);
            continue;
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Index just past the `{...}` group starting at `start`, skipping over braces
/// that sit inside quoted strings. Returns `bytes.len()` when unterminated, so
/// a truncated error cannot leak its tail either.
fn end_of_brace_group(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0usize;
    let mut i = start;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(q) => {
                if b == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                if b == q {
                    quote = None;
                }
            }
            None => match b {
                _ if is_quote(b) => quote = Some(b),
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return i + 1;
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    bytes.len()
}

/// Truncate to at most `max_bytes` UTF-8 bytes, appending a marker when cut.
pub fn truncate_args(input: &str, max_bytes: usize) -> String {
    const MARKER: &str = "…[truncated]";
    if input.len() <= max_bytes {
        return input.to_string();
    }
    if max_bytes <= MARKER.len() {
        return MARKER.chars().take(max_bytes).collect();
    }
    let keep = max_bytes - MARKER.len();
    let mut end = keep;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = input[..end].to_string();
    out.push_str(MARKER);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_mongodb_uri_credentials() {
        let raw = "connect mongodb://alice:s3cret@localhost:27017/app then drop";
        let out = redact_text(raw);
        assert!(!out.contains("s3cret"), "password must not appear: {out}");
        assert!(!out.contains("alice:"), "userinfo must be scrubbed: {out}");
        assert!(out.contains("mongodb://"), "scheme retained: {out}");
        assert!(out.contains("localhost:27017"), "host retained: {out}");
    }

    #[test]
    fn scrubs_password_json_fields() {
        let raw = r#"{"password":"hunter2","filter":{"x":1}}"#;
        let out = redact_text(raw);
        assert!(!out.contains("hunter2"), "password value leaked: {out}");
        assert!(out.contains("password"), "key may remain: {out}");
    }

    #[test]
    fn scrubs_unquoted_mongosh_pwd() {
        let raw = r#"db.createUser({user:"alice",pwd:"secret"})"#;
        let out = redact_text(raw);
        assert!(!out.contains("secret"), "password value leaked: {out}");
    }

    #[test]
    fn scrubs_quoted_js_keys_and_single_quoted_values() {
        for raw in [
            r#"db.createUser({'user':'alice','pwd':'secret'})"#,
            r#"db.createUser({"user":"alice","pwd": 'secret'})"#,
            r#"db.createUser({user:'alice', PWD : "secret"})"#,
            r#"db.createUser({'pwd':secret})"#,
            r#"{"password": 'secret'}"#,
        ] {
            let out = redact_text(raw);
            assert!(!out.contains("secret"), "password leaked from {raw}: {out}");
        }
    }

    #[test]
    fn scrubs_template_literal_secrets_containing_whitespace() {
        for raw in [
            "db.createUser({pwd: `very secret`})",
            "db.createUser({user:'alice', password: `two words here`})",
            "db.createUser({`pwd`: `spaced value`})",
        ] {
            let out = redact_text(raw);
            assert!(!out.contains("secret"), "template literal leaked from {raw}: {out}");
            assert!(!out.contains("words"), "template literal leaked from {raw}: {out}");
            assert!(!out.contains("spaced"), "template literal leaked from {raw}: {out}");
            // The key text is preserved verbatim, backticks included; only the
            // value must be replaced.
            assert!(out.contains("\"***\""), "value must be masked: {out}");
        }
    }

    #[test]
    fn error_redaction_handles_backticks_inside_brace_groups() {
        let raw = "failed: { note: `has } brace`, tag: 2 }";
        let out = redact_error(raw, false);
        assert!(!out.contains("has"), "value leaked: {out}");
        assert!(!out.contains("tag"), "group ended early: {out}");
        assert!(out.contains("failed:"), "prefix must survive: {out}");
    }

    #[test]
    fn keeps_non_secret_keys_and_similar_identifiers() {
        let raw = r#"{"user":"alice","pwdHash":"keepme","oldpwd":"keepme2"}"#;
        let out = redact_text(raw);
        assert!(out.contains("alice"), "unrelated value dropped: {out}");
        assert!(out.contains("keepme"), "pwdHash must not match: {out}");
        assert!(out.contains("keepme2"), "oldpwd must not match: {out}");
    }

    #[test]
    fn error_redaction_drops_brace_payloads_when_disabled() {
        let raw = r#"E11000 duplicate key error collection: shop.users index: email_1 dup key: { email: "a@b.example" }"#;
        let out = redact_error(raw, false);
        assert!(!out.contains("a@b.example"), "document value leaked: {out}");
        assert!(out.contains("E11000"), "diagnostic text must survive: {out}");
        assert!(out.contains("email_1"), "index name must survive: {out}");
    }

    #[test]
    fn error_redaction_keeps_payloads_when_enabled_but_still_scrubs_secrets() {
        let raw = r#"failed for mongodb://alice:s3cret@host:27017 dup key: { email: "a@b.example" }"#;
        let out = redact_error(raw, true);
        assert!(out.contains("a@b.example"), "payload expected when enabled: {out}");
        assert!(!out.contains("s3cret"), "URI credential leaked: {out}");
    }

    #[test]
    fn error_redaction_caps_length() {
        let raw = format!("boom {}", "x".repeat(MAX_ERROR_BYTES * 2));
        let out = redact_error(&raw, true);
        assert!(out.len() <= MAX_ERROR_BYTES, "len={}", out.len());
    }

    #[test]
    fn error_redaction_suppresses_values_containing_braces() {
        // A brace inside the quoted value must not be mistaken for the end of
        // the group, or the rest of the value gets copied into the log.
        let raw = r#"E11000 duplicate key error dup key: { email: "alice}secret@example" }"#;
        let out = redact_error(raw, false);
        assert!(!out.contains("secret@example"), "value leaked: {out}");
        assert!(!out.contains("alice"), "value leaked: {out}");
        assert!(out.contains("E11000"), "diagnostic must survive: {out}");
    }

    #[test]
    fn error_redaction_handles_escaped_quotes_and_nesting() {
        let raw = r#"failed: { doc: { name: "a\"}\" b", tag: 'x}y' }, n: 2 }"#;
        let out = redact_error(raw, false);
        for leak in ["a\\\"", "x}y", "tag", "n: 2"] {
            assert!(!out.contains(leak), "leaked {leak:?} from {raw}: {out}");
        }
        assert!(out.contains("failed:"), "prefix must survive: {out}");
    }

    #[test]
    fn collapse_handles_unterminated_brace() {
        let out = redact_error("bad doc: { email: \"a@b.example\"", false);
        assert!(!out.contains("a@b.example"), "unterminated group leaked: {out}");
    }

    #[test]
    fn truncates_over_max_with_marker() {
        let big = "a".repeat(MAX_ARGS_BYTES + 100);
        let out = truncate_args(&big, MAX_ARGS_BYTES);
        assert!(out.len() <= MAX_ARGS_BYTES + 32, "len={}", out.len());
        assert!(
            out.contains("truncated") || out.contains("…"),
            "expected truncation marker: {}",
            &out[out.len().saturating_sub(40)..]
        );
        assert!(out.as_bytes().len() > MAX_ARGS_BYTES - 20);
    }

    #[test]
    fn truncate_short_unchanged() {
        assert_eq!(truncate_args("hi", MAX_ARGS_BYTES), "hi");
    }
}
