import type { RuntimeConfig } from "./composition.constants";

/** Read and validate configuration. Called at startup, never at import. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const policyPath = env.ARRA_AUTH_POLICY;
  if (typeof policyPath !== "string" || !policyPath.startsWith("/")) {
    throw new Error("ARRA_AUTH_POLICY must be an absolute path to the policy file");
  }
  const port = Number(env.PORT ?? 3939);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port");
  }
  const origin = env.ARRA_ORIGIN ?? `http://127.0.0.1:${port}`;
  // Fail fast on an unusable origin rather than at the first request.
  const parsed = new URL(origin);
  if (parsed.origin !== origin.replace(/\/$/, "")) {
    throw new Error("ARRA_ORIGIN must be an exact scheme://authority with no path");
  }
  return Object.freeze({ policyPath, origin: parsed.origin, port });
}
