//! The deployment's users and roles: listing them, and for admins creating,
//! updating and dropping users.

use crate::db::users::{MongoUser, RoleInfo, RoleSpec};
use crate::server::channel::client;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::deployment_user_service_client::DeploymentUserServiceClient;
use crate::server::pb::mqlens::v1::{
    CreateDeploymentUserRequest, DropDeploymentUserRequest, ListDeploymentRolesRequest,
    ListDeploymentUsersRequest, RoleSpec as PbRoleSpec, UpdateDeploymentUserRequest,
};
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

fn to_wire(roles: &[RoleSpec]) -> Vec<PbRoleSpec> {
    roles
        .iter()
        .map(|r| PbRoleSpec {
            role: r.role.clone(),
            db: r.db.clone(),
        })
        .collect()
}

pub(crate) async fn create_user(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    username: &str,
    password: &str,
    roles: &[RoleSpec],
) -> Result<(), String> {
    routes::require("create_user", conn)?;
    let request = CreateDeploymentUserRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        username: username.to_string(),
        password: password.to_string(),
        roles: to_wire(roles),
    };
    session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(DeploymentUserServiceClient, channel)
                .create_user(request)
                .await
        })
        .await?;
    Ok(())
}

/// Changes only what is given: a non-empty password, and roles, which
/// replace the user's roles even when there are none.
pub(crate) async fn update_user(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    username: &str,
    password: Option<&str>,
    roles: Option<&[RoleSpec]>,
) -> Result<(), String> {
    routes::require("update_user", conn)?;
    let request = UpdateDeploymentUserRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        username: username.to_string(),
        password: password.filter(|p| !p.is_empty()).map(str::to_string),
        replace_roles: roles.is_some(),
        roles: roles.map(to_wire).unwrap_or_default(),
    };
    session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(DeploymentUserServiceClient, channel)
                .update_user(request)
                .await
        })
        .await?;
    Ok(())
}

pub(crate) async fn drop_user(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    username: &str,
) -> Result<(), String> {
    routes::require("drop_user", conn)?;
    let request = DropDeploymentUserRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        username: username.to_string(),
    };
    session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(DeploymentUserServiceClient, channel)
                .drop_user(request)
                .await
        })
        .await?;
    Ok(())
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

    use crate::db::users::{create_user_impl, drop_user_impl, update_user_impl};
    use crate::server::fake::FakeAdmin;
    use crate::server::pb::mqlens::v1::RoleSpec as PbRoleSpec;

    fn role(role: &str, db: &str) -> RoleSpec {
        RoleSpec {
            role: role.to_string(),
            db: db.to_string(),
        }
    }

    fn calls(env: &Env) -> Vec<FakeAdmin> {
        env.fake.with(|s| s.admin_calls.clone())
    }

    // A user is created with the password and roles given.
    #[tokio::test]
    async fn a_user_is_created_on_the_server() {
        let env = Env::new().await;
        with_admin(&env);
        let (state, id) = connected(&env).await;

        create_user_impl(
            &state,
            &id,
            "orders",
            "app",
            "s3cret",
            &[role("readWrite", "orders")],
        )
        .await
        .unwrap();

        match calls(&env).as_slice() {
            [FakeAdmin::CreateUser(c)] => {
                assert_eq!(
                    (
                        c.database.as_str(),
                        c.username.as_str(),
                        c.password.as_str()
                    ),
                    ("orders", "app", "s3cret")
                );
                assert_eq!(
                    c.roles,
                    [PbRoleSpec {
                        role: "readWrite".to_string(),
                        db: "orders".to_string()
                    }]
                );
            }
            other => panic!("{other:?}"),
        }
    }

    // An update changes only what was given: a password alone keeps the
    // roles, and roles given (even none) replace them.
    #[tokio::test]
    async fn an_update_changes_only_what_was_given() {
        let env = Env::new().await;
        with_admin(&env);
        let (state, id) = connected(&env).await;

        update_user_impl(&state, &id, "orders", "app", Some("n3w"), None)
            .await
            .unwrap();
        update_user_impl(
            &state,
            &id,
            "orders",
            "app",
            Some(""),
            Some(&[role("read", "orders")]),
        )
        .await
        .unwrap();
        update_user_impl(&state, &id, "orders", "app", None, Some(&[]))
            .await
            .unwrap();

        match calls(&env).as_slice() {
            [FakeAdmin::UpdateUser(a), FakeAdmin::UpdateUser(b), FakeAdmin::UpdateUser(c)] => {
                assert_eq!(
                    (a.password.as_deref(), a.replace_roles),
                    (Some("n3w"), false)
                );
                assert_eq!(
                    (b.password.as_deref(), b.replace_roles, b.roles.len()),
                    (None, true, 1)
                );
                assert_eq!(
                    (c.password.as_deref(), c.replace_roles, c.roles.len()),
                    (None, true, 0)
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn a_user_is_dropped_on_the_server() {
        let env = Env::new().await;
        with_admin(&env);
        let (state, id) = connected(&env).await;

        drop_user_impl(&state, &id, "orders", "app").await.unwrap();

        match calls(&env).as_slice() {
            [FakeAdmin::DropUser(d)] => assert_eq!(
                (d.database.as_str(), d.username.as_str()),
                ("orders", "app")
            ),
            other => panic!("{other:?}"),
        }
    }

    // What local mode refuses goes nowhere; nor does a change by a user
    // without the admin role, or on a read-only connection.
    #[tokio::test]
    async fn refused_user_changes_send_nothing() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;
        let err = drop_user_impl(&state, &id, "orders", "app")
            .await
            .unwrap_err();
        assert!(err.contains("does not allow admin operations"), "{err}");

        with_admin(&env);
        let (state, id) = connected(&env).await;
        assert!(create_user_impl(&state, &id, "orders", "app", "", &[])
            .await
            .is_err());
        assert!(update_user_impl(&state, &id, "orders", "app", None, None)
            .await
            .is_err());
        assert!(
            create_user_impl(&state, &id, "orders", "app", "pw", &[role("", "orders")])
                .await
                .is_err()
        );
        crate::set_connection_meta_impl(
            &state,
            &id,
            "server:a:c1",
            "Orders",
            false,
            crate::connections::ConnectionMode::ReadOnly,
        )
        .unwrap();
        assert!(drop_user_impl(&state, &id, "orders", "app").await.is_err());
        assert!(calls(&env).is_empty());
    }
}
