import { KNOWLEDGE_METHODS, type KnowledgeBundle, type RequestAuthority } from "../../knowledge/registry";
import type { KnowledgeAccess } from "../../knowledge/transport";
import { callKnowledgeMethod } from "../index.callKnowledgeMethod";
import type { V3ToolSpec } from "./catalogue";
import { READER_ONLY_METHODS } from "./readerOnlyMethods";

export type Kb = (method: string, payload: Record<string, unknown>) => Promise<unknown>;

/** A write tool may call reads and writes; a read tool only reads (A1 rule 2). */
const RANK: Readonly<Record<string, number>> = Object.freeze({ "content:read": 0, "content:write": 1 });

/**
 * The ONE capability an adapter tool gets (docs/overnight/V3-PARITY.md §3 A1):
 * `kb(method, payload)`. Before any bundle is touched it
 *  1. refuses a method outside the tool's static `uses` list;
 *  2. refuses a method whose action is above the tool's (a read tool never
 *     reaches a write method, even if a catalogue edit listed one);
 *  3. sets `workspace_name` to the ROUTE bank at the method's `scopePath`,
 *     refusing a payload that already names another workspace;
 * then encodes to JSON bytes and calls the SAME registry entry HTTP and
 * `kb_*` call, through the same governed parser and peer binding. One bundle
 * per tool call, opened for the tool's own action -- except a reader-only
 * method (`readerOnlyMethods.ts`: the #30 searches, the chat facade), which
 * no writer carries: a write tool reaches it through one reader opened for
 * the call (R18 V5, `oracle_search_chain` searches, then writes traces).
 * Such a read returns bank content, and exact grants never let content:write
 * read, so a write tool reaches it only when its spec says it also needs
 * content:read -- which the service then admitted from the same snapshot
 * (`auth/service.toolAlsoNeeds.ts`).
 *
 * A refusal here is an adapter wiring fault, not caller input, so it is a
 * plain Error, never a governed envelope.
 */
export function createKb(context: {
  spec: V3ToolSpec;
  bank: string;
  authority: RequestAuthority;
  access: KnowledgeAccess | null;
}): Kb {
  const { spec, bank, authority, access } = context;
  let bundle: Promise<KnowledgeBundle> | null = null;
  let reader: Promise<KnowledgeBundle> | null = null;
  const pinned = () => {
    if (access === null) return Promise.reject(new Error("knowledge transport is not configured"));
    bundle ??= access.getBundle(spec.action);
    return bundle;
  };
  const reading = () => {
    if (spec.action === "content:read") return pinned();
    if (access === null) return Promise.reject(new Error("knowledge transport is not configured"));
    reader ??= access.getBundle("content:read");
    return reader;
  };

  return async (method, payload) => {
    if (!spec.uses.includes(method)) throw new Error(`${spec.name} may not call ${method}`);
    const entry = KNOWLEDGE_METHODS[method];
    if (entry === undefined) throw new Error(`${spec.name}: ${method} is not a registry method`);
    const rank = RANK[entry.action];
    if (rank === undefined || rank > RANK[spec.action]!) throw new Error(`${spec.name} (${spec.action}) may not call ${method} (${entry.action})`);
    const readerOnly = READER_ONLY_METHODS.includes(method);
    if (readerOnly && spec.action !== "content:read" && !(spec.alsoNeeds ?? []).includes("content:read")) {
      throw new Error(`${spec.name} (${spec.action}) may not call ${method}: it reads bank content and the tool does not also need content:read`);
    }

    const scoped = structuredClone(payload) as Record<string, unknown>;
    let node: Record<string, unknown> = scoped;
    for (const token of entry.scopePath) {
      const next = node[token];
      if (typeof next !== "object" || next === null || Array.isArray(next)) throw new Error(`${spec.name}: ${method} payload has no ${token} object`);
      node = next as Record<string, unknown>;
    }
    if ("workspace_name" in node && node.workspace_name !== bank) throw new Error(`${spec.name}: payload names another workspace`);
    node.workspace_name = bank;

    const bytes = new TextEncoder().encode(JSON.stringify(scoped));
    return callKnowledgeMethod(access, method, bytes, authority, readerOnly ? reading : pinned);
  };
}
