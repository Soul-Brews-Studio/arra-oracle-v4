import type { ApiResult } from "../api/client";
import { describeConflict } from "./describeConflict";

export type PublishResult = { ok: true } | { ok: false; error: string };

/** Turns one `publishRevision` response into the publish outcome -- pulled
 *  out of `useKnowledge.publish` (fix round, 2026-09-27) because that
 *  decision had no test that could see it go wrong except through a hook
 *  harness this repo does not have. Same shape as `applySearchOutcome`: a
 *  plain, DOM-free unit a render-free test can pin directly.
 *
 * `publishRevision` reports a REFUSAL as HTTP 200 `{outcome: "conflict",
 * reason}` (`service.publishRevision.ts`) -- indistinguishable from success
 * by `result.ok` alone. Measured live: publishing onto a superseded node
 * returned `{"ok":true,"status":200,"body":{"outcome":"conflict"}}`, and the
 * caller navigated as if it had succeeded. This function is the one place
 * that tells a conflict apart from `accepted`/`idempotent`, so the caller
 * only has to act on the result, never re-read `outcome` itself.
 *
 * `describeFailure` is passed in rather than imported so this file does not
 * duplicate `useKnowledge`'s transport-error formatting (HTTP status /
 * error envelope) -- the two describe functions serve different failure
 * shapes and only this one also needs `describeConflict`. */
export function interpretPublishResult(result: ApiResult, describeFailure: (result: ApiResult) => string): PublishResult {
  if (!result.ok) {
    return { ok: false, error: describeFailure(result) };
  }
  const body = result.body as { outcome?: unknown; reason?: unknown } | null;
  if (body !== null && body.outcome === "conflict") {
    return { ok: false, error: describeConflict(body.reason) };
  }
  return { ok: true };
}
