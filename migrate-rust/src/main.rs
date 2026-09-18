// arra-oracle-v4 — LanceDB migration only. No search, no CRUD demo.
// Creates the `memories` table (columns per SPEC.md §3.4 / discussions #12-#15)
// as an empty LanceDB table. One bank = one directory, per §4.5.6.
//
// is_active vs tier is still open (issue #2) — column kept as-is until decided.

use arrow_schema::{DataType, Field, Fields, Schema, TimeUnit};
use lancedb::database::CreateTableMode;
use std::sync::Arc;

const EMBEDDING_DIM: i32 = 1024;

fn memories_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("name", DataType::Utf8, false),
        Field::new("workspace_name", DataType::Utf8, false),
        Field::new("session_name", DataType::Utf8, true),
        Field::new("peer_name", DataType::Utf8, true),
        Field::new("subject_peer_name", DataType::Utf8, true),
        Field::new("type", DataType::Utf8, false),
        Field::new("content", DataType::Utf8, false),
        Field::new(
            "embedding",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                EMBEDDING_DIM,
            ),
            true,
        ),
        Field::new(
            "created_at",
            DataType::Timestamp(TimeUnit::Microsecond, None),
            false,
        ),
        Field::new(
            "valid_from",
            DataType::Timestamp(TimeUnit::Microsecond, None),
            true,
        ),
        Field::new(
            "valid_to",
            DataType::Timestamp(TimeUnit::Microsecond, None),
            true,
        ),
        Field::new("sync_state", DataType::Utf8, false),
        Field::new("superseded_by", DataType::Utf8, true),
        Field::new(
            "superseded_at",
            DataType::Timestamp(TimeUnit::Microsecond, None),
            true,
        ),
        Field::new("is_active", DataType::Boolean, false),
        Field::new("h_metadata", DataType::Utf8, true),
        Field::new("internal_metadata", DataType::Utf8, true),
    ]))
}

#[tokio::main]
async fn main() -> lancedb::Result<()> {
    let data_dir = std::env::var("ARRA_V4_DATA_DIR").unwrap_or_else(|_| "./data".to_string());
    let db = lancedb::connect(&data_dir).execute().await?;

    let schema = memories_schema();
    let tbl = db
        .create_empty_table("memories", schema)
        .mode(CreateTableMode::Overwrite)
        .execute()
        .await?;

    println!("migrated: {} @ {}/memories.lance", tbl.name(), data_dir);
    for f in tbl.schema().await?.fields() as &Fields {
        println!("  {:<20} {:?} null={}", f.name(), f.data_type(), f.is_nullable());
    }
    Ok(())
}
