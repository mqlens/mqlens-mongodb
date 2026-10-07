//! Collection options: the validator, its level and its action.

use crate::db::ddl::CollectionValidation;
use crate::server::channel::client;
use crate::server::ejson;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::ddl_service_client::DdlServiceClient;
use crate::server::pb::mqlens::v1::GetCollectionOptionsRequest;
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::AppState;

pub(crate) async fn get_collection_options(
    state: &AppState,
    conn: &RemoteConn,
    database: &str,
    collection: &str,
) -> Result<CollectionValidation, String> {
    routes::require("get_collection_options", conn)?;
    let request = GetCollectionOptionsRequest {
        connection_id: conn.remote_id.clone(),
        database: database.to_string(),
        collection: collection.to_string(),
    };
    let options = session_for(state, conn)
        .await?
        .call(request, |channel, request| async move {
            client!(DdlServiceClient, channel)
                .get_collection_options(request)
                .await
        })
        .await?;
    // Printed as local mode prints the validator document; none is "{}" in
    // both.
    let validator = ejson::doc_from_wire(&options.validator)?;
    Ok(CollectionValidation {
        validator: serde_json::to_string_pretty(&validator)
            .map_err(|e| format!("Failed to serialize validator: {}", e))?,
        validation_level: options.validation_level,
        validation_action: options.validation_action,
    })
}

#[cfg(test)]
mod tests {
    use crate::db::ddl::get_collection_options_impl;
    use crate::server::fake::Env;
    use crate::server::ops::connected;
    use mongodb::bson::doc;

    // Local mode pretty-prints the validator document the driver reads; the
    // server sends it as relaxed Extended JSON. They must read the same.
    #[tokio::test]
    async fn the_validator_reads_as_local_mode_prints_it() {
        let env = Env::new().await;
        let (state, id) = connected(&env).await;

        let options = get_collection_options_impl(&state, &id, "orders", "customers")
            .await
            .unwrap();

        let validator = doc! {
            "$jsonSchema": { "required": ["email"], "properties": { "age": { "minimum": 0 } } }
        };
        assert_eq!(
            options.validator,
            serde_json::to_string_pretty(&validator).unwrap()
        );
        assert_eq!(options.validation_level, "strict");
        assert_eq!(options.validation_action, "error");
    }

    #[tokio::test]
    async fn no_validator_reads_as_local_mode_shows_none() {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.collection_options.validator = "{}".to_string();
            s.collection_options.validation_level = String::new();
            s.collection_options.validation_action = String::new();
        });
        let (state, id) = connected(&env).await;

        let options = get_collection_options_impl(&state, &id, "orders", "customers")
            .await
            .unwrap();

        assert_eq!(options.validator, "{}");
        assert_eq!(options.validation_level, "");
        assert_eq!(options.validation_action, "");
    }
}
