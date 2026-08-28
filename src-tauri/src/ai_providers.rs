//! User-configurable AI providers (#283).
//!
//! The three built-in providers were each wired in by hand: a settings field per
//! API key, a field per model, and an arm in `generate_mql_query`'s match. Adding
//! DeepSeek or pointing the assistant at a local Ollama therefore meant editing
//! Rust *and* the settings UI, which is the limitation the issue reports.
//!
//! Almost every inference service speaks one of two wire formats, so the fix is
//! not a provider per vendor but an adapter per *format* plus user-supplied
//! endpoint, key and model:
//!
//! - [`ProviderKind::OpenAiCompatible`] — `POST {base}/chat/completions` with
//!   `authorization: Bearer`. DeepSeek, OpenRouter, Groq, Together, Mistral, xAI,
//!   Ollama, LM Studio, vLLM and OpenAI itself.
//! - [`ProviderKind::AnthropicCompatible`] — `POST {base}/messages` with
//!   `x-api-key` and `anthropic-version`. Anthropic and the gateways that proxy it.
//! - [`ProviderKind::LocalCli`] — a command template containing `{prompt}`.
//!   Already existed for four fixed agent ids; now any command, so `ollama run`,
//!   `opencode run`, `llm` or a shell script of the user's own all work.
//!
//! Presets exist only to prefill the form. They are plain data, not a remote
//! catalog: MQLens keeps credentials in the vault and is expected to work with no
//! internet beyond the model endpoint itself, so fetching a third-party provider
//! list at startup would add a dependency the app does not otherwise have.

use serde::{Deserialize, Serialize};

/// Which wire format a provider speaks.
/// Wire names are part of the contract with the settings UI and the stored
/// settings file, so each is written out rather than derived. `kebab-case`
/// would split `OpenAiCompatible` at every capital into `open-ai-compatible`,
/// which is not what the frontend sends and not how anyone writes it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    #[serde(rename = "anthropic-compatible")]
    AnthropicCompatible,
    #[serde(rename = "local-cli")]
    LocalCli,
}

/// A provider the user has configured.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AiProvider {
    /// Stable identifier, referenced by `AppSettings::ai_provider`.
    pub id: String,
    /// Shown in the picker.
    pub name: String,
    pub kind: ProviderKind,
    /// Base URL for the HTTP kinds, without the trailing endpoint path.
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    /// Command template for [`ProviderKind::LocalCli`]; must contain `{prompt}`.
    /// May also contain `{model}`, replaced with [`AiProvider::model`] so one
    /// template serves every model the CLI offers.
    #[serde(default)]
    pub command: String,
    /// For [`ProviderKind::LocalCli`]: a command whose stdout lists models, one
    /// per line (`ollama list`, `llm models`). Optional — not every CLI has one,
    /// and the model can always be typed.
    #[serde(default)]
    pub models_command: String,
}

/// A ready-made provider the settings form can prefill.
pub struct ProviderPreset {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: ProviderKind,
    pub base_url: &'static str,
    pub model: &'static str,
    pub command: &'static str,
    /// Lists models for a CLI preset; empty where the CLI has no such command
    /// or its output format is not known well enough to parse.
    pub models_command: &'static str,
    /// False for endpoints that ignore credentials, so the form can say so
    /// instead of demanding a key the server does not want.
    pub needs_key: bool,
}

