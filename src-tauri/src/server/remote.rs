//! Remote connections: a desktop connection id that stands for one of an
//! MQLens Server's connections, and the routing that sends each command either
//! to the local driver or to the server.

use crate::state::AppState;
use std::sync::Arc;

/// A desktop connection backed by a connection on an MQLens Server. The
/// desktop never holds its connection string or credentials.
#[derive(Debug)]
pub(crate) struct RemoteConn {
    /// The desktop's id for it, as a local connection has one.
    pub desktop_id: String,
    pub account_id: String,
    /// The server's id for the connection.
    pub remote_id: String,
    /// What the signed-in user may do on it, as the server reported.
    pub op_classes: Vec<String>,
    /// The feature strings the server announced.
    pub features: Vec<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(id: &str) -> RemoteConn {
        RemoteConn {
            desktop_id: id.to_string(),
            account_id: "account".to_string(),
            remote_id: format!("srv-{id}"),
            op_classes: vec!["read".to_string()],
            features: Vec::new(),
        }
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
    fn a_command_the_server_cannot_serve_is_refused_for_a_remote_connection() {
        let state = AppState::new();
        state.server.add_remote(remote("r1")).unwrap();

        let err = reject_if_remote(&state, "r1", "watch_collection").unwrap_err();
        assert!(err.contains("not available on MQLens Server"), "{err}");
    }
}
