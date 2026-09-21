import { requireClosedObject } from "../../contracts/common";
import type { JcsValue } from "../../contracts/jcs";
import { failTaxonomy } from "./fail-taxonomy";
import { requireId } from "./require-id";
import { requireWorkspace } from "./require-workspace";
import { parseRequest } from "./parse-request";
import { HORIZON_TERMS, TYPE_TERMS } from "./constants";
import type { SeedRequest } from "./types";

export function parseSeedRequest(bytes: Uint8Array): SeedRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "type", "memory_horizon"], []);
  const workspace = requireWorkspace(request.get("workspace_name"));

  const branch = <K extends readonly string[]>(raw: JcsValue | undefined, group: string, terms: K) => {
    // Tokens, not concatenated strings: the shared helper owns RFC 6901
    // escaping and the deterministic unknown-key ordering.
    const node = requireClosedObject(raw ?? null, ["vocabulary_id", "terms"], [group]);
    const termObject = requireClosedObject(node.get("terms") ?? null, terms, [group, "terms"]);
    const ids: Record<string, string> = {};
    for (const key of terms) {
      ids[key] = requireId(termObject.get(key), [group, "terms", key]);
    }
    return {
      vocabulary_id: requireId(node.get("vocabulary_id"), [group, "vocabulary_id"]),
      terms: ids,
    };
  };

  const type = branch(request.get("type"), "type", TYPE_TERMS);
  const horizon = branch(request.get("memory_horizon"), "memory_horizon", HORIZON_TERMS);

  // All nine IDs distinct within the supplied workspace. Reported against the
  // LATER occurrence, which is the one that collides with what came before.
  const seen = new Set<string>();
  const check = (value: string, path: string) => {
    if (seen.has(value)) failTaxonomy("invalid_request", path);
    seen.add(value);
  };
  check(type.vocabulary_id, "/type/vocabulary_id");
  for (const key of TYPE_TERMS) check(type.terms[key]!, `/type/terms/${key}`);
  check(horizon.vocabulary_id, "/memory_horizon/vocabulary_id");
  for (const key of HORIZON_TERMS) check(horizon.terms[key]!, `/memory_horizon/terms/${key}`);

  return {
    workspace_name: workspace,
    type: type as SeedRequest["type"],
    memory_horizon: horizon as SeedRequest["memory_horizon"],
  };
}
