import type { RequestAuthority } from "../knowledge/registry";
import type { KnowledgeAccess } from "../knowledge/transport";
import { failTaxonomy } from "../publication/taxonomy";
import { callKnowledgeMethod } from "./index.callKnowledgeMethod";

const TYPE_VOCABULARY = "type";
const DEFAULT_TYPE = "note";

const encode = (payload: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(payload));

/**
 * D5a (post-merge NAT-DECISIONS 2026-09-28): the legacy MCP `remember` tool
 * (spike `memories` table, no `node_revisions`/taxonomy row of its own) still
 * routes its `type` field through the SAME sealed `type` vocabulary the
 * knowledge transports (`kb_publishRevision` / `validateTermReferences.ts`)
 * enforce, so a caller cannot invent or resurrect a type here that the
 * taxonomy kernel would refuse there.
 *
 * Omitted `type` defaults to `note`, exactly like the reserved seed (R6/R10,
 * `taxonomy.constants.ts` `TYPE_TERMS`). An unknown, retired, or otherwise
 * unresolvable term is refused with the kernel's own closed
 * `arra-taxonomy-error/v1` envelope (`invalid_reference`), never a bespoke
 * error shape -- the same refusal `kb_publishRevision` gives for the same
 * cause (`service.validateTermReferences.ts`).
 *
 * `knowledgeAccess` unset means the taxonomy kernel is not wired at all in
 * this deployment; that is a fail-closed `invalid_request`, not a silent
 * bypass, since D5a is "validate it now", not "validate it when convenient".
 */
export async function validateRememberType(
  knowledgeAccess: KnowledgeAccess | null,
  bank: string,
  authority: RequestAuthority,
  type: string | undefined,
): Promise<string> {
  const wanted = type ?? DEFAULT_TYPE;
  if (knowledgeAccess === null) failTaxonomy("invalid_request", "/type");

  const vocabulary = (await callKnowledgeMethod(
    knowledgeAccess,
    "lookupVocabularyByName",
    encode({ workspace_name: bank, name: TYPE_VOCABULARY }),
    authority,
  )) as { id: string } | null;
  if (vocabulary === null) failTaxonomy("invalid_reference", "/type");

  const term = (await callKnowledgeMethod(
    knowledgeAccess,
    "lookupTermByName",
    encode({ workspace_name: bank, vocabulary_id: vocabulary.id, name: wanted }),
    authority,
  )) as { is_active: boolean } | null;
  if (term === null) failTaxonomy("invalid_reference", "/type");
  if (term.is_active !== true) failTaxonomy("invalid_reference", "/type");

  return wanted;
}
