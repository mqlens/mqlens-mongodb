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
use crate::server::pb::mqlens::v1::capability_service_server::{
    CapabilityService, CapabilityServiceServer,
};
use crate::server::pb::mqlens::v1::connection_service_client::ConnectionServiceClient;
use crate::server::pb::mqlens::v1::connection_service_server::{
    ConnectionService, ConnectionServiceServer,
};
use crate::server::pb::mqlens::v1::metadata_service_server::{
    MetadataService, MetadataServiceServer,
};
use crate::server::pb::mqlens::v1::{
    login_request, ConnectionRef, GetConnectionRequest, ListConnectionsRequest,
    ListConnectionsResponse, LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, Principal,
    RefreshRequest, WhoAmIRequest, WhoAmIResponse,
};
use crate::server::pb::mqlens::v1::{
    CollectionInfo as PbCollectionInfo, ConnectionCapabilities, CreateIndexRequest,
    DropIndexRequest, GetCapabilitiesRequest, GetCapabilitiesResponse, IndexInfo as PbIndexInfo,
    ListCollectionsRequest, ListCollectionsResponse, ListDatabasesRequest, ListDatabasesResponse,
    ListIndexesRequest, ListIndexesResponse, MetadataAck, MongoVersionRequest,
    MongoVersionResponse,
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
    /// Held before a login answers, so a test can act while it is in flight.
    pub login_delay: Duration,
    /// Held before ListConnections answers, to play a server that stalls.
    pub list_delay: Duration,
    /// Held before a logout answers, to play a slow server.
    pub logout_delay: Duration,
    /// Codes the next refreshes fail with, before touching the token.
    pub refresh_failures: Vec<Code>,
    /// Refresh RPCs that have started, including ones still waiting on delay.
    pub refresh_starts: u32,
    /// Codes the next logouts fail with, before ending the session.
    pub logout_failures: Vec<Code>,
    pub connections: Vec<ConnectionRef>,
    /// Feature strings GetCapabilities announces.
    pub features: Vec<String>,
    /// A code MongoVersion fails with, to play an unreachable deployment.
    pub version_failure: Option<Code>,
    /// Procedures GetCapabilities announces.
    pub procedures: Vec<String>,
    /// What the metadata procedures answer, for any connection the caller
    /// can reach.
    pub databases: Vec<String>,
    pub collections: Vec<PbCollectionInfo>,
    pub indexes: Vec<PbIndexInfo>,
    pub logins: u32,
    pub refreshes: u32,
    pub logouts: u32,
    pub reuse_detected: u32,
    pub list_calls: u32,
    pub login_starts: u32,
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

    /// A signed-in caller asking about a connection it can reach.
    fn authorize_connection<T>(
        &self,
        request: &Request<T>,
        connection_id: &str,
    ) -> Result<(), Status> {
        self.authenticate(request)?;
        if self.connections.iter().any(|c| c.id == connection_id) {
            Ok(())
        } else {
            Err(Status::not_found("connection not found"))
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
                login_delay: Duration::ZERO,
                list_delay: Duration::ZERO,
                logout_delay: Duration::ZERO,
                refresh_failures: Vec::new(),
                refresh_starts: 0,
                logout_failures: Vec::new(),
                connections: vec![ConnectionRef {
                    id: "c1".to_string(),
                    name: "Orders".to_string(),
                    tags: vec!["prod".to_string()],
                    deployment_kind: "replica_set".to_string(),
                    op_classes: vec!["read".to_string(), "write".to_string()],
                }],
                features: vec!["documents.raw_bson".to_string()],
                version_failure: None,
                procedures: [
                    "MetadataService/ListDatabases",
                    "MetadataService/ListCollections",
                    "MetadataService/ListIndexes",
                    "MetadataService/MongoVersion",
                ]
                .iter()
                .map(|p| format!("/mqlens.v1.{p}"))
                .collect(),
                databases: vec!["admin".to_string(), "orders".to_string()],
                collections: [
                    ("customers", "collection"),
                    ("recent", "view"),
                    ("metrics", "timeseries"),
                    // A server that could not tell the type.
                    ("legacy", ""),
                ]
                .iter()
                .map(|(name, kind)| PbCollectionInfo {
                    name: name.to_string(),
                    r#type: kind.to_string(),
                })
                .collect(),
                indexes: vec![
                    PbIndexInfo {
                        name: "_id_".to_string(),
                        keys_json: r#"{"_id":{"$numberInt":"1"}}"#.to_string(),
                        unique: false,
                        sparse: false,
                    },
                    PbIndexInfo {
                        name: "z_1_a_-1".to_string(),
                        keys_json: r#"{"z":{"$numberInt":"1"},"a":{"$numberInt":"-1"}}"#
                            .to_string(),
                        unique: true,
                        sparse: true,
                    },
                    PbIndexInfo {
                        name: "loc_2dsphere".to_string(),
                        keys_json: r#"{"loc":"2dsphere"}"#.to_string(),
                        unique: false,
                        sparse: false,
                    },
                ],
                logins: 0,
                refreshes: 0,
                logouts: 0,
                reuse_detected: 0,
                list_calls: 0,
                login_starts: 0,
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
                .add_service(CapabilityServiceServer::new(self.clone()))
                .add_service(MetadataServiceServer::new(self.clone()))
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
        let delay = self.with(|s| {
            s.login_starts += 1;
            s.login_delay
        });
        tokio::time::sleep(delay).await;
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
        let delay = self.with(|s| {
            s.refresh_starts += 1;
            s.refresh_delay
        });
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
        let delay = self.with(|s| s.logout_delay);
        tokio::time::sleep(delay).await;
        let mut state = self.state.lock().unwrap();
        state.authenticate(&request)?;
        if !state.logout_failures.is_empty() {
            let code = state.logout_failures.remove(0);
            return Err(Status::new(code, "injected failure"));
        }
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
        let delay = self.with(|s| s.list_delay);
        tokio::time::sleep(delay).await;
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

#[tonic::async_trait]
impl CapabilityService for Fake {
    async fn get_capabilities(
        &self,
        request: Request<GetCapabilitiesRequest>,
    ) -> Result<Response<GetCapabilitiesResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authenticate(&request)?;
        // Empty op classes for an id the caller cannot reach, existing or not.
        let connections = request
            .get_ref()
            .connection_ids
            .iter()
            .map(|id| ConnectionCapabilities {
                connection_id: id.clone(),
                op_classes: state
                    .connections
                    .iter()
                    .find(|c| &c.id == id)
                    .map(|c| c.op_classes.clone())
                    .unwrap_or_default(),
            })
            .collect();
        Ok(Response::new(GetCapabilitiesResponse {
            server_version: "fake".to_string(),
            procedures: state.procedures.clone(),
            features: state.features.clone(),
            principal: Some(principal()),
            connections,
        }))
    }
}

/// Only MongoVersion, the ping a connect makes; the read adapters bring more.
#[tonic::async_trait]
impl MetadataService for Fake {
    async fn list_databases(
        &self,
        request: Request<ListDatabasesRequest>,
    ) -> Result<Response<ListDatabasesResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(ListDatabasesResponse {
            databases: state.databases.clone(),
        }))
    }

    async fn list_collections(
        &self,
        request: Request<ListCollectionsRequest>,
    ) -> Result<Response<ListCollectionsResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(ListCollectionsResponse {
            collections: state.collections.clone(),
        }))
    }

    async fn mongo_version(
        &self,
        request: Request<MongoVersionRequest>,
    ) -> Result<Response<MongoVersionResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authenticate(&request)?;
        if let Some(code) = state.version_failure {
            return Err(Status::new(code, "injected failure"));
        }
        if !state
            .connections
            .iter()
            .any(|c| c.id == request.get_ref().connection_id)
        {
            return Err(Status::not_found("connection not found"));
        }
        Ok(Response::new(MongoVersionResponse {
            version: "8.0.4".to_string(),
        }))
    }

    async fn list_indexes(
        &self,
        request: Request<ListIndexesRequest>,
    ) -> Result<Response<ListIndexesResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(ListIndexesResponse {
            indexes: state.indexes.clone(),
        }))
    }

    async fn create_index(
        &self,
        _request: Request<CreateIndexRequest>,
    ) -> Result<Response<MetadataAck>, Status> {
        Err(Status::unimplemented("CreateIndex is not implemented"))
    }

    async fn drop_index(
        &self,
        _request: Request<DropIndexRequest>,
    ) -> Result<Response<MetadataAck>, Status> {
        Err(Status::unimplemented("DropIndex is not implemented"))
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
        write_vault_meta(&path, &KEY);
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

/// Writes, beside an accounts file, the vault metadata of a vault whose key is
/// `key`, as the real vault keeps it in the same config directory.
pub(crate) fn write_vault_meta(accounts_path: &Path, key: &[u8; 32]) {
    use base64::Engine;
    let verifier = crate::vault::encrypt(key, crate::vault::VERIFIER_PLAINTEXT).unwrap();
    let meta = crate::connections::VaultMeta {
        version: 1,
        kdf_alg: "argon2id".to_string(),
        kdf_m_kib: 8,
        kdf_t: 1,
        kdf_p: 1,
        salt: base64::engine::general_purpose::STANDARD.encode([0u8; 16]),
        verifier: base64::engine::general_purpose::STANDARD.encode(verifier),
    };
    crate::connections::write_vault_meta(&accounts::vault_meta_path(accounts_path), &meta).unwrap();
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
