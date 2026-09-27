// #25 raw transport evidence (`authorization-integration-v1.md` §2, §5, §8).
//
// These use an ephemeral loopback listener and hand-written HTTP/1.1 bytes, so
// they exercise things a Fetch Request cannot express: repeated header lines,
// chunked bodies with no Content-Length, and traffic past the global backstop.
//
// Scope limit stated up front: Bun exposes Fetch headers AFTER comma-joining
// duplicates. These tests therefore prove a post-flattening fail-closed grammar
// gate, NOT raw header-line multiplicity detection.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect as tcpConnect } from "node:net";
import { bearer, createScratch, createScratchDependencies, type Scratch, TOKENS } from "./helpers/auth-fixture";

/** Above the 256 KiB route cap, per contract: an explicit resource ceiling. */
const GLOBAL_BACKSTOP = 1024 * 1024;
const ROUTE_CAP = 256 * 1024;

let scratch: Scratch;
let server: ReturnType<typeof Bun.serve>;
let port: number;
let saved: Record<string, string | undefined> = {};
let originalFetch: typeof globalThis.fetch;

/**
 * Send literal bytes on a socket and return the raw response text.
 *
 * Resolves as soon as a COMPLETE response has arrived rather than waiting for
 * the peer to close: the server may legitimately keep the connection open, and
 * waiting for `end` turned successful responses into spurious timeouts.
 */
function rawRequest(payload: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: "127.0.0.1", port }, () => socket.write(payload));
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(Buffer.concat(chunks).toString("utf-8"));
    };
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf-8");
      const headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const declared = /content-length:\s*(\d+)/i.exec(text.slice(0, headerEnd));
      if (declared === null) return; // no length: wait for close or timeout
      const bodyBytes = Buffer.byteLength(text.slice(headerEnd + 4), "utf-8");
      if (bodyBytes >= Number(declared[1])) finish();
    });
    socket.on("end", finish);
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.setTimeout(10_000, () => {
      // A timeout with data already buffered is a complete-enough response.
      if (chunks.length > 0) finish();
      else {
        socket.destroy();
        reject(new Error("socket timeout"));
      }
    });
  });
}

const statusOf = (raw: string): number => Number(/^HTTP\/1\.\d (\d{3})/.exec(raw)?.[1] ?? 0);

beforeAll(async () => {
  scratch = await createScratch();
  for (const key of ["ARRA_DATA_DIR", "ARRA_AUTH_POLICY", "ARRA_ORIGIN", "OLLAMA_URL"]) {
    saved[key] = process.env[key];
  }
  process.env.ARRA_DATA_DIR = scratch.dataDir;
  process.env.ARRA_AUTH_POLICY = scratch.policyPath;
  process.env.OLLAMA_URL = "http://mock-embedder.invalid";
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch;

  // Bind to an ephemeral port first so the configured origin matches exactly.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  port = Number(probe.port);
  probe.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  process.env.ARRA_ORIGIN = origin;
  const { createOperationService } = await import("../src/auth/service.createOperationService");
  const { createApp } = await import("../src/app.createApp");
  const { createMcpAdapter } = await import("../src/mcp");
  const service = createOperationService(
    { policyPath: scratch.policyPath },
    createScratchDependencies(scratch.connection) as never,
  );
  const app = createApp({ origin }, service, createMcpAdapter(service));
  server = Bun.serve({
    port,
    // The explicit global backstop, deliberately ABOVE the route cap.
    maxRequestBodySize: GLOBAL_BACKSTOP,
    fetch: (request) => app.handle(request),
  });
});

afterAll(async () => {
  server?.stop(true);
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await scratch.cleanup();
});

const authLine = `Authorization: ${bearer(TOKENS.alpha.secret)}`;

