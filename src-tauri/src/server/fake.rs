//! An in-process MQLens Server for tests.
//!
//! It implements the server's rules that the desktop depends on, above all
//! refresh-token rotation and reuse detection: a spent refresh token presented
//! again revokes its family and every access token, as
//! `internal/api/auth_handler.go` does. Counters let tests assert what reached
//! the server.

use crate::server::accounts::{self, ServerAccount, ServerAccountInput};
use crate::server::channel::client;
use crate::server::pb::mqlens::v1::auth_service_server::{AuthService, AuthServiceServer};
use crate::server::pb::mqlens::v1::connection_service_client::ConnectionServiceClient;
use crate::server::pb::mqlens::v1::connection_service_server::{
    ConnectionService, ConnectionServiceServer,
};
use crate::server::pb::mqlens::v1::{
    login_request, ConnectionRef, GetConnectionRequest, ListConnectionsRequest,
    ListConnectionsResponse, LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, Principal,
    RefreshRequest, WhoAmIRequest, WhoAmIResponse,
};
use crate::server::session::{unix_now, AccountSession, FileTokenStore, TokenStore};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tonic::{Code, Request, Response, Status};

pub(crate) const TENANT: &str = "acme";
pub(crate) const EMAIL: &str = "ops@acme.test";
pub(crate) const PASSWORD: &str = "correct horse battery staple";
pub(crate) const KEY: [u8; 32] = [7; 32];

struct RefreshRecord {
    family: u64,
    used: bool,
    revoked: bool,
}

struct AccessRecord {
    expires_at: i64,
    revoked: bool,
}

pub(crate) struct FakeState {
    next: u64,
    refresh: HashMap<String, RefreshRecord>,
    access: HashMap<String, AccessRecord>,
    /// Lifetime of issued access tokens; negative issues expired ones.
    pub access_ttl_secs: i64,
    /// Held before a refresh examines its token, widening any race.
    pub refresh_delay: Duration,
    /// Codes the next refreshes fail with, before touching the token.
    pub refresh_failures: Vec<Code>,
    pub connections: Vec<ConnectionRef>,
    pub logins: u32,
    pub refreshes: u32,
    pub logouts: u32,
    pub reuse_detected: u32,
    pub list_calls: u32,
}

impl FakeState {
    fn issue(&mut self, family: u64) -> LoginResponse {
        self.next += 1;
        let access_token = format!("access-{}", self.next);
        let refresh_token = format!("refresh-{}", self.next);
        let expires_at = unix_now() + self.access_ttl_secs;
        self.access.insert(
            access_token.clone(),
            AccessRecord {
                expires_at,
                revoked: false,
            },
        );
        self.refresh.insert(
            refresh_token.clone(),
            RefreshRecord {
                family,
                used: false,
                revoked: false,
            },
        );
        LoginResponse {
            access_token,
            refresh_token,
            expires_at,
            principal: Some(principal()),
        }
    }

    fn authenticate<T>(&self, request: &Request<T>) -> Result<(), Status> {
        let token =
            bearer(request).ok_or_else(|| Status::unauthenticated("missing bearer token"))?;
        match self.access.get(token) {
            Some(a) if !a.revoked && a.expires_at > unix_now() => Ok(()),
            _ => Err(Status::unauthenticated("invalid token")),
        }
    }

    fn revoke_family(&mut self, family: u64) {
        for record in self.refresh.values_mut().filter(|r| r.family == family) {
            record.revoked = true;
        }
    }

    /// Families that could still be refreshed.
    pub(crate) fn live_families(&self) -> usize {
        self.refresh
            .values()
            .filter(|r| !r.used && !r.revoked)
            .map(|r| r.family)
            .collect::<HashSet<_>>()
            .len()
    }
}

fn bearer<T>(request: &Request<T>) -> Option<&str> {
    request
        .metadata()
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn principal() -> Principal {
    Principal {
        tenant: TENANT.to_string(),
        user_id: "u1".to_string(),
        email: EMAIL.to_string(),
        roles: vec!["operator".to_string()],
    }
}

#[derive(Clone)]
pub(crate) struct Fake {
    state: Arc<Mutex<FakeState>>,
}

impl Fake {
    pub(crate) fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(FakeState {
                next: 0,
                refresh: HashMap::new(),
                access: HashMap::new(),
                access_ttl_secs: 3600,
                refresh_delay: Duration::ZERO,
                refresh_failures: Vec::new(),
                connections: vec![ConnectionRef {
                    id: "c1".to_string(),
                    name: "Orders".to_string(),
                    tags: vec!["prod".to_string()],
                    deployment_kind: "replica_set".to_string(),
                    op_classes: vec!["read".to_string(), "write".to_string()],
                }],
                logins: 0,
                refreshes: 0,
                logouts: 0,
                reuse_detected: 0,
                list_calls: 0,
            })),
        }
    }

    /// Serves on a loopback port and returns its `http://` URL.
    pub(crate) async fn serve(&self) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(
            tonic::transport::Server::builder()
                .add_service(AuthServiceServer::new(self.clone()))
                .add_service(ConnectionServiceServer::new(self.clone()))
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)),
        );
        format!("http://{addr}")
    }

    pub(crate) fn with<T>(&self, f: impl FnOnce(&mut FakeState) -> T) -> T {
        f(&mut self.state.lock().unwrap())
    }

    /// Refuses every access token issued so far.
    pub(crate) fn revoke_access_tokens(&self) {
        self.with(|s| s.access.values_mut().for_each(|a| a.revoked = true));
    }

    /// Forgets every session, as if each had been revoked on the server.
    pub(crate) fn forget_sessions(&self) {
        self.with(|s| {
            s.refresh.clear();
            s.access.values_mut().for_each(|a| a.revoked = true);
        });
    }
}

