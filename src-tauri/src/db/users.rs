//! MongoDB user & role management: list/create/update/drop database users and
//! list grantable roles. Live commands run against the real client; mock
//! connections return synthetic users/roles so the view works in demo mode.

use crate::write_guard::{guard_writable, WriteOp};
use crate::{connection_is_mock, require_real_client, AppState};
use mongodb::bson::{doc, Bson, Document};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoleSpec {
    pub role: String,
    pub db: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MongoUser {
    pub user: String,
    pub db: String,
    pub roles: Vec<RoleSpec>,
    pub mechanisms: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoleInfo {
    pub role: String,
    pub db: String,
    pub is_builtin: bool,
}

fn parse_role_array(value: Option<&Bson>) -> Vec<RoleSpec> {
    value
        .and_then(|b| b.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.as_document())
                .filter_map(|d| {
                    Some(RoleSpec {
                        role: d.get_str("role").ok()?.to_string(),
                        db: d.get_str("db").ok()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_user(d: &Document) -> MongoUser {
    MongoUser {
        user: d.get_str("user").unwrap_or_default().to_string(),
        db: d.get_str("db").unwrap_or_default().to_string(),
        roles: parse_role_array(d.get("roles")),
        mechanisms: d
            .get_array("mechanisms")
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| b.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn validate_roles(roles: &[RoleSpec]) -> Result<(), String> {
    if roles
        .iter()
        .any(|r| r.role.trim().is_empty() || r.db.trim().is_empty())
    {
        return Err("Every role needs both a role name and a database".to_string());
    }
    Ok(())
}

fn roles_to_bson(roles: &[RoleSpec]) -> Vec<Bson> {
    roles
        .iter()
        .map(|r| Bson::Document(doc! { "role": &r.role, "db": &r.db }))
        .collect()
}

// ── Mock data (demo connections) ──────────────────────────────────────────────

fn mock_users() -> Vec<MongoUser> {
    vec![
        MongoUser {
            user: "admin".into(),
            db: "admin".into(),
            roles: vec![RoleSpec { role: "root".into(), db: "admin".into() }],
            mechanisms: vec!["SCRAM-SHA-256".into()],
        },
        MongoUser {
            user: "app_user".into(),
            db: "sales_db".into(),
            roles: vec![RoleSpec { role: "readWrite".into(), db: "sales_db".into() }],
            mechanisms: vec!["SCRAM-SHA-1".into(), "SCRAM-SHA-256".into()],
        },
        MongoUser {
            user: "analyst".into(),
            db: "sales_db".into(),
            roles: vec![RoleSpec { role: "read".into(), db: "sales_db".into() }],
            mechanisms: vec!["SCRAM-SHA-256".into()],
        },
    ]
}

fn mock_roles(database: &str) -> Vec<RoleInfo> {
    let builtin = [
        "read",
        "readWrite",
        "dbAdmin",
        "dbOwner",
        "userAdmin",
        "clusterAdmin",
        "readAnyDatabase",
        "readWriteAnyDatabase",
        "userAdminAnyDatabase",
        "dbAdminAnyDatabase",
        "root",
    ];
    builtin
        .iter()
        .map(|r| RoleInfo { role: (*r).to_string(), db: database.to_string(), is_builtin: true })
        .collect()
}

// ── Async command impls ───────────────────────────────────────────────────────

/// List users of one database, or of every database (`usersInfo.forAllDBs`,
/// run on `admin`) when `database` is `None`.
pub async fn list_users_impl(
    state: &AppState,
    id: &str,
    database: Option<&str>,
) -> Result<Vec<MongoUser>, String> {
    if connection_is_mock(state, id)? {
        let users = mock_users();
        return Ok(match database {
            Some(db) => users.into_iter().filter(|u| u.db == db).collect(),
            None => users,
        });
    }
    let client = require_real_client(state, id)?;
    let (db_name, users_info) = match database {
        Some(db) => (db.to_string(), Bson::Int32(1)),
        None => ("admin".to_string(), Bson::Document(doc! { "forAllDBs": true })),
    };
    let raw = client
        .database(&db_name)
        .run_command(doc! { "usersInfo": users_info })
        .await
        .map_err(|e| format!("usersInfo failed: {}", e))?;
    let users = raw
        .get_array("users")
        .map_err(|_| "usersInfo returned no users".to_string())?;
    Ok(users
        .iter()
        .filter_map(|b| b.as_document())
        .map(parse_user)
        .collect())
}

pub async fn create_user_impl(
    state: &AppState,
    id: &str,
    database: &str,
    username: &str,
    password: &str,
    roles: &[RoleSpec],
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::UserWrite, false)?;

    if username.trim().is_empty() {
        return Err("Username is required".to_string());
    }
    if password.is_empty() {
        return Err("Password is required".to_string());
    }
    validate_roles(roles)?;
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .run_command(doc! {
            "createUser": username,
            "pwd": password,
            "roles": roles_to_bson(roles),
        })
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to create user: {}", e))
}

/// Update a user's password and/or replace its role set. At least one of the
/// two must be provided.
pub async fn update_user_impl(
    state: &AppState,
    id: &str,
    database: &str,
    username: &str,
    password: Option<&str>,
    roles: Option<&[RoleSpec]>,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::UserWrite, false)?;

    if username.trim().is_empty() {
        return Err("Username is required".to_string());
    }
    if password.map_or(true, str::is_empty) && roles.is_none() {
        return Err("Nothing to update: provide a new password and/or roles".to_string());
    }
    if let Some(roles) = roles {
        validate_roles(roles)?;
    }
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    let mut cmd = doc! { "updateUser": username };
    if let Some(pwd) = password.filter(|p| !p.is_empty()) {
        cmd.insert("pwd", pwd);
    }
    if let Some(roles) = roles {
        cmd.insert("roles", roles_to_bson(roles));
    }
    client
        .database(database)
        .run_command(cmd)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to update user: {}", e))
}

pub async fn drop_user_impl(
    state: &AppState,
    id: &str,
    database: &str,
    username: &str,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::UserWrite, false)?;

    if username.trim().is_empty() {
        return Err("Username is required".to_string());
    }
    if connection_is_mock(state, id)? {
        return Ok(());
    }
    let client = require_real_client(state, id)?;
    client
        .database(database)
        .run_command(doc! { "dropUser": username })
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to drop user: {}", e))
}

/// List roles grantable on a database, including built-in roles.
pub async fn list_roles_impl(
    state: &AppState,
    id: &str,
    database: &str,
) -> Result<Vec<RoleInfo>, String> {
    if connection_is_mock(state, id)? {
        return Ok(mock_roles(database));
    }
    let client = require_real_client(state, id)?;
    let raw = client
        .database(database)
        .run_command(doc! { "rolesInfo": 1, "showBuiltinRoles": true })
        .await
        .map_err(|e| format!("rolesInfo failed: {}", e))?;
    let roles = raw
        .get_array("roles")
        .map_err(|_| "rolesInfo returned no roles".to_string())?;
    Ok(roles
        .iter()
        .filter_map(|b| b.as_document())
        .filter_map(|d| {
            Some(RoleInfo {
                role: d.get_str("role").ok()?.to_string(),
                db: d.get_str("db").ok()?.to_string(),
                is_builtin: d.get_bool("isBuiltin").unwrap_or(false),
            })
        })
        .collect())
}
