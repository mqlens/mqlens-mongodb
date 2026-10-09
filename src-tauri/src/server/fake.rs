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
use crate::server::pb::mqlens::v1::data_service_server::{DataService, DataServiceServer};
use crate::server::pb::mqlens::v1::ddl_service_server::{DdlService, DdlServiceServer};
use crate::server::pb::mqlens::v1::deployment_user_service_server::{
    DeploymentUserService, DeploymentUserServiceServer,
};
use crate::server::pb::mqlens::v1::grid_fs_service_server::{GridFsService, GridFsServiceServer};
use crate::server::pb::mqlens::v1::metadata_service_server::{
    MetadataService, MetadataServiceServer,
};
use crate::server::pb::mqlens::v1::monitoring_service_server::{
    MonitoringService, MonitoringServiceServer,
};
use crate::server::pb::mqlens::v1::shell_service_server::{ShellService, ShellServiceServer};
use crate::server::pb::mqlens::v1::stats_service_server::{StatsService, StatsServiceServer};
use crate::server::pb::mqlens::v1::write_service_server::{WriteService, WriteServiceServer};
use crate::server::pb::mqlens::v1::{
    login_request, ConnectionRef, GetConnectionRequest, ListConnectionsRequest,
    ListConnectionsResponse, LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, Principal,
    RefreshRequest, WhoAmIRequest, WhoAmIResponse,
};
use crate::server::pb::mqlens::v1::{
    AggregateRequest, CountRequest, CountResponse, ExplainRequest, ExplainResponse, FindBatch,
    FindRequest,
};
use crate::server::pb::mqlens::v1::{
    CacheStats as PbCacheStats, CurrentOpsRequest, CurrentOpsResponse, GetProfilingStatusRequest,
    KillOpRequest, MonitoringAck, OpCounters as PbOpCounters, ProfilingStatus as PbProfilingStatus,
    ReadProfileRequest, ReadProfileResponse, ReplSetMember as PbReplSetMember,
    ReplSetStatusRequest, ReplSetStatusResponse, ServerConnections, ServerMemory, ServerNetwork,
    ServerStatusRequest, ServerStatusResponse, SetProfilingLevelRequest,
};
use crate::server::pb::mqlens::v1::{
    CollStatsRequest, CollStatsResponse, DbStatsRequest, DbStatsResponse, IndexStat,
    IndexStatsRequest, IndexStatsResponse,
};
use crate::server::pb::mqlens::v1::{
    CollectionInfo as PbCollectionInfo, ConnectionCapabilities, CreateIndexRequest,
    DropIndexRequest, GetCapabilitiesRequest, GetCapabilitiesResponse, IndexInfo as PbIndexInfo,
    ListCollectionsRequest, ListCollectionsResponse, ListDatabasesRequest, ListDatabasesResponse,
    ListIndexesRequest, ListIndexesResponse, MetadataAck, MongoVersionRequest,
    MongoVersionResponse,
};
use crate::server::pb::mqlens::v1::{
    CollectionValidation as PbCollectionValidation, CreateCollectionRequest,
    CreateDeploymentUserRequest, CreateViewRequest, DdlAck, DeploymentRole, DeploymentUser,
    DeploymentUserAck, DropCollectionRequest, DropDatabaseRequest, DropDeploymentUserRequest,
    GetCollectionOptionsRequest, ListDeploymentRolesRequest, ListDeploymentRolesResponse,
    ListDeploymentUsersRequest, ListDeploymentUsersResponse, RenameCollectionRequest,
    RenameDatabaseDetailedRequest, RenameDatabaseRequest, RenameDatabaseResult,
    RoleSpec as PbRoleSpec, SetValidatorRequest, UpdateDeploymentUserRequest,
};
use crate::server::pb::mqlens::v1::{CurrentOp as PbCurrentOp, ProfileEntry as PbProfileEntry};
use crate::server::pb::mqlens::v1::{
    DeleteDocumentRequest, DeleteManyRequest, InsertDocumentRequest, InsertDocumentResponse,
    ReplaceDocumentRequest, UpdateDocumentRequest, UpdateManyRequest, WriteResult,
};
use crate::server::pb::mqlens::v1::{
    DeleteFileRequest, DeleteFileResponse, DownloadFileRequest, FileChunk, ListFilesRequest,
    ListFilesResponse, UploadChunk, UploadFileResponse,
};
use crate::server::pb::mqlens::v1::{MongoshClientMsg, MongoshServerMsg};
use crate::server::session::{unix_now, AccountSession, FileTokenStore, TokenStore};
use mongodb::bson::{doc, Document};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::pin::Pin;
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
    /// The MQLens API versions GetCapabilities announces and requests may speak.
    pub min_api_version: u32,
    pub max_api_version: u32,
    /// The version each authenticated request spoke, 1 when it sent none.
    pub api_versions_seen: std::cell::RefCell<Vec<u32>>,
    /// A code MongoVersion fails with, to play an unreachable deployment.
    pub version_failure: Option<Code>,
    /// What the metadata procedures answer, for any connection the caller
    /// can reach.
    pub databases: Vec<String>,
    pub collections: Vec<PbCollectionInfo>,
    pub indexes: Vec<PbIndexInfo>,
    /// The documents Find and Aggregate stream, in batches of `batch_size`.
    pub documents: Vec<Document>,
    pub batch_size: usize,
    /// Held before each batch, to play a server that stalls mid-stream.
    pub batch_delay: Duration,
    pub last_find: Option<FindRequest>,
    pub last_aggregate: Option<AggregateRequest>,
    /// What Count answers, and the last request it got.
    pub count_result: i64,
    pub last_count: Option<CountRequest>,
    /// Every write and index change received, in order.
    pub writes: Vec<FakeWrite>,
    /// What the document writes answer.
    pub write_result: WriteResult,
    /// The file documents ListFiles returns, as stored.
    pub gridfs_files: Vec<Document>,
    /// The bytes DownloadFile streams, in messages of `gridfs_chunk` bytes.
    pub gridfs_content: Vec<u8>,
    pub gridfs_chunk: usize,
    /// Each upload received: its first message without data, and every byte.
    pub uploads: Vec<(UploadChunk, Vec<u8>)>,
    /// Held after an upload's last byte, before answering it.
    pub upload_delay: Duration,
    /// The download and delete requests received.
    pub gridfs_requests: Vec<FakeGridFs>,
    /// Each shell's first message without input, every line the shells were
    /// sent, and how many shells have ended.
    pub shells: Vec<MongoshClientMsg>,
    pub shell_input: Vec<String>,
    pub shells_ended: u32,
    /// Ends every new shell at once with an error, as a mongosh that cannot
    /// start would.
    pub shell_start_failure: bool,
    /// What RenameDatabaseDetailed reports.
    pub rename_result: RenameDatabaseResult,
    /// The id InsertDocument reports.
    pub inserted_id: mongodb::bson::Bson,
    /// The plan Explain answers, and the last request it got.
    pub explain_plan: Document,
    pub last_explain: Option<ExplainRequest>,
    pub data_calls: u32,
    /// Streams the client stopped reading before the end.
    pub streams_abandoned: u32,
    /// What the stats procedures answer.
    pub db_stats: DbStatsResponse,
    pub coll_stats: CollStatsResponse,
    pub index_stats: Vec<IndexStat>,
    /// What the read-class monitoring procedures answer.
    pub server_status: ServerStatusResponse,
    pub repl_set_status: ReplSetStatusResponse,
    pub profiling_status: PbProfilingStatus,
    /// What CurrentOps and ReadProfile answer.
    pub current_ops: Vec<PbCurrentOp>,
    pub profile: Vec<PbProfileEntry>,
    /// The admin monitoring calls received, in order.
    pub admin_calls: Vec<FakeAdmin>,
    /// What GetCollectionOptions, ListUsers and ListRoles answer.
    pub collection_options: PbCollectionValidation,
    pub users: Vec<DeploymentUser>,
    pub roles: Vec<DeploymentRole>,
    /// The database the last ListUsers asked about; empty means all.
    pub last_users_database: Option<String>,
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
        let version = match request.metadata().get("mqlens-api-version") {
            None => 1,
            Some(v) => v
                .to_str()
                .ok()
                .and_then(|v| v.parse::<u32>().ok())
                .ok_or_else(|| Status::invalid_argument("bad mqlens-api-version"))?,
        };
        if version < self.min_api_version || version > self.max_api_version {
            return Err(Status::failed_precondition("API version not served"));
        }
        self.api_versions_seen.borrow_mut().push(version);
        self.authenticate_any_version(request)
    }

    /// For the calls a client makes before it has agreed a version, which the
    /// server answers whatever version they name.
    fn authenticate_any_version<T>(&self, request: &Request<T>) -> Result<(), Status> {
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
                min_api_version: 1,
                max_api_version: 2,
                api_versions_seen: std::cell::RefCell::new(Vec::new()),
                version_failure: None,
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
                documents: vec![
                    doc! { "_id": 1, "name": "Ada", "total": 12.5 },
                    // Keys that look like an Extended JSON wrapper, stored as
                    // a plain sub-document.
                    doc! { "_id": 2, "nested": { "$numberLong": "7", "other": 1 } },
                    doc! { "_id": 3, "big": 9_007_199_254_740_993_i64 },
                ],
                batch_size: 100,
                batch_delay: Duration::ZERO,
                last_find: None,
                last_aggregate: None,
                count_result: 0,
                writes: Vec::new(),
                write_result: WriteResult {
                    matched_count: 1,
                    modified_count: 1,
                    deleted_count: 1,
                    upserted_id_json: String::new(),
                },
                gridfs_files: Vec::new(),
                gridfs_content: Vec::new(),
                gridfs_chunk: 4,
                uploads: Vec::new(),
                upload_delay: Duration::ZERO,
                gridfs_requests: Vec::new(),
                shells: Vec::new(),
                shell_input: Vec::new(),
                shells_ended: 0,
                shell_start_failure: false,
                rename_result: RenameDatabaseResult {
                    collections: 2,
                    documents: 40,
                },
                inserted_id: mongodb::bson::Bson::ObjectId(
                    mongodb::bson::oid::ObjectId::parse_str("64b7f0c2a1b2c3d4e5f60718").unwrap(),
                ),
                last_count: None,
                explain_plan: Document::new(),
                last_explain: None,
                data_calls: 0,
                streams_abandoned: 0,
                db_stats: DbStatsResponse {
                    collections: 4,
                    views: 1,
                    objects: 12_345,
                    avg_obj_size: 512.5,
                    data_size: 6_327_000,
                    storage_size: 8_192_000,
                    indexes: 9,
                    total_index_size: 1_048_576,
                },
                coll_stats: CollStatsResponse {
                    count: 3_000,
                    avg_obj_size: 128.25,
                    size: 384_750,
                    storage_size: 409_600,
                    nindexes: 3,
                    total_index_size: 98_304,
                    capped: true,
                },
                server_status: ServerStatusResponse {
                    host: "db-1.acme.internal:27017".to_string(),
                    version: "8.0.4".to_string(),
                    uptime_seconds: 86_400.5,
                    connections: Some(ServerConnections {
                        current: 12,
                        available: 838_848,
                        total_created: 345,
                    }),
                    opcounters: Some(PbOpCounters {
                        insert: 1,
                        query: 2,
                        update: 3,
                        delete: 4,
                        getmore: 5,
                        command: 6,
                    }),
                    memory: Some(ServerMemory {
                        resident_mb: 512,
                        virtual_mb: 2_048,
                    }),
                    network: Some(ServerNetwork {
                        bytes_in: 1_000,
                        bytes_out: 2_000,
                        num_requests: 30,
                    }),
                    cache: Some(PbCacheStats {
                        bytes_in_cache: 7,
                        max_bytes: 8,
                        dirty_bytes: 9,
                    }),
                    repl_set: Some("rs0".to_string()),
                },
                repl_set_status: ReplSetStatusResponse {
                    is_replica_set: true,
                    cluster_type: "replicaSet".to_string(),
                    set: "rs0".to_string(),
                    my_state_str: "PRIMARY".to_string(),
                    mongo_version: "8.0.4".to_string(),
                    members: vec![
                        PbReplSetMember {
                            name: "db-1:27017".to_string(),
                            state_str: "PRIMARY".to_string(),
                            health: 1,
                            self_: true,
                            uptime_secs: 86_400,
                            optime_date_ms: 1_700_000_000_000,
                            ping_ms: None,
                            sync_source: String::new(),
                            lag_secs: None,
                        },
                        PbReplSetMember {
                            name: "db-2:27017".to_string(),
                            state_str: "SECONDARY".to_string(),
                            health: 1,
                            self_: false,
                            uptime_secs: 86_000,
                            optime_date_ms: 1_699_999_999_000,
                            ping_ms: Some(3),
                            sync_source: "db-1:27017".to_string(),
                            lag_secs: Some(1.5),
                        },
                    ],
                },
                profiling_status: PbProfilingStatus {
                    level: 1,
                    slow_ms: 250,
                },
                current_ops: Vec::new(),
                profile: Vec::new(),
                admin_calls: Vec::new(),
                collection_options: PbCollectionValidation {
                    validator: r#"{"$jsonSchema":{"required":["email"],"properties":{"age":{"minimum":0}}}}"#
                        .to_string(),
                    validation_level: "strict".to_string(),
                    validation_action: "error".to_string(),
                },
                users: vec![DeploymentUser {
                    user: "app".to_string(),
                    db: "orders".to_string(),
                    roles: vec![PbRoleSpec {
                        role: "readWrite".to_string(),
                        db: "orders".to_string(),
                    }],
                    mechanisms: vec!["SCRAM-SHA-256".to_string()],
                }],
                roles: vec![
                    DeploymentRole {
                        role: "read".to_string(),
                        db: "orders".to_string(),
                        is_builtin: true,
                    },
                    DeploymentRole {
                        role: "reporting".to_string(),
                        db: "orders".to_string(),
                        is_builtin: false,
                    },
                ],
                last_users_database: None,
                // Not in size order: local mode sorts them, largest first.
                index_stats: vec![
                    IndexStat {
                        name: "_id_".to_string(),
                        size_bytes: 4_096,
                        ops: 10,
                        since_ms: 1_700_000_000_000,
                    },
                    IndexStat {
                        name: "email_1".to_string(),
                        size_bytes: 65_536,
                        ops: 900,
                        since_ms: 1_700_000_100_000,
                    },
                    IndexStat {
                        name: "created_-1".to_string(),
                        size_bytes: 16_384,
                        ops: 0,
                        since_ms: 0,
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
                .add_service(DataServiceServer::new(self.clone()))
                .add_service(StatsServiceServer::new(self.clone()))
                .add_service(MonitoringServiceServer::new(self.clone()))
                .add_service(DdlServiceServer::new(self.clone()))
                .add_service(WriteServiceServer::new(self.clone()))
                .add_service(GridFsServiceServer::new(self.clone()))
                .add_service(DeploymentUserServiceServer::new(self.clone()))
                .add_service(ShellServiceServer::new(self.clone()))
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
        state.authenticate_any_version(&request)?;
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
        state.authenticate_any_version(&request)?;
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
        state.authenticate_any_version(&request)?;
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
            min_api_version: state.min_api_version,
            max_api_version: state.max_api_version,
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
        request: Request<CreateIndexRequest>,
    ) -> Result<Response<MetadataAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .writes
            .push(FakeWrite::CreateIndex(request.into_inner()));
        Ok(Response::new(MetadataAck {}))
    }

    async fn drop_index(
        &self,
        request: Request<DropIndexRequest>,
    ) -> Result<Response<MetadataAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .writes
            .push(FakeWrite::DropIndex(request.into_inner()));
        Ok(Response::new(MetadataAck {}))
    }
}

