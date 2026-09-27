// Split from index.ts (Nat style, one exported function per file —
// docs/overnight/DECISIONS.md, slice style-server-split, 2026-09-28).
//
// This module owns no routing logic, holds no store handle and imports no raw
// data, model or audit module: §3 keeps the HTTP entrypoint free of them, so
// even trusted index work is delegated to the composition module.

import { createApp } from "./app.createApp";
import { configureKnowledgeAccess, createMcpAdapter } from "./mcp";
import {
  composeAuditSink,
  composeKnowledgeAccess,
  composeService,
  composeV3Compat,
} from "./composition";

/** Build a fully wired app from explicit configuration. */
export async function buildApp(config: { policyPath: string; origin: string; assets?: string; v3Compat?: boolean }) {
  // R18 D10: explicit configuration wins; otherwise the operator's env. Read
  // once, so the service and the X-Arra-Peer header read agree.
  const v3Compat = config.v3Compat ?? composeV3Compat();
  // #31: the same process is the sole knowledge writer (see
  // knowledge/transport.ts's file header). Opened BEFORE `composeService` now
  // (D5a): the HTTP `remember` twin needs the SAME access MCP `remember` uses
  // to validate `type`, so it must exist before the service that wires it.
  // Shared by the HTTP route and the MCP `kb_*` tools below. The chat model
  // (#32 / R9) is composed inside it, from the same env.
  const access = await composeKnowledgeAccess();
  configureKnowledgeAccess(access);
  const service = await composeService(
    {
      policyPath: config.policyPath,
      origin: config.origin,
      port: 0,
      v3Compat,
    },
    access,
  );
  return createApp({ origin: config.origin, v3Compat }, service, createMcpAdapter(service), {
    assets: config.assets,
    // #31 / R8: the HTTP route (and the CLI's `kb` leg over it) audits into
    // the same composed sink MCP does.
    knowledge: { policyPath: config.policyPath, access, audit: await composeAuditSink() },
  });
}
