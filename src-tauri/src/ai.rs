// Natural-language → MongoDB query generation via the Anthropic Messages API.
// The app's backend holds the API key (kept out of the frontend bundle) and calls
// https://api.anthropic.com/v1/messages over HTTPS (no official Rust SDK).

use std::time::Duration;

pub const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// One prior turn of the chat conversation, threaded into the request for context.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ChatTurn {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

/// System prompt instructing the model to translate a request into a MongoDB
/// query (find or aggregate) plus a short explanation, returning JSON only.
pub fn mql_system_prompt(collection: &str, fields: &[String]) -> String {
    let field_list = if fields.is_empty() {
        "(unknown — infer reasonable field names)".to_string()
    } else {
        fields.join(", ")
    };
    format!(
        "You are a MongoDB query assistant for the collection \"{collection}\". \
Known fields: {field_list}.\n\n\
For each user request, decide whether it needs a simple find or an aggregation pipeline, \
then respond with ONLY a JSON object of this exact shape:\n\
{{\n\
  \"explanation\": <one or two short sentences describing what the query does>,\n\
  \"queryType\": \"find\" | \"aggregate\",\n\
  \"filter\": <MongoDB query document — for find; {{}} otherwise>,\n\
  \"sort\": <MongoDB sort document — for find; {{}} otherwise>,\n\
  \"pipeline\": <array of MongoDB aggregation stages — for aggregate; [] otherwise>\n\
}}\n\n\
Rules:\n\
- Output only that JSON object. No markdown code fences, no text outside the JSON.\n\
- Use \"aggregate\" when the request needs $group, $lookup, $unwind, $project with computed \
fields, faceting, or any multi-stage transformation; otherwise use \"find\".\n\
- For \"find\": put criteria in \"filter\" and ordering in \"sort\"; leave \"pipeline\" as [].\n\
- For \"aggregate\": put the full stage array in \"pipeline\"; leave \"filter\"/\"sort\" as {{}}.\n\
- Use valid MongoDB operators ($gt, $lt, $in, $regex, $and, $or, $group, $match, etc.)."
    )
}

/// System prompt for the shell assistant: like `mql_system_prompt` but adds a
/// "script" queryType carrying raw mongosh JavaScript for writes, multi-statement
/// work, loops, or anything not expressible as a single find/aggregate.
pub fn mql_shell_system_prompt(collection: &str, fields: &[String]) -> String {
    let field_list = if fields.is_empty() {
        "(unknown — infer reasonable field names)".to_string()
    } else {
        fields.join(", ")
    };
    format!(
        "You are a MongoDB shell (mongosh) assistant for the collection \"{collection}\". \
Known fields: {field_list}.\n\n\
For each user request, decide whether it needs a simple find, an aggregation pipeline, \
or a JavaScript script, then respond with ONLY a JSON object of this exact shape:\n\
{{\n\
  \"explanation\": <one or two short sentences describing what it does>,\n\
  \"queryType\": \"find\" | \"aggregate\" | \"script\",\n\
  \"filter\": <MongoDB query document — for find; {{}} otherwise>,\n\
  \"sort\": <MongoDB sort document — for find; {{}} otherwise>,\n\
  \"pipeline\": <array of MongoDB aggregation stages — for aggregate; [] otherwise>,\n\
  \"script\": <raw mongosh JavaScript string — for script; \"\" otherwise>\n\
}}\n\n\
Rules:\n\
- Output only that JSON object. No markdown code fences, no text outside the JSON.\n\
- Use \"script\" for writes (insertOne/insertMany/updateMany/deleteMany/bulkWrite), \
multi-statement work, loops, variables, or anything a single find/aggregate cannot express. \
The script is valid mongosh JavaScript that uses db.{collection} (and db.<other> as needed) \
and prints results with printjson(...) where useful. Leave filter/sort/pipeline empty.\n\
- Use \"find\" for plain reads: put criteria in \"filter\", ordering in \"sort\"; leave \
pipeline [] and script \"\".\n\
- Use \"aggregate\" for $group/$lookup/$unwind/$project-with-computed-fields/faceting or \
multi-stage transforms: put stages in \"pipeline\"; leave filter/sort {{}} and script \"\".\n\
- Use valid MongoDB/mongosh operators and syntax."
    )
}

