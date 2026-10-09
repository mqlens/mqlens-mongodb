//! The deployment's users and roles.

use crate::db::users::{MongoUser, RoleInfo, RoleSpec};
use crate::server::channel::client;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::deployment_user_service_client::DeploymentUserServiceClient;
use crate::server::pb::mqlens::v1::{ListDeploymentRolesRequest, ListDeploymentUsersRequest};
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::AppState;

/// `None` lists users across every database, as in local mode.
pub(crate) async fn list_users(
    state: &AppState,
    conn: &RemoteConn,
    database: Option<&str>,
) -> Result<Vec<MongoUser>, String> {
    routes::require("list_users", conn)?;
    let request = ListDeploymentUsersRequest {
        connection_id: conn.remote_id.clone(),
        database: database.unwrap_or_default().to_string(),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(DeploymentUserServiceClient, channel)
                .list_users(request)
                .await
        })
        .await?;
    Ok(response
        .users
        .into_iter()
        .map(|user| MongoUser {
            user: user.user,
            db: user.db,
            roles: user
                .roles
                .into_iter()
                .map(|role| RoleSpec {
                    role: role.role,
                    db: role.db,
                })
                .collect(),
            mechanisms: user.mechanisms,
        })
        .collect())
}

pub(crate) async fn list_roles(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
) -> Result<Vec<RoleInfo>, String> {
    routes::require("list_roles", conn)?;
    let request = ListDeploymentRolesRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
    };
    let response = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(DeploymentUserServiceClient, channel)
                .list_roles(request)
                .await
        })
        .await?;
    Ok(response
        .roles
        .into_iter()
        .map(|role| RoleInfo {
            role: role.role,
            db: role.db,
            is_builtin: role.is_builtin,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use crate::db::users::{list_roles_impl, list_users_impl, MongoUser, RoleInfo, RoleSpec};
    use crate::server::fake::Env;
    use crate::server::ops::connected;

    fn with_admin(env: &Env) {
        env.fake
            .with(|s| s.connections[0].op_classes.push("admin".to_string()));
    }

    #[tokio::test]
    async fn users_carry_their_roles_and_mechanisms() {
        let env = Env::new().await;
        with_admin(&env);
        let (state, id) = connected(&env).await;

        let users = list_users_impl(&state, &id, Some("orders")).await.unwrap();

        assert_eq!(
            users,
            vec![MongoUser {
                user: "app".to_string(),
                db: "orders".to_string(),
                roles: vec![RoleSpec {
                    role: "readWrite".to_string(),
                    db: "orders".to_string(),
                }],
                mechanisms: vec!["SCRAM-SHA-256".to_string()],
            }]
        );
        assert_eq!(
            env.fake.with(|s| s.last_users_database.clone()).as_deref(),
            Some("orders")
        );
    }

    // Local mode with no database lists users across all of them; the
    // server takes an empty database to mean the same.
    #[tokio::test]
    async fn users_across_all_databases_ask_with_no_database() {
        let env = Env::new().await;
        with_admin(&env);
        let (state, id) = connected(&env).await;

        list_users_impl(&state, &id, None).await.unwrap();

        assert_eq!(
            env.fake.with(|s| s.last_users_database.clone()).as_deref(),
            Some("")
        );
    }

    #[tokio::test]
    async fn roles_say_which_are_built_in() {
        let env = Env::new().await;
        with_admin(&env);
        let (state, id) = connected(&env).await;

        assert_eq!(
            list_roles_impl(&state, &id, "orders").await.unwrap(),
            vec![
                RoleInfo {
                    role: "read".to_string(),
                    db: "orders".to_string(),
                    is_builtin: true,
                },
                RoleInfo {
                    role: "reporting".to_string(),
                    db: "orders".to_string(),
                    is_builtin: false,
                },
            ]
        );
    }

    #[tokio::test]
    async fn without_the_admin_role_users_are_refused_plainly() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;

        let err = list_users_impl(&state, &id, None).await.unwrap_err();

        assert!(err.contains("does not allow admin operations"), "{err}");
    }
}
