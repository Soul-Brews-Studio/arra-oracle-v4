// The call log (SPEC §6.3) — non-optional.
//
//   "An MCP server you cannot watch is one you are trusting on faith.
//    'The model said it saved that' is not evidence a row exists."
//
// Successes AND failures. A call that errored is the one you most want to read
// later — both of digger-node's refusal-message fixes were found by reading its
// own call log, not by a test.
//
// Re-export barrel (style-split5b, 2026-09-28, #22): every function that used
// to live here VERBATIM now lives in its own `calls.<fn>.ts` file, module
// state moved to `calls.state.ts` with one identity, and shared private
// helpers (`quote`, `requiredBank`, `safeInteger`) got their own single-export
// files since they are used by more than one split. This file is a RAW module
// in the Python adapter guard (`raw_import()` in
// app/migrate-py/tests/test_revision_v1.py, matching `./calls`/`../mcp/calls`
// plus any dotted split); a plain re-export barrel with no logic of its own
// changes nothing about that containment.
export { redact } from "./calls.redact";
export { truncate } from "./calls.truncate";
export { auditFailureCount } from "./calls.auditFailureCount";
export { logCall } from "./calls.logCall";
export type { AuditAttribution, CallRecord } from "./calls.logCall";
export { recent } from "./calls.recent";
export { aggregate } from "./calls.aggregate";