/// A GridFS download or delete the fake received.
#[derive(Clone, Debug)]
pub(crate) enum FakeGridFs {
    Download(DownloadFileRequest),
    Delete(DeleteFileRequest),
}

type FileChunks = Pin<Box<dyn tokio_stream::Stream<Item = Result<FileChunk, Status>> + Send>>;

#[tonic::async_trait]
impl GridFsService for Fake {
    async fn list_files(
        &self,
        request: Request<ListFilesRequest>,
    ) -> Result<Response<ListFilesResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        let mut files_bson = Vec::new();
        for doc in &state.gridfs_files {
            let mut bytes = Vec::new();
            doc.to_writer(&mut bytes).unwrap();
            files_bson.push(bytes.into());
        }
        Ok(Response::new(ListFilesResponse {
            files_ejson: Vec::new(),
            files_bson,
        }))
    }

    type DownloadFileStream = FileChunks;

    async fn download_file(
        &self,
        request: Request<DownloadFileRequest>,
    ) -> Result<Response<Self::DownloadFileStream>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .gridfs_requests
            .push(FakeGridFs::Download(request.into_inner()));
        let chunks: Vec<Result<FileChunk, Status>> = state
            .gridfs_content
            .chunks(state.gridfs_chunk.max(1))
            .map(|data| {
                Ok(FileChunk {
                    data: data.to_vec().into(),
                })
            })
            .collect();
        Ok(Response::new(Box::pin(tokio_stream::iter(chunks))))
    }

    async fn upload_file(
        &self,
        request: Request<tonic::Streaming<UploadChunk>>,
    ) -> Result<Response<UploadFileResponse>, Status> {
        let (metadata, extensions, mut stream) = request.into_parts();
        let mut first = stream
            .message()
            .await?
            .ok_or_else(|| Status::invalid_argument("empty upload"))?;
        {
            let state = self.state.lock().unwrap();
            let check = Request::from_parts(metadata, extensions, ());
            state.authorize_connection(&check, &first.connection_id)?;
        }
        let mut data = std::mem::take(&mut first.data).to_vec();
        while let Some(chunk) = stream.message().await? {
            data.extend_from_slice(&chunk.data);
        }
        let delay = {
            let mut state = self.state.lock().unwrap();
            state.uploads.push((first, data));
            state.upload_delay
        };
        tokio::time::sleep(delay).await;
        Ok(Response::new(UploadFileResponse {
            file_id_ejson: r#"{"_id":{"$oid":"64b7f0c2a1b2c3d4e5f60719"}}"#.to_string(),
        }))
    }

    async fn delete_file(
        &self,
        request: Request<DeleteFileRequest>,
    ) -> Result<Response<DeleteFileResponse>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .gridfs_requests
            .push(FakeGridFs::Delete(request.into_inner()));
        Ok(Response::new(DeleteFileResponse {}))
    }
}

