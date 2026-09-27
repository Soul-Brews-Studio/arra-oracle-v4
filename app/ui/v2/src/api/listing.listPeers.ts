import { type Bank } from "./memory";
import { type Page, type PeerRow } from "./listing";
import { call } from "./listing.call";
import { toPage } from "./listing.toPage";

/** `include_total` is ALWAYS sent, never omitted.
 *
 * The first version spread it in only when true, which is the ergonomic
 * default in most APIs and wrong in this one: this kernel's request grammar
 * is closed and has no optional-key concept, so every field is
 * required-but-nullable and a missing key is `missing_field`, not a default.
 * Omitting it produced `missing_field at /include_total` on every call --
 * the same mismatch the isolation proof hit for the same reason.
 */
export async function listPeers(
  b: Bank,
  afterName: string | null,
  limit: number,
  includeTotal: boolean,
): Promise<Page<PeerRow>> {
  const result = await call(b, "listPeers", {
    after_name: afterName,
    limit,
    include_total: includeTotal,
  });
  return toPage<PeerRow>(result, "next_after_name");
}
