//! Replica set member discovery for the connection editor's Discover button.
//!
//! One seed member is asked for its `hello` reply, which every member answers
//! before authentication, so no credentials leave the editor.

use mongodb::bson::Document;
use mongodb::options::ClientOptions;
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
    let hello = client
        .database("admin")
        .run_command(mongodb::bson::doc! { "hello": 1 })
        .await
        .map_err(|e| e.to_string())?;
    Ok(members_from_hello(&hello))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

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
}
