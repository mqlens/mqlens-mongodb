use serde::{Deserialize, Serialize};

fn default_ssh_port() -> u16 {
    22
}

/// SSH authentication method. Frontend-shaped, internally tagged:
///   {"type":"password","password":"..."}
///   {"type":"key","path":"...","passphrase":"..."}
///   {"type":"agent"}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SshAuth {
    Password {
        password: String,
    },
    Key {
        path: String,
        #[serde(default)]
        passphrase: Option<String>,
    },
    /// Delegate signing to the system ssh-agent; no key material is stored.
    Agent,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SshConfig {
    pub enabled: bool,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
}

/// Split a `mongodb://` URI into (scheme_prefix, authority, rest) where `rest`
/// is the path+query starting at the first '/' or '?' (or empty).
fn split_uri(uri: &str) -> (&str, &str, &str) {
    let scheme = "mongodb://";
    let after = uri.strip_prefix(scheme).unwrap_or(uri);
    let end = after.find(|c| c == '/' || c == '?').unwrap_or(after.len());
    let (authority, rest) = after.split_at(end);
    (scheme, authority, rest)
}

/// Strip `user:pass@` credentials from an authority, returning the host list.
fn hosts_of_authority(authority: &str) -> &str {
    match authority.rfind('@') {
        Some(i) => &authority[i + 1..],
        None => authority,
    }
}

/// Extract the first MongoDB target (host, port) from a connection URI.
/// Defaults the port to 27017 when omitted. Used as the SSH tunnel's target.
pub fn extract_target_host_port(uri: &str) -> (String, u16) {
    let (_, authority, _) = split_uri(uri);
    let hosts = hosts_of_authority(authority);
    let first = hosts.split(',').next().unwrap_or(hosts);
    match first.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(27017)),
        None => (first.to_string(), 27017),
    }
}

/// Rewrite a `mongodb://` URI so it points at a locally-forwarded address
/// (the SSH tunnel's listener). Forces `directConnection=true` and drops
/// `replicaSet` (a single forwarded host cannot drive replica-set discovery).
pub fn rewrite_uri_hosts(uri: &str, local_host: &str, local_port: u16) -> String {
    let (scheme, authority, rest) = split_uri(uri);

    let creds = match authority.rfind('@') {
        Some(i) => &authority[..=i], // includes the '@'
        None => "",
    };
    let new_authority = format!("{}{}:{}", creds, local_host, local_port);

    // Split rest into path and query.
    let (path, query) = if let Some(q) = rest.strip_prefix('?') {
        ("", q)
    } else if let Some(idx) = rest.find('?') {
        (&rest[..idx], &rest[idx + 1..])
    } else {
        (rest, "")
    };

    let mut params: Vec<String> = query
        .split('&')
        .filter(|p| !p.is_empty())
        .filter(|p| {
            let key = p.split('=').next().unwrap_or("");
            !key.eq_ignore_ascii_case("replicaSet") && !key.eq_ignore_ascii_case("directConnection")
        })
        .map(|p| p.to_string())
        .collect();
    params.push("directConnection=true".to_string());

    let query_str = if params.is_empty() {
        String::new()
    } else {
        format!("?{}", params.join("&"))
    };

    format!("{}{}{}{}", scheme, new_authority, path, query_str)
}

// ── Live SSH tunnel (russh) ────────────────────────────────────────────────
use std::sync::{Arc, Mutex as StdMutex};
use russh::client::{self, Config};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{check_known_hosts, load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// An ssh-agent connection over whatever transport the platform uses
/// (unix socket, Windows named pipe).
pub(crate) type BoxedAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

/// Connect to the system ssh-agent. `sock` is the value of `SSH_AUTH_SOCK`
/// (passed explicitly so tests don't depend on the ambient environment).
/// Errors are user-readable and actionable.
#[cfg(unix)]
pub(crate) async fn connect_agent_at(sock: Option<String>) -> Result<BoxedAgentClient, String> {
    let sock = match sock.filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => {
            return Err(
                "SSH agent not reachable (SSH_AUTH_SOCK is not set). Start an ssh-agent and load your key with ssh-add."
                    .to_string(),
            )
        }
    };
    AgentClient::connect_uds(&sock)
        .await
        .map(|c| c.dynamic())
        .map_err(|e| {
            format!(
                "SSH agent not reachable at '{}': {}. Is your ssh-agent running?",
                sock, e
            )
        })
}

/// Windows: the OpenSSH agent service listens on a well-known named pipe;
/// `SSH_AUTH_SOCK`, when set, may point at an alternative pipe.
#[cfg(windows)]
pub(crate) async fn connect_agent_at(sock: Option<String>) -> Result<BoxedAgentClient, String> {
    let pipe = sock
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".to_string());
    AgentClient::connect_named_pipe(&pipe)
        .await
        .map(|c| c.dynamic())
        .map_err(|e| {
            format!(
                "SSH agent not reachable at '{}': {}. Is the 'OpenSSH Authentication Agent' service running?",
                pipe, e
            )
        })
}

#[cfg(not(any(unix, windows)))]
pub(crate) async fn connect_agent_at(_sock: Option<String>) -> Result<BoxedAgentClient, String> {
    Err("ssh-agent is not supported on this platform yet".to_string())
}

// russh client handler that verifies the server host key against ~/.ssh/known_hosts.
struct TunnelClient {
    host: String,
    port: u16,
    reject_reason: Arc<StdMutex<Option<String>>>,
}

