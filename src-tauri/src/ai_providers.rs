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
    let base = base_url.trim().trim_end_matches('/');
    let want = path.trim_start_matches('/');
    if base.ends_with(want) {
        return base.to_string();
    }
    format!("{base}/{want}")
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
            _ => Ok(join_endpoint(&self.base_url, "models")),
        }
    }

    /// Reject a configuration before it produces a confusing HTTP or shell error.
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
                if !self.command.contains("{prompt}") {
                    return Err(format!(
                        "{}'s command must contain {{prompt}}, which is replaced with the request.",
                        self.name
                    ));
                }
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
                self.endpoint()?;
                if self.model.trim().is_empty() {
                    return Err(format!("{} needs a model name.", self.name));
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
    fn a_command_without_the_placeholder_is_refused() {
        let mut p = provider(ProviderKind::LocalCli, "");
        p.command = "opencode run".into();
        let err = p.validate().unwrap_err();
        assert!(err.contains("{prompt}"), "{err}");
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