/// Map a chat turn's role to a value, treating anything that isn't "assistant" as "user".
fn normalized_role<'a>(role: &str, assistant_value: &'a str, user_value: &'a str) -> &'a str {
    if role == "assistant" {
        assistant_value
    } else {
        user_value
    }
}

/// Build the Anthropic Messages API request body, including prior chat turns.
pub fn build_query_gen_request(
    model: &str,
    system: &str,
    history: &[ChatTurn],
    user_prompt: &str,
) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> = history
        .iter()
        .map(|t| {
            serde_json::json!({
                "role": normalized_role(&t.role, "assistant", "user"),
                "content": t.content,
            })
        })
        .collect();
    messages.push(serde_json::json!({ "role": "user", "content": user_prompt }));
    serde_json::json!({
        "model": model,
        "max_tokens": 2048,
        // cache_control is harmless if the prefix is below the cacheable minimum.
        "system": [{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }],
        "messages": messages,
    })
}

/// Concatenate the text content blocks from an Anthropic Messages response.
pub fn response_text(resp: &serde_json::Value) -> String {
    resp.get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Pull the FIRST balanced JSON object out of free text, then validate that it
/// parses. Returns compact JSON.
///
/// Tolerates prose and Markdown code fences around the object, and braces
/// inside string values.
pub fn extract_json_object(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let start = text
        .find('{')
        .ok_or_else(|| "Model response contained no JSON object".to_string())?;

    // Scan from the first '{', matching braces while skipping string contents.
    // Structural chars ({ } " \) are ASCII, so byte scanning is UTF-8 safe.
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut end: Option<usize> = None;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
        } else {
            match b {
                b'"' => in_string = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
    }

    let end = end.ok_or_else(|| "Model response contained an unterminated JSON object".to_string())?;
    let candidate = &text[start..=end];
    let parsed: serde_json::Value = serde_json::from_str(candidate)
        .map_err(|e| format!("Model did not return valid JSON: {}", e))?;
    serde_json::to_string(&parsed).map_err(|e| e.to_string())
}

/// Extract the generated `{filter, sort}` JSON from a successful API response.
pub fn extract_mql_from_response(resp: &serde_json::Value) -> Result<String, String> {
    extract_json_object(&response_text(resp))
}

/// Append optional user instructions to a system prompt.
pub fn apply_custom_instructions(system: &str, custom: &str) -> String {
    if custom.trim().is_empty() {
        system.to_string()
    } else {
        format!(
            "{}\n\nAdditional instructions from the user:\n{}",
            system,
            custom.trim()
        )
    }
}

/// Fold a system prompt + prior turns + the user request into a single prompt
/// (for local CLI agents that accept only one prompt argument).
pub fn combined_prompt(system: &str, history: &[ChatTurn], user: &str) -> String {
    let mut out = system.to_string();
    if !history.is_empty() {
        out.push_str("\n\nConversation so far:");
        for t in history {
            let who = if t.role == "assistant" { "Assistant" } else { "User" };
            out.push_str(&format!("\n{}: {}", who, t.content));
        }
    }
    out.push_str(&format!("\n\nUser request: {}", user));
    out
}

pub const OPENAI_URL: &str = "https://api.openai.com/v1/chat/completions";

pub fn build_openai_request(
    model: &str,
    system: &str,
    history: &[ChatTurn],
    user_prompt: &str,
) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];
    for t in history {
        messages.push(serde_json::json!({
            "role": normalized_role(&t.role, "assistant", "user"),
            "content": t.content,
        }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": user_prompt }));
    serde_json::json!({ "model": model, "messages": messages })
}

pub fn extract_openai_text(resp: &serde_json::Value) -> String {
    resp.get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string()
}

pub async fn generate_openai(
    api_key: &str,
    model: &str,
    system: &str,
    history: &[ChatTurn],
    user_prompt: &str,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("No OpenAI API key set. Add one in Settings.".to_string());
    }
    let body = build_openai_request(model, system, history, user_prompt);
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = reqwest::Client::new();
    let resp = client
        .post(OPENAI_URL)
        .header("authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to reach OpenAI API: {}", e))?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response from OpenAI API: {}", e))?;
    if !status.is_success() {
        let message = json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("request failed");
        return Err(format!("OpenAI API error ({}): {}", status.as_u16(), message));
    }
    extract_json_object(&extract_openai_text(&json))
}

