/** Thin fetch wrapper over `POST /api/knowledge/:bank/:method`.
 *
 * Two things this deliberately surfaces rather than smooths over:
 *   - the HTTP STATUS, because the server maps error codes to distinct
 *     statuses (409 conflict, 503 recovery_required, 404 not_found) and
 *     collapsing them would hide the thing most worth seeing
 *   - the raw JSON body, unformatted, because this is a POC for inspecting
 *     real envelopes
 */
export type ApiResult = {
  ok: boolean;
  status: number;
  durationMs: number;
  body: unknown;
  error?: string;
};

// callMethod / health moved out (style-ui-split, docs/overnight/DECISIONS.md):
// each lives in its own file named after itself. Re-exported here so
// importers (`state/useOverview.ts`, `components/WorkspaceBar.tsx`) do not
// churn.
export { callMethod } from "./client.callMethod";
export { health } from "./client.health";
