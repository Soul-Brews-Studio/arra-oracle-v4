import { requireBoolean, requireClosedObject, requireEnum } from "../../contracts/common";
import { failTaxonomy } from "./fail-taxonomy";
import { requireId } from "./require-id";
import { requireLabel } from "./require-label";
import { requireName } from "./require-name";
import { requireNullableDescription } from "./require-nullable-description";
import { requireWorkspace } from "./require-workspace";
import { parseRequest } from "./parse-request";
import {
  CARDINALITIES,
  HIERARCHIES,
  RESERVED_VOCABULARY_NAMES,
  TERM_POLICIES,
  VOCABULARY_KINDS,
} from "./constants";

export type CreateVocabularyRequest = {
  workspace_name: string;
  vocabulary_id: string;
  name: string;
  label: string;
  description: string | null;
  kind: (typeof VOCABULARY_KINDS)[number];
  term_policy: (typeof TERM_POLICIES)[number];
  cardinality: (typeof CARDINALITIES)[number];
  required: boolean;
  hierarchy: (typeof HIERARCHIES)[number];
};

export function parseCreateVocabulary(bytes: Uint8Array): CreateVocabularyRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "vocabulary_id", "name", "label", "description",
     "kind", "term_policy", "cardinality", "required", "hierarchy"], []);
  const name = requireName(request.get("name"), ["name"]);
  // Reserved names belong to bootstrap alone. This is a policy refusal, so it
  // is invalid_request at /name rather than a conflict.
  if ((RESERVED_VOCABULARY_NAMES as readonly string[]).includes(name)) {
    failTaxonomy("invalid_request", "/name");
  }
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    vocabulary_id: requireId(request.get("vocabulary_id"), ["vocabulary_id"]),
    name,
    label: requireLabel(request.get("label"), ["label"]),
    description: requireNullableDescription(request.get("description"), ["description"]),
    kind: requireEnum(request.get("kind") ?? null, VOCABULARY_KINDS, ["kind"]),
    term_policy: requireEnum(request.get("term_policy") ?? null, TERM_POLICIES, ["term_policy"]),
    cardinality: requireEnum(request.get("cardinality") ?? null, CARDINALITIES, ["cardinality"]),
    required: requireBoolean(request.get("required") ?? null, ["required"]),
    hierarchy: requireEnum(request.get("hierarchy") ?? null, HIERARCHIES, ["hierarchy"]),
  };
}
