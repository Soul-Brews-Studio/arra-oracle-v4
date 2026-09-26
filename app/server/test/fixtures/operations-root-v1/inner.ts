// #103 / #102, DECISIONS.md R5: `mcp_calls` and `connections` are operations
// tables written straight to `ARRA_DATA_DIR` (`mcp/calls.ts`,
// `mcp/connections.ts`). The scenarios this file runs prove the READERS
// (`mcp/calls.listMcpCalls.ts`, `mcp/connections.listConnections.ts`, wired
// in `knowledge/registry.ts`) answer from that same root, on BOTH transports,
// with workspace isolation, pagination and `audit:read` authorization
// unchanged; that the #102 fold no longer corrupts `connections` under
// concurrent writers; and (fix round 2) that no caller can make one stored
// row deny the listing for a whole workspace.
//
// ISOLATION (fix-round finding, 2026-09-26): this file is named `inner.ts`,
// not `*.test.ts`, so Bun's own test-discovery glob (`.test.`/`.spec.` in the
// filename) never picks it up when a directory is handed to `bun test`
// (`test:full`'s `bun test test ../cli.test.ts`) or when `test.order.ts`
// walks `test/` for `*.test.ts` (`bun run test`, `test:parallel`). The ONLY
// way to run it is the explicit path invocation the sibling
// `../../operations-root-readers.test.ts` performs via `runOwnedChild`, which
// gives THIS file's own process -- and therefore its own, never-before-
// touched copy of `storage.ts` -- to set `ARRA_DATA_DIR` on. `DATA_DIR` is a
// `const` read from `process.env.ARRA_DATA_DIR` at module load
// (`storage.ts:15`), so sharing a `bun test` process with ANY file that
// already imported `../src/app` before this file's `beforeAll` runs would
// freeze `DATA_DIR` to whatever THAT file set (or the default `../data`) --
// measured regression: `bun test test/transport-service.test.ts
// test/mcp-correctness.test.ts` went from 31 pass / 0 fail to 16 pass /
// 15 fail once `knowledge/registry.ts` gained a STATIC import of this
// table's reader (fixed by making that import lazy; see `registry.ts`).
//
// LAYOUT (fix round 2): the scenarios used to live in this one file, which
// reached 520 lines. They are now registered from sibling files, each a
// single `register*` function, and still run in THIS one process against ONE
// fixture -- registration order below is execution order, and it matters:
//   ./service-level.ts    direct reader/writer calls, private workspaces
//   ./live-transports.ts  HTTP + MCP; order-dependent `cred-a` counts
//   ./audit-poisoning.ts  `cred-ro` traffic on livealpha -- LAST, so the
//                         counts above never see it
import { afterAll, beforeAll } from "bun:test";
import { registerAuditPoisoningTests } from "./audit-poisoning";
import { openOperationsRootFixture, type OperationsRootFixture } from "./fixture";
import { registerLiveTransportTests } from "./live-transports";
import { registerServiceLevelTests } from "./service-level";

// Filled in by `beforeAll`; the registered tests only dereference it at RUN
// time, by which point it is complete.
const fx = {} as OperationsRootFixture;

beforeAll(async () => {
  Object.assign(fx, await openOperationsRootFixture());
}, 30_000);

afterAll(async () => {
  await fx.cleanup?.();
}, 30_000);

registerServiceLevelTests(fx);
registerLiveTransportTests(fx);
registerAuditPoisoningTests(fx);
