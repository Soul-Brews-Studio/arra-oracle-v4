import { targetOp } from "../contracts/evidence-v1";
import { PublicationError, failPublication } from "./errors";
import { timestampToMicros } from "./rows";
import { quote } from "./storage";
import { type CreateTraceHitInput, TRACE_FIELDS, TRACE_HIT_FIELDS, encodeTraceHitRow, encodeTraceRow, millisToTimestamp, parseCreateTrace, timestampToMillis } from "./trace";
import { assertTraceChain } from "./service.assertTraceChain";
import { PEERS, SESSIONS, TRACES, TRACE_HITS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";
import { writeContextRow } from "./service.writeContextRow";

export function createTrace(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null }, requestBytes: Uint8Array) {
// STATIC validation precedes owner work, as with every other mutation.
      const request = parseCreateTrace(requestBytes);
      // Target normalization is PURE and needs only this request's own
      // workspace_name, kind and target -- all fully known now, so it runs
      // OUTSIDE mutateContextWrite(core, ), before owner work starts, per the convention
      // `advanceReadCursor` states: "STATIC validation precedes owner work.
      // Parsing inside the queued turn would make a malformed request an
      // owner event." `target_json` is the exact canonical text that would
      // be stored; a hit's `target_key` is never persisted (no such column).
      //
      // Tokens are `["hits", index]`, NOT `["hits", index, "target"]`:
      // `targetOp` appends its own `workspace_name` / `target_kind` / `target`
      // suffixes internally, so the base must be the HIT's own pointer for
      // the one sub-error that is actually reachable here (a malformed
      // `target`) to land at `/hits/<i>/target` rather than
      // `/hits/<i>/target/target`. The other two sub-errors `targetOp` can
      // raise (`workspace_name`, `target_kind`) are structurally unreachable
      // at this call site -- `parseCreateTrace` already validated both --
      // so their mis-anchored pointers are latent, not live.
      const normalizedHits = request.hits.map((hit, index) => ({
        input: hit,
        target_json: targetOp(request.workspace_name, hit.kind, hit.target, ["hits", index]).target_json,
      }));
      return mutateContextWrite(core, async () => {
        await requireContextWorkspaceRow(writer, request.workspace_name);

        if (request.session_name !== null) {
          await writer.refresh(SESSIONS);
          const session = await contextOne(
            writer,
            SESSIONS,
            `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
          );
          if (session === null) failPublication("invalid_reference", "/session_name");
        }
        if (request.peer_name !== null) {
          await writer.refresh(PEERS);
          const peer = await contextOne(
            writer,
            PEERS,
            `${contextScope(request.workspace_name)} AND name = ${quote(request.peer_name)}`,
          );
          if (peer === null) failPublication("invalid_reference", "/peer_name");
        }

        await writer.refresh(TRACES);
        const existing = await contextOne(
          writer,
          TRACES,
          `${contextScope(request.workspace_name)} AND id = ${quote(request.id)}`,
        );

        // A hit-shape mismatch, PER FIELD. Shared by the full-match check
        // (already_satisfied) and the prefix check (TR-2, below): both need
        // exactly the same notion of "this stored hit IS the requested one".
        const hitMatches = (
          stored: Record<string, unknown>,
          wanted: { input: CreateTraceHitInput; target_json: string },
        ): boolean =>
          stored.kind === wanted.input.kind &&
          stored.ref === wanted.input.ref &&
          stored.target === wanted.target_json &&
          stored.line_start === wanted.input.line_start &&
          stored.line_end === wanted.input.line_end &&
          stored.excerpt === wanted.input.excerpt &&
          stored.content_hash === wanted.input.content_hash &&
          stored.captured_at === wanted.input.captured_at &&
          stored.note === wanted.input.note;

        if (existing !== null) {
          const encodedExisting = encodeTraceRow(existing);
          await writer.refresh(TRACE_HITS);
          // Enough rows to tell "exactly N" (possible full match), "fewer
          // than N" (TR-2: a prior write may be an ambiguous PARTIAL) and
          // "more than N" (a real payload mismatch) apart -- never a
          // whole-table audit.
          const existingHitRows = await writer.query(
            TRACE_HITS,
            `${contextScope(request.workspace_name)} AND trace_id = ${quote(request.id)}`,
            normalizedHits.length + 1,
          );

          const sameTrace =
            encodedExisting.name === request.name &&
            encodedExisting.session_name === request.session_name &&
            encodedExisting.peer_name === request.peer_name &&
            encodedExisting.query === request.query &&
            encodedExisting.mode === request.mode &&
            encodedExisting.session_id === request.session_id &&
            encodedExisting.session_from_ts ===
              (request.session_from_ts === null ? null : millisToTimestamp(timestampToMillis(request.session_from_ts))) &&
            encodedExisting.session_to_ts ===
              (request.session_to_ts === null ? null : millisToTimestamp(timestampToMillis(request.session_to_ts))) &&
            encodedExisting.friction_score === request.friction_score &&
            encodedExisting.confidence === request.confidence &&
            encodedExisting.parent_id === request.parent_id &&
            encodedExisting.prev_id === request.prev_id &&
            encodedExisting.depth === request.depth &&
            encodedExisting.status === request.status &&
            encodedExisting.h_metadata === request.h_metadata &&
            encodedExisting.internal_metadata === request.internal_metadata;

          const existingHitsEncoded = existingHitRows
            .map((row) => encodeTraceHitRow(row))
            .sort((a, b) => Number(BigInt(a.position as string) - BigInt(b.position as string)));

          // TR-3: `position` is contractually contiguous 0..n-1 per trace
          // (trace.ts). A gap or a duplicate here is STORED corruption, not
          // a caller mismatch -- decided BEFORE any payload comparison, same
          // precedence rule this kernel already uses everywhere else for
          // stored-state faults.
          for (let i = 0; i < existingHitsEncoded.length; i++) {
            if (existingHitsEncoded[i]!.position !== String(i)) failPublication("integrity_failure", "");
          }

          let sameHits = existingHitsEncoded.length === normalizedHits.length;
          if (sameHits) {
            for (let i = 0; i < normalizedHits.length; i++) {
              if (!hitMatches(existingHitsEncoded[i]!, normalizedHits[i]!)) {
                sameHits = false;
                break;
              }
            }
          }

          if (sameTrace && sameHits) {
            return {
              outcome: "already_satisfied" as const,
              row: encodedExisting,
              hits: existingHitsEncoded,
            };
          }

          // TR-2: a retry against a FRESH, unpoisoned owner (e.g. after a
          // process restart) can land here even though the PRIOR attempt was
          // an ambiguous partial write: the trace row and some PREFIX of its
          // hits landed, then the process died before the rest were
          // appended. That is incomplete stored state, not a conflicting
          // payload, and the byte-identical caller must not be blamed for
          // it. Recognized ONLY as an EXACT element-wise prefix -- never a
          // superset, never a reordering -- of the requested hits.
          if (sameTrace && existingHitsEncoded.length < normalizedHits.length) {
            let isPrefix = true;
            for (let i = 0; i < existingHitsEncoded.length; i++) {
              if (!hitMatches(existingHitsEncoded[i]!, normalizedHits[i]!)) {
                isPrefix = false;
                break;
              }
            }
            if (isPrefix) failPublication("recovery_required", "");
          }

          return { outcome: "conflict" as const, reason: "payload" as const };
        }

        // A caller-supplied parent_id / prev_id must resolve in THIS
        // workspace -- invalid_reference at its own pointer. Anything wrong
        // DEEPER in that chain is stored corruption or a bound, never the
        // caller's fault, which is why the walk below reports differently.
        if (request.parent_id !== null) {
          await writer.refresh(TRACES);
          const parent = await contextOne(
            writer,
            TRACES,
            `${contextScope(request.workspace_name)} AND id = ${quote(request.parent_id)}`,
          );
          if (parent === null) failPublication("invalid_reference", "/parent_id");
          await assertTraceChain(writer, request.workspace_name, parent, "parent_id");
        }
        if (request.prev_id !== null) {
          await writer.refresh(TRACES);
          const prev = await contextOne(
            writer,
            TRACES,
            `${contextScope(request.workspace_name)} AND id = ${quote(request.prev_id)}`,
          );
          if (prev === null) failPublication("invalid_reference", "/prev_id");
          await assertTraceChain(writer, request.workspace_name, prev, "prev_id");
        }

        // TR-1(b): build EVERY physical hit row -- INCLUDING running it
        // through `encodeTraceHitRow`'s own shape check -- in a PRE-WRITE
        // pass, before the trace row's `writeContextRow.bind(null, writer, core)` call below starts the
        // ambiguous post-write window. A hit-shaping fault must refuse the
        // WHOLE request atomically, before anything is durable: once the
        // trace row lands there is no way to attach hits to it after the
        // fact (v1 is immutable, no append-hits method), so any hit fault
        // discovered only INSIDE that window would strand an orphan trace
        // row and poison the owner for an ordinary caller mistake.
        const preparedHits = normalizedHits.map(({ input, target_json }, i) => {
          const physicalHit: Record<string, unknown> = {
            workspace_name: request.workspace_name,
            trace_id: request.id,
            kind: input.kind,
            ref: input.ref,
            target: target_json,
            line_start: input.line_start === null ? null : BigInt(input.line_start),
            line_end: input.line_end === null ? null : BigInt(input.line_end),
            excerpt: input.excerpt,
            content_hash: input.content_hash,
            captured_at: input.captured_at === null ? null : timestampToMicros(input.captured_at),
            note: input.note,
            position: BigInt(i),
          };
          return { physicalHit, expectedHit: encodeTraceHitRow(physicalHit) };
        });

        // ONLY a real creation samples the clock.
        const sampled = options.clock();
        if (typeof sampled !== "number" || !Number.isSafeInteger(sampled)) {
          failPublication("invalid_request", "");
        }
        // RAW MILLISECONDS. NOT `* 1000n`: `traces.created_at` is already
        // milliseconds, unlike the micros columns elsewhere in this kernel.
        const millis = BigInt(sampled);
        try {
          millisToTimestamp(millis);
        } catch (error) {
          if (!(error instanceof PublicationError)) throw error;
          return failPublication("invalid_request", "");
        }

        const physicalTrace: Record<string, unknown> = {
          id: request.id,
          name: request.name,
          workspace_name: request.workspace_name,
          session_name: request.session_name,
          peer_name: request.peer_name,
          query: request.query,
          mode: request.mode,
          session_id: request.session_id,
          session_from_ts: request.session_from_ts === null ? null : timestampToMillis(request.session_from_ts),
          session_to_ts: request.session_to_ts === null ? null : timestampToMillis(request.session_to_ts),
          friction_score: request.friction_score,
          confidence: request.confidence,
          parent_id: request.parent_id,
          prev_id: request.prev_id,
          depth: BigInt(request.depth),
          status: request.status,
          h_metadata: request.h_metadata,
          internal_metadata: request.internal_metadata,
          // updated_at === created_at on every fresh write, by construction.
          created_at: millis,
          updated_at: millis,
        };
        const expectedTrace = encodeTraceRow(physicalTrace);
        const storedTrace = await writeContextRow(writer, core, 
          TRACES,
          physicalTrace,
          async () => {
            const found = await contextOne(
              writer,
              TRACES,
              `${contextScope(request.workspace_name)} AND id = ${quote(request.id)}`,
            );
            if (found === null) {
              core.poison();
              failPublication("recovery_required", "");
            }
            return encodeTraceRow(found);
          },
          expectedTrace,
          TRACE_FIELDS,
          false,
        );

        const storedHits: Record<string, unknown>[] = [];
        for (let i = 0; i < preparedHits.length; i++) {
          const { physicalHit, expectedHit } = preparedHits[i]!;
          // `wroteAlready: true` from the FIRST hit onward (and for the very
          // first one, because the trace row itself already landed): once
          // anything is durably written this operation is in the ambiguous
          // window, and a hook failure here must poison rather than merely
          // refuse the request.
          const storedHit = await writeContextRow(writer, core, 
            TRACE_HITS,
            physicalHit,
            async () => {
              const found = await contextOne(
                writer,
                TRACE_HITS,
                `${contextScope(request.workspace_name)} AND trace_id = ${quote(request.id)} AND position = ${i}`,
              );
              if (found === null) {
                core.poison();
                failPublication("recovery_required", "");
              }
              return encodeTraceHitRow(found);
            },
            expectedHit,
            TRACE_HIT_FIELDS,
            true,
          );
          storedHits.push(storedHit);
        }

        return { outcome: "created" as const, row: storedTrace, hits: storedHits };
      });
}
