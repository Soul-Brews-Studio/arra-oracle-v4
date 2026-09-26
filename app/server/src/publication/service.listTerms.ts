import { MAX_CHAIN_WIRE_BYTES } from "./rows";
import { quote } from "./storage";
import { encodeTermRow, parseListTerms } from "./taxonomy";
import { TERM_FIELDS } from "./taxonomy.constants";
import { failTaxonomy } from "./taxonomy.failTaxonomy";
import { TERMS, scopeOf } from "./service.constants";
import { readTaxonomy } from "./service.readTaxonomy";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";
import { wireBytesOf } from "./service.wireBytesOf";

/**
 * K6 (docs/overnight/V3-PARITY.md §5): a plain, workspace+vocabulary-scoped,
 * keyset-paginated term listing. `getTerm`/`lookupTermByName` are get-by-one
 * only, so nothing before this could enumerate a vocabulary's terms.
 */
export async function listTerms(
  reader: DatasetAdapter,
  requestBytes: Uint8Array,
): Promise<{ rows: Record<string, unknown>[]; next_after_id: string | null }> {
  return readTaxonomy(async () => {
    const request = parseListTerms(requestBytes);
    // Same workspace precedence as `listNodes`/`listPeers`/`listSessions`:
    // an unseeded bank is `invalid_reference`, not an empty listing.
    await requireWorkspace(reader, request.workspace_name);
    await reader.refresh(TERMS);

    const scope =
      scopeOf(request.workspace_name) +
      ` AND vocabulary_id = ${quote(request.vocabulary_id)}` +
      (request.include_inactive ? "" : " AND is_active = true") +
      (request.after_id === null ? "" : ` AND id > ${quote(request.after_id)}`);

    // KEYSET, never offset: `id` is a nanoid21 assigned once per term and
    // never reused, so ascending `id` order is a safe total-order cursor --
    // the same shape `listNodes` uses over its own id. One projection over
    // every physical field, matching `listPeers`: no per-row re-fetch.
    const selected = await reader.orderedProjection(
      TERMS,
      scope,
      [...TERM_FIELDS],
      { column: "id", ascending: true },
      request.limit + 1,
    );

    const seen = new Set<string>();
    for (const row of selected) {
      const id = row.id;
      if (typeof id !== "string") failTaxonomy("integrity_failure");
      // A duplicate id straddling the lookahead row would otherwise evade
      // the check and split silently across two pages.
      if (seen.has(id)) failTaxonomy("integrity_failure");
      seen.add(id);
    }

    const page = selected.slice(0, request.limit);
    const rows: Record<string, unknown>[] = [];
    let budget = 1;
    for (const row of page) {
      const encoded = encodeTermRow(row);
      budget += wireBytesOf(encoded) + 1;
      if (budget > MAX_CHAIN_WIRE_BYTES) failTaxonomy("limit_exceeded");
      rows.push(encoded);
    }

    const hasMore = selected.length > request.limit;
    const lastId = page.length > 0 ? page[page.length - 1]!.id : null;
    return { rows, next_after_id: hasMore ? (lastId as string) : null };
  });
}
