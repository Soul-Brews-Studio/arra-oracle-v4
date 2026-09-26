/**
 * #71 (Parent #28) read-cursor kernel.
 *
 * Contract: app/docs/contracts/read-cursor-v1.md
 * SHA256 04f553dd20f572d6bc9c83b1c8752e69018ff5556ad2b2b1b1308162ca82f24f
 */

import { describe, expect, test } from "bun:test";
import { createReadCursorFixture } from "./helpers/read-cursor-fixture";
import {
  advanceReadCursorRequest,
  cursorId,
  getReadCursorRequest,
} from "./helpers/read-cursor-fixture";
import {
  appendRequest,
  joinRequest,
  messageItem,
  peerRequest,
  sessionRequest,
} from "./helpers/context-fixture";
import { runGated } from "./helpers/publication-fixture";
import { ContractError } from "../src/contracts/errors";
import { PublicationError } from "../src/publication/errors";
import {
  encodeReadCursorRow,
  parseAdvanceReadCursor,
  parseGetReadCursor,
  validateWorkspaceRow,
  WORKSPACE_FIELDS,
} from "../src/publication/read-cursor";

/**
 * PREFLIGHT, recorded once.
 *
 * Run before any implementation exists so the absence is evidence rather than
 * an assumption. A skipped test is never credited as acceptance here: these
 * assert the FINAL required surface, so they fail while the API is absent and
 * pass only once it is genuinely present.
 */
