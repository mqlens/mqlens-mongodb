// Natural-language → MongoDB query generation via the Anthropic Messages API.
// The app's backend holds the API key (kept out of the frontend bundle) and calls
// https://api.anthropic.com/v1/messages over HTTPS (no official Rust SDK).

use std::time::Duration;

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
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

/// Pull the FIRST balanced JSON object out of free text — tolerates prose or
/// ```json fences before/after it, and braces inside string values — then
/// validate it parses. Returns compact JSON.
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

const OPENAI_URL: &str = "https://api.openai.com/v1/chat/completions";

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

pub fn gemini_url(model: &str, api_key: &str) -> String {
    format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key
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
    let client = reqwest::Client::new();
    let resp = client
        .post(gemini_url(model, api_key))
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
pub fn parse_command_template(template: &str, prompt: &str) -> Result<(String, Vec<String>), String> {
    let tokens: Vec<&str> = template.split_whitespace().collect();
    if tokens.is_empty() {
        return Err("Command template is empty".to_string());
    }
    let program = tokens[0].to_string();
    let mut args: Vec<String> = Vec::new();
    let mut substituted = false;
    for tok in &tokens[1..] {
        if *tok == "{prompt}" {
            args.push(prompt.to_string());
            substituted = true;
        } else {
            args.push((*tok).to_string());
        }
    }
    if !substituted {
        args.push(prompt.to_string());
    }
    Ok((program, args))
}

/// Run a local agent CLI with the given prompt and extract the {filter, sort} JSON
/// from its stdout. Uses the agent's own local auth; no API key involved.
pub async fn generate_local(template: &str, prompt: &str) -> Result<String, String> {
    let (program, args) = parse_command_template(template, prompt)?;

    let run = tokio::process::Command::new(&program)
        .args(&args)
        .stdin(std::process::Stdio::null())
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

