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
        out = scrub_json_string_value(&out, key);
    }
    out
}

/// Replace `"key":"..."` string values with `"***"` (case-insensitive key).
fn scrub_json_string_value(input: &str, key: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let lower = input.to_ascii_lowercase();
    let key_lower = key.to_ascii_lowercase();
    let needle = format!("\"{key_lower}\"");
    let mut i = 0;
    while i < input.len() {
        if lower[i..].starts_with(&needle) {
            out.push_str(&input[i..i + needle.len()]);
            i += needle.len();
            // skip whitespace and colon
            while i < input.len() && input.as_bytes()[i].is_ascii_whitespace() {
                out.push(input.as_bytes()[i] as char);
                i += 1;
            }
            if i < input.len() && input.as_bytes()[i] == b':' {
                out.push(':');
                i += 1;
            }
            while i < input.len() && input.as_bytes()[i].is_ascii_whitespace() {
                out.push(input.as_bytes()[i] as char);
                i += 1;
            }
            if i < input.len() && input.as_bytes()[i] == b'"' {
                i += 1; // opening quote
                while i < input.len() {
                    let b = input.as_bytes()[i];
                    if b == b'\\' && i + 1 < input.len() {
                        i += 2;
                        continue;
                    }
                    if b == b'"' {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                out.push_str("\"***\"");
                continue;
            }
            continue;
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
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