describe("preflight: the required surface", () => {
  test("the pure module exists and exports its grammar", async () => {
    const mod = await import("../src/publication/read-cursor").catch((error) => ({
      __absent: String(error),
    }));
    expect(mod).not.toHaveProperty("__absent");
    expect(typeof (mod as Record<string, unknown>).parseGetReadCursor).toBe("function");
    expect(typeof (mod as Record<string, unknown>).parseAdvanceReadCursor).toBe("function");
    expect(typeof (mod as Record<string, unknown>).encodeReadCursorRow).toBe("function");
  });

  // The two READER factories only: these need no gate. The two writer
  // factories are exercised in a real gated child, because claiming four from
  // two would be a false surface claim.
  test("both READER factories expose the new read method", async () => {
    const fixture = await createReadCursorFixture(["alpha-workspace"]);
    try {
      const service = await import("../src/publication/service");
      const readers = ["openContextReader", "openEvidenceReader"] as const;
      for (const factory of readers) {
        const bundle = await (service as Record<string, any>)[factory](fixture.datasetRoot);
        expect(Object.keys(bundle.context).sort()).toEqual([
          "getContext", "getMessage", "getPeer", "getReadCursor", "getRecallEligibility", "getSearchFreshness", "getSession", "getTrace",
          "listConnections", "listLifecycleHistory", "listMcpCalls", "listMessages", "listPeers", "listSearchChunks", "listSessionLinks", "listSessionMembers", "listSessions",
          "listTraceHits", "searchKnowledgeKeyword", "searchKnowledgeSemantic",
        ]);
        expect("close" in bundle.context).toBe(false);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);
});

describe("real persistence: cursors inside the real gate", () => {
  const CHILD = new URL("./fixtures/read-cursor-v1/core/gated-cursor.ts", import.meta.url).pathname;
  const ALPHA = "alpha-workspace";
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
  const MSG1 = cursorId("msg1");
  const MSG2 = cursorId("msg2");
  const MSG3 = cursorId("msg3");

  const drive = async (
    root: string,
    ops: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
    return JSON.parse(line);
  };
  const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
  const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

  /** Peer, session, membership and two real messages, through the REAL API. */
  const seedOps = () => [
    ctx("registerPeer", peerRequest(ALPHA)),
    ctx("registerSession", sessionRequest(ALPHA)),
    ctx("joinSession", joinRequest(ALPHA)),
    ctx("appendMessages", appendRequest(ALPHA, "sess-a", [
      messageItem({ public_id: MSG1 }),
      messageItem({ public_id: MSG2, message: { content: "second" } }),
      messageItem({ public_id: MSG3, message: { content: "third" } }),
    ])),
  ];
  const SEED = 4;

  test("BOTH writer factories expose the thirty-two context methods, with no nested close", async () => {
    for (const factory of ["context", "evidence"] as const) {
      const fixture = await createReadCursorFixture([ALPHA]);
      try {
        const parsed = await drive(fixture.datasetRoot, [], { factory });
        // The writer's context facade spreads the full read-method set in
        // (`{ ...reads, ...writeOnly }`), so this is that union, not just the
        // write-only methods. #30 R7/R8 added embedPendingChunks (write-only)
        // and getSearchFreshness (read); overnight R18 added closeSession
        // (write-only) and listSessionMembers (read).
        expect(parsed.contextMethods).toEqual([
          "advanceReadCursor", "appendMessages", "closeSession", "createSessionLink", "createTrace", "embedPendingChunks", "getContext",
          "getMessage", "getPeer", "getReadCursor", "getRecallEligibility", "getSearchFreshness", "getSession", "getTrace",
          "indexRevisionChunks", "joinSession", "listConnections", "listLifecycleHistory", "listMcpCalls", "listMessages", "listPeers", "listSearchChunks",
          "listSessionLinks", "listSessionMembers", "listSessions", "listTraceHits", "reconcileSearchChunks", "registerPeer", "registerSession",
          "retireNode", "supersedeNode", "writeChunkEmbedding",
        ]);
        expect(parsed.contextHasClose).toBe(false);
        // Only the BUNDLE closes the owner; the bundle key set is unchanged.
        expect(parsed.writerKeys).toContain("close");
        expect(parsed.writerKeys).toContain("context");
      } finally {
        await fixture.cleanup();
      }
    }
  }, 300_000);

  test("absent reads as null, then creation persists all five physical fields", async () => {
    const fixture = await createReadCursorFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("getReadCursor", getReadCursorRequest(ALPHA)),
        ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, { last_read_message_id: MSG1 })),
        ctx("getReadCursor", getReadCursorRequest(ALPHA)),
        hx("readRawRows", { table: "read_cursors", predicate: `workspace_name = '${ALPHA}'` }),
      ]);
      // Absent is null, not an error.
      expect(parsed[`op${SEED}`].value).toBeNull();

      const created = parsed[`op${SEED + 1}`];
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.value.outcome).toBe("created");
      expect(Object.keys(created.value.row)).toEqual([
        "workspace_name", "peer_name", "session_name", "last_read_message_id", "last_read_at",
      ]);
      expect(created.value.row.last_read_message_id).toBe(MSG1);
      expect(created.value.row.last_read_at).toBe("2026-09-21T00:00:00.000Z");
      // The read agrees with the write.
      expect(parsed[`op${SEED + 2}`].value).toEqual(created.value.row);
      // And the PHYSICAL timestamp is exact microseconds, not a lossy Number.
      const raw = parsed[`op${SEED + 3}`].value;
      expect(raw).toHaveLength(1);
      expect(raw[0].last_read_at).toBe(String(BigInt(CLOCK) * 1000n));
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a retained NULL pointer advances through the composed IS NULL + TIMESTAMP cast", async () => {
    /**
     * Mandatory by contract section 5. The service never CREATES a
     * null-pointer row, so the retained state is planted; what is measured is
     * the real UPDATE statement that composes an `IS NULL` guard with a
     * `CAST(... AS TIMESTAMP(6))` assignment, and its readback.
     *
     * Separate accepted uses of each primitive were feasibility evidence only.
     * This is the measurement of that exact statement.
     */
    const fixture = await createReadCursorFixture([ALPHA]);
    try {
      const planted = String(BigInt(Date.parse("2026-09-20T00:00:00.000Z")) * 1000n);
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        hx("insertRawCursor", {
          workspace_name: ALPHA, peer_name: "peer-a", session_name: "sess-a",
          last_read_message_id: null, last_read_at_micros: planted,
        }),
        // A retained null-pointer row is READABLE.
        ctx("getReadCursor", getReadCursorRequest(ALPHA)),
        // ... and ADVANCEABLE, guarded by the present-row null-pointer form.
        ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, {
          last_read_message_id: MSG1,
          expected: { last_read_message_id: null },
        })),
        hx("readRawRows", { table: "read_cursors", predicate: `workspace_name = '${ALPHA}'` }),
      ]);

      const read = parsed[`op${SEED + 1}`];
      expect(read.ok, JSON.stringify(read)).toBe(true);
      expect(read.value.last_read_message_id).toBeNull();
      expect(read.value.last_read_at).toBe("2026-09-20T00:00:00.000Z");

      const advanced = parsed[`op${SEED + 2}`];
      expect(advanced.ok, JSON.stringify(advanced)).toBe(true);
      expect(advanced.value.outcome).toBe("advanced");
      expect(advanced.value.row.last_read_message_id).toBe(MSG1);
      expect(advanced.value.row.last_read_at).toBe("2026-09-21T00:00:00.000Z");

      // Exactly ONE row: the update replaced the retained row rather than
      // appending a second one at the same logical key.
      const raw = parsed[`op${SEED + 3}`].value;
      expect(raw).toHaveLength(1);
      expect(raw[0].last_read_message_id).toBe(MSG1);
      expect(raw[0].last_read_at).toBe(String(BigInt(CLOCK) * 1000n));
      // The context boundary hook is SHARED with the seed writes, so the
      // triple under test is the LAST one. Six writes fire in total: peer,
      // session, membership, three messages -- then this cursor update.
      expect(parsed.trace.filter((b: string) => b === "before_write")).toHaveLength(7);
      expect(parsed.trace.slice(-3)).toEqual(["before_write", "after_write", "after_readback"]);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  describe("the post-write readback discriminates its failure classes", () => {
    /**
     * `after_write` fires strictly BETWEEN the SDK call and the readback, so
     * the child mutates the desired message there. Deterministic by
     * construction -- no prototype patch, no timing window, and no claim
     * whatsoever about what a normal concurrent writer would do.
     */
    const readback = async (
      kind: string,
      extra: Record<string, unknown> = {},
    ): Promise<Record<string, any>> => {
      const fixture = await createReadCursorFixture([ALPHA]);
      try {
        return await drive(
          fixture.datasetRoot,
          [
            ...seedOps(),
            ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, { last_read_message_id: MSG1 })),
            // A second mutation on a POISONED owner must be refused.
            ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, {
              last_read_message_id: MSG2, expected: { last_read_message_id: MSG1 },
            })),
          ],
          { mutateAt: { boundary: "after_write", occurrence: 7, kind, public_id: MSG1, ...extra } },
        );
      } finally {
        await fixture.cleanup();
      }
    };

    test("a target that VANISHED after the write is ambiguity, not corruption", async () => {
      const parsed = await readback("delete");
      const failed = parsed[`op${SEED}`];
      expect(failed.ok).toBe(false);
      // recovery_required, NOT invalid_reference: the reference was valid when
      // it was chosen, and NOT integrity_failure: nothing is malformed.
      expect(failed).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "recovery_required",
        path: "",
      });
      // The owner is poisoned: no later mutation is attempted.
      expect(parsed[`op${SEED + 1}`].ok).toBe(false);
      expect(parsed[`op${SEED + 1}`].code).toBe("recovery_required");
      // after_readback never fired for the failed write.
      expect(parsed.trace.filter((b: string) => b === "after_readback")).toHaveLength(6);
    }, 300_000);

    test("a DUPLICATED target is corruption and keeps integrity_failure", async () => {
      const parsed = await readback("duplicate");
      const failed = parsed[`op${SEED}`];
      expect(failed.ok).toBe(false);
      expect(failed).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "integrity_failure",
        path: "",
        message: "stored state failed integrity validation",
      });
      // Corruption poisons too, and the class is preserved through the
      // shared boundary rather than normalized to recovery_required.
      expect(parsed[`op${SEED + 1}`].ok).toBe(false);
    }, 300_000);

    test("a DIFFERENT legacy id under the same public_id and ordinal is caught", async () => {
      /**
       * The discriminator for the field this readback used to miss: public_id
       * and seq_in_session are both unchanged, so a comparison on those two
       * alone would have acknowledged a write against a different message.
       */
      const parsed = await readback("reid", { new_id: "987654" });
      const failed = parsed[`op${SEED}`];
      expect(failed.ok).toBe(false);
      expect(failed).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "recovery_required",
        path: "",
      });
      expect(parsed[`op${SEED + 1}`].ok).toBe(false);
    }, 300_000);
  });

  test("replay and both conflicts NEVER sample the clock", async () => {
    const fixture = await createReadCursorFixture([ALPHA]);
    try {
      // First create with a real clock, in its own child.
      const first = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, { last_read_message_id: MSG2 })),
      ]);
      expect(first[`op${SEED}`].value.outcome).toBe("created");
      const firstRow = first[`op${SEED}`].value.row;

      // A throw-if-called clock: any path that samples it fails loudly.
      const second = await drive(
        fixture.datasetRoot,
        [
          ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, {
            last_read_message_id: MSG2, expected: { last_read_message_id: MSG2 },
          })),
          ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, {
            last_read_message_id: MSG1, expected: { last_read_message_id: MSG2 },
          })),
          // A HIGHER ordinal, so neither rule 1 nor rule 2 fires first and
          // the guard comparison is genuinely what refuses it.
          ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, {
            last_read_message_id: MSG3, expected: null,
          })),
        ],
        { clockMs: "throw" },
      );

      // Already there: the ORIGINAL row and its original timestamp.
      expect(second.op0.ok, JSON.stringify(second.op0)).toBe(true);
      expect(second.op0.value.outcome).toBe("already_satisfied");
      expect(second.op0.value.row).toEqual(firstRow);
      // Backward: a lower ordinal, reported as a returned value.
      expect(second.op1.value).toEqual({
        outcome: "conflict", reason: "backward", row: firstRow,
      });
      // Stale guard: `expected: null` claims ABSENCE while a row is present.
      expect(second.op2.value).toEqual({
        outcome: "conflict", reason: "expected", row: firstRow,
      });
      // No mutation and no hook fired on ANY of the three.
      expect(second.clockCalls).toBe(0);
      expect(second.trace).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
});

