import { type DatasetAdapter } from "./service.types";
import { validateDomainReferences } from "./service.validateDomainReferences";
import { validateLinkReferences } from "./service.validateLinkReferences";
import { validateTermReferences } from "./service.validateTermReferences";
import { validateValidity } from "./service.validateValidity";

/** All NEW-content reference checks, run before any append. */
export async function validateNewContent(
  adapter: DatasetAdapter,
  workspace: string,
  nodeId: string,
  encoded: Record<string, unknown>,
): Promise<void> {
  validateValidity(encoded);
  await validateDomainReferences(adapter, workspace, encoded);
  await validateTermReferences(adapter, workspace, encoded);
  await validateLinkReferences(adapter, workspace, nodeId, encoded);
}
