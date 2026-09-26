import { connect } from "@lancedb/lancedb";
import { encodeConnectionRow } from "../publication/context.encodeConnectionRow";
import { encodeMcpCallRow } from "../publication/context.encodeMcpCallRow";
import { encodeMessageRow } from "../publication/context.encodeMessageRow";
import { encodePeerRow } from "../publication/context.encodePeerRow";
import { encodeSessionPeerRow } from "../publication/context.encodeSessionPeerRow";
import { encodeSessionRow } from "../publication/context.encodeSessionRow";
import { encodeSupersedeLogRow } from "../publication/lifecycle";
import { encodeReadCursorRow, validateWorkspaceRow } from "../publication/read-cursor";
import { encodeNodeRow } from "../publication/rows";
import { encodeSearchChunkRow } from "../publication/search-chunk.encodeSearchChunkRow";
import { decodeVerifiedRevision } from "../publication/service.decodeVerifiedRevision";
import { encodeDerivedLink } from "../publication/service.encodeDerivedLink";
import { encodeDerivedTerm } from "../publication/service.encodeDerivedTerm";
import { encodeSessionLinkRow } from "../publication/session-link";
import { assertTargetDataset, decodeArrowRows, TARGET_TABLES } from "../publication/storage";
import { encodeTermRow } from "../publication/taxonomy.encodeTermRow";
import { encodeVocabularyRow } from "../publication/taxonomy.encodeVocabularyRow";
import { encodeTraceHitRow } from "../publication/trace.encodeTraceHitRow";
import { encodeTraceRow } from "../publication/trace.encodeTraceRow";
import { errorOutcome } from "./errorOutcome";
import { type Emit } from "./plan.types";

/** The TS stored-row codec for every one of the 19 tables. */
const CODECS: Readonly<Record<string, (row: Record<string, unknown>) => unknown>> = {
  workspaces: validateWorkspaceRow,
  peers: encodePeerRow,
  sessions: encodeSessionRow,
  session_peers: encodeSessionPeerRow,
  messages: encodeMessageRow,
  session_links: encodeSessionLinkRow,
  nodes: encodeNodeRow,
  // Recomputes the content digest from the governed columns, not just shape.
  node_revisions: decodeVerifiedRevision,
  node_revision_terms: encodeDerivedTerm,
  revision_links: encodeDerivedLink,
  supersede_log: encodeSupersedeLogRow,
  vocabularies: encodeVocabularyRow,
  terms: encodeTermRow,
  traces: encodeTraceRow,
  trace_hits: encodeTraceHitRow,
  search_chunks_v1: encodeSearchChunkRow,
  mcp_calls: encodeMcpCallRow,
  connections: encodeConnectionRow,
  read_cursors: encodeReadCursorRow,
};

/**
 * Re-read EVERY stored row of the finished candidate through the TS
 * stored-row codecs, from raw Arrow buffers (never `toArray`), and report
 * per-table failures. A row Python wrote that the service would reject on
 * read -- a sub-millisecond time, a non-nanoid id -- shows up here.
 *
 * Read-only and run after the writer bundle is closed: it opens a plain
 * connection, verifies the reviewed 19-table shape, and writes nothing.
 */
export async function checkStoredRows(candidateRoot: string, emit: Emit): Promise<void> {
  const connection = await connect(candidateRoot, { readConsistencyInterval: 0 });
  let targetOk = true;
  try {
    await assertTargetDataset(connection);
  } catch (error) {
    errorOutcome(error);
    targetOk = false;
  }
  const tables: Record<string, { rows: number; failures: number; first?: unknown }> = {};
  if (targetOk) {
    for (const name of TARGET_TABLES) {
      const codec = CODECS[name];
      if (codec === undefined) throw new Error(`no stored-row codec wired for ${name}`);
      const table = await connection.openTable(name);
      const rows = decodeArrowRows(await table.query().toArrow());
      let failures = 0;
      let first: unknown;
      for (const row of rows) {
        try {
          codec(row);
        } catch (error) {
          failures += 1;
          first ??= errorOutcome(error);
        }
      }
      tables[name] = failures ? { rows: rows.length, failures, first } : { rows: rows.length, failures };
    }
  }
  connection.close();
  emit({ kind: "codec", target_dataset_ok: targetOk, tables });
}
