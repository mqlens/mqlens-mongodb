// Natural-language → MongoDB query generation via the Anthropic Messages API.
// The app's backend holds the API key (kept out of the frontend bundle) and calls
// https://api.anthropic.com/v1/messages over HTTPS (no official Rust SDK).

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

pub const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// One prior turn of the chat conversation, threaded into the request for context.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ChatTurn {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

/// What the assistant hands back for one request.
///
/// `query` is the compact JSON object the panel inserts, exactly as before.
/// The other two exist because the model's reasoning used to be discarded
/// twice — once by a prompt that forbade any prose, once by
/// `extract_json_object` throwing away everything around the JSON.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AiReply {
    pub query: String,
    /// Provider-native reasoning, when the model emits it: DeepSeek's and
    /// o-series' `reasoning_content`, Anthropic `thinking` blocks, Gemini
    /// `thought` parts. `None` for models that do not think out loud.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thoughts: Option<String>,
    /// The model's own working notes written around the JSON, for every
    /// provider — local CLIs included, which have no reasoning channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// What a local agent ran on the way to the answer. Empty for HTTP providers,
    /// which are asked for one completion and call nothing.
    #[serde(rename = "toolCalls", default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<AgentToolCall>,
}

/// One tool an agent ran while answering, for the panel to show.
///
/// Local coding agents do real work before they reply — reading a file, running a
/// query — and until now that arrived as undifferentiated prose in `notes`. This
/// is the same activity, kept structured.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCall {
    pub name: String,
    /// The arguments, as compact JSON. Clipped: a tool input can be a whole file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    /// What the tool returned. Clipped for the same reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub failed: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// What an agent's event stream amounted to: its answer, and what it ran to get there.
#[derive(Debug, PartialEq)]
pub struct AgentRun {
    pub text: String,
    pub tool_calls: Vec<AgentToolCall>,
}

/// How much of an agent's output is read at all.
///
/// `MAX_EVENTS`, `MAX_TOOL_CALLS` and `MAX_TOOL_TEXT` bound the *transcript*;
/// none of them bounds memory, because `Command::output()` has already buffered
/// the whole of stdout before any of them is consulted. A structured run whose
/// tool returned a 1 MB document per call, or read a large file, could exhaust
/// the app before parsing began. Generous — a long agent turn is nowhere near
/// this — and the excess is reported rather than silently dropped.
const MAX_AGENT_STDOUT: usize = 8 * 1024 * 1024;
/// Enough for a stack trace and a message; stderr is drained mainly so a chatty
/// child does not block on a full pipe while stdout is being read.
const MAX_AGENT_STDERR: usize = 256 * 1024;

/// Kept small on purpose: this is a transcript entry, not a log. A tool can
/// return a whole file, and the panel has to stay readable.
const MAX_TOOL_CALLS: usize = 50;
const MAX_TOOL_TEXT: usize = 2000;
/// Far above any real turn, so it only ever catches a runaway stream.
const MAX_EVENTS: usize = 10_000;

/// `text` clipped to `max` characters, on a character boundary.
fn clip(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    match trimmed.char_indices().nth(max) {
        None => trimmed.to_string(),
        Some((end, _)) => format!("{}…", &trimmed[..end]),
    }
}

