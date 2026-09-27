/**
 * `GET /api/instance-audit` (#31 R25, Nat D4b): the instance audit log
 * reader, in its own file because `app.createApp.ts` is already at the
 * 500-line cap (AGENTS.md style ratchet: one exported function per file).
 *
 * Model-free, no `bank`/workspace param at all -- this is not a knowledge
 * registry method (`knowledge/transport.ts`), it has no workspace, and
 * accepting `bank` here would suggest a scope this route does not have.
 */

import { Elysia } from "elysia";
import type { OperationService } from "./auth/service.createOperationService";
import { AuthDenied } from "./auth/service.createOperationService";
import { errorResponse, readAuthorization } from "./auth/http";
import type { InstanceAuditQuery } from "./audit/instanceAudit.readInstanceAuditRows";

const STATUS_FOR: Readonly<Record<string, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  policy_unavailable: 503,
  invalid_request: 503,
  invalid_scope: 400,
});

const noStore = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Same bound as `/api/backfill`'s `batch`: digits only, 1..1000 inclusive. */
const positiveInt = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
};

const ROUTE_VALUES = new Set(["/api/backfill", "/api/reindex"]);
const OUTCOME_VALUES = new Set(["admitted", "refused"]);

export function instanceAuditRoute(
  service: OperationService,
  transportGuard: (request: Request) => Response | null,
) {
  return (app: Elysia) =>
    app.get(
      "/api/instance-audit",
      async ({ request }) => {
        const blocked = transportGuard(request);
        if (blocked) return blocked;
        const url = new URL(request.url);
        const routeFilter = url.searchParams.get("route");
        const outcomeFilter = url.searchParams.get("outcome");
        if (routeFilter !== null && !ROUTE_VALUES.has(routeFilter)) return errorResponse(400);
        if (outcomeFilter !== null && !OUTCOME_VALUES.has(outcomeFilter)) return errorResponse(400);
        const query: InstanceAuditQuery = {
          limit: positiveInt(url.searchParams.get("limit")),
          cursor: url.searchParams.get("cursor"),
          route: routeFilter as InstanceAuditQuery["route"],
          outcome: outcomeFilter as InstanceAuditQuery["outcome"],
        };
        try {
          const page = await service.readInstanceAudit(readAuthorization(request), query);
          return noStore(page);
        } catch (error) {
          const code = error instanceof AuthDenied ? error.code : "policy_unavailable";
          return errorResponse(STATUS_FOR[code] ?? 503);
        }
      },
      { parse: "none" },
    );
}
