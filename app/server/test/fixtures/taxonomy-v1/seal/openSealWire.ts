// The REAL wire for the #27 / R6 seal child: `createApp` + `createKnowledgeAccess`
// + the MCP adapter, driven only through `Request` objects. Nothing here opens
// a writer itself; the transport's own lazily opened ordinary writer is the
// one under test, exactly as a live server would open it.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../../../src/app.createApp";
import { createOperationService, type StoreDependencies } from "../../../../src/auth/service.createOperationService";
import { createKnowledgeAccess } from "../../../../src/knowledge/transport";
import { configureKnowledgeAccess, createMcpAdapter } from "../../../../src/mcp";

const ORIGIN = "http://127.0.0.1:3939";
const HOST = "127.0.0.1:3939";
const WRITER_TOKEN = "a".repeat(64);
const READER_TOKEN = "b".repeat(64);
const sha256 = (token: string) => createHash("sha256").update(token, "ascii").digest("hex");

/** A `content:read`+`content:write` writer and a `content:read`-only reader,
 *  (`readerToken`), both on `workspace`, and the audit records the app appends. */
export function openSealWire(root: string, workDir: string, workspace: string) {
  const policyPath = join(workDir, "policy.json");
  const credential = (id: string, principal: string, token: string) => ({
    id,
    principal_id: principal,
    sha256: sha256(token),
    not_before: "2020-01-01T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked: false,
  });
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        {
          id: "writer",
          disabled: false,
          workspaces: [{ name: workspace, actions: ["content:read", "content:write"] }],
          global_actions: [],
        },
        { id: "reader", disabled: false, workspaces: [{ name: workspace, actions: ["content:read"] }], global_actions: [] },
      ],
      credentials: [credential("cred-writer", "writer", WRITER_TOKEN), credential("cred-reader", "reader", READER_TOKEN)],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );

  const access = createKnowledgeAccess({ datasetRoot: root, env: process.env });
  configureKnowledgeAccess(access);
  // The legacy memory store is never reached by a kb_ tool; only the audit
  // append runs, and it is recorded here rather than written anywhere.
  const unused = async (): Promise<never> => {
    throw new Error("legacy store is not used by kb_ tools");
  };
  const audits: Record<string, unknown>[] = [];
  const deps: StoreDependencies = {
    insert: unused,
    list: unused,
    searchText: unused,
    searchVector: unused,
    getById: unused,
    stats: unused,
    backfill: unused,
    ensureFtsIndex: unused,
    embedHealth: unused,
    recentCalls: unused,
    aggregateCalls: unused,
    logCall: async (record) => {
      audits.push(record);
    },
  };
  const service = createOperationService({ policyPath }, deps);
  const app = createApp({ origin: ORIGIN }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });

  const headers = (token: string | null): Record<string, string> => ({
    host: HOST,
    "content-type": "application/json",
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  });
  const http = async (method: string, body: unknown, token: string | null = WRITER_TOKEN) => {
    const res = await app.handle(
      new Request(`${ORIGIN}/api/knowledge/${workspace}/${method}`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const mcp = async (tool: string, payload: unknown, token: string | null = WRITER_TOKEN) => {
    const res = await app.handle(
      new Request(`${ORIGIN}/mcp/${workspace}`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { payload } } }),
      }),
    );
    const wire = (await res.json().catch(() => null)) as { result?: { isError?: boolean; content?: { text?: string }[] } } | null;
    const text = wire?.result?.content?.[0]?.text;
    let value: unknown = text ?? null;
    try {
      value = text === undefined ? null : JSON.parse(text);
    } catch {
      // A plain-text tool error stays text.
    }
    return { status: res.status, isError: wire?.result?.isError === true, value };
  };
  return { http, mcp, audits, readerToken: READER_TOKEN };
}