/// Post a chat completion to any OpenAI-compatible endpoint.
///
/// The wire format is the same one `generate_openai` uses; only the URL and the
/// name in error messages differ. Splitting it out is what lets DeepSeek,
/// OpenRouter, Groq, Together, Mistral, xAI, Ollama, LM Studio and vLLM work
/// without an adapter each.
///
/// `api_key` may be empty: local servers ignore credentials, and sending
/// `Bearer ` with nothing after it makes some of them reject the request.
pub async fn generate_openai_compatible(
    endpoint: &str,
    api_key: &str,
    model: &str,
    provider_name: &str,
    system: &str,
    history: &[ChatTurn],
    user_prompt: &str,
) -> Result<String, String> {
    let body = build_openai_request(model, system, history, user_prompt);
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = reqwest::Client::new();
    let mut request = client
        .post(endpoint)
        .header("content-type", "application/json");
    if !api_key.trim().is_empty() {
        request = request.header("authorization", format!("Bearer {}", api_key));
    }
    let resp = request
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to reach {}: {}", provider_name, e))?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response from {}: {}", provider_name, e))?;
    if !status.is_success() {
        return Err(format!(
            "{} error ({}): {}",
            provider_name,
            status.as_u16(),
            api_error_message(&json)
        ));
    }
    extract_json_object(&extract_openai_text(&json))
}

/// Post a message request to any endpoint speaking Anthropic's format.
pub async fn generate_anthropic_compatible(
    endpoint: &str,
    api_key: &str,
    model: &str,
    provider_name: &str,
    system: &str,
    history: &[ChatTurn],
    user_prompt: &str,
) -> Result<String, String> {
    let body = build_query_gen_request(model, system, history, user_prompt);
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = reqwest::Client::new();
    let mut request = client
        .post(endpoint)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json");
    if !api_key.trim().is_empty() {
        request = request.header("x-api-key", api_key);
    }
    let resp = request
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to reach {}: {}", provider_name, e))?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response from {}: {}", provider_name, e))?;
    if !status.is_success() {
        return Err(format!(
            "{} error ({}): {}",
            provider_name,
            status.as_u16(),
            api_error_message(&json)
        ));
    }
    extract_json_object(&response_text(&json))
}

/// The human-readable half of an error body, for either wire format.
///
/// Both nest it under `error.message`, but gateways and local servers are looser:
/// some send `error` as a bare string, some only `message`. Reaching for each in
/// turn beats reporting "request failed" for a response that said why.
fn api_error_message(json: &serde_json::Value) -> String {
    if let Some(m) = json
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
    {
        return m.to_string();
    }
    if let Some(m) = json.get("error").and_then(|e| e.as_str()) {
        return m.to_string();
    }
    if let Some(m) = json.get("message").and_then(|m| m.as_str()) {
        return m.to_string();
    }
    "request failed".to_string()
}