impl client::Handler for TunnelClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                *self.reject_reason.lock().unwrap_or_else(|p| p.into_inner()) = Some(format!(
                    "SSH host key for {}:{} is not in ~/.ssh/known_hosts. Trust it first, e.g.: ssh-keyscan -p {} {} >> ~/.ssh/known_hosts",
                    self.host, self.port, self.port, self.host
                ));
                Ok(false)
            }
            Err(e) => {
                *self.reject_reason.lock().unwrap_or_else(|p| p.into_inner()) = Some(format!(
                    "SSH host key verification FAILED for {}:{}: {}. The server key may have changed (possible MITM) — verify before connecting.",
                    self.host, self.port, e
                ));
                Ok(false)
            }
        }
    }
}

/// A live SSH tunnel: a local TCP listener forwarding to a remote target over SSH.
/// Dropping or closing it aborts the accept loop and tears down the SSH session.
pub struct SshTunnel {
    pub local_port: u16,
    accept_task: tokio::task::JoinHandle<()>,
}

impl SshTunnel {
    pub fn close(self) {
        self.accept_task.abort();
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

/// Open an SSH tunnel and forward a fresh local port to `target_host:target_port`
/// as reachable from the SSH server. Returns once authenticated and listening.
pub async fn open_tunnel(
    cfg: &SshConfig,
    target_host: String,
    target_port: u16,
) -> Result<SshTunnel, String> {
    let reject_reason = Arc::new(StdMutex::new(None::<String>));
    let handler = TunnelClient {
        host: cfg.host.clone(),
        port: cfg.port,
        reject_reason: reject_reason.clone(),
    };
    let config = Arc::new(Config {
        ..Default::default()
    });

    let mut session = client::connect(config, (cfg.host.as_str(), cfg.port), handler)
        .await
        .map_err(|e| {
            // Prefer the specific host-key reason if check_server_key set one.
            reject_reason
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| format!("SSH connection to {}:{} failed: {}", cfg.host, cfg.port, e))
        })?;

    let authed = match &cfg.auth {
        SshAuth::Password { password } => session
            .authenticate_password(cfg.user.clone(), password.clone())
            .await
            .map_err(|e| format!("SSH password authentication error: {}", e))?
            .success(),
        SshAuth::Key { path, passphrase } => {
            let key = load_secret_key(path, passphrase.as_deref())
                .map_err(|e| format!("Failed to load SSH private key '{}': {}", path, e))?;
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| format!("SSH key hash negotiation failed: {}", e))?
                .flatten();
            session
                .authenticate_publickey(cfg.user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| format!("SSH public-key authentication error: {}", e))?
                .success()
        }
        SshAuth::Agent => {
            let mut agent = connect_agent_at(std::env::var("SSH_AUTH_SOCK").ok()).await?;
            let identities = agent
                .request_identities()
                .await
                .map_err(|e| format!("Failed to list SSH agent identities: {}", e))?;
            if identities.is_empty() {
                return Err(
                    "SSH agent has no identities loaded — add one with ssh-add.".to_string()
                );
            }
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| format!("SSH key hash negotiation failed: {}", e))?
                .flatten();
            // Try every identity the agent holds; signing stays in the agent.
            let mut authed = false;
            let mut last_err: Option<String> = None;
            for identity in identities {
                let result = match identity {
                    AgentIdentity::PublicKey { key, .. } => {
                        session
                            .authenticate_publickey_with(cfg.user.clone(), key, hash, &mut agent)
                            .await
                    }
                    AgentIdentity::Certificate { certificate, .. } => {
                        session
                            .authenticate_certificate_with(
                                cfg.user.clone(),
                                certificate,
                                hash,
                                &mut agent,
                            )
                            .await
                    }
                };
                match result {
                    Ok(r) if r.success() => {
                        authed = true;
                        break;
                    }
                    Ok(_) => {}
                    Err(e) => last_err = Some(e.to_string()),
                }
            }
            if !authed {
                return Err(match last_err {
                    Some(e) => format!(
                        "SSH agent identities were rejected by the server for user '{}' (last agent error: {})",
                        cfg.user, e
                    ),
                    None => format!(
                        "SSH agent identities were rejected by the server for user '{}'.",
                        cfg.user
                    ),
                });
            }
            true
        }
    };
    if !authed {
        return Err(format!("SSH authentication failed for user '{}'", cfg.user));
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("Failed to bind local tunnel port: {}", e))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read local tunnel port: {}", e))?
        .port();

    let accept_task = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((socket, peer)) => {
                    match session
                        .channel_open_direct_tcpip(
                            target_host.clone(),
                            target_port as u32,
                            "127.0.0.1".to_string(),
                            peer.port() as u32,
                        )
                        .await
                    {
                        Ok(channel) => {
                            tokio::spawn(pump(socket, channel));
                        }
                        Err(_) => continue,
                    }
                }
                Err(_) => break,
            }
        }
        let _ = session
            .disconnect(Disconnect::ByApplication, "", "English")
            .await;
    });

    Ok(SshTunnel {
        local_port,
        accept_task,
    })
}

// Pipe bytes between a local TCP socket and an SSH direct-tcpip channel.
async fn pump(mut stream: TcpStream, mut channel: russh::Channel<russh::client::Msg>) {
    let mut buf = vec![0u8; 65536];
    let mut stream_closed = false;
    loop {
        tokio::select! {
            r = stream.read(&mut buf), if !stream_closed => {
                match r {
                    Ok(0) => {
                        stream_closed = true;
                        let _ = channel.eof().await;
                    }
                    Ok(n) => {
                        if channel.data(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        if stream.write_all(data).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof) => {
                        let _ = stream.shutdown().await;
                        break;
                    }
                    Some(_) => {}
                    None => break,
                }
            }
        }
    }
}
