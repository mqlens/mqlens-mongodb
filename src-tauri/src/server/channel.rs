//! The gRPC channel to an MQLens Server.
//!
//! One channel per signed-in account, shared by every call to that server.
//! Building it does no I/O; the connection is opened by the first call and
//! re-established by tonic when it drops.

use std::net::IpAddr;
use std::time::Duration;
use tonic::codegen::http::Uri;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint};

pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// HTTP/2 pings keep an idle channel, and a quiet shell stream, from being
/// closed by proxies and load balancers between the desktop and the server.
pub(crate) const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
pub(crate) const KEEPALIVE_TIMEOUT: Duration = Duration::from_secs(20);
/// Largest message a client accepts. Find and Aggregate batches, GridFS chunks
/// and export chunks all stay far below this; tonic's 4 MiB default does not
/// leave room for a batch of large documents.
pub(crate) const MAX_DECODE_BYTES: usize = 64 * 1024 * 1024;

/// How to reach one MQLens Server.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ChannelConfig {
    pub url: String,
    /// Permit `http://` to a server that is not on this computer. Tokens and
    /// data then cross the network unencrypted, so this is an explicit opt-in.
    pub allow_insecure_http: bool,
    /// Extra PEM certificate authority to trust, for servers behind a private CA.
    pub extra_ca_pem: Option<String>,
}