/// Model ids from a `GET .../models` response, in either HTTP format.
///
/// OpenAI and Anthropic both answer `{"data": [{"id": ...}]}`. Servers that
/// only pretend to be OpenAI are looser — Ollama's native route is
/// `{"models": [{"name": ...}]}` — so each likely container and key is tried
/// before giving up, and the error says which shapes were looked for.
pub fn parse_models_json(resp: &serde_json::Value) -> Result<Vec<String>, String> {
    let items = resp
        .get("data")
        .or_else(|| resp.get("models"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            "No model list in the response: expected a `data` or `models` array.".to_string()
        })?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let id = item
            .get("id")
            .or_else(|| item.get("name"))
            .or_else(|| item.get("model"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(id) = id {
            if seen.insert(id.to_string()) {
                out.push(id.to_string());
            }
        }
    }
    if out.is_empty() {
        return Err("The model list was empty, or its entries had no `id`/`name`.".to_string());
    }
    Ok(out)
}

/// Model names from a CLI's listing output, one per line.
///
/// Two shapes are common. Table output (`ollama list`) puts the name in the
/// first column under an uppercase header row; prose output (`llm models`)
/// writes `Provider: model-id (aliases: ...)`. So a line containing `": "` is
/// read after that separator, otherwise from its start, and a first token of
/// bare uppercase letters is taken to be a header. Names keep their own colons
/// — `llama3:latest` has one and is not a separator.
pub fn parse_models_cli_output(stdout: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let candidate_region = match line.find(": ") {
            Some(i) => &line[i + 2..],
            None => line,
        };
        let Some(token) = candidate_region.split_whitespace().next() else {
            continue;
        };
        let is_header = token.len() > 1
            && token.chars().all(|c| c.is_ascii_uppercase() || c == '_');
        if is_header {
            continue;
        }
        if seen.insert(token.to_string()) {
            out.push(token.to_string());
        }
    }
    out
}

/// Ask an HTTP provider which models it offers.
///
/// Sends the same credential the generation call would, so a wrong key fails
/// here — in Settings, with the provider named — rather than on the first query.
pub async fn list_models_http(
    kind: crate::ai_providers::ProviderKind,
    endpoint: &str,
    api_key: &str,
    provider_name: &str,
) -> Result<Vec<String>, String> {
    use crate::ai_providers::ProviderKind;
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = reqwest::Client::new();
    let mut request = client.get(endpoint);
    if !api_key.trim().is_empty() {
        request = match kind {
            ProviderKind::AnthropicCompatible => request
                .header("x-api-key", api_key)
                .header("anthropic-version", ANTHROPIC_VERSION),
            _ => request.header("authorization", format!("Bearer {}", api_key)),
        };
    } else if kind == ProviderKind::AnthropicCompatible {
        request = request.header("anthropic-version", ANTHROPIC_VERSION);
    }
    // One budget for the whole exchange. Wrapping only `send()` left the body
    // read unbounded, so an endpoint that returned headers and then stalled held
    // the picker in "loading" indefinitely and abandoned requests piled up.
    let fetch = async {
        let resp = request
            .send()
            .await
            .map_err(|e| format!("Failed to reach {}: {}", provider_name, e))?;
        let status = resp.status();
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Invalid response from {}: {}", provider_name, e))?;
        Ok::<(reqwest::StatusCode, serde_json::Value), String>((status, json))
    };
    let (status, json) = tokio::time::timeout(Duration::from_secs(20), fetch)
        .await
        .map_err(|_| format!("{} did not answer within 20s.", provider_name))??;
    if !status.is_success() {
        return Err(format!(
            "{} error ({}): {}",
            provider_name,
            status.as_u16(),
            api_error_message(&json)
        ));
    }
    parse_models_json(&json)
}