/// Endpoints and commands offered as one-click starting points.
///
/// A preset is a hint, never a constraint: every field stays editable, and a
/// provider absent from this list is configured by picking its wire format and
/// typing the endpoint. `base_url` values are the vendor's documented
/// OpenAI-compatible path, which for most is the host plus `/v1`.
pub const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        id: "deepseek",
        name: "DeepSeek",
        kind: ProviderKind::OpenAiCompatible,
        base_url: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        command: "",
        models_command: "",
        needs_key: true,
    },
    ProviderPreset {
        id: "openrouter",
        name: "OpenRouter",
        kind: ProviderKind::OpenAiCompatible,
        base_url: "https://openrouter.ai/api/v1",
        model: "",
        command: "",
        models_command: "",
        needs_key: true,
    },
    ProviderPreset {
        id: "groq",
        name: "Groq",
        kind: ProviderKind::OpenAiCompatible,
        base_url: "https://api.groq.com/openai/v1",
        model: "",
        command: "",
        models_command: "",
        needs_key: true,
    },
    ProviderPreset {
        id: "together",
        name: "Together AI",
        kind: ProviderKind::OpenAiCompatible,
        base_url: "https://api.together.xyz/v1",
        model: "",
        command: "",
        models_command: "",
        needs_key: true,
    },
    ProviderPreset {
        id: "mistral",
        name: "Mistral",
        kind: ProviderKind::OpenAiCompatible,
        base_url: "https://api.mistral.ai/v1",
        model: "",
        command: "",
        models_command: "",
        needs_key: true,
    },
    ProviderPreset {
        id: "xai",
        name: "xAI (Grok)",
        kind: ProviderKind::OpenAiCompatible,
        base_url: "https://api.x.ai/v1",
        model: "",
        command: "",
        models_command: "",
        needs_key: true,
    },
    // Local servers: no credential, and the endpoint is on the loopback
    // interface, so nothing leaves the machine.
    ProviderPreset {
        id: "ollama",
        name: "Ollama (local)",
        kind: ProviderKind::OpenAiCompatible,
        base_url: "http://localhost:11434/v1",
        model: "",
        command: "",
        models_command: "",
        needs_key: false,
    },
    ProviderPreset {
        id: "lmstudio",
        name: "LM Studio (local)",
        kind: ProviderKind::OpenAiCompatible,
        base_url: "http://localhost:1234/v1",
        model: "",
        command: "",
        models_command: "",
        needs_key: false,
    },
    ProviderPreset {
        id: "vllm",
        name: "vLLM (local)",
        kind: ProviderKind::OpenAiCompatible,
        base_url: "http://localhost:8000/v1",
        model: "",
        command: "",
        models_command: "",
        needs_key: false,
    },
    // Anthropic's own API, and anything proxying its message format.
    ProviderPreset {
        id: "anthropic-compatible",
        name: "Anthropic-compatible endpoint",
        kind: ProviderKind::AnthropicCompatible,
        base_url: "https://api.anthropic.com/v1",
        model: "",
        command: "",
        models_command: "",
        needs_key: true,
    },
    // Local agent CLIs. `{prompt}` is substituted with the full prompt.
    ProviderPreset {
        id: "opencode",
        name: "opencode (local CLI)",
        kind: ProviderKind::LocalCli,
        base_url: "",
        model: "",
        // No {model} slot and no models_command: opencode's model flag and its
        // listing command are not known here with enough confidence to preset,
        // and a guessed flag fails on the user's first request. Users who know
        // their build can add `--model {model}` and a list command themselves.
        command: "opencode run {prompt}",
        models_command: "",
        needs_key: false,
    },
    ProviderPreset {
        id: "ollama-cli",
        name: "Ollama CLI (local)",
        kind: ProviderKind::LocalCli,
        base_url: "",
        model: "llama3",
        command: "ollama run {model} {prompt}",
        models_command: "ollama list",
        needs_key: false,
    },
    ProviderPreset {
        id: "llm-cli",
        name: "llm (local CLI)",
        kind: ProviderKind::LocalCli,
        base_url: "",
        model: "",
        command: "llm -m {model} {prompt}",
        models_command: "llm models",
        needs_key: false,
    },
];

/// Join a base URL and an endpoint path without doubling or dropping the slash.
///
/// Users paste base URLs with and without a trailing slash, and some paste the
/// full `.../chat/completions` because that is what the vendor's curl example
/// shows. Both are accepted rather than failing with a 404 that looks like a
/// credential problem.
pub fn join_endpoint(base_url: &str, path: &str) -> String {
    let (base, query) = split_query(base_url.trim());
    let base = base.trim_end_matches('/');
    let want = path.trim_start_matches('/');
    if base.ends_with(want) {
        return format!("{base}{query}");
    }
    format!("{base}/{want}{query}")
}

/// A URL split into its path part and any `?query` / `#fragment` tail.
///
/// Gateways hand out endpoints carrying a query — Azure-style
/// `?api-version=…` is the common one — and appending a route after the query
/// produces a URL that cannot work. Everything that edits the path does so on
/// the first half and reattaches the second.
fn split_query(url: &str) -> (&str, &str) {
    match url.find(['?', '#']) {
        Some(i) => (&url[..i], &url[i..]),
        None => (url, ""),
    }
}

