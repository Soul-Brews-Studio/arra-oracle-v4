import type { RequestAuthority } from "../knowledge/registry";
import type { KnowledgeAccess } from "../knowledge/transport";
import { isDatasetConfigured } from "../knowledge/transport.isDatasetConfigured";
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
 * `knowledgeAccess` null (no MCP knowledge access wired at all -- an
 * isolated test, or transport composition itself failing -- never the
 * bare-`ARRA_DATA_DIR` deployment, which still gets a non-null access with
 * `datasetConfigured: false`, see below) is a fail-closed `invalid_request`:
 * there is no kernel to even ask, so this is a wiring gap, not the
 * documented optional-root case.
 *
 * `ARRA_KNOWLEDGE_DATASET_ROOT` UNSET is different and expected
 * (`composition.ts`'s `composeKnowledgeAccess` docs, `README.md`): an
 * existing legacy-store-only deployment "keeps starting up exactly as
 * before", so `remember` must keep accepting any `type`, same as pre-D5a,
 * rather than failing every call with `unsupported_dataset`. That case is
 * detected from CONFIGURATION (`isDatasetConfigured`, backed by the
 * `KnowledgeAccess.datasetConfigured` flag `composeKnowledgeAccess` sets
 * false only when the root env var itself is unset), never from the error
 * code `getBundle` happens to throw: `unsupported_dataset` is the kernel's
 * one generic envelope for roughly fifteen distinct storage failures
 * (`publication/storage.ts`: missing root, root not a directory, missing
 * table, schema/field-type/nullability mismatch, ...), so a CONFIGURED root
 * that is broken in any of those ways throws the identical code and MUST
 * still fail closed -- only the documented root-unset shape bypasses (round
 * 3 fix: catching by code alone fails open on a configured-but-broken
 * dataset, which is exactly the case D5a exists to seal).
 */
export async function validateType(
  knowledgeAccess: KnowledgeAccess | null,
  bank: string,
  authority: RequestAuthority,
  type: string | undefined,
): Promise<string> {
  const wanted = type ?? DEFAULT_TYPE;
  if (knowledgeAccess === null) failTaxonomy("invalid_request", "/type");

  let vocabulary: { id: string } | null;
  try {
    vocabulary = (await callKnowledgeMethod(
      knowledgeAccess,
      "lookupVocabularyByName",
      encode({ workspace_name: bank, name: TYPE_VOCABULARY }),
      authority,
    )) as { id: string } | null;
  } catch (error) {
    if (!isDatasetConfigured(knowledgeAccess)) return wanted;
    throw error;
  }
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
