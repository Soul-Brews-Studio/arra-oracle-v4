// Rust owns the schema. Creates the `memories` table and nothing else --
// the TS server opens what this wrote, it never defines it.
//
// Idempotent by default: re-running leaves an existing table alone.
// ARRA_RESET=1 recreates it (old versions stay on disk; Lance keeps every manifest).

use arrow_schema::{DataType, Field, Schema, TimeUnit};
use lancedb::database::CreateTableMode;
use std::sync::Arc;

const EMBEDDING_DIM: i32 = 1024; // mxbai-embed-large / bge-m3 both emit 1024

fn memories_schema() -> Arc<Schema> {
    let ts = || DataType::Timestamp(TimeUnit::Microsecond, None);
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
            true, // nullable on purpose: text lands first, vectors backfill later
        ),
        Field::new("created_at", ts(), false),
        Field::new("valid_from", ts(), true),
        Field::new("valid_to", ts(), true),
        Field::new("sync_state", DataType::Utf8, false),
        Field::new("superseded_by", DataType::Utf8, true),
        Field::new("superseded_at", ts(), true),
        Field::new("is_active", DataType::Boolean, false),
        Field::new("h_metadata", DataType::Utf8, true),
        Field::new("internal_metadata", DataType::Utf8, true),
    ]))
}

#[tokio::main]
async fn main() -> lancedb::Result<()> {
    let data_dir = std::env::var("ARRA_DATA_DIR").unwrap_or_else(|_| "../data".to_string());
    let reset = std::env::var("ARRA_RESET").is_ok();
    let db = lancedb::connect(&data_dir).execute().await?;

    let existing = db.table_names().execute().await?;
    if existing.iter().any(|t| t == "memories") && !reset {
        let tbl = db.open_table("memories").execute().await?;
        println!(
            "memories already exists at {data_dir} -- rows={} version={}. ARRA_RESET=1 to recreate.",
            tbl.count_rows(None).await?,
            tbl.version().await?
        );
        return Ok(());
    }

    let tbl = db
        .create_empty_table("memories", memories_schema())
        .mode(CreateTableMode::Overwrite)
        .execute()
        .await?;

    println!("created  memories @ {data_dir}/memories.lance");
    for f in tbl.schema().await?.fields() {
        println!("  {:<20} {:?} null={}", f.name(), f.data_type(), f.is_nullable());
    }
    Ok(())
}