describe("the stored row codec refuses what it cannot vouch for", () => {
  const MICROS = BigInt(Date.parse("2026-09-21T00:00:00.000Z")) * 1000n;
  const validRow = () => ({
    workspace_name: "alpha-workspace",
    peer_name: "peer-a",
    session_name: "sess-a",
    last_read_message_id: cursorId("msg1"),
    last_read_at: MICROS,
  });
  const publicationErr = (run: () => unknown): PublicationError => {
    try {
      run();
    } catch (error) {
      if (error instanceof PublicationError) {
        expect(error.name).toBe("PublicationError");
        return error;
      }
      throw new Error(`expected PublicationError, got ${(error as Error)?.name}: ${String(error)}`);
    }
    throw new Error("expected a throw, got none");
  };
  const corrupt = (run: () => unknown) =>
    expect(publicationErr(run).toJSON()).toEqual({
      version: "arra-publication-error/v1",
      code: "integrity_failure",
      path: "",
      message: "stored state failed integrity validation",
    });

  test("an explicit UNDEFINED pointer is corruption, not a null", () => {
    // `undefined` is not the null spelling. A stored column that is present
    // but holds undefined is a malformed row, and reading it as "no pointer"
    // would invent an absence the data never stated.
    const row: Record<string, unknown> = { ...validRow(), last_read_message_id: undefined };
    expect(Object.prototype.hasOwnProperty.call(row, "last_read_message_id")).toBe(true);
    corrupt(() => encodeReadCursorRow(row));
    // The explicit null IS accepted, so this is a distinction and not a ban.
    expect(encodeReadCursorRow({ ...validRow(), last_read_message_id: null }).last_read_message_id)
      .toBeNull();
  });

  test("an INHERITED column is not a stored column", () => {
    // `in` walks the prototype chain, so a row missing a real column can look
    // complete and then be encoded from prototype data.
    const inherited: Record<string, unknown> = Object.create({ last_read_at: MICROS });
    inherited.workspace_name = "alpha-workspace";
    inherited.peer_name = "peer-a";
    inherited.session_name = "sess-a";
    inherited.last_read_message_id = null;
    expect("last_read_at" in inherited).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(inherited, "last_read_at")).toBe(false);
    corrupt(() => encodeReadCursorRow(inherited));
  });

  test("an EXTRA stored column is refused", () => {
    corrupt(() => encodeReadCursorRow({ ...validRow(), stray: 1 }));
  });

  test("a malformed CONTAINER is refused before any field is read", () => {
    corrupt(() => encodeReadCursorRow([] as unknown as Record<string, unknown>));
    corrupt(() => encodeReadCursorRow(null as unknown as Record<string, unknown>));
    corrupt(() => encodeReadCursorRow("row" as unknown as Record<string, unknown>));
  });
});

