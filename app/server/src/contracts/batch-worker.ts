/**
 * Bun worker entrypoint for `arra-contract-batch/v1`.
 *
 * Reads exactly one request from stdin (streaming, capped at 16 MiB including
 * an optional final LF), writes exactly one JSON document to stdout followed
 * by a single LF, logs only to stderr. Contract errors exit 0 — they are a
 * valid protocol exchange. Only infrastructure failure exits nonzero.
 *
 * Not imported by any route, MCP server or CLI. Invoked by the Python adapter
 * as an argument-array subprocess with an explicit script path.
 *
 *   bun run app/server/src/contracts/batch-worker.ts < request.json
 */

import { ContractError, ERROR_VERSION } from "./errors";
import { LIMITS, parseStrictBytes, utf8ByteLength } from "./jcs";
import { BATCH_VERSION, type BatchResponse, type RawPayloadSpans, dispatchBatch, encodeResponse } from "./batch-v1";

async function readStdinCapped(maxBytes: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      return null; // over cap: caller reports limit_exceeded without decoding
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

function framingFailure(code: "limit_exceeded" | "invalid_json" | "invalid_unicode", message: string): BatchResponse {
  return { version: BATCH_VERSION, ok: false, results: [], error: { item_id: null, detail: { version: ERROR_VERSION, code, path: "", message } } };
}

async function main(): Promise<number> {
  let response: BatchResponse;
  const bytes = await readStdinCapped(LIMITS.maxTransportBytes);
  if (bytes === null) {
    response = framingFailure("limit_exceeded", `request exceeds ${LIMITS.maxTransportBytes} bytes`);
  } else {
    // Strip exactly one optional trailing LF before strict parsing.
    const body = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0a ? bytes.subarray(0, bytes.byteLength - 1) : bytes;
    try {
      // One parse, two outputs: the value tree, and the RAW UTF-8 span of each
      // item payload so the per-payload bound measures wire bytes, not the
      // compacted form. No second JSON parser.
      const rawPayloadBytes: RawPayloadSpans = new Map();
      const request = parseStrictBytes(body, [], {
        maxBytes: LIMITS.maxTransportBytes,
        onSpan: (path, rawBytes) => {
          if (path.length === 3 && path[0] === "items" && path[2] === "payload" && typeof path[1] === "number") {
            rawPayloadBytes.set(path[1], rawBytes);
          }
        },
      });
      response = dispatchBatch(request, { rawPayloadBytes });
    } catch (error) {
      if (error instanceof ContractError) {
        response = { version: BATCH_VERSION, ok: false, results: [], error: { item_id: null, detail: error.toJSON() } };
      } else {
        console.error(`worker_failure: ${(error as Error).stack ?? String(error)}`);
        return 2;
      }
    }
  }
  const text = encodeResponse(response);
  if (utf8ByteLength(text) + 1 > LIMITS.maxTransportBytes) {
    // Bound response production: never emit an oversized document, and never truncate one.
    const fallback = encodeResponse(framingFailure("limit_exceeded", `response exceeds ${LIMITS.maxTransportBytes} bytes`));
    await Bun.write(Bun.stdout, fallback + "\n");
    return 0;
  }
  await Bun.write(Bun.stdout, text + "\n");
  return 0;
}

process.exitCode = await main();