/// A write or index change the fake received.
#[derive(Clone, Debug)]
pub(crate) enum FakeWrite {
    Insert(InsertDocumentRequest),
    Update(UpdateDocumentRequest),
    Replace(ReplaceDocumentRequest),
    Delete(DeleteDocumentRequest),
    UpdateMany(UpdateManyRequest),
    DeleteMany(DeleteManyRequest),
    CreateIndex(CreateIndexRequest),
    DropIndex(DropIndexRequest),
    CreateCollection(CreateCollectionRequest),
    DropCollection(DropCollectionRequest),
    RenameCollection(RenameCollectionRequest),
    CreateView(CreateViewRequest),
    DropDatabase(DropDatabaseRequest),
    RenameDatabase(RenameDatabaseDetailedRequest),
    SetValidator(SetValidatorRequest),
}

impl Fake {
    /// Records a write and answers it with the configured result.
    fn write<T>(
        &self,
        request: Request<T>,
        connection_id: impl Fn(&T) -> &str,
        record: impl FnOnce(T) -> FakeWrite,
    ) -> Result<Response<WriteResult>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, connection_id(request.get_ref()))?;
        state.writes.push(record(request.into_inner()));
        Ok(Response::new(state.write_result.clone()))
    }
}

#[tonic::async_trait]
impl WriteService for Fake {
    async fn insert_document(
        &self,
        request: Request<InsertDocumentRequest>,
    ) -> Result<Response<InsertDocumentResponse>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state.writes.push(FakeWrite::Insert(request.into_inner()));
        Ok(Response::new(InsertDocumentResponse {
            inserted_id_json: state
                .inserted_id
                .clone()
                .into_canonical_extjson()
                .to_string(),
        }))
    }

    async fn update_document(
        &self,
        request: Request<UpdateDocumentRequest>,
    ) -> Result<Response<WriteResult>, Status> {
        self.write(request, |r| &r.connection_id, FakeWrite::Update)
    }

    async fn replace_document(
        &self,
        request: Request<ReplaceDocumentRequest>,
    ) -> Result<Response<WriteResult>, Status> {
        self.write(request, |r| &r.connection_id, FakeWrite::Replace)
    }

    async fn delete_document(
        &self,
        request: Request<DeleteDocumentRequest>,
    ) -> Result<Response<WriteResult>, Status> {
        self.write(request, |r| &r.connection_id, FakeWrite::Delete)
    }

    async fn update_many(
        &self,
        request: Request<UpdateManyRequest>,
    ) -> Result<Response<WriteResult>, Status> {
        self.write(request, |r| &r.connection_id, FakeWrite::UpdateMany)
    }

    async fn delete_many(
        &self,
        request: Request<DeleteManyRequest>,
    ) -> Result<Response<WriteResult>, Status> {
        self.write(request, |r| &r.connection_id, FakeWrite::DeleteMany)
    }
}

