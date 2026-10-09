//! Remote connections: a desktop connection id that stands for one of an
//! MQLens Server's connections, and the routing that sends each command either
//! to the local driver or to the server.

use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;

/// A desktop connection backed by a connection on an MQLens Server. The
/// desktop never holds its connection string or credentials.
#[derive(Debug)]
pub(crate) struct RemoteConn {
    /// The desktop's id for it, as a local connection has one.
    pub desktop_id: String,
    pub account_id: String,
    /// The account as it was when the connection was made, without its token.
    /// Commands refuse once the stored account signs in as someone else.
    pub identity: crate::server::accounts::ServerAccount,
    /// The accounts file the account is stored in, to resume its session.
    pub accounts_path: std::path::PathBuf,
    pub account_name: String,
    /// The account's MQLens Server URL.
    pub server_url: String,
    /// The server's id for the connection.
    pub remote_id: String,
    /// What the signed-in user may do on it, as the server reported.
    pub op_classes: Vec<String>,
    /// The MQLens API version agreed with the server; every request on the
    /// connection speaks it.
    pub api_version: u32,
}

/// The MQLens API versions this desktop speaks. 2 is the first with documents
/// as raw BSON, which every document read needs.
pub(crate) const API_VERSIONS: (u32, u32) = (2, 2);

/// The version to speak with a server that serves `server_min` to
/// `server_max`: the highest both serve, or why there is none.
pub(crate) fn negotiate(server_min: u32, server_max: u32) -> Result<u32, String> {
    let (min, max) = API_VERSIONS;
    let version = server_max.min(max);
    if version >= min && version >= server_min {
        return Ok(version);
    }
    let speaks = format!("This MQLens Server speaks API versions {server_min} to {server_max}");
    if server_max < min {
        Err(format!(
            "{speaks}, and this app needs {min} or later. Update MQLens Server."
        ))
    } else {
        Err(format!(
            "{speaks}, and this app speaks up to {max}. Update this app."
        ))
    }
}

/// What a command without a server adapter yet says for a remote connection.
pub(crate) const NOT_SERVED: &str = "This is not available on MQLens Server connections yet";

/// What the connection list shows about a remote connection. Never a
/// connection string or credential: the desktop has none.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionInfo {
    pub account_id: String,
    pub account_name: String,
    pub server_url: String,
    pub remote_id: String,
    pub op_classes: Vec<String>,
    /// Commands this connection cannot run; the UI disables them.
    pub blocked_commands: Vec<String>,
}

impl RemoteConn {
    pub(crate) fn info(&self) -> RemoteConnectionInfo {
        RemoteConnectionInfo {
            account_id: self.account_id.clone(),
            account_name: self.account_name.clone(),
            server_url: self.server_url.clone(),
            remote_id: self.remote_id.clone(),
            op_classes: self.op_classes.clone(),
            blocked_commands: crate::server::routes::blocked_commands(self)
                .into_iter()
                .map(str::to_string)
                .collect(),
        }
    }
}

/// Where a command for a connection runs.
#[derive(Debug)]
pub(crate) enum Route {
    Local(mongodb::Client),
    Remote(Arc<RemoteConn>),
}

/// Where a command for connection `id` runs. Chosen where a command obtains
/// its client, below its guards and audit. A local id gets exactly the client,
/// and an unknown id exactly the error, that `require_real_client` gives.
pub(crate) fn route(state: &AppState, id: &str) -> Result<Route, String> {
    if let Some(conn) = state.server.remote(id)? {
        return Ok(Route::Remote(conn));
    }
    crate::require_real_client(state, id).map(Route::Local)
}

/// Refuses `command` for a remote connection, for commands MQLens Server
/// cannot serve yet. A command left unported still cannot run locally for a
/// remote id: its `require_real_client` finds no client.
pub(crate) fn reject_if_remote(state: &AppState, id: &str, command: &str) -> Result<(), String> {
    match state.server.remote(id)? {
        Some(_) => Err(format!(
            "{command} is not available on MQLens Server connections"
        )),
        None => Ok(()),
    }
}

