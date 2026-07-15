use serde_json::Value;

// (name, type) pairs — type is "collection" or "timeseries", matching the
// strings list_collections_impl reports for real clusters.
pub fn get_mock_collections(db: &str) -> Vec<(String, &'static str)> {
    match db {
        "sales_db" => vec![
            ("customers".to_string(), "collection"),
            ("transactions".to_string(), "collection"),
            ("products".to_string(), "collection"),
            ("sensor_readings".to_string(), "timeseries"),
        ],
        "user_analytics" => vec![
            ("events".to_string(), "collection"),
            ("sessions".to_string(), "collection"),
        ],
        "admin" => vec![
            ("system.users".to_string(), "collection"),
            ("system.version".to_string(), "collection"),
        ],
        _ => vec![],
    }
}

// Count matching mock documents (no pagination) — mirrors the filter logic of
// execute_mock_query so counts aren't capped by the page limit.
pub fn count_mock_documents(database: &str, collection: &str, filter: &str) -> Result<u64, String> {
    let filter_val: Value = if filter.trim().is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(filter).map_err(|e| format!("Invalid MQL filter JSON: {}", e))?
    };

    let mut docs = get_mock_data(database, collection);
    if let Value::Object(filter_map) = &filter_val {
        docs.retain(|doc| {
            for (k, v) in filter_map {
                if doc.get(k) != Some(v) {
                    return false;
                }
            }
            true
        });
    }
    Ok(docs.len() as u64)
}

pub fn execute_mock_query(
    database: &str,
    collection: &str,
    filter: &str,
    sort: &str,
    limit: i64,
    skip: i64,
) -> Result<Vec<String>, String> {
    let filter_val: Value = if filter.trim().is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(filter).map_err(|e| format!("Invalid MQL filter JSON: {}", e))?
    };

    let sort_val: Value = if sort.trim().is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(sort).map_err(|e| format!("Invalid MQL sort JSON: {}", e))?
    };

    let mut docs = get_mock_data(database, collection);

    // Filter mock documents
    if let Value::Object(filter_map) = &filter_val {
        docs.retain(|doc| {
            for (k, v) in filter_map {
                if doc.get(k) != Some(v) {
                    return false;
                }
            }
            true
        });
    }

    // Sort mock documents
    if let Value::Object(sort_map) = &sort_val {
        for (k, order) in sort_map {
            let is_descending = order.as_i64().unwrap_or(1) == -1;
            docs.sort_by(|a, b| {
                let val_a = a.get(k);
                let val_b = b.get(k);
                match (val_a, val_b) {
                    (Some(va), Some(vb)) => {
                        if va.is_number() && vb.is_number() {
                            let num_a = va.as_f64().unwrap_or(0.0);
                            let num_b = vb.as_f64().unwrap_or(0.0);
                            if is_descending {
                                num_b
                                    .partial_cmp(&num_a)
                                    .unwrap_or(std::cmp::Ordering::Equal)
                            } else {
                                num_a
                                    .partial_cmp(&num_b)
                                    .unwrap_or(std::cmp::Ordering::Equal)
                            }
                        } else {
                            let str_a = va.to_string();
                            let str_b = vb.to_string();
                            if is_descending {
                                str_b.cmp(&str_a)
                            } else {
                                str_a.cmp(&str_b)
                            }
                        }
                    }
                    (Some(_), None) => {
                        if is_descending {
                            std::cmp::Ordering::Less
                        } else {
                            std::cmp::Ordering::Greater
                        }
                    }
                    (None, Some(_)) => {
                        if is_descending {
                            std::cmp::Ordering::Greater
                        } else {
                            std::cmp::Ordering::Less
                        }
                    }
                    (None, None) => std::cmp::Ordering::Equal,
                }
            });
        }
    }

    // Paginate mock documents
    let total_len = docs.len();
    let skip_index = (skip as usize).min(total_len);
    let max_limit = crate::limits::normalize_query_limit(limit) as usize;
    let limit_index = (skip_index + max_limit).min(total_len);

    let sliced = docs[skip_index..limit_index].to_vec();
    let result_strs: Vec<String> = sliced
        .iter()
        .map(|v| serde_json::to_string(v).unwrap())
        .collect();
    Ok(result_strs)
}

pub fn get_mock_explain(database: &str, collection: &str, filter: &str) -> String {
    // Only sales_db.transactions returns a COLLSCAN plan, so the index-suggestion
    // banner has somewhere to demo without a real server. Every other namespace
    // keeps the pre-existing IXSCAN shape.
    let winning_plan = if database == "sales_db" && collection == "transactions" {
        serde_json::json!({
            "stage": "SORT",
            "sortPattern": { "timestamp": -1 },
            "inputStage": { "stage": "COLLSCAN" }
        })
    } else {
        serde_json::json!({
            "stage": "IXSCAN",
            "keyPattern": { "category": 1 },
            "indexName": "category_1",
            "isMultiKey": false,
            "direction": "forward"
        })
    };

    let parsed_query = if database == "sales_db" && collection == "transactions" {
        serde_json::json!({ "$and": [ { "customer_name": { "$eq": "Alice Smith" } } ] })
    } else {
        serde_json::from_str::<serde_json::Value>(filter).unwrap_or_default()
    };

    let plan = serde_json::json!({
        "explainVersion": "1",
        "queryPlanner": {
            "namespace": format!("{}.{}", database, collection),
            "indexFilterSet": false,
            "parsedQuery": parsed_query,
            "winningPlan": winning_plan
        },
        "executionStats": {
            "executionSuccess": true,
            "nReturned": 3,
            "executionTimeMillis": 1,
            "totalKeysExamined": 3,
            "totalDocsExamined": 3
        }
    });
    serde_json::to_string_pretty(&plan).unwrap()
}