type Batches = Pin<Box<dyn tokio_stream::Stream<Item = Result<FindBatch, Status>> + Send>>;

impl Fake {
    /// The stored documents as raw BSON, in batches, each after
    /// `batch_delay`. Counts a stream the client drops before the end.
    /// The stored documents in batches, at most `limit` of them (0: all).
    fn batches(&self, limit: usize) -> Batches {
        let (mut documents, size, delay) =
            self.with(|s| (s.documents.clone(), s.batch_size.max(1), s.batch_delay));
        if limit > 0 {
            documents.truncate(limit);
        }
        let state = self.state.clone();
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        tokio::spawn(async move {
            for chunk in documents.chunks(size) {
                tokio::time::sleep(delay).await;
                let batch = FindBatch {
                    documents_ejson: Vec::new(),
                    documents_bson: chunk
                        .iter()
                        .map(|d| {
                            let mut bytes = Vec::new();
                            d.to_writer(&mut bytes).unwrap();
                            bytes.into()
                        })
                        .collect(),
                };
                if tx.send(Ok(batch)).await.is_err() {
                    state.lock().unwrap().streams_abandoned += 1;
                    return;
                }
            }
        });
        Box::pin(tokio_stream::wrappers::ReceiverStream::new(rx))
    }
}

#[tonic::async_trait]
impl DataService for Fake {
    type FindStream = Batches;
    type AggregateStream = Batches;

