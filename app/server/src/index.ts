// Startup entry (SPEC §5.2, `authorization-integration-v1.md` §2, §3).
//
// Split into index.buildApp.ts and index.startup.ts (Nat style, one exported
// function per file — docs/overnight/DECISIONS.md, slice style-server-split,
// 2026-09-28); this path is unchanged (package.json scripts, dev-stack.sh,
// `bun build src/index.ts` all cite it) and still owns the ONLY
// `import.meta.main` startup call.
//
// Importing this module must not read real configuration, open the dataset,
// contact a model or listen; only `import.meta.main` does startup work.

import { startup } from "./index.startup";

export { buildApp } from "./index.buildApp";
export { startup } from "./index.startup";

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