/// `…/v1/chat/completions` → `…/v1`, likewise for `…/messages`; unchanged otherwise.
fn strip_generation_suffix(path: &str) -> &str {
    let base = path.trim_end_matches('/');
    for suffix in ["/chat/completions", "/messages"] {
        if let Some(prefix) = base.strip_suffix(suffix) {
            return prefix;
        }
    }
    base
}

/// Lowercased host of `url`, or None when this app would not request over it.
///
/// The scheme and port are deliberately excluded. A known service is known by
/// *where* the request goes, and `http://api.openai.com/v1` is the same recipient
/// as the https form — it simply reaches it without TLS. Comparing whole origins
/// made those two mismatch, so a mistyped `http://` cloud endpoint read as "some
/// unknown server", which is the reading that lets it past every rule.
fn host_of(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(parsed.host_str()?.to_ascii_lowercase())
}

/// Whether `url` is reached over TLS.
fn uses_tls(url: &str) -> bool {
    reqwest::Url::parse(url.trim())
        .map(|u| u.scheme() == "https")
        .unwrap_or(false)
}

/// The cloud services reached through the dedicated built-in fields rather than
/// a preset, so a custom provider aimed at the same origin is held to the same
/// rule. Referenced, not re-spelled, so the URLs cannot drift apart.
const BUILT_IN_AUTHENTICATED: &[(&str, &str)] = &[
    (crate::ai::OPENAI_URL, "OpenAI"),
    (crate::ai::ANTHROPIC_URL, "Anthropic"),
    (
        "https://generativelanguage.googleapis.com/v1beta/models",
        "Google Gemini",
    ),
];

/// The name of the service at `base_url`'s origin, if it authenticates requests.
///
/// Checked in the backend and not only in the form: the form derives the
/// requirement from `ai_provider_presets`, which is fetched asynchronously and
/// falls back to an empty list when the call fails, so the guard failed open
/// exactly when it was least able to notice — a known cloud endpoint saved with
/// no key, and the schema and prompt then sent to it unauthenticated.
///
/// Both lists, because neither is complete on its own: the presets are what the
/// form offers, while OpenAI, Anthropic and Gemini are reached through their own
/// settings fields and appear in no preset. A custom provider pointed at
/// `https://api.openai.com/v1` was therefore not covered by the preset lookup.
///
/// Endpoints on neither list stay keyless: a private gateway or a LAN server must
/// remain usable, so only origins this app knows to authenticate are held to it.
fn authenticated_service(base_url: &str) -> Option<&'static str> {
    let host = host_of(base_url)?;
    let same_host = |url: &str| host_of(url).as_deref() == Some(host.as_str());
    PRESETS
        .iter()
        .find(|p| p.needs_key && same_host(p.base_url))
        .map(|p| p.name)
        .or_else(|| {
            BUILT_IN_AUTHENTICATED
                .iter()
                .find(|(url, _)| same_host(url))
                .map(|(_, name)| *name)
        })
}

/// Whether `url` would carry a request off this machine without TLS.
///
/// A key on such an endpoint is sent as a header in clear text, along with the
/// schema and the prompt, so one mistyped or copy-pasted URL puts a credential on
/// the network. Keyless `http://` stays allowed: a LAN Ollama or vLLM has nothing
/// to leak, and refusing it would rule out the setups these presets exist for.
///
/// Loopback covers `localhost`, its subdomains, and any loopback IP, which is
/// what the local presets use.
fn is_cleartext_remote(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url.trim()) else {
        return false; // not a URL we would request over; `endpoint()` judges it
    };
    if parsed.scheme() != "http" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false; // nothing to send to
    };
    // `host_str` brackets an IPv6 literal, which `IpAddr` does not accept.
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return false;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => !ip.is_loopback(),
        // A name that is not `localhost` resolves somewhere off this machine as
        // far as we can tell, and guessing otherwise is what leaks the key.
        Err(_) => true,
    }
}