    async fn find(
        &self,
        request: Request<FindRequest>,
    ) -> Result<Response<Self::FindStream>, Status> {
        {
            let mut state = self.state.lock().unwrap();
            state.authorize_connection(&request, &request.get_ref().connection_id)?;
            state.data_calls += 1;
            state.last_find = Some(request.get_ref().clone());
        }
        let limit = usize::try_from(request.get_ref().limit).unwrap_or(0);
        Ok(Response::new(self.batches(limit)))
    }

    async fn aggregate(
        &self,
        request: Request<AggregateRequest>,
    ) -> Result<Response<Self::AggregateStream>, Status> {
        {
            let mut state = self.state.lock().unwrap();
            state.authorize_connection(&request, &request.get_ref().connection_id)?;
            state.data_calls += 1;
            state.last_aggregate = Some(request.get_ref().clone());
        }
        Ok(Response::new(self.batches(0)))
    }

    async fn count(
        &self,
        request: Request<CountRequest>,
    ) -> Result<Response<CountResponse>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state.last_count = Some(request.get_ref().clone());
        Ok(Response::new(CountResponse {
            count: state.count_result,
        }))
    }

    async fn explain(
        &self,
        request: Request<ExplainRequest>,
    ) -> Result<Response<ExplainResponse>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state.last_explain = Some(request.get_ref().clone());
        Ok(Response::new(ExplainResponse {
            plan_json: mongodb::bson::Bson::Document(state.explain_plan.clone())
                .into_canonical_extjson()
                .to_string(),
        }))
    }
}

