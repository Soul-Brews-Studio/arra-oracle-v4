/**
 * R18 D10: `ARRA_MCP_V3_COMPAT` turns on the v3-compatible MCP family
 * (`mcp/legacy-v3/`). Trusted operator configuration, read here and nowhere
 * else, never from a request. Only the exact value "1" enables it, so a typo
 * or "true" leaves the default (off) in place rather than guessing.
 */
export function composeV3Compat(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARRA_MCP_V3_COMPAT === "1";
}