fn get_mock_data(database: &str, collection: &str) -> Vec<Value> {
    match (database, collection) {
        ("sales_db", "customers") => {
            vec![
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3120" },
                    "name": "Alice Smith",
                    "email": "alice@example.com",
                    "tier": "Premium",
                    "joined": "2024-01-10",
                    "address": { "city": "New York", "state": "NY" }
                }),
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3121" },
                    "name": "Bob Johnson",
                    "email": "bob@example.com",
                    "tier": "Standard",
                    "joined": "2024-03-15",
                    "address": { "city": "San Francisco", "state": "CA" }
                }),
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3122" },
                    "name": "Charlie Brown",
                    "email": "charlie@example.com",
                    "tier": "Premium",
                    "joined": "2023-11-20",
                    "address": { "city": "Seattle", "state": "WA" }
                }),
            ]
        }
        ("sales_db", "transactions") => {
            vec![
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3220" },
                    "customer_name": "Alice Smith",
                    "amount": 1250.00,
                    "items": ["SuperBook Pro"],
                    "status": "Completed",
                    "timestamp": "2025-05-10T14:32:00Z"
                }),
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3221" },
                    "customer_name": "Bob Johnson",
                    "amount": 199.99,
                    "items": ["Noise Cancelling Headphones"],
                    "status": "Completed",
                    "timestamp": "2025-05-12T09:15:00Z"
                }),
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3222" },
                    "customer_name": "Charlie Brown",
                    "amount": 549.49,
                    "items": ["Ergonomic Desk Chair", "Monitor Stand"],
                    "status": "Pending",
                    "timestamp": "2025-05-24T18:00:00Z"
                }),
            ]
        }
        ("sales_db", "products") => {
            vec![
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3320" },
                    "name": "SuperBook Pro",
                    "category": "Electronics",
                    "price": 1299.99,
                    "stock": 42
                }),
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3321" },
                    "name": "Noise Cancelling Headphones",
                    "category": "Electronics",
                    "price": 199.99,
                    "stock": 150
                }),
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3322" },
                    "name": "Ergonomic Desk Chair",
                    "category": "Office",
                    "price": 349.50,
                    "stock": 25
                }),
            ]
        }
        ("user_analytics", "events") => {
            vec![
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3420" },
                    "event_type": "page_view",
                    "path": "/home",
                    "timestamp": "2026-05-24T22:00:00Z"
                }),
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3421" },
                    "event_type": "click",
                    "target": "buy-now-btn",
                    "timestamp": "2026-05-24T22:05:00Z"
                }),
            ]
        }
        ("user_analytics", "sessions") => {
            vec![
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3520" },
                    "session_id": "sess_001",
                    "duration_seconds": 180,
                    "referrer": "google.com"
                }),
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3521" },
                    "session_id": "sess_002",
                    "duration_seconds": 950,
                    "referrer": "github.com"
                }),
            ]
        }
        ("sales_db", "sensor_readings") => {
            vec![
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3320" },
                    "timestamp": "2026-07-10T08:00:00Z",
                    "sensor_id": "temp-01",
                    "value": 21.4,
                    "unit": "C"
                }),
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3321" },
                    "timestamp": "2026-07-10T08:05:00Z",
                    "sensor_id": "temp-01",
                    "value": 21.9,
                    "unit": "C"
                }),
                serde_json::json!({
                    "_id": { "$oid": "603d779f4f102e3a105c3322" },
                    "timestamp": "2026-07-10T08:10:00Z",
                    "sensor_id": "hum-02",
                    "value": 44.0,
                    "unit": "%"
                }),
            ]
        }
        _ => vec![],
    }
}

// Build a mock IndexInfo from a conventional index name (e.g. "email_1" -> { email: 1 }).
// This name-parsing lives ONLY in mock data; real connections read the actual spec.
fn mock_index(name: &str) -> crate::IndexInfo {
    let (keys, unique) = if name == "_id_" {
        (r#"{"_id":1}"#.to_string(), true)
    } else {
        // Split a trailing _1 / _-1 direction off the field name.
        match name.rsplit_once('_') {
            Some((field, dir)) if dir == "1" || dir == "-1" => {
                (format!("{{\"{}\":{}}}", field, dir), false)
            }
            _ => (format!("{{\"{}\":1}}", name), false),
        }
    };
    crate::IndexInfo {
        name: name.to_string(),
        keys,
        unique,
        sparse: false,
    }
}

pub fn get_mock_indexes(db: &str, collection: &str) -> Vec<crate::IndexInfo> {
    let names: Vec<&str> = match (db, collection) {
        ("sales_db", "customers") => vec!["_id_", "email_1", "tier_1"],
        ("sales_db", "transactions") => vec!["_id_", "timestamp_-1", "customer_name_1"],
        ("sales_db", "products") => vec!["_id_", "price_1", "category_1"],
        ("sales_db", "sensor_readings") => vec!["_id_", "timestamp_-1"],
        ("user_analytics", "events") => vec!["_id_", "event_type_1", "timestamp_-1"],
        ("user_analytics", "sessions") => vec!["_id_", "session_id_1"],
        ("admin", "system.users") => vec!["_id_", "user_1_db_1"],
        _ => vec!["_id_"],
    };
    names.into_iter().map(mock_index).collect()
}