/// Run a CLI's model-listing command and parse its output.
///
/// The template is split on whitespace and run as-is: there is no prompt to
/// substitute, and `{model}` makes no sense in a command that produces the list.
pub async fn list_models_cli(models_command: &str) -> Result<Vec<String>, String> {
    let tokens = split_command_line(models_command)?;
    let Some((program, args)) = tokens.split_first() else {
        return Err("No model-listing command is set for this provider.".to_string());
    };
    let run = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        // Tokio does not kill a child when the future is dropped; without this a
        // timed-out command keeps running after the UI has given up on it.
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(30), run)
        .await
        .map_err(|_| format!("'{}' did not finish within 30s.", program))?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("'{}' not found on PATH. Install it or fix the command in Settings.", program)
            } else {
                format!("Failed to run '{}': {}", program, e)
            }
        })?;
    if !output.status.success() {
        return Err(format!(
            "'{}' failed: {}",
            program,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let models = parse_models_cli_output(&String::from_utf8_lossy(&output.stdout));
    if models.is_empty() {
        return Err(format!("'{}' printed nothing that looks like a model name.", program));
    }
    Ok(models)
}

/// Endpoint for a Gemini model.
///
/// Deliberately carries no credential. The key used to travel here as a `?key=`
/// query parameter, which HTTPS encrypts on the wire but which leaks everywhere a
/// URL is recorded in cleartext: local logs, crash reports, proxy access logs and
/// the `Failed to reach Gemini API: <url>` text of a transport error. It is sent
/// as a header instead, matching how the other two providers in this file are
/// already authenticated (`authorization: Bearer` for OpenAI, `x-api-key` for
/// Anthropic).
pub fn gemini_url(model: &str) -> String {
    format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    )
}

pub fn build_gemini_request(
    system: &str,
    history: &[ChatTurn],
    user_prompt: &str,
) -> serde_json::Value {
    let mut contents: Vec<serde_json::Value> = history
        .iter()
        .map(|t| {
            serde_json::json!({
                "role": normalized_role(&t.role, "model", "user"),
                "parts": [{ "text": t.content }],
            })
        })
        .collect();
    contents.push(serde_json::json!({ "role": "user", "parts": [{ "text": user_prompt }] }));
    serde_json::json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": contents,
    })
}

pub fn extract_gemini_text(resp: &serde_json::Value) -> String {
    resp.get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

pub async fn generate_gemini(
    api_key: &str,
    model: &str,
    system: &str,
    history: &[ChatTurn],
    user_prompt: &str,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("No Google Gemini API key set. Add one in Settings.".to_string());
    }
    let body = build_gemini_request(system, history, user_prompt);
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = reqwest::Client::new();
    let resp = client
        .post(gemini_url(model))
        .header("x-goog-api-key", api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to reach Gemini API: {}", e))?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response from Gemini API: {}", e))?;
    if !status.is_success() {
        let message = json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("request failed");
        return Err(format!("Gemini API error ({}): {}", status.as_u16(), message));
    }
    extract_json_object(&extract_gemini_text(&json))
}

/// Parse a command template into (program, args), substituting the literal `{prompt}`
/// token with the prompt as a single argv element. No shell is invoked, so prompt
/// contents (spaces, quotes, ;, $(), etc.) cannot inject additional commands.
/// If the template has no `{prompt}` token, the prompt is appended as the final arg.
/// Split a command line the way a shell would *tokenise* it — and nothing more.
///
/// `split_whitespace` kept the quote characters and broke a quoted path into
/// pieces, so `python3 "/Users/me/My Scripts/models.py"` reached Python as two
/// malformed arguments. This honours single quotes, double quotes and — off
/// Windows — backslash escapes, and deliberately does not expand variables,
/// globs, substitutions or `~`: the command is still executed directly, never
/// through a shell, so nothing here can introduce shell injection.
pub fn split_command_line(line: &str) -> Result<Vec<String>, String> {
    split_command_line_for(line, cfg!(windows))
}

