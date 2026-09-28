// Split from transport.ts (style-split4b, 2026-09-28).
import {
  checkBodyEncoding,
  errorResponse,
  isValidWorkspace,
  readAuthorization,
} from "../auth/http";
import { KNOWLEDGE_METHODS, type RequestAuthority } from "./registry";
import { KnowledgeAuthDenied, admitKnowledgeAction, type KnowledgeAuthFailure } from "./transport.admitKnowledgeAction";
import { requireBoundPeers } from "./transport.requireBoundPeers";
import { auditKnowledgeCall, type KnowledgeAuditCall, type KnowledgeAuditSink } from "./transport.auditKnowledgeCall";
import { payloadRefusal } from "./transport.payloadRefusal";
import { isRejection } from "./transport.isRejection";
import { readKnowledgeBody } from "./transport.readKnowledgeBody";
import { peekWorkspaceName } from "./transport.peekWorkspaceName";
import { knowledgeErrorResponse } from "./transport.knowledgeErrorResponse";
import type { KnowledgeAccess } from "./transport.state";

const AUTH_STATUS_FOR: Readonly<Record<KnowledgeAuthFailure, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  policy_unavailable: 503,
});

/**
 * Handle one `POST /api/knowledge/:bank/:method` request end to end.
 *
 * Order, fixed: validate the route scope grammar and the method name (pure
 * routing, no policy I/O), check body encoding, read the bounded raw bytes,
 * peek the body's own scope claim with the governed parser, THEN admit (which
 * also yields the request's #87 `RequestAuthority`), THEN refuse a body scope
 * that differs from the route bank, THEN refuse any caller-asserted peer
 * outside the grant's binding, THEN dispatch the ORIGINAL bytes and that
 * authority to the registered method. Every outcome AFTER admission, ok or
 * error, is appended to `ctx.audit` exactly like an MCP `kb_*` call (#31 / R8;
 * see `transport.auditKnowledgeCall.ts`); a request refused before admission
 * is not audited on either transport. A body-scope mismatch is still the
 * generic 400 whatever admission decides (so no status changed), but an
 * ADMITTED caller's mismatch is audited, as MCP audits it after admission
 * (round 3, 2026-09-27). A malformed or oversized body never reaches admission
 * with a false success, but a body-format fault surfaces its own governed
 * envelope rather than a generic 400 wherever this module can tell the two
 * apart.
 */
export async function handleKnowledgeRequest(
  request: Request,
  params: { bank: string; method: string },
  ctx: { policyPath: string; access: KnowledgeAccess; audit?: KnowledgeAuditSink },
): Promise<Response> {
  if (!isValidWorkspace(params.bank)) return errorResponse(400);
  const entry = KNOWLEDGE_METHODS[params.method];
  if (entry === undefined) return errorResponse(404);

  const encoding = checkBodyEncoding(request);
  if (encoding !== null) return errorResponse(encoding.status);

  const raw = await readKnowledgeBody(request);
  if (isRejection(raw)) return errorResponse(raw.status);

  let scoped: string | null;
  try {
    scoped = peekWorkspaceName(raw.bytes, entry.scopePath);
  } catch (error) {
    const response = knowledgeErrorResponse(error);
    if (response !== null) return response;
    return errorResponse(400);
  }
  const scopeMismatch = scoped === null || scoped !== params.bank;

  let authority: RequestAuthority;
  let call: KnowledgeAuditCall | null = null;
  const startedMs = Date.now();
  try {
    authority = admitKnowledgeAction(ctx.policyPath, readAuthorization(request), params.bank, entry.action, (auth) => {
      call = { method: params.method, workspace: params.bank, bytes: raw.bytes, auth, userAgent: request.headers.get("user-agent"), startedMs };
    });
  } catch (error) {
    if (scopeMismatch) return errorResponse(400);
    if (error instanceof KnowledgeAuthDenied) return errorResponse(AUTH_STATUS_FOR[error.code]);
    return errorResponse(503);
  }
  const audited = call as KnowledgeAuditCall | null;
  const audit = (outcome: Parameters<typeof auditKnowledgeCall>[2]) =>
    audited === null ? Promise.resolve() : auditKnowledgeCall(ctx.audit, audited, outcome);
  if (scopeMismatch) {
    // The same text MCP audits: a body that is no object is its own refusal.
    let body: unknown = null;
    try {
      body = JSON.parse(new TextDecoder().decode(raw.bytes));
    } catch {}
    await audit({ status: "error", error: payloadRefusal(body) });
    return errorResponse(400);
  }
  try {
    requireBoundPeers(params.method, raw.bytes, authority);
  } catch (error) {
    await audit({ status: "error", error });
    return knowledgeErrorResponse(error) ?? errorResponse(400);
  }

  try {
    // Operations-root methods (R5) never touch the knowledge bundle at all --
    // checked BEFORE `getBundle`, which would otherwise throw
    // `unsupported_dataset` whenever `ARRA_KNOWLEDGE_DATASET_ROOT` is unset,
    // even though `entry.call` would never have used the bundle it opened.
    if (entry.operations !== undefined) {
      const result = await entry.operations(raw.bytes);
      await audit({ status: "ok", value: result });
      return new Response(JSON.stringify(result ?? null), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    const bundle = await ctx.access.getBundle(entry.action);
    const result = await entry.call(bundle, raw.bytes, authority);
    await audit({ status: "ok", value: result });
    return new Response(JSON.stringify(result ?? null), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (error) {
    await audit({ status: "error", error });
    const response = knowledgeErrorResponse(error);
    if (response !== null) return response;
    return new Response(JSON.stringify({ error: "internal" }), {
      status: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}