impl AiProvider {
    /// The URL a request should be posted to, or an error naming what is missing.
    pub fn endpoint(&self) -> Result<String, String> {
        if self.base_url.trim().is_empty() {
            return Err(format!(
                "{} has no endpoint URL. Add one in Settings → AI.",
                self.name
            ));
        }
        match self.kind {
            ProviderKind::OpenAiCompatible => {
                Ok(join_endpoint(&self.base_url, "chat/completions"))
            }
            ProviderKind::AnthropicCompatible => Ok(join_endpoint(&self.base_url, "messages")),
            ProviderKind::LocalCli => Err(format!("{} is a local command, not a URL", self.name)),
        }
    }

    /// Where the provider lists its models. Both HTTP formats expose `GET
    /// {base}/models`; the response shapes differ and `ai::parse_models_json`
    /// accepts each.
    pub fn models_endpoint(&self) -> Result<String, String> {
        if self.base_url.trim().is_empty() {
            return Err(format!(
                "{} has no endpoint URL. Add one in Settings → AI.",
                self.name
            ));
        }
        match self.kind {
            ProviderKind::LocalCli => Err(format!("{} is a local command, not a URL", self.name)),
            // The UI accepts a pasted *generation* URL (`…/v1/chat/completions`,
            // `…/v1/messages`) as the base; the models route hangs off the same
            // prefix, so that suffix is removed before joining.
            _ => {
                let (path, query) = split_query(self.base_url.trim());
                Ok(join_endpoint(
                    &format!("{}{}", strip_generation_suffix(path), query),
                    "models",
                ))
            }
        }
    }