describe("repeated and malformed Authorization header lines", () => {
  test("two identical Authorization lines are refused", async () => {
    const raw = await rawRequest(
      `GET /api/memories?bank=alpha HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\n${authLine}\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(raw)).toBe(401);
  });

  test("two DIFFERENT Authorization lines are refused", async () => {
    const raw = await rawRequest(
      `GET /api/memories?bank=alpha HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\nAuthorization: ${bearer(TOKENS.beta.secret)}\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(raw)).toBe(401);
  });

  test("a valid credential followed by an empty Authorization line is refused", async () => {
    const raw = await rawRequest(
      `GET /api/memories?bank=alpha HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\nAuthorization: \r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(raw)).toBe(401);
  });

  test("a single comma-bearing value is refused exactly like a duplicate", async () => {
    const raw = await rawRequest(
      `GET /api/memories?bank=alpha HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: ${bearer(TOKENS.alpha.secret)},${bearer(TOKENS.beta.secret)}\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(raw)).toBe(401);
  });

  test("one well-formed Authorization line still succeeds", async () => {
    const raw = await rawRequest(
      `GET /api/memories?bank=alpha HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(raw)).toBe(200);
  });
});

describe("Host and Origin on the wire", () => {
  test("a DNS-rebinding-style Host mismatch is 400", async () => {
    const raw = await rawRequest(
      `GET /api/memories?bank=alpha HTTP/1.1\r\nHost: attacker.example\r\n${authLine}\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(raw)).toBe(400);
  });

  test("repeated Host lines are refused", async () => {
    const raw = await rawRequest(
      `GET /api/memories?bank=alpha HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: attacker.example\r\n${authLine}\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(raw)).toBe(400);
  });

  test("a mismatched Origin is 403 even with a valid credential", async () => {
    const raw = await rawRequest(
      `GET /api/memories?bank=alpha HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://evil.example\r\n${authLine}\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(raw)).toBe(403);
  });

  test("a literal null Origin is refused", async () => {
    const raw = await rawRequest(
      `GET /api/memories?bank=alpha HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: null\r\n${authLine}\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(raw)).toBe(403);
  });

  test("public liveness is still subject to Host checks", async () => {
    const bad = await rawRequest(`GET /health HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n`);
    expect(statusOf(bad)).toBe(400);
    const good = await rawRequest(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(statusOf(good)).toBe(200);
  });
});

describe("raw body bounds on the real route", () => {
  const bodyOfSize = (total: number) => {
    const envelope = { workspace_name: "alpha", name: "big", content: "" };
    const shell = JSON.stringify(envelope);
    return JSON.stringify({ ...envelope, content: "a".repeat(total - shell.length) });
  };

  test("a body of exactly 262144 bytes is accepted by the route cap", async () => {
    const body = bodyOfSize(ROUTE_CAP);
    expect(Buffer.byteLength(body)).toBe(ROUTE_CAP);
    const raw = await rawRequest(
      `POST /api/memories HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    // 201 means it passed the cap, the gate and the insert.
    expect(statusOf(raw)).toBe(201);
  });

  test("a body of 262145 bytes is rejected by the APPLICATION with 413", async () => {
    const body = bodyOfSize(ROUTE_CAP + 1);
    expect(Buffer.byteLength(body)).toBe(ROUTE_CAP + 1);
    const raw = await rawRequest(
      `POST /api/memories HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    // Distinguishing evidence: this is the app's own small JSON envelope, well
    // below the 1 MiB global backstop, so the route cap is what rejected it.
    expect(statusOf(raw)).toBe(413);
    expect(raw).toContain("payload too large");
  });

  test("traffic past the GLOBAL backstop is a framework rejection, not the app's envelope", async () => {
    const body = bodyOfSize(GLOBAL_BACKSTOP + 4096);
    const raw = await rawRequest(
      `POST /api/memories HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    // Recorded honestly: this is a resource ceiling, NOT an admission path, and
    // it does not carry the application's fixed JSON body.
    expect(statusOf(raw)).toBe(413);
    expect(raw).not.toContain("payload too large");
  });

  test("a chunked oversized body with no Content-Length is still rejected", async () => {
    const chunk = "a".repeat(64 * 1024);
    let payload = `POST /api/memories HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`;
    // Five 64 KiB chunks exceed the 256 KiB cap without ever declaring a length.
    for (let i = 0; i < 5; i++) payload += `${chunk.length.toString(16)}\r\n${chunk}\r\n`;
    payload += "0\r\n\r\n";
    const raw = await rawRequest(payload);
    expect(statusOf(raw)).toBe(413);
  });

  test("gzip content-encoding is refused before any raw read", async () => {
    const raw = await rawRequest(
      `POST /api/memories HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(statusOf(raw)).toBe(415);
  });

  test("a non-JSON content type is refused", async () => {
    const raw = await rawRequest(
      `POST /api/memories HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(statusOf(raw)).toBe(415);
  });
});

describe("body content rules", () => {
  const post = (body: string, extra = "") =>
    rawRequest(
      `POST /api/memories HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authLine}\r\nContent-Type: application/json\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );

  test("duplicate decoded JSON keys are refused", async () => {
    expect(statusOf(await post('{"workspace_name":"alpha","workspace_name":"alpha","name":"n","content":"c"}'))).toBe(400);
  });

  test("malformed JSON is refused", async () => {
    expect(statusOf(await post('{"workspace_name":"alpha",'))).toBe(400);
  });

  test("a lone surrogate escape is refused", async () => {
    expect(statusOf(await post('{"workspace_name":"\\ud800","name":"n","content":"c"}'))).toBe(400);
  });

  test("a body naming another bank is authorized against THAT bank, and denied", async () => {
    // operator-a holds no grant on beta, so this is 403 rather than a silent
    // write into a workspace the caller merely named.
    expect(statusOf(await post('{"workspace_name":"beta","name":"n","content":"c"}'))).toBe(403);
  });
});