#[tonic::async_trait]
impl StatsService for Fake {
    async fn db_stats(
        &self,
        request: Request<DbStatsRequest>,
    ) -> Result<Response<DbStatsResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(state.db_stats))
    }

    async fn coll_stats(
        &self,
        request: Request<CollStatsRequest>,
    ) -> Result<Response<CollStatsResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(state.coll_stats))
    }

    async fn index_stats(
        &self,
        request: Request<IndexStatsRequest>,
    ) -> Result<Response<IndexStatsResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(IndexStatsResponse {
            indexes: state.index_stats.clone(),
        }))
    }
}

/// The read-class monitoring procedures; the admin ones come with D5.
#[tonic::async_trait]
impl MonitoringService for Fake {
    async fn server_status(
        &self,
        request: Request<ServerStatusRequest>,
    ) -> Result<Response<ServerStatusResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(state.server_status.clone()))
    }

    async fn current_ops(
        &self,
        request: Request<CurrentOpsRequest>,
    ) -> Result<Response<CurrentOpsResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(CurrentOpsResponse {
            ops: state.current_ops.clone(),
            truncated: false,
        }))
    }

    async fn repl_set_status(
        &self,
        request: Request<ReplSetStatusRequest>,
    ) -> Result<Response<ReplSetStatusResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(state.repl_set_status.clone()))
    }

    async fn kill_op(
        &self,
        request: Request<KillOpRequest>,
    ) -> Result<Response<MonitoringAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .admin_calls
            .push(FakeAdmin::KillOp(request.into_inner()));
        Ok(Response::new(MonitoringAck {}))
    }

    async fn get_profiling_status(
        &self,
        request: Request<GetProfilingStatusRequest>,
    ) -> Result<Response<PbProfilingStatus>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(state.profiling_status))
    }

    async fn set_profiling_level(
        &self,
        request: Request<SetProfilingLevelRequest>,
    ) -> Result<Response<PbProfilingStatus>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        let set = request.into_inner();
        state.profiling_status = PbProfilingStatus {
            level: set.level.into(),
            slow_ms: set.slow_ms.into(),
        };
        state.admin_calls.push(FakeAdmin::SetProfilingLevel(set));
        Ok(Response::new(state.profiling_status))
    }

    async fn read_profile(
        &self,
        request: Request<ReadProfileRequest>,
    ) -> Result<Response<ReadProfileResponse>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .admin_calls
            .push(FakeAdmin::ReadProfile(request.into_inner()));
        Ok(Response::new(ReadProfileResponse {
            entries: state.profile.clone(),
        }))
    }
}

