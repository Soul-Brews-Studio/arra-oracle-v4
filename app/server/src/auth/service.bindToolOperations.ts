import type { WorkspaceAction } from "./policy";
import type { RequestAuthority } from "../knowledge/registry";
import { isBoundAuthor } from "./service.isBoundAuthor";
import type { StoreDependencies, ToolOperations } from "./service.types";

/**
 * Operations bound to one admitted MCP request (`service.ts` `runMcp`).
 *
 * Every store-reaching method first calls `requires`, which the service
 * closes over its private context and a per-request liveness flag: the action
 * check stops a read-admitted dispatcher calling insert, and the liveness
 * check stops a dispatcher STASHING ops and using them after the request
 * finished. Split out of `service.ts` for its line cap only; it receives
 * `requires` and `deny` and so cannot mint or widen authority itself.
 */
export function bindToolOperations(bound: {
  bank: string;
  authority: RequestAuthority;
  assertedPeer: string | null;
  deps: StoreDependencies;
  requires: (needed: WorkspaceAction) => void;
  deny: (code: "forbidden") => never;
}): ToolOperations {
  const { bank, authority, assertedPeer, deps, requires, deny } = bound;
  return Object.freeze({
    bank,
    authority,
    assertedPeer,
    insert: (row) => {
      requires("content:write");
      // #87 / R3: `remember`'s author is bound like HTTP's, before the store.
      if (!isBoundAuthor(row, authority.peers)) deny("forbidden");
      return deps.insert({ ...row, workspace_name: bank });
    },
    list: (limit, filters) => {
      requires("content:read");
      return deps.list(bank, limit, filters);
    },
    searchText: (q, limit) => {
      requires("content:read");
      return deps.searchText(q, bank, limit);
    },
    searchVector: (q, limit) => {
      requires("content:read");
      return deps.searchVector(q, bank, limit);
    },
    getById: (id) => {
      requires("content:read");
      return deps.getById(bank, id);
    },
    stats: () => {
      requires("diagnostics:read");
      return deps.stats(bank);
    },
    embedReadiness: async () => {
      requires("diagnostics:read");
      const health = await deps.embedHealth();
      return { ok: health.ok, dims: health.dims };
    },
    recentCalls: (limit, status) => {
      requires("audit:read");
      return deps.recentCalls(bank, limit, status);
    },
    aggregateCalls: () => {
      requires("audit:read");
      return deps.aggregateCalls(bank);
    },
  } satisfies ToolOperations);
}