    /// Reject a configuration before it produces a confusing HTTP or shell error.
    /// Refuse to put a credential on the network in clear text.
    ///
    /// Its own method rather than a step inside `validate`, because the model
    /// list is fetched from the draft before anything is saved: `list_ai_models`
    /// never went through `validate`, so the auto-load 600 ms after a key was
    /// typed sent it to a remote `http://` endpoint while the form still showed
    /// no error. Every path that puts the key on the wire calls this.
    pub fn check_transport(&self) -> Result<(), String> {
        // Here rather than only in `validate`, so the model-list path enforces it
        // too: reaching a service known to authenticate over `http://` puts the
        // request on the network in clear text even with no key set, and a
        // redirect or an error arrives far too late to have protected it.
        if let Some(service) = authenticated_service(&self.base_url) {
            if !uses_tls(&self.base_url) {
                return Err(format!(
                    "{} must reach {} over https://. Over http:// the collection \
                     schema, your prompt and any API key would cross the network \
                     in clear text.",
                    self.name, service
                ));
            }
        }
        if !self.api_key.trim().is_empty() && is_cleartext_remote(&self.base_url) {
            return Err(format!(
                "{}'s API key would be sent in clear text, because its URL is http:// \
                 and not on this machine. Use https://, or remove the key.",
                self.name
            ));
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("A provider needs an id.".to_string());
        }
        if self.name.trim().is_empty() {
            return Err(format!("Provider `{}` needs a display name.", self.id));
        }
        match self.kind {
            ProviderKind::LocalCli => {
                if self.command.trim().is_empty() {
                    return Err(format!("{} needs a command.", self.name));
                }
                // No `{prompt}` requirement: the parser appends the request as the
                // last argument when the placeholder is absent, and saved built-in
                // overrides such as `codex exec` have relied on that since before
                // placeholders existed. Requiring it here broke them on upgrade.
                // A template that slots the model in needs one to slot.
                if self.command.contains("{model}") && self.model.trim().is_empty() {
                    return Err(format!(
                        "{}'s command uses {{model}} but no model is set. Load the list or type one.",
                        self.name
                    ));
                }
                Ok(())
            }
            _ => {
                let endpoint = self.endpoint()?;
                // Parsed, not just concatenated: `endpoint()` only joins a path, so
                // `not a url`, a bare path, or `ftp://host` was saved happily and
                // failed later inside reqwest — an error the form could not attach
                // to the field the user had got wrong.
                if host_of(&endpoint).is_none() {
                    return Err(format!(
                        "{}'s URL must be an http:// or https:// address with a host. \
                         `{}` is not one.",
                        self.name,
                        self.base_url.trim()
                    ));
                }
                if self.model.trim().is_empty() {
                    return Err(format!("{} needs a model name.", self.name));
                }
                // Transport first: over `http://` the answer is "use https", not
                // "add a key" that would then travel in clear text as well.
                self.check_transport()?;
                if self.api_key.trim().is_empty() {
                    if let Some(service) = authenticated_service(&self.base_url) {
                        return Err(format!(
                            "{} needs an API key: {} authenticates every request, so without \
                             one the collection schema and your prompt would be sent to it \
                             unauthenticated.",
                            self.name, service
                        ));
                    }
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(kind: ProviderKind, base_url: &str) -> AiProvider {
        AiProvider {
            id: "p1".into(),
            name: "Test provider".into(),
            kind,
            base_url: base_url.into(),
            api_key: String::new(),
            model: "some-model".into(),
            command: String::new(),
            models_command: String::new(),
        }
    }

    #[test]
    fn a_url_that_is_not_a_url_is_refused_at_save_rather_than_at_first_request() {
        // `endpoint()` only joins a path, so these were saved happily and failed
        // later inside reqwest — an error the form could not attach to the field.
        for bad in ["not a url", "/v1/chat", "ftp://files.example/v1", "api.openai.com/v1"] {
            let p = provider(ProviderKind::OpenAiCompatible, bad);
            let err = p.validate().unwrap_err();
            assert!(err.contains("http://"), "{bad}: {err}");
        }
        // ...and a real one still passes.
        let mut ok = provider(ProviderKind::OpenAiCompatible, "https://llm.internal.example/v1");
        ok.api_key = String::new();
        ok.validate().expect("a well-formed URL is fine");
    }

    #[test]
    fn a_known_cloud_service_cannot_be_reached_over_http() {
        // Comparing whole origins let `http://api.openai.com/v1` read as an
        // unknown server, so it passed with no key at all and the schema and
        // prompt would have crossed the network in clear text.
        for url in [
            "http://api.openai.com/v1",
            "http://api.anthropic.com/v1",
            "http://api.deepseek.com/v1",
            // A non-standard port on a known host is still that host.
            "http://api.openai.com:8080/v1",
        ] {
            let mut p = provider(ProviderKind::OpenAiCompatible, url);
            let err = p.validate().unwrap_err();
            assert!(err.contains("https://"), "{url}: {err}");
            // ...and a key does not make it acceptable either.
            p.api_key = "sk-key".into();
            let err = p.validate().unwrap_err();
            assert!(err.contains("clear text"), "{url} with a key: {err}");
        }

        // A server this app knows nothing about is still reachable over http:
        // a LAN vLLM or a private gateway must keep working.
        let unknown = provider(ProviderKind::OpenAiCompatible, "http://192.168.1.50:8000/v1");
        unknown.validate().expect("an unknown host over http is the user's call");
    }

    #[test]
    fn a_known_authenticated_endpoint_cannot_be_saved_without_a_key() {
        // The form derives this from `ai_provider_presets`, which is fetched and
        // falls back to an empty list on failure — so the guard failed open
        // exactly when it could not tell, and DeepSeek could be saved keyless.
        let deepseek = PRESETS
            .iter()
            .find(|p| p.id == "deepseek")
            .expect("deepseek preset");
        assert!(deepseek.needs_key);

        let mut p = provider(ProviderKind::OpenAiCompatible, deepseek.base_url);
        let err = p.validate().unwrap_err();
        assert!(err.contains("needs an API key"), "{err}");
        assert!(err.contains(deepseek.name), "the reason names the service: {err}");
        p.api_key = "sk-key".into();
        p.validate().expect("valid with a key");

        // The same service reached by another path on the same origin, and with
        // the default port spelled out, is still that service.
        for url in [
            "https://api.deepseek.com/v1/chat/completions",
            "https://API.DeepSeek.com:443/v1",
        ] {
            let p = provider(ProviderKind::OpenAiCompatible, url);
            assert!(p.validate().is_err(), "{url} should still require a key");
        }
    }

    #[test]
    fn a_key_on_a_cleartext_remote_endpoint_is_refused() {
        // An `http://` URL off this machine carries the key as a plain header,
        // along with the schema and the prompt, so one mistyped or copy-pasted
        // URL is enough to put a credential on the network.
        // Hosts no preset covers, so the *key* is what makes these unacceptable —
        // a known cloud host over http is refused outright, keyed or not, and is
        // covered by `a_known_cloud_service_cannot_be_reached_over_http`.
        for url in [
            "http://llm.vendor.example/v1",
            "http://192.168.1.50:8000/v1",
            "http://[2001:db8::1]:8000/v1",
        ] {
            let mut p = provider(ProviderKind::OpenAiCompatible, url);
            p.api_key = "sk-secret".into();
            let err = p.validate().unwrap_err();
            assert!(err.contains("clear text"), "{url}: {err}");
            // Without a key there is nothing to leak, and LAN servers are the
            // reason the keyless presets exist.
            p.api_key = String::new();
            assert!(p.validate().is_ok(), "{url} must stay usable without a key");
        }
    }

    #[test]
    fn the_model_list_path_also_refuses_a_known_service_over_http() {
        // `list_ai_models` never goes through `validate`, so the TLS rule lives in
        // `check_transport` where both paths reach it.
        let p = provider(ProviderKind::OpenAiCompatible, "http://api.openai.com/v1");
        let err = p.check_transport().unwrap_err();
        assert!(err.contains("https://"), "{err}");
        let ok = provider(ProviderKind::OpenAiCompatible, "https://api.openai.com/v1");
        ok.check_transport().expect("https is fine");
    }

    #[test]
    fn an_endpoint_no_preset_covers_still_needs_no_key() {
        // Only origins this app ships a preset for are held to a key. A private
        // gateway or a LAN server must stay usable without one.
        for url in ["https://llm.internal.example/v1", "http://192.168.1.50:8000/v1"] {
            let p = provider(ProviderKind::OpenAiCompatible, url);
            p.validate().unwrap_or_else(|e| panic!("{url}: {e}"));
        }
        // ...and so must the keyless presets, which is why they are marked.
        for preset in PRESETS.iter().filter(|p| !p.needs_key && !p.base_url.is_empty()) {
            let p = provider(ProviderKind::OpenAiCompatible, preset.base_url);
            p.validate()
                .unwrap_or_else(|e| panic!("{} should not need a key: {e}", preset.id));
        }
    }

    #[test]
    fn a_key_is_allowed_over_tls_and_on_this_machine() {
        for url in [
            "https://api.deepseek.com/v1",
            "http://localhost:11434/v1",
            "http://127.0.0.1:11434/v1",
            "http://[::1]:11434/v1",
            "http://ollama.localhost:11434/v1",
        ] {
            let mut p = provider(ProviderKind::OpenAiCompatible, url);
            p.api_key = "sk-secret".into();
            assert!(p.validate().is_ok(), "{url} should be accepted: {:?}", p.validate());
        }
    }

    /// The frontend sends these exact strings and the settings file stores them.
    /// This is the test that was missing: nothing serialized the enum before, so
    /// `kebab-case` producing `open-ai-compatible` went unnoticed until a user
    /// tried to save an OpenAI-compatible provider.
    #[test]
    fn provider_kinds_serialize_to_the_names_the_ui_uses() {
        for (kind, wire) in [
            (ProviderKind::OpenAiCompatible, "openai-compatible"),
            (ProviderKind::AnthropicCompatible, "anthropic-compatible"),
            (ProviderKind::LocalCli, "local-cli"),
        ] {
            assert_eq!(serde_json::to_string(&kind).unwrap(), format!("\"{wire}\""));
            let back: ProviderKind = serde_json::from_str(&format!("\"{wire}\"")).unwrap();
            assert_eq!(back, kind);
        }
        assert!(serde_json::from_str::<ProviderKind>("\"open-ai-compatible\"").is_err());
    }

    /// The same struct the form posts to `validate_ai_provider`/`list_ai_models`.
    #[test]
    fn a_provider_from_the_form_deserializes() {
        let json = r#"{"id":"deepseek","name":"DeepSeek","kind":"openai-compatible",
            "base_url":"https://api.deepseek.com/v1","api_key":"k","model":"deepseek-chat",
            "command":"","models_command":""}"#;
        let p: AiProvider = serde_json::from_str(json).expect("the form's own payload must parse");
        assert_eq!(p.kind, ProviderKind::OpenAiCompatible);
    }

    #[test]
    fn joins_a_base_url_whether_or_not_it_ends_in_a_slash() {
        assert_eq!(
            join_endpoint("https://api.deepseek.com/v1", "chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            join_endpoint("https://api.deepseek.com/v1/", "chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            join_endpoint("  http://localhost:11434/v1  ", "chat/completions"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn accepts_a_base_url_that_already_names_the_endpoint() {
        // Vendors' curl examples show the full path, so users paste it. Doubling
        // it produces a 404 that reads like an auth problem.
        assert_eq!(
            join_endpoint("https://api.deepseek.com/v1/chat/completions", "chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            join_endpoint("https://gateway.example/v1/messages/", "messages"),
            "https://gateway.example/v1/messages"
        );
    }

    #[test]
    fn a_query_string_in_the_base_url_stays_at_the_end() {
        // Gateways hand out `…?api-version=…`; appending the route after the
        // query produced a URL that could never work, for generation or listing.
        let base = "https://gw.example/v1/chat/completions?api-version=2026-01";
        assert_eq!(
            join_endpoint(base, "chat/completions"),
            "https://gw.example/v1/chat/completions?api-version=2026-01"
        );
        let mut p = provider(ProviderKind::OpenAiCompatible, base);
        assert_eq!(p.endpoint().unwrap(), base);
        assert_eq!(
            p.models_endpoint().unwrap(),
            "https://gw.example/v1/models?api-version=2026-01"
        );
        // A plain base with a query gains the route before the query.
        p.base_url = "https://gw.example/v1?api-version=2026-01".into();
        assert_eq!(
            p.endpoint().unwrap(),
            "https://gw.example/v1/chat/completions?api-version=2026-01"
        );
        assert_eq!(
            p.models_endpoint().unwrap(),
            "https://gw.example/v1/models?api-version=2026-01"
        );
    }

    #[test]
    fn each_wire_format_gets_its_own_path() {
        assert_eq!(
            provider(ProviderKind::OpenAiCompatible, "https://x/v1")
                .endpoint()
                .unwrap(),
            "https://x/v1/chat/completions"
        );
        assert_eq!(
            provider(ProviderKind::AnthropicCompatible, "https://x/v1")
                .endpoint()
                .unwrap(),
            "https://x/v1/messages"
        );
    }

    #[test]
    fn a_local_command_has_no_endpoint() {
        let mut p = provider(ProviderKind::LocalCli, "");
        p.command = "opencode run {prompt}".into();
        assert!(p.endpoint().is_err());
        p.validate().expect("a command with {prompt} is valid");
    }

    #[test]
    fn a_command_without_the_placeholder_is_accepted_because_the_parser_appends() {
        // `codex exec` is a real saved override from before placeholders existed.
        let mut p = provider(ProviderKind::LocalCli, "");
        p.command = "codex exec".into();
        p.validate().expect("legacy template must keep working after upgrade");
        let (prog, args) = crate::ai::parse_command_template(&p.command, "find users", "").unwrap();
        assert_eq!((prog.as_str(), args), ("codex", vec!["exec".to_string(), "find users".to_string()]));
    }

    #[test]
    fn http_providers_need_an_endpoint_and_a_model() {
        let missing_url = provider(ProviderKind::OpenAiCompatible, "");
        assert!(missing_url.validate().unwrap_err().contains("endpoint"));

        let mut missing_model = provider(ProviderKind::OpenAiCompatible, "https://x/v1");
        missing_model.model = String::new();
        assert!(missing_model.validate().unwrap_err().contains("model"));
    }

    #[test]
    fn a_key_is_optional_so_local_servers_work() {
        // Ollama and LM Studio ignore credentials; requiring one would make the
        // form demand something the server does not want.
        let p = provider(ProviderKind::OpenAiCompatible, "http://localhost:11434/v1");
        assert!(p.api_key.is_empty());
        p.validate().expect("no key required");
    }

    #[test]
    fn the_models_endpoint_shares_the_base_url() {
        assert_eq!(
            provider(ProviderKind::OpenAiCompatible, "https://x/v1/").models_endpoint().unwrap(),
            "https://x/v1/models"
        );
        assert_eq!(
            provider(ProviderKind::AnthropicCompatible, "https://x/v1").models_endpoint().unwrap(),
            "https://x/v1/models"
        );
        assert!(provider(ProviderKind::LocalCli, "").models_endpoint().is_err());
    }

    #[test]
    fn the_models_endpoint_survives_a_pasted_generation_url() {
        // The hint says pasting the full path works — so it has to work here too,
        // not only for generation.
        for (base, expect) in [
            ("https://api.deepseek.com/v1/chat/completions", "https://api.deepseek.com/v1/models"),
            ("https://api.deepseek.com/v1/chat/completions/", "https://api.deepseek.com/v1/models"),
            ("https://gw.example/v1/messages", "https://gw.example/v1/models"),
            ("https://api.deepseek.com/v1", "https://api.deepseek.com/v1/models"),
        ] {
            let mut p = provider(ProviderKind::OpenAiCompatible, base);
            if base.contains("/messages") { p.kind = ProviderKind::AnthropicCompatible; }
            assert_eq!(p.models_endpoint().unwrap(), expect, "base {base}");
        }
    }

    #[test]
    fn a_command_that_slots_the_model_in_needs_one() {
        let mut p = provider(ProviderKind::LocalCli, "");
        p.command = "ollama run {model} {prompt}".into();
        p.model = String::new();
        let err = p.validate().unwrap_err();
        assert!(err.contains("{model}"), "{err}");
        assert!(err.contains("no model"), "{err}");

        p.model = "llama3".into();
        p.validate().expect("valid once a model is set");
    }

    #[test]
    fn a_command_without_the_model_slot_does_not_demand_a_model() {
        // The four original agents bake the model into the CLI's own config.
        let mut p = provider(ProviderKind::LocalCli, "");
        p.command = "claude -p {prompt}".into();
        p.model = String::new();
        p.validate().expect("no {model}, no requirement");
    }

    #[test]
    fn presets_are_internally_consistent() {
        let mut ids = std::collections::HashSet::new();
        for preset in PRESETS {
            assert!(ids.insert(preset.id), "duplicate preset id {}", preset.id);
            assert!(!preset.name.is_empty(), "{} has no name", preset.id);
            match preset.kind {
                ProviderKind::LocalCli => {
                    assert!(
                        preset.command.contains("{prompt}"),
                        "{} is a CLI preset without {{prompt}}",
                        preset.id
                    );
                    assert!(preset.base_url.is_empty(), "{} is a CLI, not a URL", preset.id);
                    // A preset that slots the model in must ship with one, or the
                    // freshly-added provider fails validation before the user has
                    // had a chance to load the list.
                    if preset.command.contains("{model}") && preset.models_command.is_empty() {
                        assert!(
                            !preset.model.is_empty(),
                            "{} uses {{model}} with no list command and no starting model",
                            preset.id
                        );
                    }
                    assert!(
                        !preset.models_command.contains("{prompt}")
                            && !preset.models_command.contains("{model}"),
                        "{}'s models_command must not use placeholders",
                        preset.id
                    );
                }
                _ => {
                    assert!(
                        preset.models_command.is_empty(),
                        "{} is HTTP; models come from GET /models, not a command",
                        preset.id
                    );
                    assert!(
                        preset.base_url.starts_with("http"),
                        "{} needs an http(s) base URL",
                        preset.id
                    );
                    assert!(preset.command.is_empty(), "{} is HTTP, not a command", preset.id);
                }
            }
        }
    }

    #[test]
    fn every_preset_produces_a_usable_endpoint() {
        for preset in PRESETS {
            if preset.kind == ProviderKind::LocalCli {
                continue;
            }
            let p = AiProvider {
                id: preset.id.into(),
                name: preset.name.into(),
                kind: preset.kind,
                base_url: preset.base_url.into(),
                api_key: String::new(),
                model: "m".into(),
                command: String::new(),
            models_command: String::new(),
            };
            let endpoint = p.endpoint().unwrap_or_else(|e| panic!("{}: {e}", preset.id));
            let expected = match preset.kind {
                ProviderKind::AnthropicCompatible => "/messages",
                _ => "/chat/completions",
            };
            assert!(
                endpoint.ends_with(expected),
                "{} -> {endpoint}, expected it to end with {expected}",
                preset.id
            );
        }
    }

    #[test]
    fn local_servers_are_the_ones_that_need_no_key() {
        for preset in PRESETS {
            if preset.base_url.contains("localhost") {
                assert!(!preset.needs_key, "{} is local; it should not demand a key", preset.id);
            }
        }
    }
}