/// Normalizes a server URL as the user typed it to `scheme://host[:port]`,
/// rejecting anything a gRPC channel cannot use or should not be allowed to.
pub(crate) fn normalize_url(input: &str, allow_insecure_http: bool) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Enter the MQLens Server URL".to_string());
    }
    let uri: Uri = trimmed
        .parse()
        .map_err(|e| format!("Invalid MQLens Server URL: {e}"))?;
    let (Some(scheme), Some(authority), Some(host)) =
        (uri.scheme_str(), uri.authority(), uri.host())
    else {
        return Err("MQLens Server URL must start with https://".to_string());
    };
    if authority.as_str().contains('@') {
        return Err("MQLens Server URL must not include a user name or password".to_string());
    }
    if !matches!(uri.path(), "" | "/") || uri.query().is_some() {
        return Err("MQLens Server URL must not include a path".to_string());
    }
    let scheme = scheme.to_ascii_lowercase();
    match scheme.as_str() {
        "https" => {}
        "http" if allow_insecure_http || is_loopback_host(host) => {}
        "http" => {
            return Err(
                "MQLens Server URL must use https:// unless the server runs on this computer"
                    .to_string(),
            )
        }
        _ => return Err("MQLens Server URL must start with https://".to_string()),
    }
    Ok(format!(
        "{scheme}://{}",
        authority.as_str().to_ascii_lowercase()
    ))
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// A lazily connecting channel to the server. Must be called inside a tokio
/// runtime: the channel spawns its connection task there.
pub(crate) fn channel(config: &ChannelConfig) -> Result<Channel, String> {
    let url = normalize_url(&config.url, config.allow_insecure_http)?;
    let mut endpoint = Endpoint::from_shared(url.clone())
        .map_err(|e| format!("Invalid MQLens Server URL: {e}"))?
        .user_agent(format!("MQLens/{}", env!("CARGO_PKG_VERSION")))
        .map_err(|e| format!("Invalid MQLens Server URL: {e}"))?
        .connect_timeout(CONNECT_TIMEOUT)
        .http2_keep_alive_interval(KEEPALIVE_INTERVAL)
        .keep_alive_timeout(KEEPALIVE_TIMEOUT)
        .keep_alive_while_idle(true)
        .tcp_nodelay(true);

    if url.starts_with("https://") {
        let mut tls = ClientTlsConfig::new()
            .with_native_roots()
            .with_webpki_roots();
        if let Some(pem) = config
            .extra_ca_pem
            .as_deref()
            .map(str::trim)
            .filter(|pem| !pem.is_empty())
        {
            if !pem.contains("-----BEGIN CERTIFICATE-----") {
                return Err(
                    "The extra CA certificate must be PEM text starting with -----BEGIN CERTIFICATE-----"
                        .to_string(),
                );
            }
            tls = tls.ca_certificate(Certificate::from_pem(pem));
        }
        endpoint = endpoint
            .tls_config(tls)
            .map_err(|e| format!("Could not set up TLS for MQLens Server: {e}"))?;
    }
    Ok(endpoint.connect_lazy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::errors;
    use crate::server::pb::mqlens::v1::capability_service_client::CapabilityServiceClient;
    use crate::server::pb::mqlens::v1::capability_service_server::{
        CapabilityService, CapabilityServiceServer,
    };
    use crate::server::pb::mqlens::v1::{GetCapabilitiesRequest, GetCapabilitiesResponse};
    use tonic::{Request, Response, Status};

    #[test]
    fn urls_are_normalized_to_scheme_and_authority() {
        let cases = [
            ("https://mqlens.example.com", "https://mqlens.example.com"),
            (
                "  HTTPS://MQLens.Example.com:8443/  ",
                "https://mqlens.example.com:8443",
            ),
            ("http://localhost:8080", "http://localhost:8080"),
            ("http://127.0.0.1:8080/", "http://127.0.0.1:8080"),
            ("http://[::1]:8080", "http://[::1]:8080"),
        ];
        for (input, want) in cases {
            assert_eq!(
                normalize_url(input, false).as_deref(),
                Ok(want),
                "input {input:?}"
            );
        }
    }

    #[test]
    fn plaintext_http_needs_loopback_or_an_opt_in() {
        let err = normalize_url("http://mqlens.internal:8080", false).unwrap_err();
        assert!(err.contains("must use https://"), "{err}");
        assert_eq!(
            normalize_url("http://mqlens.internal:8080", true).as_deref(),
            Ok("http://mqlens.internal:8080")
        );
        // A name that merely starts like a loopback address is not one.
        assert!(normalize_url("http://127.0.0.1.example.com", false).is_err());
    }

    #[test]
    fn unusable_urls_are_rejected() {
        let cases = [
            ("", "Enter the MQLens Server URL"),
            ("mqlens.example.com", "must start with https://"),
            ("ftp://mqlens.example.com", "must start with https://"),
            ("https://mqlens.example.com/api", "must not include a path"),
            (
                "https://mqlens.example.com/?tenant=acme",
                "must not include a path",
            ),
            (
                "https://user:secret@mqlens.example.com",
                "must not include a user name or password",
            ),
            ("https://exa mple.com", "Invalid MQLens Server URL"),
        ];
        for (input, want) in cases {
            let err = normalize_url(input, true).unwrap_err();
            assert!(
                err.contains(want),
                "input {input:?}: got {err:?}, want it to contain {want:?}"
            );
        }
    }

    // Building the TLS config is where rustls chooses a crypto provider. The
    // lock file carries both ring and aws-lc-rs, which makes an implicit choice
    // panic; this must succeed with the provider tonic is told to use.
    #[tokio::test]
    async fn https_channels_build_their_tls_config() {
        let config = ChannelConfig {
            url: "https://mqlens.example.com".to_string(),
            ..Default::default()
        };
        assert!(channel(&config).is_ok());
    }

    #[tokio::test]
    async fn an_extra_ca_must_be_pem() {
        let config = ChannelConfig {
            url: "https://mqlens.example.com".to_string(),
            extra_ca_pem: Some("not a certificate".to_string()),
            ..Default::default()
        };
        let err = channel(&config).unwrap_err();
        assert!(err.contains("must be PEM"), "{err}");

        // Blank means none.
        let config = ChannelConfig {
            extra_ca_pem: Some("  ".to_string()),
            ..config
        };
        assert!(channel(&config).is_ok());
    }

    struct FakeCapabilities;

    #[tonic::async_trait]
    impl CapabilityService for FakeCapabilities {
        async fn get_capabilities(
            &self,
            request: Request<GetCapabilitiesRequest>,
        ) -> Result<Response<GetCapabilitiesResponse>, Status> {
            if request
                .get_ref()
                .connection_ids
                .iter()
                .any(|id| id == "denied")
            {
                let mut status = Status::permission_denied("no grant on denied");
                status
                    .metadata_mut()
                    .insert(errors::CORRELATION_KEY, "corr-42".parse().unwrap());
                return Err(status);
            }
            Ok(Response::new(GetCapabilitiesResponse {
                server_version: "fake-1".to_string(),
                procedures: vec!["/mqlens.v1.CapabilityService/GetCapabilities".to_string()],
                ..Default::default()
            }))
        }
    }

    async fn serve_fake() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(
            tonic::transport::Server::builder()
                .add_service(CapabilityServiceServer::new(FakeCapabilities))
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)),
        );
        format!("http://{addr}")
    }

    // The generated client, the channel and the error rendering, end to end
    // over a real loopback HTTP/2 connection.
    #[tokio::test]
    async fn a_generated_client_calls_a_server_over_the_channel() {
        let url = serve_fake().await;
        let channel = channel(&ChannelConfig {
            url,
            ..Default::default()
        })
        .unwrap();
        let mut client =
            CapabilityServiceClient::new(channel).max_decoding_message_size(MAX_DECODE_BYTES);

        let resp = client
            .get_capabilities(GetCapabilitiesRequest {
                connection_ids: vec!["c1".to_string()],
            })
            .await
            .unwrap()
            .into_inner();
        assert_eq!(resp.server_version, "fake-1");
        assert_eq!(
            resp.procedures,
            ["/mqlens.v1.CapabilityService/GetCapabilities"]
        );

        let status = client
            .get_capabilities(GetCapabilitiesRequest {
                connection_ids: vec!["denied".to_string()],
            })
            .await
            .unwrap_err();
        assert_eq!(
            errors::describe(&status),
            "MQLens Server did not permit this operation: no grant on denied (MQLens Server correlation id: corr-42)"
        );
    }

    #[tokio::test]
    async fn an_unreachable_server_reports_unavailable() {
        // Bind and drop a listener so the port is known to be closed.
        let addr = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap();
        let channel = channel(&ChannelConfig {
            url: format!("http://{addr}"),
            ..Default::default()
        })
        .unwrap();
        let status = CapabilityServiceClient::new(channel)
            .get_capabilities(GetCapabilitiesRequest::default())
            .await
            .unwrap_err();
        assert_eq!(status.code(), tonic::Code::Unavailable, "{status:?}");
        assert!(errors::describe(&status).starts_with("MQLens Server is unavailable"));
    }
}
