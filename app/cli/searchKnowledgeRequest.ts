/**
 * `search` over the knowledge tier (#30, overnight R7 #30 part + R14): thin
 * sugar over `kb searchKnowledgeKeyword` / `kb searchKnowledgeSemantic`,
 * exactly like the friendly aliases in `kb.aliases.ts`. It shapes the JSON
 * and nothing more; the server's governed parser is the validator (the query
 * is sent verbatim, and an out-of-range limit is the server's `invalid_value`
 * at `/limit`, printed unchanged).
 *
 * Only what the server CANNOT tell apart is refused here, before any network
 * call: a missing `--query`, a malformed `--limit`, and `--profile` without
 * `--mode semantic` (keyword search has no profile to apply it to).
 */

import { KNOWLEDGE_METHOD_NAMES } from "../server/src/knowledge/registry";
import type { CliOptions } from "./parseFlags";
import { positiveInt } from "./positiveInt";

const METHOD = { keyword: "searchKnowledgeKeyword", semantic: "searchKnowledgeSemantic" } as const;
for (const method of Object.values(METHOD)) {
  if (!KNOWLEDGE_METHOD_NAMES.includes(method)) throw new Error(`searchKnowledgeRequest.ts: unknown registry method '${method}'`);
}

export function searchKnowledgeRequest(
  options: CliOptions,
  bank: string,
  mode: "keyword" | "semantic",
): { method: string; body: Record<string, unknown> } {
  const query = options.query;
  if (!query) throw new Error("--query is required");
  if (mode === "keyword" && options.profile !== undefined) throw new Error("--profile applies to --mode semantic only");
  const body: Record<string, unknown> = { workspace_name: bank, query };
  if (options.limit !== undefined) body.limit = positiveInt(options.limit, "limit", 10);
  if (options.profile !== undefined) body.embedding_profile = options.profile;
  return { method: METHOD[mode], body };
}
