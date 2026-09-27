// Startup entry (SPEC §5.2, `authorization-integration-v1.md` §2, §3).
//
// This module owns no routing logic, holds no store handle and imports no raw
// data, model or audit module: §3 keeps the HTTP entrypoint free of them, so
// even trusted index work is delegated to the composition module.
//
// Importing this module must not read real configuration, open the dataset,
// contact a model or listen; only `import.meta.main` does startup work.

import { createApp } from "./app.createApp";
import { configureKnowledgeAccess, createMcpAdapter } from "./mcp";
import {
  checkChatConfig,
  checkSupportedRuntime,
  composeAuditSink,
  composeKnowledgeAccess,
  composeService,
  composeV3Compat,
  GLOBAL_BODY_BACKSTOP,
  readConfig,
  runStartupIndexWork,
} from "./composition";
import { loadPolicy } from "./auth/loader.loadPolicy";

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

/**
 * THE startup sequence — the one production actually runs.
 *
 * Order is contractual: refuse an unsupported runtime, read configuration
 * ONCE, validate the policy, do trusted index work, then build and listen.
 *
 * `import.meta.main` calls this and nothing else. An earlier version read the
 * configuration before the runtime check and then repeated the listen call
 * outside this function, so the tested seam was not the real path.
 */
export async function startup(
  deps: {
    readonly env?: NodeJS.ProcessEnv;
    readonly runtime?: () => ReturnType<typeof checkSupportedRuntime>;
    readonly indexWork?: () => Promise<void>;
    readonly build?: (config: { policyPath: string; origin: string }) => Promise<{
      listen(options: { port: number; hostname: string; maxRequestBodySize: number }): void;
    }>;
    readonly assets?: string;
  } = {},
): Promise<{ origin: string; port: number }> {
  // 1. Runtime first: the header and body guarantees were measured on the
  //    pinned versions and are not portable by assumption.
  const runtime = (deps.runtime ?? checkSupportedRuntime)();
  if (!runtime.ok) throw new Error(`startup refused: ${runtime.reason}`);

  // 2. Configuration, read exactly once and passed on from here. The chat
  //    model settings (#32 / R9) are validated with it: a malformed
  //    ARRA_CHAT_* refuses startup rather than failing the first question.
  const config = readConfig(deps.env ?? process.env);
  await checkChatConfig(deps.env ?? process.env);

  // 3. An unreadable or invalid policy stops startup rather than silently
  //    leaving the service open.
  loadPolicy(config.policyPath);

  // 4. Trusted index work, before anything can be served.
  await (deps.indexWork ?? runStartupIndexWork)();

  // 5. Build and listen, with the explicit global backstop ABOVE the route
  //    cap. That backstop is a resource ceiling, not an admission path.
  const build =
    deps.build ??
    ((c: { policyPath: string; origin: string }) => buildApp({ ...c, assets: deps.assets }));
  const app = await build({ policyPath: config.policyPath, origin: config.origin });
  app.listen({
    port: config.port,
    hostname: "127.0.0.1",
    maxRequestBodySize: GLOBAL_BODY_BACKSTOP,
  });
  return { origin: config.origin, port: config.port };
}

if (import.meta.main) {
  try {
    // The ONLY production path: no configuration read and no listen outside it.
    const { origin } = await startup({ assets: "public" });
    console.log(`arra-oracle-v4 on ${origin}`);
    console.log("  MCP   POST /mcp/:bank   (bearer required)");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "startup refused");
    process.exit(1);
  }
}
