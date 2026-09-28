/**
 * Barrel for the publication kernel's dataset adapters (#22 style-split4a).
 *
 * Everything here is PACKAGE-INTERNAL. The contracted factories live in
 * `service.ts`; nothing in this module is a request-facing service, and no
 * raw `Table` or `Connection` ever leaves it.
 *
 * Each exported function moved VERBATIM to its own `storage.<fn>.ts`
 * sibling; shared data lives in `storage.schema.ts`, the shared
 * `realpathOrFail` helper in `storage.realpathOrFail.ts`. Re-exports here do
 * not count as function exports under the one-function-per-file ratchet
 * (`app/migrate-py/tests/test_revision_v1.py`'s HELPER_REUSE_ALLOWED derives
 * the split siblings from this barrel automatically via
 * `barrel.parent.glob(f"{barrel.stem}.*.ts")`).
 *
 * Responsibilities, each one a decision rather than an accident:
 *
 * 1. Prove the inherited descriptor really is this dataset's gate -- by
 *    number, ownership, mode, link count and inode, on the descriptor itself.
 *    The environment says where to look and proves nothing.
 * 2. Resolve the dataset root through realpath, matching Python's
 *    `Path.resolve()`. A lexical resolve would let two spellings of one
 *    directory disagree about identity across the two languages.
 * 3. Refuse any dataset that is not the reviewed target19 SHAPE -- all 19
 *    tables, every field name, type and nullability -- before any mutation.
 * 4. Read timestamp and Int64 columns from RAW Arrow buffers, never a row
 *    accessor, so exact microsecond precision survives to the encoder.
 */
export { LOCK_FILENAME, INHERITED_FD, assertInheritedGate } from "./storage.assertInheritedGate";
export { TARGET_SCHEMA, TARGET_TABLES } from "./storage.schema";
export { assertLocalDatasetRoot } from "./storage.assertLocalDatasetRoot";
export { describeField } from "./storage.describeField";
export { assertTargetDataset } from "./storage.assertTargetDataset";
export { quote } from "./storage.quote";
export { decodeArrowRows } from "./storage.decodeArrowRows";
export { rawRows } from "./storage.rawRows";

// No connection factory is exported. `service.ts` opens its own connection
// and keeps it private, so this module offers no route to a raw handle.
export type { Connection, Table } from "@lancedb/lancedb";