/// An admin monitoring call the fake received.
#[derive(Clone, Debug)]
pub(crate) enum FakeAdmin {
    KillOp(KillOpRequest),
    SetProfilingLevel(SetProfilingLevelRequest),
    ReadProfile(ReadProfileRequest),
    CreateUser(CreateDeploymentUserRequest),
    UpdateUser(UpdateDeploymentUserRequest),
    DropUser(DropDeploymentUserRequest),
}

/// Only GetCollectionOptions; the DDL writes come with D5.
#[tonic::async_trait]
impl DdlService for Fake {
    async fn create_collection(
        &self,
        request: Request<CreateCollectionRequest>,
    ) -> Result<Response<DdlAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .writes
            .push(FakeWrite::CreateCollection(request.into_inner()));
        Ok(Response::new(DdlAck {}))
    }

    async fn drop_collection(
        &self,
        request: Request<DropCollectionRequest>,
    ) -> Result<Response<DdlAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .writes
            .push(FakeWrite::DropCollection(request.into_inner()));
        Ok(Response::new(DdlAck {}))
    }

    async fn rename_collection(
        &self,
        request: Request<RenameCollectionRequest>,
    ) -> Result<Response<DdlAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .writes
            .push(FakeWrite::RenameCollection(request.into_inner()));
        Ok(Response::new(DdlAck {}))
    }

    async fn create_view(
        &self,
        request: Request<CreateViewRequest>,
    ) -> Result<Response<DdlAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .writes
            .push(FakeWrite::CreateView(request.into_inner()));
        Ok(Response::new(DdlAck {}))
    }

    async fn drop_database(
        &self,
        request: Request<DropDatabaseRequest>,
    ) -> Result<Response<DdlAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .writes
            .push(FakeWrite::DropDatabase(request.into_inner()));
        Ok(Response::new(DdlAck {}))
    }

    async fn rename_database(
        &self,
        _request: Request<RenameDatabaseRequest>,
    ) -> Result<Response<DdlAck>, Status> {
        Err(Status::unimplemented("RenameDatabase is not implemented"))
    }

    async fn rename_database_detailed(
        &self,
        request: Request<RenameDatabaseDetailedRequest>,
    ) -> Result<Response<RenameDatabaseResult>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .writes
            .push(FakeWrite::RenameDatabase(request.into_inner()));
        Ok(Response::new(state.rename_result.clone()))
    }

    async fn get_collection_options(
        &self,
        request: Request<GetCollectionOptionsRequest>,
    ) -> Result<Response<PbCollectionValidation>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(state.collection_options.clone()))
    }

    async fn set_validator(
        &self,
        request: Request<SetValidatorRequest>,
    ) -> Result<Response<DdlAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .writes
            .push(FakeWrite::SetValidator(request.into_inner()));
        Ok(Response::new(DdlAck {}))
    }
}