describe("the selected WORKSPACE row is validated structurally", () => {
  const MICROS = BigInt(Date.parse("2026-09-21T00:00:00.000Z")) * 1000n;
  const valid = () => ({
    id: "workspace-alpha",
    name: "alpha-workspace",
    created_at: MICROS,
    h_metadata: null,
    internal_metadata: null,
    configuration: null,
    mission: null,
  });
  const corrupt = (row: Record<string, unknown>) => {
    let error: unknown;
    try {
      validateWorkspaceRow(row);
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    if (!(error instanceof PublicationError)) throw error;
    expect(error.name).toBe("PublicationError");
    expect(error.toJSON()).toEqual({
      version: "arra-publication-error/v1", code: "integrity_failure", path: "",
      message: "stored state failed integrity validation",
    });
  };

  test("the seven physical columns, and a valid row still passes", () => {
    expect([...WORKSPACE_FIELDS]).toEqual([
      "id", "name", "created_at", "h_metadata", "internal_metadata", "configuration", "mission",
    ]);
    expect(validateWorkspaceRow(valid())).toEqual({
      ...valid(), created_at: "2026-09-21T00:00:00.000Z",
    });
    // Nullable columns carrying real text are equally valid.
    expect(validateWorkspaceRow({ ...valid(), mission: "a mission" }).mission).toBe("a mission");
  });

  test("workspace.id is a required string and NOT a nanoid", () => {
    // Peers and sessions carry that namespace; workspaces do not. Requiring it
    // here from resemblance would be a new identity decision.
    expect(validateWorkspaceRow({ ...valid(), id: "ws" }).id).toBe("ws");
    // Empty and over-long ids are covered by the required-string rule below;
    // an earlier revision of this test asserted the NAME grammar here, which
    // was the invented rule rather than the physical one.
    corrupt({ ...valid(), id: 5 });
    corrupt({ ...valid(), id: null });
  });

  test("workspace.id is a physical REQUIRED STRING, with no name grammar", () => {
    // The physical column is utf8 NOT NULL. Nonempty and a 256-byte bound are
    // NAME semantics belonging to peers and sessions; importing them here from
    // resemblance would refuse workspaces this service never had authority to
    // reject.
    const long = "w".repeat(300);
    expect(validateWorkspaceRow({ ...valid(), id: long }).id).toBe(long);
    expect(validateWorkspaceRow({ ...valid(), id: "" }).id).toBe("");
    // Still a STRING, and still valid Unicode.
    corrupt({ ...valid(), id: 5 });
    corrupt({ ...valid(), id: null });
    corrupt({ ...valid(), id: "\uD800" });
  });

  test("nullable text columns must be valid UNICODE, with no invented bound", () => {
    const long = "m".repeat(300);
    expect(validateWorkspaceRow({ ...valid(), mission: long }).mission).toBe(long);
    for (const field of ["h_metadata", "internal_metadata", "configuration", "mission"] as const) {
      // A LONE surrogate is not valid Unicode and must not be rendered onto
      // the wire as a replacement character.
      corrupt({ ...valid(), [field]: "bad\uDC00text" });
      corrupt({ ...valid(), [field]: "\uD83D" });
    }
  });

  test("an EXTRA column is not the contracted shape", () => {
    // Presence of the seven is not the same as being exactly the seven: an
    // unknown column means the row is not what this validator describes.
    corrupt({ ...valid(), unexpected_column: "x" });
  });

  test("a MISSING column is corruption, own-property only", () => {
    for (const field of WORKSPACE_FIELDS) {
      const row: Record<string, unknown> = { ...valid() };
      delete row[field];
      corrupt(row);
    }
    const inherited: Record<string, unknown> = Object.create({ mission: null });
    for (const field of WORKSPACE_FIELDS) {
      if (field !== "mission") inherited[field] = (valid() as Record<string, unknown>)[field];
    }
    corrupt(inherited);
  });

  test("created_at is raw micros, exact or refused", () => {
    corrupt({ ...valid(), created_at: MICROS + 1n });
    corrupt({ ...valid(), created_at: null });
    corrupt({ ...valid(), created_at: "2026-09-21T00:00:00.000Z" });
    corrupt({ ...valid(), created_at: 253402300800000000n });
  });

  test("nullable text columns take EXPLICIT null only", () => {
    corrupt({ ...valid(), h_metadata: undefined });
    corrupt({ ...valid(), configuration: 5 });
  });
});

describe("request grammar is closed, in the GOVERNED envelope", () => {
  const ID = cursorId("msg1");
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const get = (o: Record<string, unknown> = {}) => ({
    workspace_name: "alpha-workspace", peer_name: "peer-a", session_name: "sess-a", ...o,
  });
  const adv = (o: Record<string, unknown> = {}) => ({
    ...get(), last_read_message_id: ID, expected: null, ...o,
  });
  /** All FOUR wire fields, every time: a code alone cannot catch a wrong path. */
  const governed = (
    run: () => unknown,
    expected: { code: string; path: string; message: string },
  ): void => {
    let error: unknown;
    try {
      run();
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    if (!(error instanceof ContractError)) {
      throw new Error(`expected ContractError, got ${(error as Error)?.name}: ${String(error)}`);
    }
    // The ACTUAL name, not only the class: `instanceof` says nothing about
    // what a caller catching by name would see, and `toJSON` omits it.
    expect(error.name).toBe("ContractError");
    const actual: Record<string, unknown> = error.toJSON();
    expect(actual).toEqual({ version: "arra-error/v1", ...expected } as Record<string, unknown>);
  };

  test("both requests accept exactly their own keys", () => {
    expect(parseGetReadCursor(bytes(get()))).toEqual({
      workspace_name: "alpha-workspace", peer_name: "peer-a", session_name: "sess-a",
    });
    expect(parseAdvanceReadCursor(bytes(adv()))).toEqual({
      workspace_name: "alpha-workspace", peer_name: "peer-a", session_name: "sess-a",
      last_read_message_id: ID, expected: null,
    });
    governed(() => parseGetReadCursor(bytes({ workspace_name: "w", session_name: "s" })), {
      code: "missing_field", path: "/peer_name", message: 'missing required key "peer_name"',
    });
    governed(() => parseGetReadCursor(bytes({ ...get(), extra: 1 })), {
      code: "unexpected_field", path: "/extra", message: 'unexpected key "extra"',
    });
    governed(() => { const { expected: _drop, ...rest } = adv(); return parseAdvanceReadCursor(bytes(rest)); }, {
      code: "missing_field", path: "/expected", message: 'missing required key "expected"',
    });
  });

  test("names are nonempty valid Unicode bounded at 256 UTF-8 BYTES", () => {
    governed(() => parseGetReadCursor(bytes(get({ peer_name: "" }))), {
      code: "invalid_value", path: "/peer_name", message: "must be nonempty",
    });
    governed(() => parseGetReadCursor(bytes(get({ peer_name: 5 }))), {
      code: "invalid_type", path: "/peer_name", message: "expected string",
    });
    // null is a TYPE failure, not a nullable spelling: these keys are required.
    governed(() => parseGetReadCursor(bytes(get({ session_name: null }))), {
      code: "invalid_type", path: "/session_name", message: "expected string",
    });
    governed(() => parseGetReadCursor(bytes(get({ peer_name: "a".repeat(257) }))), {
      code: "limit_exceeded", path: "/peer_name", message: "text is 257 bytes; limit 256",
    });
    // 256 BYTES, not characters: 64 four-byte code points is exactly the bound.
    const fourByte = "\u{1F600}".repeat(64);
    expect(parseGetReadCursor(bytes(get({ peer_name: fourByte }))).peer_name).toBe(fourByte);
    expect(new TextEncoder().encode(fourByte)).toHaveLength(256);
  });

  test("the namespace is public_id: a legacy decimal id fails STATICALLY", () => {
    // "42" is a real message.id in the legacy numbering. It must never reach
    // the store as a cursor pointer, not even to be classified.
    for (const path of ["/last_read_message_id", "/expected/last_read_message_id"]) {
      const request = path.startsWith("/expected")
        ? adv({ expected: { last_read_message_id: "42" } })
        : adv({ last_read_message_id: "42" });
      governed(() => parseAdvanceReadCursor(bytes(request)), {
        code: "invalid_value", path, message: "expected a 21-character URL-safe id",
      });
    }
    // There is no NULLABLE desired position.
    governed(() => parseAdvanceReadCursor(bytes(adv({ last_read_message_id: null }))), {
      code: "invalid_value", path: "/last_read_message_id",
      message: "expected a 21-character URL-safe id",
    });
  });

  test("expected is a THREE-valued guard, each spelling distinct", () => {
    expect(parseAdvanceReadCursor(bytes(adv({ expected: null }))).expected).toBeNull();
    expect(parseAdvanceReadCursor(bytes(adv({ expected: { last_read_message_id: null } }))).expected)
      .toEqual({ last_read_message_id: null });
    expect(parseAdvanceReadCursor(bytes(adv({ expected: { last_read_message_id: ID } }))).expected)
      .toEqual({ last_read_message_id: ID });
    governed(() => parseAdvanceReadCursor(bytes(adv({ expected: "none" }))), {
      code: "invalid_type", path: "/expected", message: "expected object",
    });
    governed(() => parseAdvanceReadCursor(bytes(adv({ expected: { last_read_message_id: ID, x: 1 } }))), {
      code: "unexpected_field", path: "/expected/x", message: 'unexpected key "x"',
    });
  });

  test("a non-bytes entrypoint is refused at ROOT", () => {
    // A second, ungoverned parser path would otherwise exist for any caller
    // holding an object rather than request bytes.
    governed(() => (parseGetReadCursor as unknown as (v: unknown) => unknown)({ workspace_name: "w" }), {
      code: "invalid_type", path: "", message: "expected request bytes",
    });
  });
});

describe("stored timestamps convert exactly or not at all", () => {
  const base = {
    workspace_name: "alpha-workspace", peer_name: "peer-a", session_name: "sess-a",
    last_read_message_id: null,
  };
  const at = (micros: unknown) => encodeReadCursorRow({ ...base, last_read_at: micros });
  const corrupt = (micros: unknown) => {
    let error: unknown;
    try {
      at(micros);
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    if (!(error instanceof PublicationError)) throw error;
    expect(error.name).toBe("PublicationError");
    expect(error.toJSON()).toEqual({
      version: "arra-publication-error/v1", code: "integrity_failure", path: "",
      message: "stored state failed integrity validation",
    });
  };

  test("the Gregorian bounds render, and one microsecond outside does not", () => {
    // Measured, not inferred from a range constant.
    expect(at(-62135596800000000n).last_read_at).toBe("0001-01-01T00:00:00.000Z");
    expect(at(253402300799999000n).last_read_at).toBe("9999-12-31T23:59:59.999Z");
    corrupt(-62135596800000001n);
    corrupt(253402300800000000n);
  });

  test("a SUB-MILLISECOND remainder is corruption, never rounded", () => {
    const exact = BigInt(Date.parse("2026-09-21T00:00:00.000Z")) * 1000n;
    expect(at(exact).last_read_at).toBe("2026-09-21T00:00:00.000Z");
    corrupt(exact + 1n);
    corrupt(exact + 999n);
  });

  test("null, text and unsafe numbers are all refused", () => {
    // `last_read_at` has NO null spelling on the wire, and this refusal holds
    // whatever the engine admits -- it is proven here, not inferred from a
    // NOT NULL column declaration.
    corrupt(null);
    corrupt(undefined);
    corrupt("2026-09-21T00:00:00.000Z");
    corrupt(Number.MAX_SAFE_INTEGER + 2);
  });
});

describe("raw byte handling is DELEGATED to the accepted strict parser", () => {
  const enc = new TextEncoder();
  const governedRaw = (
    bytes: Uint8Array,
    expected: { code: string; path: string; message: string },
  ): void => {
    let error: unknown;
    try {
      parseGetReadCursor(bytes);
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    if (!(error instanceof ContractError)) {
      throw new Error(`expected ContractError, got ${(error as Error)?.name}: ${String(error)}`);
    }
    expect(error.name).toBe("ContractError");
    const actual: Record<string, unknown> = error.toJSON();
    expect(actual).toEqual({ version: "arra-error/v1", ...expected } as Record<string, unknown>);
  };

  test("a DUPLICATE object key is refused at the repeated pointer", () => {
    // JSON.parse would silently keep the last value. The accepted parser does
    // not, and this module inherits that rather than re-deciding it.
    governedRaw(
      enc.encode('{"workspace_name":"w","workspace_name":"w","peer_name":"p","session_name":"s"}'),
      { code: "duplicate_key", path: "/workspace_name", message: "duplicate decoded object key" },
    );
  });

  test("malformed UTF-8 is refused at ROOT", () => {
    governedRaw(new Uint8Array([0x7b, 0xff, 0x7d]), {
      code: "invalid_unicode", path: "", message: "malformed UTF-8",
    });
  });

  test("nesting deeper than 64 is refused, with the pointer that reached it", () => {
    let deep = '{"workspace_name":"w","peer_name":"p","session_name":';
    let tail = "";
    for (let i = 0; i < 70; i += 1) {
      deep += "[";
      tail += "]";
    }
    const error = (() => {
      try {
        parseGetReadCursor(enc.encode(`${deep}"s"${tail}}`));
      } catch (thrown) {
        return thrown as ContractError;
      }
      throw new Error("expected a throw, got none");
    })();
    expect(error.name).toBe("ContractError");
    expect(error.toJSON()).toMatchObject({
      version: "arra-error/v1",
      code: "limit_exceeded",
      message: "nesting depth 65 exceeds 64",
    });
    // The pointer walks the actual path that breached the bound.
    expect(error.path.startsWith("/session_name/0/0/0")).toBe(true);
  });

  test("a document past 1 MiB is refused at ROOT, by BYTES", () => {
    const oversize = `{"workspace_name":"${"w".repeat(1_100_000)}","peer_name":"p","session_name":"s"}`;
    governedRaw(enc.encode(oversize), {
      code: "limit_exceeded", path: "",
      message: `document is ${enc.encode(oversize).length} bytes; limit 1048576`,
    });
  });
});

describe("stored names, pointers and raw-microsecond timestamps", () => {
  const MICROS = BigInt(Date.parse("2026-09-21T00:00:00.000Z")) * 1000n;
  const row = (o: Record<string, unknown> = {}) => ({
    workspace_name: "alpha-workspace", peer_name: "peer-a", session_name: "sess-a",
    last_read_message_id: null, last_read_at: MICROS, ...o,
  });
  const corrupt = (value: Record<string, unknown>) => {
    let error: unknown;
    try {
      encodeReadCursorRow(value);
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    if (!(error instanceof PublicationError)) throw error;
    expect(error.name).toBe("PublicationError");
    expect(error.toJSON()).toEqual({
      version: "arra-publication-error/v1", code: "integrity_failure", path: "",
      message: "stored state failed integrity validation",
    });
  };

  test("stored NAMES keep the 256-byte bound and valid Unicode", () => {
    // A stored name past the bound could never have been written through this
    // service, so reading one back is corruption rather than a long name.
    corrupt(row({ peer_name: "a".repeat(257) }));
    corrupt(row({ session_name: "s\uD800" }));
    corrupt(row({ workspace_name: "" }));
    // 64 four-byte code points is exactly 256 bytes and is accepted.
    const fourByte = "\u{1F600}".repeat(64);
    expect(encodeReadCursorRow(row({ peer_name: fourByte })).peer_name).toBe(fourByte);
  });

  test("a MALFORMED retained pointer is corruption, per length and charset", () => {
    // The retained pointer must satisfy the declared namespace itself. An
    // orphan or malformed one is terminal through this interface rather than
    // silently converted or read as absent.
    corrupt(row({ last_read_message_id: "a".repeat(20) }));
    corrupt(row({ last_read_message_id: "a".repeat(22) }));
    corrupt(row({ last_read_message_id: `${"a".repeat(20)}!` }));
    corrupt(row({ last_read_message_id: 42 }));
    // The legacy decimal spelling is refused on READ too, not only on request.
    corrupt(row({ last_read_message_id: "42" }));
  });

  test("a bigint timestamp converts exactly; a JS number is now refused (#105 amendment)", () => {
    // CORRECTED 2026-09-26 (overnight R1, docs/overnight/DECISIONS.md): this
    // test previously asserted that a safe-integer `number` converts exactly
    // "like a bigint", reasoning that "Arrow can hand back either
    // representation". Measured false (LANCEDB-FACTS.md §1): the client's
    // lossy `toArray()`/`.get()` accessor -- the only thing that could ever
    // hand this kernel a plain `number` -- always returns MILLISECONDS, never
    // raw microseconds. `decodeArrowRows`/`rawRows` (storage.ts) return the
    // raw microsecond value as a `bigint`, always. So a real `number` reaching
    // this row's `last_read_at` is not "the same instant, differently typed"
    // -- it is a millisecond value 1000x smaller than the microseconds it
    // would be mistaken for, which is exactly the #105 latent hazard. There is
    // no legitimate production path that hands this encoder a `number`; the
    // fix is to refuse one rather than accept it as equivalent to a `bigint`.
    const asBigInt = encodeReadCursorRow(row({ last_read_at: MICROS }));
    expect(asBigInt.last_read_at).toBe("2026-09-21T00:00:00.000Z");
    expect(Number.isSafeInteger(Number(MICROS))).toBe(true);
    corrupt(row({ last_read_at: Number(MICROS) }));
    corrupt(row({ last_read_at: Number(MICROS) + 0.5 }));
  });
});
