//! Replica set member discovery for the connection editor's Discover button.
//!
//! One seed member is asked for its `hello` reply, which every member answers
//! before authentication, so no credentials leave the editor.

use mongodb::bson::Document;
use mongodb::options::ClientOptions;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// URI option values keep the RFC 3986 unreserved characters.
const OPTION_VALUE: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct DiscoveredMembers {
    /// `None` when the seed is not a replica set member.
    pub set_name: Option<String>,
    /// Data-bearing members (`hosts` then `passives`), as `host:port`.
    pub hosts: Vec<String>,
    pub arbiters: Vec<String>,
}

/// Options for talking to the first seed alone: direct, unauthenticated, quick.
pub fn seed_options(mut options: ClientOptions) -> ClientOptions {
    options.hosts.truncate(1);
    options.direct_connection = Some(true);
    options.credential = None;
    options.repl_set_name = None;
    options.server_selection_timeout = Some(std::time::Duration::from_secs(10));
    options
}

pub fn members_from_hello(hello: &Document) -> DiscoveredMembers {
    let list = |key: &str| -> Vec<String> {
        hello
            .get_array(key)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let mut hosts = list("hosts");
    hosts.extend(list("passives"));
    DiscoveredMembers {
        set_name: hello.get_str("setName").ok().map(str::to_string),
        hosts,
        arbiters: list("arbiters"),
    }
}

/// Ask the first seed host of `uri` which replica set it belongs to and who
/// its members are. The mock URIs the e2e harness uses never reach here.
#[tauri::command]
pub async fn discover_replica_set(uri: String) -> Result<DiscoveredMembers, String> {
    let normalized = crate::connections::normalize_mongodb_uri_options(&uri);
    let options = ClientOptions::parse(&normalized)
        .await
        .map_err(|e| format!("Failed to parse connection URI: {e}"))?;
    let client = mongodb::Client::with_options(seed_options(options)).map_err(|e| e.to_string())?;
    let admin = client.database("admin");
    let hello = hello_reply(|cmd| {
        let admin = admin.clone();
        async move {
            admin.run_command(cmd).await.map_err(|e| {
                let code = match *e.kind {
                    mongodb::error::ErrorKind::Command(ref c) => Some(c.code),
                    _ => None,
                };
                (code, e.to_string())
            })
        }
    })
    .await?;
    Ok(members_from_hello(&hello))
}

/// `hello`, or `isMaster` on a server that predates `hello` (before 4.2.10 /
/// 4.4.2) and answers CommandNotFound (59), as the driver's own handshake does.
async fn hello_reply<F, Fut>(run: F) -> Result<Document, String>
where
    F: Fn(Document) -> Fut,
    Fut: std::future::Future<Output = Result<Document, (Option<i32>, String)>>,
{
    match run(mongodb::bson::doc! { "hello": 1 }).await {
        Err((Some(59), _)) => run(mongodb::bson::doc! { "isMaster": 1 }).await.map_err(|(_, e)| e),
        reply => reply.map_err(|(_, e)| e),
    }
}

/// The `mongodb://` form of a `mongodb+srv://` URI: its userinfo, path and
/// options kept, the host replaced by the resolved `hosts`, and what SRV
/// implies or DNS supplied — TLS, and the TXT record's replicaSet and
/// authSource — added unless the URI set them itself.
pub fn seed_list_uri(srv_uri: &str, hosts: &[String], repl_set: Option<&str>, auth_source: Option<&str>) -> String {
    let rest = srv_uri.split_once("://").map_or(srv_uri, |(_, r)| r);
    let (authority, tail) = rest.find(['/', '?']).map_or((rest, ""), |i| rest.split_at(i));
    let userinfo = authority.rfind('@').map_or("", |i| &authority[..=i]);
    let (path, query) = tail.split_once('?').unwrap_or((tail, ""));
    let path = path.strip_prefix('/').unwrap_or(path);

    let mut params: Vec<String> = query.split(['&', ';']).filter(|p| !p.is_empty()).map(str::to_string).collect();
    let has = |params: &[String], keys: &[&str]| {
        params.iter().any(|p| keys.iter().any(|k| p.split('=').next().is_some_and(|key| key.eq_ignore_ascii_case(k))))
    };
    if !has(&params, &["tls", "ssl"]) {
        params.push("tls=true".into());
    }
    if let Some(set) = repl_set.filter(|_| !has(&params, &["replicaSet"])) {
        params.push(format!("replicaSet={}", utf8_percent_encode(set, OPTION_VALUE)));
    }
    if let Some(source) = auth_source.filter(|_| !has(&params, &["authSource"])) {
        params.push(format!("authSource={}", utf8_percent_encode(source, OPTION_VALUE)));
    }
    format!("mongodb://{userinfo}{}/{path}?{}", hosts.join(","), params.join("&"))
}

/// Resolve a `mongodb+srv://` URI's SRV and TXT records into a seed-list URI,
/// for exporting to tools that cannot read SRV.
#[tauri::command]
pub async fn resolve_srv_seed_list(uri: String) -> Result<String, String> {
    let normalized = crate::connections::normalize_mongodb_uri_options(&uri);
    let options = ClientOptions::parse(&normalized)
        .await
        .map_err(|e| format!("Failed to resolve SRV record: {e}"))?;
    let hosts: Vec<String> = options.hosts.iter().map(|h| h.to_string()).collect();
    let source = options.credential.as_ref().and_then(|c| c.source.as_deref());
    Ok(seed_list_uri(&uri, &hosts, options.repl_set_name.as_deref(), source))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

    #[tokio::test]
    async fn an_older_server_without_hello_is_asked_with_is_master() {
        let asked = std::sync::Mutex::new(Vec::new());
        let reply = hello_reply(|cmd: Document| {
            let name = cmd.keys().next().unwrap().to_string();
            asked.lock().unwrap().push(name.clone());
            async move {
                if name == "hello" {
                    Err((Some(59), "no such command: 'hello'".to_string()))
                } else {
                    Ok(doc! { "setName": "rs-old", "hosts": ["old-a:27017"] })
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(*asked.lock().unwrap(), ["hello", "isMaster"]);
        assert_eq!(members_from_hello(&reply).set_name.as_deref(), Some("rs-old"));
    }

    #[tokio::test]
    async fn another_failure_is_reported_without_a_retry() {
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let err = hello_reply(|_cmd: Document| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Err((Some(13), "unauthorized".to_string())) }
        })
        .await
        .unwrap_err();
        assert_eq!(err, "unauthorized");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn seed_options_talk_to_the_first_host_directly_without_credentials() {
        let parsed = ClientOptions::parse(
            "mongodb://alice:pw@a.example:27017,b.example:27018/?replicaSet=rs0&authSource=admin",
        )
        .await
        .unwrap();
        let seed = seed_options(parsed);
        assert_eq!(seed.hosts.len(), 1);
        assert_eq!(seed.hosts[0].to_string(), "a.example:27017");
        assert_eq!(seed.direct_connection, Some(true));
        assert!(seed.credential.is_none());
        assert!(seed.repl_set_name.is_none());
        assert!(seed.server_selection_timeout.is_some());
    }

    #[test]
    fn members_come_from_hosts_and_passives_with_arbiters_apart() {
        let hello = doc! {
            "setName": "rs0",
            "hosts": ["a.example:27017", "b.example:27017"],
            "passives": ["c.example:27017"],
            "arbiters": ["d.example:27017"],
        };
        assert_eq!(
            members_from_hello(&hello),
            DiscoveredMembers {
                set_name: Some("rs0".into()),
                hosts: vec!["a.example:27017".into(), "b.example:27017".into(), "c.example:27017".into()],
                arbiters: vec!["d.example:27017".into()],
            }
        );
    }

    #[test]
    fn a_standalone_reports_no_set() {
        let hello = doc! { "isWritablePrimary": true };
        assert_eq!(members_from_hello(&hello), DiscoveredMembers::default());
    }

    #[test]
    fn an_srv_uri_becomes_its_seed_list_with_what_dns_added() {
        let hosts = ["a.x.net:27017".to_string(), "b.x.net:27017".to_string()];
        assert_eq!(
            seed_list_uri("mongodb+srv://u:p%40w@cluster0.x.net/app?retryWrites=true", &hosts, Some("atlas-1"), Some("admin")),
            "mongodb://u:p%40w@a.x.net:27017,b.x.net:27017/app?retryWrites=true&tls=true&replicaSet=atlas-1&authSource=admin"
        );
    }

    #[test]
    fn options_the_srv_uri_set_itself_win() {
        let hosts = ["a.x.net:27017".to_string()];
        assert_eq!(
            seed_list_uri("mongodb+srv://c.x.net/?tls=false&authSource=db1&replicaSet=mine", &hosts, Some("atlas-1"), Some("admin")),
            "mongodb://a.x.net:27017/?tls=false&authSource=db1&replicaSet=mine"
        );
        assert_eq!(seed_list_uri("mongodb+srv://c.x.net", &hosts, None, None), "mongodb://a.x.net:27017/?tls=true");
    }
}
