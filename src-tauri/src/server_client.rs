//! "Server mode" client: talks to mqlens-server over the Connect protocol
//! (JSON over HTTP POST for unary RPCs). No gRPC/codegen — just reqwest + serde.
//!
//! protojson encodes int64 as JSON strings and field names as camelCase, so the
//! response structs use `rename_all = "camelCase"` and parse numeric strings.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct ConnectError {
    code: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub tenant: String,
    pub user_id: String,
    pub email: String,
    #[serde(default)]
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expires_at: String, // protojson int64-as-string
    pub principal: Principal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub deployment_kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListConnectionsResp {
    #[serde(default)]
    connections: Vec<ConnectionRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListDatabasesResp {
    #[serde(default)]
    databases: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCollectionsResp {
    #[serde(default)]
    collections: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CountResp {
    #[serde(default)]
    count: String, // int64 as string
}

pub struct ServerClient {
    base_url: String,
    http: reqwest::Client,
}

impl ServerClient {
    pub fn new(base_url: String) -> Self {
        ServerClient {
            base_url,
            http: reqwest::Client::new(),
        }
    }

    async fn post_json<Req: Serialize, Resp: DeserializeOwned>(
        &self,
        method_path: &str,
        body: &Req,
        token: Option<&str>,
    ) -> Result<Resp, String> {
        let url = format!("{}/{}", self.base_url.trim_end_matches('/'), method_path);
        let mut req = self.http.post(&url).json(body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(parse_error(status.as_u16(), &text));
        }
        serde_json::from_str::<Resp>(&text).map_err(|e| format!("decode response: {e}"))
    }

    pub async fn login(
        &self,
        tenant: &str,
        email: &str,
        password: &str,
    ) -> Result<LoginResult, String> {
        let body = serde_json::json!({
            "tenant": tenant,
            "local": { "email": email, "password": password },
        });
        self.post_json("mqlens.v1.AuthService/Login", &body, None).await
    }

    pub async fn list_connections(&self, token: &str) -> Result<Vec<ConnectionRef>, String> {
        let resp: ListConnectionsResp = self
            .post_json("mqlens.v1.ConnectionService/ListConnections", &serde_json::json!({}), Some(token))
            .await?;
        Ok(resp.connections)
    }

    pub async fn list_databases(&self, token: &str, connection_id: &str) -> Result<Vec<String>, String> {
        let body = serde_json::json!({ "connectionId": connection_id });
        let resp: ListDatabasesResp = self
            .post_json("mqlens.v1.MetadataService/ListDatabases", &body, Some(token))
            .await?;
        Ok(resp.databases)
    }

    pub async fn list_collections(
        &self,
        token: &str,
        connection_id: &str,
        database: &str,
    ) -> Result<Vec<String>, String> {
        let body = serde_json::json!({ "connectionId": connection_id, "database": database });
        let resp: ListCollectionsResp = self
            .post_json("mqlens.v1.MetadataService/ListCollections", &body, Some(token))
            .await?;
        Ok(resp.collections)
    }

    pub async fn count(
        &self,
        token: &str,
        connection_id: &str,
        database: &str,
        collection: &str,
        filter_json: &str,
    ) -> Result<i64, String> {
        let body = serde_json::json!({
            "connectionId": connection_id,
            "database": database,
            "collection": collection,
            "filterJson": filter_json,
        });
        let resp: CountResp = self
            .post_json("mqlens.v1.DataService/Count", &body, Some(token))
            .await?;
        if resp.count.is_empty() {
            return Ok(0); // protojson omits zero values
        }
        resp.count.parse::<i64>().map_err(|e| format!("bad count {}: {e}", resp.count))
    }
}

fn parse_error(status: u16, body: &str) -> String {
    if let Ok(ce) = serde_json::from_str::<ConnectError>(body) {
        return format!("{}: {}", ce.code, ce.message);
    }
    format!("HTTP {status}: {body}")
}

// ---- Tauri commands (server mode) ----

#[tauri::command]
pub async fn server_login(
    server_url: String,
    tenant: String,
    email: String,
    password: String,
) -> Result<LoginResult, String> {
    ServerClient::new(server_url).login(&tenant, &email, &password).await
}

#[tauri::command]
pub async fn server_list_connections(
    server_url: String,
    token: String,
) -> Result<Vec<ConnectionRef>, String> {
    ServerClient::new(server_url).list_connections(&token).await
}

#[tauri::command]
pub async fn server_list_databases(
    server_url: String,
    token: String,
    connection_id: String,
) -> Result<Vec<String>, String> {
    ServerClient::new(server_url).list_databases(&token, &connection_id).await
}

#[tauri::command]
pub async fn server_list_collections(
    server_url: String,
    token: String,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    ServerClient::new(server_url)
        .list_collections(&token, &connection_id, &database)
        .await
}

#[tauri::command]
pub async fn server_count(
    server_url: String,
    token: String,
    connection_id: String,
    database: String,
    collection: String,
    filter_json: String,
) -> Result<i64, String> {
    ServerClient::new(server_url)
        .count(&token, &connection_id, &database, &collection, &filter_json)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_login_response_with_string_int64_and_camelcase() {
        let json = r#"{
            "accessToken":"tok","refreshToken":"r","expiresAt":"1780000000",
            "principal":{"tenant":"acme","userId":"u1","email":"a@acme.test","roles":["owner"]}
        }"#;
        let r: LoginResult = serde_json::from_str(json).unwrap();
        assert_eq!(r.access_token, "tok");
        assert_eq!(r.expires_at, "1780000000");
        assert_eq!(r.principal.user_id, "u1");
        assert_eq!(r.principal.roles, vec!["owner".to_string()]);
    }

    #[test]
    fn parses_connection_refs() {
        let json = r#"{"connections":[{"id":"c1","name":"Prod","tags":["p"],"deploymentKind":"replica_set"}]}"#;
        let r: ListConnectionsResp = serde_json::from_str(json).unwrap();
        assert_eq!(r.connections.len(), 1);
        assert_eq!(r.connections[0].deployment_kind, "replica_set");
    }

    #[test]
    fn parses_count_string() {
        let r: CountResp = serde_json::from_str(r#"{"count":"42"}"#).unwrap();
        assert_eq!(r.count.parse::<i64>().unwrap(), 42);
    }

    #[test]
    fn empty_count_defaults_to_zero_parse() {
        // Connect omits zero-valued fields; absent count => "" => treat as 0 upstream.
        let r: CountResp = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(r.count, "");
    }

    #[test]
    fn parses_connect_error() {
        let msg = parse_error(401, r#"{"code":"unauthenticated","message":"bad token"}"#);
        assert_eq!(msg, "unauthenticated: bad token");
    }

    #[test]
    fn non_json_error_falls_back_to_status() {
        let msg = parse_error(502, "oops");
        assert!(msg.contains("502"));
    }
}