/// Parse a local agent's structured event stream into its answer and tool calls.
///
/// `None` when the output is not an event stream, which is the ordinary case: no
/// built-in command asks for one, so this only sees events when the user has put
/// the flags in the command themselves. The caller then treats the output as text
/// exactly as before, so nothing that works today stops working.
///
/// The shape handled here is Claude Code's `--output-format stream-json`, checked
/// against a real run rather than assumed — see the fixture in `tests/fixtures`.
/// Codex and cursor-agent have structured modes too, but with different envelopes
/// that are not implemented until they can be verified the same way.
pub fn parse_agent_events(stdout: &str) -> Option<AgentRun> {
    // Streamed rather than collected: a long agent run emits megabytes, and
    // holding every parsed event as well as the string they came from doubles
    // that for no gain — each is read once and thrown away. `MAX_TOOL_CALLS`
    // bounds what is *kept*; this bounds what is *parsed*.
    let mut parsed_events = 0usize;
    let mut calls: Vec<AgentToolCall> = Vec::new();
    // Where each `tool_use_id` landed, so its result can be attached later.
    let mut by_id: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut assistant_text = String::new();
    let mut final_text: Option<String> = None;
    let mut saw_known = false;

    for line in stdout.lines().map(str::trim) {
        if parsed_events >= MAX_EVENTS {
            break;
        }
        if !line.starts_with('{') {
            continue;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(kind) = event.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        parsed_events += 1;
        let event = &event;
        match kind {
            "assistant" | "user" => {
                saw_known = true;
                let blocks = event
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                let Some(blocks) = blocks else { continue };
                for block in blocks {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("tool_use") => {
                            if calls.len() >= MAX_TOOL_CALLS {
                                continue;
                            }
                            let name = block
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let input = block
                                .get("input")
                                .map(|i| clip(&i.to_string(), MAX_TOOL_TEXT))
                                .filter(|i| !i.is_empty() && i != "{}");
                            if let Some(id) = block.get("id").and_then(|i| i.as_str()) {
                                by_id.insert(id.to_string(), calls.len());
                            }
                            calls.push(AgentToolCall {
                                name,
                                input,
                                output: None,
                                failed: false,
                            });
                        }
                        Some("tool_result") => {
                            let Some(idx) = block
                                .get("tool_use_id")
                                .and_then(|i| i.as_str())
                                .and_then(|id| by_id.get(id))
                                .copied()
                            else {
                                continue;
                            };
                            let raw = match block.get("content") {
                                Some(serde_json::Value::String(t)) => t.clone(),
                                Some(other) => other.to_string(),
                                None => String::new(),
                            };
                            let call = &mut calls[idx];
                            let clipped = clip(&raw, MAX_TOOL_TEXT);
                            call.output = (!clipped.is_empty()).then_some(clipped);
                            call.failed = block
                                .get("is_error")
                                .and_then(|e| e.as_bool())
                                .unwrap_or(false);
                        }
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                if !assistant_text.is_empty() {
                                    assistant_text.push('\n');
                                }
                                assistant_text.push_str(t);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "result" => {
                saw_known = true;
                // The agent's own summary of the turn, which is the answer when
                // there is one. An errored turn has no answer to take.
                if event.get("subtype").and_then(|s| s.as_str()) == Some("success") {
                    if let Some(t) = event.get("result").and_then(|r| r.as_str()) {
                        final_text = Some(t.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    // One stray JSON line in ordinary prose is not an event stream.
    if !saw_known || parsed_events < 2 {
        return None;
    }
    Some(AgentRun {
        text: final_text.unwrap_or(assistant_text),
        tool_calls: calls,
    })
}

/// An image pasted into the chat, sent with the request and never stored.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ImageAttachment {
    /// `image/png`, `image/jpeg`, `image/webp` or `image/gif`.
    pub media_type: String,
    /// Base64 without a `data:` prefix.
    pub data: String,
}

pub const MAX_IMAGES: usize = 4;
/// Decoded size cap per image. Providers cap around here too, and a larger
/// paste is almost always a whole-screen capture rather than the detail meant.
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// Reject attachments a provider would reject anyway, with a better message.
pub fn validate_images(images: &[ImageAttachment]) -> Result<(), String> {
    if images.len() > MAX_IMAGES {
        return Err(format!("At most {MAX_IMAGES} images per message."));
    }
    for (i, img) in images.iter().enumerate() {
        if !ALLOWED_IMAGE_TYPES.contains(&img.media_type.as_str()) {
            return Err(format!(
                "Image {} is {}; only PNG, JPEG, WebP and GIF are accepted.",
                i + 1,
                img.media_type
            ));
        }
        // 4 base64 chars encode 3 bytes; padding makes this a slight overestimate,
        // which is the safe direction.
        let decoded = img.data.trim_end_matches('=').len() * 3 / 4;
        if decoded > MAX_IMAGE_BYTES {
            return Err(format!(
                "Image {} is about {} MB; the limit is {} MB.",
                i + 1,
                decoded / (1024 * 1024),
                MAX_IMAGE_BYTES / (1024 * 1024)
            ));
        }
        if img.data.trim().is_empty() {
            return Err(format!("Image {} has no data.", i + 1));
        }
        // Decoded here, not just measured: this function exists so a file the
        // provider would reject is refused with a message that says why, and a
        // truncated or corrupted payload otherwise reached the provider and came
        // back as an opaque transport error. The size cap above bounds the work.
        if base64::engine::general_purpose::STANDARD
            .decode(img.data.trim())
            .is_err()
        {
            return Err(format!(
                "Image {} could not be read; try attaching it again.",
                i + 1
            ));
        }
    }
    Ok(())
}

/// A user turn's content in OpenAI's format: plain text alone, or a parts array
/// once images are attached. Text first, then images, in paste order.
pub fn openai_user_content(prompt: &str, images: &[ImageAttachment]) -> serde_json::Value {
    if images.is_empty() {
        return serde_json::Value::String(prompt.to_string());
    }
    let mut parts = vec![serde_json::json!({ "type": "text", "text": prompt })];
    for img in images {
        parts.push(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", img.media_type, img.data) }
        }));
    }
    serde_json::Value::Array(parts)
}

/// Anthropic's format. Images precede the text, which is the ordering the
/// documentation uses for "look at this and then answer".
pub fn anthropic_user_content(prompt: &str, images: &[ImageAttachment]) -> serde_json::Value {
    if images.is_empty() {
        return serde_json::Value::String(prompt.to_string());
    }
    let mut parts: Vec<serde_json::Value> = images
        .iter()
        .map(|img| {
            serde_json::json!({
                "type": "image",
                "source": { "type": "base64", "media_type": img.media_type, "data": img.data }
            })
        })
        .collect();
    parts.push(serde_json::json!({ "type": "text", "text": prompt }));
    serde_json::Value::Array(parts)
}

/// Gemini's `parts` for a user turn.
pub fn gemini_user_parts(prompt: &str, images: &[ImageAttachment]) -> Vec<serde_json::Value> {
    let mut parts: Vec<serde_json::Value> = images
        .iter()
        .map(|img| serde_json::json!({ "inline_data": { "mime_type": img.media_type, "data": img.data } }))
        .collect();
    parts.push(serde_json::json!({ "text": prompt }));
    parts
}

/// Reasoning an OpenAI-format response carries alongside its answer.
///
/// DeepSeek documents `message.reasoning_content`; some gateways relay it as
/// `message.reasoning`. Both are read, neither is required.
pub fn extract_openai_reasoning(resp: &serde_json::Value) -> Option<String> {
    let msg = resp.get("choices")?.as_array()?.first()?.get("message")?;
    let text = msg
        .get("reasoning_content")
        .or_else(|| msg.get("reasoning"))?
        .as_str()?
        .trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// `thinking` blocks from an Anthropic response, joined.
///
/// Opportunistic: this request does **not** ask for extended thinking, so a
/// stock Anthropic reply carries no `thinking` blocks and this returns `None`.
/// It reads them when they are there — a gateway or proxy configured to enable
/// thinking upstream — and the collapsible in the panel is populated from
/// `notes` (the model's prose before the JSON) for every provider regardless.
/// Enabling thinking here would mean sending a `thinking` field to arbitrary
/// Anthropic-*compatible* endpoints, which is a change to make deliberately and
/// against the current API contract, not as a side effect of adding a parser.
pub fn extract_anthropic_thinking(resp: &serde_json::Value) -> Option<String> {
    let joined = resp
        .get("content")?
        .as_array()?
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("thinking"))
        .filter_map(|b| b.get("thinking").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    (!joined.trim().is_empty()).then(|| joined.trim().to_string())
}

/// Parts a Gemini response flags with `thought: true`, joined.
///
/// Opportunistic, for the same reason as `extract_anthropic_thinking`: this
/// request does not enable thought summaries, so a stock reply carries no
/// `thought` parts. The panel's collapsible is fed by `notes` in that case.
pub fn extract_gemini_thoughts(resp: &serde_json::Value) -> Option<String> {
    let parts = resp
        .get("candidates")?
        .as_array()?
        .first()?
        .get("content")?
        .get("parts")?
        .as_array()?;
    let joined = parts
        .iter()
        .filter(|p| p.get("thought").and_then(|t| t.as_bool()) == Some(true))
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    (!joined.trim().is_empty()).then(|| joined.trim().to_string())
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
- You may write a few short lines of working notes first — what you looked at, why find vs aggregate. Then finish with exactly one JSON object and nothing after it. No markdown code fences around the JSON.\n\
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
- You may write a few short lines of working notes first — what you looked at, why find vs aggregate. Then finish with exactly one JSON object and nothing after it. No markdown code fences around the JSON.\n\
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
    images: &[ImageAttachment],
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
    messages.push(serde_json::json!({ "role": "user", "content": anthropic_user_content(user_prompt, images) }));
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
    split_json_object(text).map(|(json, _)| json)
}

/// `{` followed by a quoted key — a real object rather than a brace in prose,
/// whose keys are bare (`{ age: {$gt: 30} }`, `use { for grouping`).
fn opens_like_json(text: &str) -> bool {
    let mut chars = text.chars();
    if chars.next() != Some('{') {
        return false;
    }
    matches!(chars.find(|c| !c.is_whitespace()), Some('"'))
}

/// Separate the model's answer from what it wrote around it.
///
/// Returns the compact JSON object and, if any, the surrounding prose as notes.
/// Where the old extractor took the FIRST `{`, this takes the LAST balanced
/// object that parses: the prompt asks for notes *before* the JSON, and notes
/// about a query naturally contain braces — `{ age: {$gt: 30} }` is not valid
/// JSON and must not be mistaken for the answer. Fences are stripped from the
/// notes so a model that ignores the no-fences rule still reads cleanly.
pub fn split_json_object(text: &str) -> Result<(String, Option<String>), String> {
    let bytes = text.as_bytes();
    let mut best: Option<(usize, usize, String)> = None;
    // Set when a balanced candidate after `best` failed to parse. That candidate
    // sits where the answer is supposed to be, so `best` is no longer safely the
    // answer — see the rejection below.
    let mut malformed_after_best = false;
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find('{') {
        let start = search_from + rel;
        // Match braces from `start`, skipping string contents. Structural
        // chars are ASCII, so byte scanning is UTF-8 safe.
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
        let Some(end) = end else {
            // An unbalanced `{` never closes, so everything after it sits inside
            // an object with no end. When it opens like JSON — a quoted key —
            // that is a truncated answer, and the objects nested in it are parts
            // of it: returning one hands the panel a fragment of the reply, which
            // is how `{"filter":{"tenant":"acme"}` became the query
            // `{"tenant":"acme"}`. A brace in prose has no quoted key, so it is
            // still just stepped over.
            if opens_like_json(&text[start..]) {
                return Err("Model response contains an unterminated JSON object".to_string());
            }
            search_from = start + 1;
            continue;
        };
        let candidate = &text[start..=end];
        match serde_json::from_str::<serde_json::Value>(candidate) {
            Ok(parsed) if parsed.is_object() => {
                let compact = serde_json::to_string(&parsed).map_err(|e| e.to_string())?;
                best = Some((start, end, compact));
                malformed_after_best = false;
            }
            // Balanced but invalid — prose like `{ age: {$gt: 30} }`, or an
            // answer with a trailing comma — is skipped as a *whole*. Stepping
            // inside it would find its nested `{}` and hand that back as the
            // reply, which the panel turns into a match-all query.
            _ => malformed_after_best = true,
        }
        search_from = end + 1;
    }
    let Some((start, end, json)) = best else {
        return Err(if text.contains('{') {
            "Model response contained no valid JSON object".to_string()
        } else {
            "Model response contained no JSON object".to_string()
        });
    };
    // The answer is the last balanced object, so a malformed one after `best`
    // means the answer itself is broken and `best` is something the model wrote
    // *about* the query. Returning it would hand the panel a filter the user
    // never asked for, indistinguishable from a real one — so refuse the reply
    // rather than guess which object was meant. The cost is that brace-bearing
    // prose written *after* the JSON is rejected too; the prompts ask for notes
    // first for exactly this reason, and a loud error beats a silent wrong query.
    if malformed_after_best {
        return Err("Model response ended with a malformed JSON object".to_string());
    }
    let notes = format!("{}\n\n{}", text[..start].trim(), text[end + 1..].trim());
    let notes = strip_fences(&notes);
    let notes = notes.trim();
    Ok((json, (!notes.is_empty()).then(|| notes.to_string())))
}

/// Remove ``` fence lines, keeping whatever was inside them.
fn strip_fences(text: &str) -> String {
    text.lines()
        .filter(|l| !l.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n")
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
    images: &[ImageAttachment],
) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];
    for t in history {
        messages.push(serde_json::json!({
            "role": normalized_role(&t.role, "assistant", "user"),
            "content": t.content,
        }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": openai_user_content(user_prompt, images) }));
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

/// Whether `url` is a loopback address — a local server, whose traffic cannot
/// leave the machine, which is why `http://` is legitimate for one.
fn is_loopback_url(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some(h) => {
            let h = h
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_ascii_lowercase();
            h == "localhost"
                || h.ends_with(".localhost")
                || h.parse::<std::net::IpAddr>()
                    .map(|ip| ip.is_loopback())
                    .unwrap_or(false)
        }
        None => false,
    }
}

/// Whether a redirect from `original` to `target` may be followed *with the
/// request's headers still on it*.
///
/// Two rules, and both are needed. The host must not change: `x-api-key` and
/// `x-goog-api-key` are ordinary headers, so unlike `authorization` reqwest keeps
/// them across origins, and an `https → https` hop to another host would hand the
/// credential to whoever that host is. And the target must be TLS or loopback, so
/// a same-host downgrade cannot put it on the wire in clear text.
///
/// The port must match too. A different port on the same host is a different
/// origin and, on loopback especially, a different program — Ollama on 11434 and
/// something else on 1234 are not the same service, and neither is
/// `api.example:443` and `api.example:8443`.
///
/// The one exception is a plain scheme upgrade, `http` on its default port to
/// `https` on its default port: the port changes only because the scheme did, and
/// the result is strictly better than the request that was made.
pub(crate) fn redirect_is_safe(target: &reqwest::Url, original: &reqwest::Url) -> bool {
    if target.host_str().is_none() || target.host_str() != original.host_str() {
        return false;
    }
    let same_port = target.port_or_known_default() == original.port_or_known_default();
    let default_port_upgrade = original.scheme() == "http"
        && target.scheme() == "https"
        && original.port().is_none()
        && target.port().is_none();
    if !same_port && !default_port_upgrade {
        return false;
    }
    target.scheme() == "https" || is_loopback_url(target)
}

/// The one HTTP client for every provider request, with redirects constrained.
///
/// reqwest's default follows up to ten redirects, and `check_transport` had only
/// judged the URL the user typed — so an `https://` endpoint answering `302` to an
/// `http://` location got the key sent again over that hop. `x-api-key` is an
/// ordinary header, so unlike `authorization` reqwest does not strip it across
/// origins, and automatic model loading meant no further user action was needed
/// for this to happen.
///
/// A redirect is followed only to the same host, and only over `https://` or to a
/// loopback address; see `redirect_is_safe`. Anything else stops the chain, which
/// surfaces as a request error rather than a silent cleartext hop.
fn http_client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let policy = reqwest::redirect::Policy::custom(|attempt| {
                // `previous()` starts at the URL the request was made to, which is
                // what "the same host" has to mean — comparing against the previous
                // hop would let a chain walk to another host one redirect at a time.
                let Some(original) = attempt.previous().first() else {
                    return attempt.stop();
                };
                if attempt.previous().len() >= 5 || !redirect_is_safe(attempt.url(), original) {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            });
            // No fallback client: `Client::new()` would restore reqwest's
            // follow-anything default, which is the behaviour this exists to
            // prevent, and a build failure here is a TLS/connector failure that
            // would fail every request anyway. Reported, not worked around.
            reqwest::Client::builder()
                .redirect(policy)
                .build()
                .map_err(|e| format!("Could not start an HTTPS client: {e}"))
        })
        .clone()
}

/// The whole budget for one generation exchange — connect, headers and body.
///
/// Generous, because a reasoning model can think for a while; finite, because
/// without it an endpoint that accepted the connection and then stalled left the
/// chat disabled indefinitely, with no way out but restarting the app.
const GENERATION_TIMEOUT: Duration = Duration::from_secs(120);

/// Send `request` and read its JSON body under a single deadline.
///
/// One budget for the pair rather than one per step: wrapping only `send()`
/// leaves the body read unbounded, and headers-then-silence is the stall that
/// actually happens.
pub(crate) async fn send_json_within(
    request: reqwest::RequestBuilder,
    label: &str,
    budget: Duration,
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    let exchange = async {
        let resp = request
            .send()
            .await
            .map_err(|e| format!("Failed to reach {}: {}", label, e))?;
        let status = resp.status();
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Invalid response from {}: {}", label, e))?;
        Ok::<(reqwest::StatusCode, serde_json::Value), String>((status, json))
    };
    tokio::time::timeout(budget, exchange)
        .await
        .map_err(|_| format!("{} did not answer within {}s.", label, budget.as_secs()))?
}

pub async fn generate_openai(
    api_key: &str,
    model: &str,
    system: &str,
    history: &[ChatTurn],
    user_prompt: &str,
    images: &[ImageAttachment],
) -> Result<AiReply, String> {
    if api_key.trim().is_empty() {
        return Err("No OpenAI API key set. Add one in Settings.".to_string());
    }
    let body = build_openai_request(model, system, history, user_prompt, images);
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = http_client()?;
    let (status, json) = send_json_within(
        client
            .post(OPENAI_URL)
            .header("authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json")
            .json(&body),
        "OpenAI API",
        GENERATION_TIMEOUT,
    )
    .await?;
    if !status.is_success() {
        let message = json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("request failed");
        return Err(format!("OpenAI API error ({}): {}", status.as_u16(), message));
    }
    openai_reply(&json)
}

/// Build the reply from an OpenAI-format response body.
fn openai_reply(json: &serde_json::Value) -> Result<AiReply, String> {
    let (query, notes) = split_json_object(&extract_openai_text(json))?;
    Ok(AiReply { query, thoughts: extract_openai_reasoning(json), notes , tool_calls: Vec::new() })
}

/// Build the reply from an Anthropic-format response body.
fn anthropic_reply(json: &serde_json::Value) -> Result<AiReply, String> {
    let (query, notes) = split_json_object(&response_text(json))?;
    Ok(AiReply { query, thoughts: extract_anthropic_thinking(json), notes , tool_calls: Vec::new() })
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
    images: &[ImageAttachment],
) -> Result<AiReply, String> {
    let body = build_openai_request(model, system, history, user_prompt, images);
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = http_client()?;
    let mut request = client
        .post(endpoint)
        .header("content-type", "application/json");
    if !api_key.is_empty() {
        request = request.header("authorization", format!("Bearer {}", api_key));
    }
    let (status, json) =
        send_json_within(request.json(&body), provider_name, GENERATION_TIMEOUT).await?;
    if !status.is_success() {
        return Err(format!(
            "{} error ({}): {}",
            provider_name,
            status.as_u16(),
            api_error_message(&json)
        ));
    }
    openai_reply(&json)
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
    images: &[ImageAttachment],
) -> Result<AiReply, String> {
    let body = build_query_gen_request(model, system, history, user_prompt, images);
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = http_client()?;
    let mut request = client
        .post(endpoint)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json");
    if !api_key.is_empty() {
        request = request.header("x-api-key", api_key);
    }
    let (status, json) =
        send_json_within(request.json(&body), provider_name, GENERATION_TIMEOUT).await?;
    if !status.is_success() {
        return Err(format!(
            "{} error ({}): {}",
            provider_name,
            status.as_u16(),
            api_error_message(&json)
        ));
    }
    anthropic_reply(&json)
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
    let client = http_client()?;
    let mut request = client.get(endpoint);
    if !api_key.is_empty() {
        request = match kind {
            ProviderKind::AnthropicCompatible => request
                .header("x-api-key", api_key)
                .header("anthropic-version", ANTHROPIC_VERSION),
            _ => request.header("authorization", format!("Bearer {}", api_key)),
        };
    } else if kind == ProviderKind::AnthropicCompatible {
        request = request.header("anthropic-version", ANTHROPIC_VERSION);
    }
    // Listing is a metadata call behind a picker, so it gets a much shorter
    // budget than generation.
    let (status, json) =
        send_json_within(request, provider_name, Duration::from_secs(20)).await?;
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
    images: &[ImageAttachment],
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
    contents.push(serde_json::json!({ "role": "user", "parts": gemini_user_parts(user_prompt, images) }));
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
                // Parts flagged `thought` are the model's reasoning, returned
                // separately by `extract_gemini_thoughts`. Including them here
                // put the same text in `notes` as well, so the panel showed
                // Gemini's reasoning twice.
                .filter(|p| p.get("thought").and_then(|t| t.as_bool()) != Some(true))
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
    images: &[ImageAttachment],
) -> Result<AiReply, String> {
    if api_key.trim().is_empty() {
        return Err("No Google Gemini API key set. Add one in Settings.".to_string());
    }
    let body = build_gemini_request(system, history, user_prompt, images);
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = http_client()?;
    let (status, json) = send_json_within(
        client
            .post(gemini_url(model))
            .header("x-goog-api-key", api_key)
            .header("content-type", "application/json")
            .json(&body),
        "Gemini API",
        GENERATION_TIMEOUT,
    )
    .await?;
    if !status.is_success() {
        let message = json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("request failed");
        return Err(format!("Gemini API error ({}): {}", status.as_u16(), message));
    }
    let (query, notes) = split_json_object(&extract_gemini_text(&json))?;
    Ok(AiReply { query, thoughts: extract_gemini_thoughts(&json), notes , tool_calls: Vec::new() })
}

/// What to tell a local agent about MQLens's own tools.
///
/// An agent that does not know the tools exist writes a query from the field list
/// alone and cannot say why it might be wrong; one that does not know they are
/// *missing* can imply it checked. Both states are stated outright so the answer
/// says which it was.
/// What can honestly be said about the agent's reach to MQLens's own tools.
///
/// Three states, not two. "The server is off" and "I did not hand this command a
/// config" are different facts: a user who followed the `claude mcp add` flow in
/// Settings has an agent that reaches `mqlens` without `{mcp_config}`, and telling
/// it the server is switched off would talk it out of an inspection it could
/// actually do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpReach {
    /// The server is not running. Nothing can reach it.
    Off,
    /// This command was handed a config, so the tools are there.
    Injected,
    /// The server is up, but whether *this* agent can see it is unknown.
    Unknown,
}

pub fn mcp_availability_note(
    reach: McpReach,
    connection: Option<&str>,
    connection_id: Option<&str>,
    database: Option<&str>,
    collection: &str,
) -> String {
    // Named outright. Told to inspect but not *where*, an agent picks a namespace
    // itself, and two connections can hold collections of the same name — so the
    // query comes back looking right and built from another environment's data.
    // The id, not just the name: two profiles may share a display name, and the
    // tools take an id anyway — so naming it removes the guess entirely rather
    // than asking the agent to resolve a label that may match two connections.
    let identified = match connection_id {
        Some(id) if !id.is_empty() => format!(" Its connection_id is `{id}` — pass that."),
        _ => String::new(),
    };
    let namespace = match (connection, database) {
        (Some(c), Some(d)) if !c.is_empty() && !d.is_empty() => format!(
            "\n\nThe question is about `{d}.{collection}` on the connection named \
             `{c}`, which is the one open in front of the user.{identified} Use exactly \
             that namespace; do not pick another connection or database, and if the \
             tools show more than one candidate, say so rather than guessing."
        ),
        (_, Some(d)) if !d.is_empty() => format!(
            "\n\nThe question is about `{d}.{collection}`.{identified} Use exactly that \
             namespace."
        ),
        _ => String::new(),
    };
    let body = match reach {
        McpReach::Injected =>
        "\n\nMQLens's own tools are available to you over MCP as the `mqlens` server: \
         list_connections, list_profiles, connect, list_databases, list_collections, \
         schema_analysis, list_indexes, find, aggregate and explain. Use them before \
         writing the query — the field list above is a summary of names, not observed \
         data, so check the real types, indexes and actual values with schema_analysis \
         and a small find rather than guessing at enum values or formats.",
        McpReach::Unknown =>
            "\n\nMQLens may be available to you as the `mqlens` MCP server, if you have \
             it configured — this request did not hand you a configuration, so it \
             cannot tell. Check whether those tools are there; if they are, use \
             schema_analysis and a small find to confirm the real types and values \
             before writing the query, and if they are not, say in your notes which \
             parts you could not verify.",
        McpReach::Off =>
        "\n\nMQLens's MCP server is switched off, so you cannot sample the collection: \
         you have the field names above and nothing else. Write the query from them, and \
         say plainly in your notes which parts you could not verify — an enum value or a \
         date format you assumed, for instance — so the user knows what to check.",
    };
    // The namespace matters either way: without the tools it still tells the agent
    // which collection the field list belongs to.
    format!("{body}{namespace}")
}

/// Where MQLens's own MCP server is listening, for an agent that can reach it.
///
/// Loopback only: the server binds `127.0.0.1`, and the token is the whole of its
/// authentication, so this never belongs anywhere but on this machine.
///
/// `token` is the *helper* token and `path` the helper path, never the ones an
/// external client uses. That separation is what makes the agent's writes go
/// through the user instead of through a boolean the agent sets itself.
pub struct McpEndpoint {
    pub port: u16,
    pub token: String,
    pub path: String,
}

/// The MCP client config for MQLens's own server.
///
/// The shape is the one `claude mcp add --transport http` writes itself, rather
/// than one inferred from documentation — a config an agent cannot parse fails by
/// silently having no tools, which looks exactly like the problem it was meant to
/// solve.
pub fn mcp_config_json(endpoint: &McpEndpoint) -> String {
    serde_json::json!({
        "mcpServers": {
            "mqlens": {
                "type": "http",
                "url": format!("http://127.0.0.1:{}{}", endpoint.port, endpoint.path),
                "headers": { "Authorization": format!("Bearer {}", endpoint.token) }
            }
        }
    })
    .to_string()
}

/// A temp file holding that config, removed when this drops.
///
/// It contains the bearer token, so on Unix it is created `0600` *before* a byte
/// is written — widening it afterwards would leave a window where any local user
/// could read the token — and it is deleted however the run ends.
///
/// Windows has no equivalent here and inherits the directory's ACLs, which for the
/// per-user temp directory means the owner alone. That is weaker than an explicit
/// mode: a machine whose temp directory has been opened up would expose the token,
/// and this does not defend against that.
pub struct McpConfigFile(std::path::PathBuf);

impl McpConfigFile {
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for McpConfigFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn write_mcp_config(endpoint: &McpEndpoint) -> Result<McpConfigFile, String> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut path = std::env::temp_dir();
    path.push(format!(
        "mqlens-agent-mcp-{}-{}.json",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write as _;
    let mut file = opts
        .open(&path)
        .map_err(|e| format!("create {}: {e}", path.display()))?;
    // Held from here on, so a failure below still removes the file.
    let guard = McpConfigFile(path);
    file.write_all(mcp_config_json(endpoint).as_bytes())
        .map_err(|e| format!("write {}: {e}", guard.0.display()))?;
    Ok(guard)
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
    mcp_config: Option<&str>,
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
            .map(|piece| {
                let piece = piece.replace("{model}", model.trim());
                match mcp_config {
                    Some(path) => piece.replace("{mcp_config}", path),
                    None => piece,
                }
            })
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
pub async fn generate_local(
    template: &str,
    prompt: &str,
    model: &str,
    mcp: Option<&McpEndpoint>,
) -> Result<AiReply, String> {
    // Written only when the command asks for it, so a template that says nothing
    // about MCP never has a token file created for it.
    let config = if template.contains("{mcp_config}") {
        match mcp {
            Some(endpoint) => Some(write_mcp_config(endpoint)?),
            None => {
                return Err(
                    "This command uses {mcp_config}, but MQLens's MCP server is switched off. \
                     Turn it on in Settings, or take {mcp_config} out of the command."
                        .to_string(),
                )
            }
        }
    } else {
        None
    };
    let config_path = config.as_ref().map(|c| c.path().to_string_lossy().to_string());
    let (program, args) = parse_command_template(template, prompt, model, config_path.as_deref())?;

    // Piped and read under a cap rather than collected with `output()`. That
    // buffers the whole of stdout before any limit can be consulted, so a tool
    // returning a megabyte per call could exhaust the app before parsing began —
    // a cap applied afterwards bounds the transcript, not the memory.
    let mut child = tokio::process::Command::new(&program)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Tokio does not kill a child when the future is dropped; without this a
        // timed-out command keeps running after the UI has given up on it.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("'{}' not found on PATH. Install it or fix the command in Settings.", program)
            } else {
                format!("Failed to run '{}': {}", program, e)
            }
        })?;

    let mut stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let mut stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;

    // Both concurrently: a child writing a lot to stderr blocks on a full pipe if
    // only stdout is being drained, and then nothing finishes.
    let gather = async {
        use tokio::io::AsyncReadExt;
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut buf_out = vec![0u8; 64 * 1024];
        let mut buf_err = vec![0u8; 8 * 1024];
        let (mut out_done, mut err_done, mut over_cap) = (false, false, false);

        // Both pipes are drained until each reaches EOF, and the cap is checked as
        // the bytes arrive. Reading them with `try_join!` and killing afterwards
        // did not work: the join waits for *both* to finish, so a child that
        // capped stdout and kept writing blocked on the pipe nobody was draining
        // and the kill was never reached — the run lasted until the 180s timeout
        // and reported a hang instead of a size.
        while !(out_done && err_done) {
            tokio::select! {
                read = stdout_pipe.read(&mut buf_out), if !out_done => {
                    let n = read?;
                    if n == 0 {
                        out_done = true;
                    } else if out.len() + n > MAX_AGENT_STDOUT {
                        over_cap = true;
                        break;
                    } else {
                        out.extend_from_slice(&buf_out[..n]);
                    }
                }
                read = stderr_pipe.read(&mut buf_err), if !err_done => {
                    let n = read?;
                    if n == 0 {
                        err_done = true;
                    } else if err.len() < MAX_AGENT_STDERR {
                        // Kept up to the cap and read past it regardless: a child
                        // blocked on a full stderr pipe never exits either.
                        let room = MAX_AGENT_STDERR - err.len();
                        err.extend_from_slice(&buf_err[..n.min(room)]);
                    }
                }
            }
        }

        if over_cap {
            // Immediately, while it is still blocked on the pipe we stopped reading.
            let _ = child.kill().await;
        }
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, out, err, over_cap))
    };

    // Local coding agents (claude-code, codex, …) can take a while to start up
    // and respond — allow a generous window before giving up.
    let (status, stdout_bytes, stderr_bytes, over_cap) =
        tokio::time::timeout(Duration::from_secs(180), gather)
            .await
            .map_err(|_| "Local agent timed out after 180s".to_string())?
            .map_err(|e| format!("Failed to read from '{}': {}", program, e))?;

    if over_cap {
        // No claim about side effects. The agent may already have completed a write
        // the user approved, and the truncated stream is not evidence either way —
        // saying "nothing was applied" would be an assurance this cannot make. What
        // it *can* report is whatever activity survives in the part that was read.
        let ran = parse_agent_events(&String::from_utf8_lossy(&stdout_bytes))
            .map(|run| {
                run.tool_calls
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|names| !names.is_empty());
        return Err(match ran {
            Some(names) => format!(
                "Local agent '{}' produced more than {} MB of output, past what this \
                 reads, so its answer was not used. It had already run: {}. Check \
                 whether anything was changed. If its tools are returning whole \
                 documents, narrow what it is asked to inspect.",
                program,
                MAX_AGENT_STDOUT / (1024 * 1024),
                names
            ),
            None => format!(
                "Local agent '{}' produced more than {} MB of output, past what this \
                 reads, so its answer was not used. If its tools are returning whole \
                 documents, narrow what it is asked to inspect.",
                program,
                MAX_AGENT_STDOUT / (1024 * 1024)
            ),
        });
    }
    let output = std::process::Output { status, stdout: stdout_bytes, stderr: stderr_bytes };
    let stdout_text = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let failure = format!("Local agent '{}' failed: {}", program, stderr.trim());
        // A run that failed *after* running tools is exactly when the transcript
        // matters: those calls happened, some with side effects, and returning
        // only stderr threw the record of them away. The failure is still an
        // error — it is reported with the activity attached rather than instead
        // of it.
        return match parse_agent_events(&stdout_text) {
            Some(run) if !run.tool_calls.is_empty() => Err(format!(
                "{failure}\n\nIt had already run: {}",
                run.tool_calls
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            _ => Err(failure),
        };
    }
    let stdout = stdout_text;
    // An agent asked for structured output reports what it ran; everything else
    // is prose with a JSON object in it, exactly as before.
    match parse_agent_events(&stdout) {
        Some(run) => {
            let (query, notes) = split_json_object(&run.text)?;
            Ok(AiReply { query, thoughts: None, notes, tool_calls: run.tool_calls })
        }
        None => {
            let (query, notes) = split_json_object(&stdout)?;
            Ok(AiReply { query, thoughts: None, notes, tool_calls: Vec::new() })
        }
    }
}

pub async fn generate_anthropic(
    api_key: &str,
    model: &str,
    system: &str,
    history: &[ChatTurn],
    user_prompt: &str,
    images: &[ImageAttachment],
) -> Result<AiReply, String> {
    if api_key.trim().is_empty() {
        return Err("No Anthropic API key set. Add one in Settings to use the query assistant.".to_string());
    }
    let body = build_query_gen_request(model, system, history, user_prompt, images);
    // Trimmed once, here: a pasted key often carries whitespace, and model
    // loading runs on the uncommitted draft — so the request went out with the
    // raw value and came back 401 while the same provider worked after saving.
    let api_key = api_key.trim();
    let client = http_client()?;
    let (status, json) = send_json_within(
        client
            .post(ANTHROPIC_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body),
        "Anthropic API",
        GENERATION_TIMEOUT,
    )
    .await?;
    if !status.is_success() {
        let message = json
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("request failed");
        return Err(format!("Anthropic API error ({}): {}", status.as_u16(), message));
    }
    anthropic_reply(&json)
}