/// An identity for remote connections built in tests.
#[cfg(test)]
pub(crate) fn test_identity() -> crate::server::accounts::ServerAccount {
    crate::server::accounts::ServerAccountInput {
        id: Some("account".to_string()),
        name: "Acme".to_string(),
        url: "https://mqlens.acme.test".to_string(),
        tenant: "acme".to_string(),
        email: "ops@acme.test".to_string(),
        allow_insecure_http: false,
        extra_ca_pem: None,
    }
    .into_account()
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(id: &str) -> RemoteConn {
        RemoteConn {
            desktop_id: id.to_string(),
            account_id: "account".to_string(),
            identity: test_identity(),
            accounts_path: std::path::PathBuf::new(),
            account_name: "Acme".to_string(),
            server_url: "https://mqlens.acme.test".to_string(),
            remote_id: format!("srv-{id}"),
            op_classes: vec!["read".to_string()],
            api_version: 2,
        }
    }

    // The highest version both sides serve wins; with none in common, the
    // message names which side to update. A server from before versioning
    // reports 0 to 0.
    #[test]
    fn the_highest_shared_api_version_is_spoken() {
        let (min, max) = API_VERSIONS;
        assert_eq!(negotiate(1, max), Ok(max));
        assert_eq!(negotiate(min, max + 5), Ok(max));
        for (server_min, server_max) in [(1, min - 1), (0, 0)] {
            let err = negotiate(server_min, server_max).unwrap_err();
            assert!(err.contains("Update MQLens Server"), "{err}");
        }
        let err = negotiate(max + 1, max + 3).unwrap_err();
        assert!(err.contains("Update this app"), "{err}");
    }

    #[tokio::test]
    async fn a_local_connection_routes_to_its_driver_client() {
        let state = AppState::new();
        let client = mongodb::Client::with_uri_str("mongodb://127.0.0.1:1")
            .await
            .unwrap();
        state
            .connections
            .lock()
            .unwrap()
            .insert("local".to_string(), client);

        assert!(matches!(route(&state, "local").unwrap(), Route::Local(_)));
        assert!(reject_if_remote(&state, "local", "watch_collection").is_ok());
    }

    // Commands keep failing exactly as they do today for an id nobody knows.
    #[test]
    fn an_unknown_connection_fails_as_it_does_in_local_mode() {
        let state = AppState::new();
        assert_eq!(
            route(&state, "nope").unwrap_err(),
            crate::require_real_client(&state, "nope").unwrap_err()
        );
    }

    #[test]
    fn a_remote_connection_routes_to_the_server_never_the_driver() {
        let state = AppState::new();
        state.server.add_remote(remote("r1")).unwrap();

        match route(&state, "r1").unwrap() {
            Route::Remote(conn) => assert_eq!(conn.remote_id, "srv-r1"),
            Route::Local(_) => panic!("a remote connection was routed to the local driver"),
        }
    }

    #[test]
    fn a_remote_connection_is_listed_with_its_server() {
        let state = AppState::new();
        state.server.add_remote(remote("r1")).unwrap();
        crate::set_connection_meta_impl(
            &state,
            "r1",
            "server:account:srv-r1",
            "Orders",
            false,
            Default::default(),
        )
        .unwrap();

        let list = crate::connection_list_impl(&state).unwrap();
        assert_eq!(
            list[0].server,
            Some(RemoteConnectionInfo {
                account_id: "account".to_string(),
                account_name: "Acme".to_string(),
                server_url: "https://mqlens.acme.test".to_string(),
                remote_id: "srv-r1".to_string(),
                op_classes: vec!["read".to_string()],
                blocked_commands: crate::server::routes::blocked_commands(
                    &state.server.remote("r1").unwrap().unwrap()
                )
                .into_iter()
                .map(str::to_string)
                .collect(),
            })
        );
        assert!(!list[0].server.as_ref().unwrap().blocked_commands.is_empty());
    }

    // The connection list reaches the frontend and MCP clients; a local entry
    // must look exactly as it did before server mode.
    #[test]
    fn a_local_connection_is_listed_exactly_as_before() {
        let state = AppState::new();
        crate::set_connection_meta_impl(&state, "l1", "p1", "Local", false, Default::default())
            .unwrap();

        let list = crate::connection_list_impl(&state).unwrap();
        let json = serde_json::to_value(&list[0]).unwrap();
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["id", "mode", "name", "profileId", "viaMcp"]);
    }

    #[tokio::test]
    async fn disconnecting_a_remote_connection_forgets_it() {
        let state = AppState::new();
        state.server.add_remote(remote("r1")).unwrap();
        state.mocks.lock().unwrap().insert("r1".to_string(), false);
        crate::set_connection_meta_impl(&state, "r1", "p", "Orders", false, Default::default())
            .unwrap();

        crate::disconnect_db_impl(&state, "r1").await.unwrap();

        assert!(state.server.remote("r1").unwrap().is_none());
        assert_eq!(
            route(&state, "r1").unwrap_err(),
            crate::require_real_client(&state, "r1").unwrap_err()
        );
        assert!(crate::connection_list_impl(&state).unwrap().is_empty());
    }

    fn assert_not_available<T: std::fmt::Debug>(what: &str, result: Result<T, String>) {
        match result {
            Err(e) if e.contains("not available on MQLens Server") => {}
            other => panic!("{what}: expected a clear refusal, got {other:?}"),
        }
    }

    // Until a command has an adapter, every path from a command to MongoDB
    // refuses a remote connection plainly: no driver client, no URI, no
    // mongosh process.
    #[tokio::test]
    async fn every_path_to_mongodb_refuses_a_remote_connection() {
        let state = AppState::new();
        state.server.add_remote(remote("r1")).unwrap();
        state.mocks.lock().unwrap().insert("r1".to_string(), false);

        assert_not_available(
            "require_real_client",
            crate::require_real_client(&state, "r1"),
        );
        assert_not_available(
            "preflight_copy",
            crate::db::copy::preflight_copy_impl(&state, "r1", "db", Vec::new(), Vec::new())
                .await
                .map(|_| ()),
        );
        assert_not_available(
            "resolve_conn_uri",
            crate::db::mongotools::resolve_conn_uri(&state, "r1"),
        );
        assert_not_available(
            "start_mongosh_session",
            crate::start_mongosh_session_impl(
                &state,
                "r1",
                "mongodb://127.0.0.1:1",
                "admin",
                "no-such-mongosh-binary",
                "",
            )
            .await
            .map(|_| ()),
        );
        assert_not_available(
            "run_mongosh_script",
            crate::run_mongosh_script_impl(
                &state,
                "r1",
                "mongodb://127.0.0.1:1",
                "admin",
                "no-such-mongosh-binary",
                "db.version()",
            )
            .await
            .map(|_| ()),
        );
    }

    // Commands reach a driver client only through require_real_client, so a
    // remote id is never handed one by another path. Counts the reads of the
    // client map outside test modules.
    #[test]
    fn only_require_real_client_reads_driver_clients() {
        fn walk(
            dir: &std::path::Path,
            root: &std::path::Path,
            found: &mut std::collections::BTreeMap<String, usize>,
        ) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, root, found);
                    continue;
                }
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                if !name.ends_with(".rs") || name == "tests.rs" || name.ends_with("_tests.rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                let code = match text
                    .find("#[cfg(test)]\nmod tests {")
                    .or_else(|| text.find("#[cfg(test)]\r\nmod tests {"))
                {
                    Some(at) => &text[..at],
                    None => &text[..],
                };
                // Whitespace removed: a read split over lines counts too.
                let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
                let reads = code.matches(".connections.lock").count();
                if reads > 0 {
                    let rel = path
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    found.insert(rel, reads);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found = std::collections::BTreeMap::new();
        walk(&root, &root, &mut found);
        // connect inserts, disconnect removes, require_real_client reads.
        assert_eq!(
            found,
            std::collections::BTreeMap::from([("lib.rs".to_string(), 3)]),
            "read driver clients through crate::require_real_client"
        );
    }

    #[test]
    fn a_command_the_server_cannot_serve_is_refused_for_a_remote_connection() {
        let state = AppState::new();
        state.server.add_remote(remote("r1")).unwrap();

        let err = reject_if_remote(&state, "r1", "watch_collection").unwrap_err();
        assert!(err.contains("not available on MQLens Server"), "{err}");
    }
}