/// Only the listings; creating, updating and dropping users come with D5.
#[tonic::async_trait]
impl DeploymentUserService for Fake {
    async fn list_users(
        &self,
        request: Request<ListDeploymentUsersRequest>,
    ) -> Result<Response<ListDeploymentUsersResponse>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state.last_users_database = Some(request.get_ref().database.clone());
        Ok(Response::new(ListDeploymentUsersResponse {
            users: state.users.clone(),
        }))
    }

    async fn list_roles(
        &self,
        request: Request<ListDeploymentRolesRequest>,
    ) -> Result<Response<ListDeploymentRolesResponse>, Status> {
        let state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        Ok(Response::new(ListDeploymentRolesResponse {
            roles: state.roles.clone(),
        }))
    }

    async fn create_user(
        &self,
        request: Request<CreateDeploymentUserRequest>,
    ) -> Result<Response<DeploymentUserAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .admin_calls
            .push(FakeAdmin::CreateUser(request.into_inner()));
        Ok(Response::new(DeploymentUserAck {}))
    }

    async fn update_user(
        &self,
        request: Request<UpdateDeploymentUserRequest>,
    ) -> Result<Response<DeploymentUserAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .admin_calls
            .push(FakeAdmin::UpdateUser(request.into_inner()));
        Ok(Response::new(DeploymentUserAck {}))
    }

    async fn drop_user(
        &self,
        request: Request<DropDeploymentUserRequest>,
    ) -> Result<Response<DeploymentUserAck>, Status> {
        let mut state = self.state.lock().unwrap();
        state.authorize_connection(&request, &request.get_ref().connection_id)?;
        state
            .admin_calls
            .push(FakeAdmin::DropUser(request.into_inner()));
        Ok(Response::new(DeploymentUserAck {}))
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

type ShellOutput =
    Pin<Box<dyn tokio_stream::Stream<Item = Result<MongoshServerMsg, Status>> + Send>>;

/// What the fake shell answers a line with.
enum ShellReply {
    Stdout(String),
    Stderr(String),
    Nothing,
    Quit,
    Fail,
}

/// A REPL just big enough for the session code: a quoted string echoes
/// bare, as mongosh echoes an expression's value; `.break` prints nothing;
/// `throw` goes to stderr; `quit()` ends the shell; anything else is
/// "ran" back.
fn fake_repl(line: &str) -> ShellReply {
    let line = line.trim();
    if line.len() >= 2 && line.starts_with('\'') && line.ends_with('\'') {
        ShellReply::Stdout(format!("{}\n", &line[1..line.len() - 1]))
    } else if line.is_empty() || line == ".break" {
        ShellReply::Nothing
    } else if line == "quit()" {
        ShellReply::Quit
    } else if line == "fail()" {
        ShellReply::Fail
    } else if let Some(db) = line.strip_prefix("use ") {
        ShellReply::Stdout(format!("switched to db {db}\n"))
    } else if let Some(error) = line.strip_prefix("throw ") {
        ShellReply::Stderr(format!("Uncaught {error}\n"))
    } else {
        ShellReply::Stdout(format!("ran {line}\n"))
    }
}

#[tonic::async_trait]
impl ShellService for Fake {
    type MongoshSessionStream = ShellOutput;

    async fn mongosh_session(
        &self,
        request: Request<tonic::Streaming<MongoshClientMsg>>,
    ) -> Result<Response<ShellOutput>, Status> {
        let (metadata, extensions, mut input) = request.into_parts();
        let mut first = input
            .message()
            .await?
            .ok_or_else(|| Status::invalid_argument("empty shell"))?;
        {
            let check = Request::from_parts(metadata, extensions, ());
            let mut state = self.state.lock().unwrap();
            state.authorize_connection(&check, &first.connection_id)?;
            let mut recorded = first.clone();
            recorded.input = Default::default();
            state.shells.push(recorded);
        }
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let fake = self.clone();
        let fails_at_start = self.with(|s| s.shell_start_failure);
        tokio::spawn(async move {
            if fails_at_start {
                let _ = tx
                    .send(Err(Status::internal("mongosh: connection refused")))
                    .await;
                return;
            }
            let mut pending = std::mem::take(&mut first.input).to_vec();
            'shell: loop {
                while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                    let line = String::from_utf8_lossy(&pending[..end]).into_owned();
                    pending.drain(..=end);
                    fake.with(|s| s.shell_input.push(line.clone()));
                    let reply = match fake_repl(&line) {
                        ShellReply::Stdout(text) => MongoshServerMsg {
                            output: text.into_bytes().into(),
                            ..Default::default()
                        },
                        ShellReply::Stderr(text) => MongoshServerMsg {
                            stderr: text.into_bytes().into(),
                            ..Default::default()
                        },
                        ShellReply::Nothing => continue,
                        ShellReply::Quit => break 'shell,
                        ShellReply::Fail => {
                            let _ = tx.send(Err(Status::internal("mongosh crashed"))).await;
                            break 'shell;
                        }
                    };
                    if tx.send(Ok(reply)).await.is_err() {
                        break 'shell;
                    }
                }
                match input.message().await {
                    Ok(Some(message)) => pending.extend_from_slice(&message.input),
                    _ => break,
                }
            }
            fake.with(|s| s.shells_ended += 1);
        });
        Ok(Response::new(Box::pin(
            tokio_stream::wrappers::ReceiverStream::new(rx),
        )))
    }
}