#[tonic::async_trait]
impl AuthService for Fake {
    async fn login(
        &self,
        request: Request<LoginRequest>,
    ) -> Result<Response<LoginResponse>, Status> {
        let message = request.into_inner();
        let mut state = self.state.lock().unwrap();
        state.logins += 1;
        match message.login {
            Some(login_request::Login::Local(creds))
                if message.tenant == TENANT
                    && creds.email == EMAIL
                    && creds.password == PASSWORD =>
            {
                state.next += 1;
                let family = state.next;
                Ok(Response::new(state.issue(family)))
            }
            _ => Err(Status::unauthenticated("invalid login")),
        }
    }

    async fn refresh(
        &self,
        request: Request<RefreshRequest>,
    ) -> Result<Response<LoginResponse>, Status> {
        let delay = self.with(|s| s.refresh_delay);
        tokio::time::sleep(delay).await;

        let token = request.into_inner().refresh_token;
        let mut state = self.state.lock().unwrap();
        state.refreshes += 1;
        if !state.refresh_failures.is_empty() {
            let code = state.refresh_failures.remove(0);
            return Err(Status::new(code, "injected failure"));
        }
        let (family, used) = match state.refresh.get(&token) {
            Some(r) if !r.revoked => (r.family, r.used),
            _ => return Err(Status::unauthenticated("invalid login")),
        };
        if used {
            state.reuse_detected += 1;
            state.revoke_family(family);
            state.access.values_mut().for_each(|a| a.revoked = true);
            return Err(Status::unauthenticated("invalid login"));
        }
        state.refresh.get_mut(&token).unwrap().used = true;
        Ok(Response::new(state.issue(family)))
    }

    async fn logout(
        &self,
        request: Request<LogoutRequest>,
    ) -> Result<Response<LogoutResponse>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authenticate(&request)?;
        state.logouts += 1;
        if let Some(access) = bearer(&request).and_then(|t| state.access.get_mut(t)) {
            access.revoked = true;
        }
        if let Some(family) = state
            .refresh
            .get(&request.get_ref().refresh_token)
            .map(|r| r.family)
        {
            state.revoke_family(family);
        }
        Ok(Response::new(LogoutResponse {}))
    }

    async fn who_am_i(
        &self,
        request: Request<WhoAmIRequest>,
    ) -> Result<Response<WhoAmIResponse>, Status> {
        self.state.lock().unwrap().authenticate(&request)?;
        Ok(Response::new(WhoAmIResponse {
            principal: Some(principal()),
        }))
    }
}

#[tonic::async_trait]
impl ConnectionService for Fake {
    async fn list_connections(
        &self,
        request: Request<ListConnectionsRequest>,
    ) -> Result<Response<ListConnectionsResponse>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authenticate(&request)?;
        state.list_calls += 1;
        Ok(Response::new(ListConnectionsResponse {
            connections: state.connections.clone(),
        }))
    }

    async fn get_connection(
        &self,
        _request: Request<GetConnectionRequest>,
    ) -> Result<Response<ConnectionRef>, Status> {
        Err(Status::unimplemented("GetConnection is not implemented"))
    }
}

/// A fake server with one saved account for it, in a temporary accounts file.
pub(crate) struct Env {
    pub fake: Fake,
    pub path: PathBuf,
    pub account: ServerAccount,
    _dir: tempfile::TempDir,
}

impl Env {
    pub(crate) async fn new() -> Self {
        let fake = Fake::new();
        let url = fake.serve().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(accounts::ACCOUNTS_FILE_NAME);
        let (account, _) = accounts::save_account(
            &path,
            &KEY,
            ServerAccountInput {
                id: None,
                name: "Acme".to_string(),
                url,
                tenant: TENANT.to_string(),
                email: EMAIL.to_string(),
                allow_insecure_http: false,
                extra_ca_pem: None,
            },
        )
        .unwrap();
        Self {
            fake,
            path,
            account,
            _dir: dir,
        }
    }

    pub(crate) fn store(&self) -> Arc<dyn TokenStore> {
        file_store(&self.path)
    }

    /// The account as it is on disk now.
    pub(crate) fn stored_account(&self) -> ServerAccount {
        accounts::find(&self.path, &KEY, &self.account.id).unwrap()
    }

    pub(crate) fn stored_token(&self) -> Option<String> {
        self.stored_account().refresh_token
    }
}

pub(crate) fn file_store(path: &Path) -> Arc<dyn TokenStore> {
    Arc::new(FileTokenStore::new(
        path.to_path_buf(),
        Arc::new(|| Ok(KEY)),
    ))
}

pub(crate) async fn list_connections(
    session: &AccountSession,
) -> Result<Vec<ConnectionRef>, String> {
    session
        .call(ListConnectionsRequest {}, |channel, request| async move {
            client!(ConnectionServiceClient, channel)
                .list_connections(request)
                .await
        })
        .await
        .map(|response| response.connections)
}