/// `split_command_line`, with the platform stated rather than compiled in, so
/// both rules can be tested from either platform.
///
/// On Windows a backslash is a path separator, not an escape: `C:\tools\ollama.exe
/// list` was becoming the program `C:toolsollama.exe`, because each backslash ate
/// the character after it. Quotes still group, which is what a path with spaces
/// needs, and dropping the escape also keeps `"C:\Program Files\Ollama\"` intact
/// instead of reading its trailing separator as an escaped quote. Nothing is lost:
/// a Windows filename cannot contain a quote, so there is no quote left to escape.
pub fn split_command_line_for(line: &str, windows: bool) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut has_token = false;
    let mut chars = line.chars().peekable();
    // None outside quotes, else the quote character we are inside.
    let mut quote: Option<char> = None;

    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            // A backslash is literal inside single quotes, as in a shell.
            (Some('\''), _) => cur.push(c),
            (Some('"'), '\\') if windows => cur.push(c),
            (Some('"'), '\\') => match chars.next() {
                // Only these are special inside double quotes; anything else
                // keeps its backslash, again matching shell behaviour.
                Some(n @ ('"' | '\\')) => cur.push(n),
                Some(n) => {
                    cur.push('\\');
                    cur.push(n);
                }
                None => return Err("Command ends with a dangling backslash.".to_string()),
            },
            (Some(_), _) => cur.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                has_token = true;
            }
            (None, '\\') if windows => {
                cur.push(c);
                has_token = true;
            }
            (None, '\\') => match chars.next() {
                Some(n) => {
                    cur.push(n);
                    has_token = true;
                }
                None => return Err("Command ends with a dangling backslash.".to_string()),
            },
            (None, c) if c.is_whitespace() => {
                if has_token {
                    out.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            (None, c) => {
                cur.push(c);
                has_token = true;
            }
        }
    }
    if quote.is_some() {
        return Err("Command has an unclosed quote.".to_string());
    }
    if has_token {
        out.push(cur);
    }
    Ok(out)
}

pub fn parse_command_template(
    template: &str,
    prompt: &str,
    model: &str,
) -> Result<(String, Vec<String>), String> {
    let tokens = split_command_line(template)?;
    if tokens.is_empty() {
        return Err("Command template is empty".to_string());
    }
    if template.contains("{model}") && model.trim().is_empty() {
        return Err("The command uses {model} but no model is set.".to_string());
    }
    let program = tokens[0].to_string();
    let mut args: Vec<String> = Vec::new();
    let mut substituted = false;
    // Placeholders are replaced *within* each token, so `--prompt={prompt}` and
    // `--model={model}` work as well as bare `{prompt}`. Each token stays one
    // argument, so a prompt with spaces is never split by the shell.
    for tok in &tokens[1..] {
        // `{model}` is substituted in the *template's* text only. The prompt is
        // user content and may itself contain the literal `{model}`; splitting on
        // `{prompt}` first and substituting in the pieces keeps it untouched.
        let pieces: Vec<String> = tok
            .split("{prompt}")
            .map(|piece| piece.replace("{model}", model.trim()))
            .collect();
        if pieces.len() > 1 {
            substituted = true;
        }
        args.push(pieces.join(prompt));
    }
    if !substituted {
        args.push(prompt.to_string());
    }
    Ok((program, args))
}

/// Run a local agent CLI with the given prompt and extract the {filter, sort} JSON
/// from its stdout. Uses the agent's own local auth; no API key involved.
pub async fn generate_local(template: &str, prompt: &str, model: &str) -> Result<String, String> {
    let (program, args) = parse_command_template(template, prompt, model)?;

    let run = tokio::process::Command::new(&program)
        .args(&args)
        .stdin(std::process::Stdio::null())
        // Tokio does not kill a child when the future is dropped; without this a
        // timed-out command keeps running after the UI has given up on it.
        .kill_on_drop(true)
        .output();

    // Local coding agents (claude-code, codex, …) can take a while to start up
    // and respond — allow a generous window before giving up.
    let output = tokio::time::timeout(Duration::from_secs(180), run)
        .await
        .map_err(|_| "Local agent timed out after 180s".to_string())?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("'{}' not found on PATH. Install it or fix the command in Settings.", program)
            } else {
                format!("Failed to run '{}': {}", program, e)
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Local agent '{}' failed: {}",
            program,
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_json_object(&stdout)
}

pub async fn generate_anthropic(
    api_key: &str,
    model: &str,
    system: &str,
    history: &[ChatTurn],
    user_prompt: &str,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("No Anthropic API key set. Add one in Settings to use the query assistant.".to_string());
    }
    let body = build_query_gen_request(model, system, history, user_prompt);
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = reqwest::Client::new();
    let resp = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to reach Anthropic API: {}", e))?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response from Anthropic API: {}", e))?;
    if !status.is_success() {
        let message = json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("request failed");
        return Err(format!("Anthropic API error ({}): {}", status.as_u16(), message));
    }
    extract_mql_from_response(&json)
}

