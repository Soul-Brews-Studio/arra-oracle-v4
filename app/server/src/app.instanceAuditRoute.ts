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
import {
  InvalidCursorError,
  INSTANCE_AUDIT_MAX_LIMIT,
  type InstanceAuditQuery,
} from "./audit/instanceAudit.readInstanceAuditRows";

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

const INVALID = Symbol("invalid-limit");

/**
 * Digits only, clamped to `1..INSTANCE_AUDIT_MAX_LIMIT` (the reader clamps
 * again, so this is belt-and-suspenders, not the only guard). Distinguishes
 * "absent" (`null` -> `undefined`, fall back to the reader's default) from
 * "present but not a valid limit" (`INVALID` -> the route 400s) -- an absent
 * `?limit=` and a present-but-garbage `?limit=abc` are different requests
 * and previously got inconsistent status codes (round-2 verifier nonblocking
 * finding); `?limit=0` is "present but not >=1", so it 400s too now.
 */
const positiveInt = (value: string | null): number | undefined | typeof INVALID => {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return INVALID;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, INSTANCE_AUDIT_MAX_LIMIT) : INVALID;
};

/** Filterable to any instance-audit-writing route, including this reader's own self-audit rows. */
const ROUTE_VALUES = new Set(["/api/backfill", "/api/reindex", "/api/instance-audit"]);
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
        const limit = positiveInt(url.searchParams.get("limit"));
        if (limit === INVALID) return errorResponse(400);
        // `URLSearchParams.get` returns `null` for an absent param, but
        // `InstanceAuditQuery` (and the reader's `!== undefined` filter
        // guard) treats "absent" as `undefined`, not `null` -- a bare pass-
        // through here made every absent filter render as the SQL literal
        // `'null'`, which never matches a row (round-2 verifier finding).
        const cursorParam = url.searchParams.get("cursor");
        const query: InstanceAuditQuery = {
          limit,
          cursor: cursorParam === null ? undefined : cursorParam,
          route: routeFilter === null ? undefined : (routeFilter as InstanceAuditQuery["route"]),
          outcome: outcomeFilter === null ? undefined : (outcomeFilter as InstanceAuditQuery["outcome"]),
        };
        try {
          const page = await service.readInstanceAudit(readAuthorization(request), query);
          return noStore(page);
        } catch (error) {
          if (error instanceof InvalidCursorError) return errorResponse(400);
          const code = error instanceof AuthDenied ? error.code : "policy_unavailable";
          return errorResponse(STATUS_FOR[code] ?? 503);
        }
      },
      { parse: "none" },
    );
}
