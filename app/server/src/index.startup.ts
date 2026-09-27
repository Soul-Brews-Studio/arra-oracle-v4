// Split from index.ts (Nat style, one exported function per file —
// docs/overnight/DECISIONS.md, slice style-server-split, 2026-09-28).

import { buildApp } from "./index.buildApp";
import {
  checkChatConfig,
  checkSupportedRuntime,
  GLOBAL_BODY_BACKSTOP,
  readConfig,
  runStartupIndexWork,
} from "./composition";
import { loadPolicy } from "./auth/loader.loadPolicy";

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
