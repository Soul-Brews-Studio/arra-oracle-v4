/**
 * #59 (Parent #28) context kernel — the PURE half.
 *
 * Request grammar, physical row encoding and the response budget, all without
 * a dataset, a gate or a child process. Persistence cases follow; they are not
 * simulated here, because a mock of the store would prove only that the mock
 * agrees with itself.
 *
 * Contract: app/docs/contracts/context-ingestion-v1.md
 * SHA256 9c3c1a0fd41f43b7867dd76530e6294b13a1f85ad9ea8cf053101dfc5923ece5
 */

import { describe, expect, test } from "bun:test";
import { runGated } from "./helpers/publication-fixture";
import {
  appendRequest,
  contextId,
  createContextFixture,
  joinRequest,
  messageItem,
  peerRequest,
  sessionRequest,
  sourcedItem,
} from "./helpers/context-fixture";
import { OPERATOR } from "./helpers/read-boundary-fixture";
import { ContractError } from "../src/contracts/errors";
import { prepareNewMessage } from "../src/contracts/source-ingestion-v1";
import { PublicationError } from "../src/publication/errors";
import {
  MESSAGE_FIELDS,
  PEER_FIELDS,
  SESSION_FIELDS,
  SESSION_PEER_FIELDS,
  MAX_ITEMS,
  MAX_RESULT_WIRE_BYTES,
  encodeMessageRow,
  encodePeerRow,
  encodeSessionPeerRow,
  encodeSessionRow,
  parseAppendMessages,
  parseGetMessage,
  parseGetPeer,
  parseGetSession,
  parseJoinSession,
  parseListMessages,
  parseListPeers,
  parseListSessions,
  parseRegisterPeer,
  parseRegisterSession,
  rowWireBytes,
} from "../src/publication/context";
import { testTimeout } from "./helpers/timing.testTimeout";

const WS = "alpha-workspace";
const id = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/**
 * The two envelopes are asserted SEPARATELY and by class.
 *
 * Asserting only a code is how the #47 envelope defect survived two lanes: the
 * codes are identical across envelopes, so a code-only assertion cannot see a
 * wrong version.
 */
const contractErr = (run: () => unknown): ContractError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw new Error(`expected ContractError, got ${(error as Error)?.name}: ${String(error)}`);
  }
  throw new Error("expected a throw, got none");
};

const publicationErr = (run: () => unknown): PublicationError => {
  try {
    run();
  } catch (error) {
    if (error instanceof PublicationError) return error;
    throw new Error(`expected PublicationError, got ${(error as Error)?.name}: ${String(error)}`);
  }
  throw new Error("expected a throw, got none");
};

const item = (o: Record<string, unknown> = {}) => ({
  public_id: id("m1"),
  message: { peer_name: "peer-a", role: null, content: "hello", in_reply_to: null },
  source: null,
  ...o,
});

describe("request grammar is closed, and keeps the GOVERNED envelope", () => {
  test("registerPeer and registerSession parse their exact shapes", () => {
    const peer = { workspace_name: WS, peer_id: id("p1"), name: "peer-a" };
    expect(parseRegisterPeer(bytes(peer))).toEqual(peer);
    const session = { workspace_name: WS, session_id: id("s1"), name: "sess-a" };
    // K12a (overnight R18): the omitted optional title reads back as an explicit null.
    expect(parseRegisterSession(bytes(session))).toEqual({ ...session, h_metadata: null });
  });

  test("shape failures keep arra-error/v1, not a context envelope", () => {
    // Strict parse / closed shape is grammar, not context semantics.
    const e = contractErr(() =>
      parseRegisterPeer(bytes({ workspace_name: WS, peer_id: id("p1"), name: "x", extra: 1 })),
    );
    expect(e.toJSON().version).toBe("arra-error/v1");
    expect(e.code).toBe("unexpected_field");
  });

  test("a nullable value must be an EXPLICIT null, never omitted", () => {
    const missing = { public_id: id("m1"), message: { peer_name: "p", role: null, content: "c" }, source: null };
    const e = contractErr(() => parseAppendMessages(bytes({ workspace_name: WS, session_name: "s", items: [missing] })));
    expect(e.code).toBe("missing_field");
  });

  test("source keys are the CODEC's names, not the draft's abbreviations", () => {
    // Frozen contract section 2 corrects revision 1 explicitly. The abbreviated
    // shape must be rejected by the governed parser.
    const abbreviated = item({ source: { message_id: "m", created_at: null, supplied_digest: null } });
    const e = contractErr(() =>
      parseAppendMessages(bytes({ workspace_name: WS, session_name: "s", items: [abbreviated] })),
    );
    // The closed-object helper reports the MISSING required key before it
    // reaches the unexpected one, so the abbreviated shape surfaces as
    // missing_field. Either way it is refused by the governed parser and
    // never reaches context semantics -- that is the point being pinned.
    expect(["missing_field", "unexpected_field"]).toContain(e.code);
    expect(e.path).toContain("/items/0/source/");

    const correct = item({
      source: { source_message_id: "m-1", source_created_at: null, supplied_digest: null },
    });
    const parsed = parseAppendMessages(bytes({ workspace_name: WS, session_name: "s", items: [correct] }));
    expect((parsed.items[0]!.source as Record<string, unknown>).source_message_id).toBe("m-1");
  });

  test("items is nonempty and capped at 128", () => {
    expect(MAX_ITEMS).toBe(128);
    expect(contractErr(() => parseAppendMessages(bytes({ workspace_name: WS, session_name: "s", items: [] }))).code)
      .toBe("invalid_value");
    const many = Array.from({ length: 129 }, (_u, i) => item({ public_id: id(`m${i}`) }));
    expect(contractErr(() => parseAppendMessages(bytes({ workspace_name: WS, session_name: "s", items: many }))).code)
      .toBe("limit_exceeded");
  });

  test("a duplicate requested public_id rejects at the LATER item", () => {
    const dup = [item({ public_id: id("same") }), item({ public_id: id("other") }), item({ public_id: id("same") })];
    const e = contractErr(() => parseAppendMessages(bytes({ workspace_name: WS, session_name: "s", items: dup })));
    // The later occurrence is the one that collides with what came before.
    expect(e.path).toBe("/items/2/public_id");
  });

  test("listMessages limit is a JSON integer 1..100, and after_seq is Int64 TEXT", () => {
    const ok = { workspace_name: WS, session_name: "s", after_seq: "-9223372036854775808", limit: 100 };
    expect(parseListMessages(bytes(ok)).after_seq).toBe("-9223372036854775808");
    expect(parseListMessages(bytes({ ...ok, after_seq: null })).after_seq).toBeNull();
    for (const bad of [0, 101, 1.5, "10"]) {
      expect(contractErr(() => parseListMessages(bytes({ ...ok, limit: bad }))).path).toBe("/limit");
    }
    // A cursor is canonical decimal text, never a number.
    expect(contractErr(() => parseListMessages(bytes({ ...ok, after_seq: 5 }))).path).toBe("/after_seq");
  });

  test("after_seq rejects NEGATIVE ZERO, with 0 and -1 as positive controls", () => {
    // "-0" matches a naive -?(0|[1-9][0-9]*) and is a second spelling of zero,
    // so a cursor could round-trip differently than it arrived. Found by root
    // running the parser, not by this suite passing.
    const base = { workspace_name: WS, session_name: "s", limit: 10 };
    expect(parseListMessages(bytes({ ...base, after_seq: "0" })).after_seq).toBe("0");
    expect(parseListMessages(bytes({ ...base, after_seq: "-1" })).after_seq).toBe("-1");
    const e = contractErr(() => parseListMessages(bytes({ ...base, after_seq: "-0" })));
    expect(e.toJSON().version).toBe("arra-error/v1");
    expect(e.code).toBe("invalid_value");
    expect(e.path).toBe("/after_seq");
  });

  test("listPeers/listSessions: limit is 1..100, after_name is a nullable NAME (not Int64), include_total is a required boolean", () => {
    for (const parse of [parseListPeers, parseListSessions] as const) {
      const ok = { workspace_name: WS, after_name: null, limit: 50, include_total: false };
      // K10 (overnight R18): listSessions' omitted optional filters read back as explicit nulls.
      const filters: Record<string, unknown> = parse === parseListSessions ? { is_active: null, member_peer_name: null } : {};
      expect(parse(bytes(ok)) as Record<string, unknown>).toEqual({ ...ok, ...filters });
      expect(parse(bytes({ ...ok, after_name: "peer-a" })).after_name).toBe("peer-a");
      expect(parse(bytes({ ...ok, include_total: true })).include_total).toBe(true);
      for (const bad of [0, 101, 1.5, "10"]) {
        expect(contractErr(() => parse(bytes({ ...ok, limit: bad }))).path).toBe("/limit");
      }
      // The cursor is a NAME, not Int64 decimal text -- a bare number is the
      // wrong grammar for this field, the mirror image of after_seq's own
      // text-vs-number distinction above.
      expect(contractErr(() => parse(bytes({ ...ok, after_name: 5 }))).path).toBe("/after_name");
      // Required, not defaulted by omission: this grammar has no optional
      // keys anywhere else, so a missing or non-boolean value fails closed
      // rather than silently defaulting to false.
      const { include_total: _drop, ...missing } = ok;
      expect(contractErr(() => parse(bytes(missing))).code).toBe("missing_field");
      expect(contractErr(() => parse(bytes({ ...ok, include_total: "true" }))).path).toBe("/include_total");
    }
  });

  test("the read requests are closed too", () => {
    expect(parseGetPeer(bytes({ workspace_name: WS, peer_name: "p" }))).toEqual({ workspace_name: WS, peer_name: "p" });
    expect(parseGetSession(bytes({ workspace_name: WS, session_name: "s" }))).toEqual({ workspace_name: WS, session_name: "s" });
    // #87 / R3: the omitted optional requester reads back as an explicit null.
    expect(parseGetMessage(bytes({ workspace_name: WS, public_id: id("m1") }))).toEqual({
      workspace_name: WS, public_id: id("m1"), requester_peer_name: null,
    });
    expect(parseJoinSession(bytes({ workspace_name: WS, session_name: "s", peer_name: "p" }))).toEqual({
      workspace_name: WS, session_name: "s", peer_name: "p",
    });
  });

  test("names are byte-bounded at 256 UTF-8 BYTES, not characters", () => {
    const fits = "ก".repeat(85);  // 255 bytes
    const over = "ก".repeat(86);  // 258 bytes
    expect(parseRegisterPeer(bytes({ workspace_name: WS, peer_id: id("p1"), name: fits })).name).toBe(fits);
    expect(contractErr(() => parseRegisterPeer(bytes({ workspace_name: WS, peer_id: id("p1"), name: over }))).path)
      .toBe("/name");
  });

  test("names are NOT trimmed, cased or normalized", () => {
    const composed = "é"; // e + combining acute, NOT U+00E9
    expect(parseRegisterPeer(bytes({ workspace_name: WS, peer_id: id("p1"), name: composed })).name).toBe(composed);
    expect(parseRegisterPeer(bytes({ workspace_name: WS, peer_id: id("p1"), name: "  x  " })).name).toBe("  x  ");
  });
});

describe("physical rows encode in target_v1 order, with the STORED envelope", () => {
  const MICROS = 1_600_000_000_000_000n;

  const peerRow = { id: id("p1"), name: "peer-a", workspace_name: WS, h_metadata: null, internal_metadata: null, configuration: null, created_at: MICROS };
  const sessionRow = { ...peerRow, name: "sess-a", is_active: true };
  const sessionPeerRow = { workspace_name: WS, session_name: "s", peer_name: "p", configuration: null, internal_metadata: null, joined_at: MICROS, left_at: null };
  const messageRow = {
    id: 5n, public_id: id("m1"), workspace_name: WS, session_name: "s", peer_name: "p",
    content: "hello", token_count: 0n, seq_in_session: 1n, h_metadata: null, internal_metadata: null,
    created_at: MICROS, role: null, in_reply_to: null, read: null, read_at: null,
    source_namespace: null, source_message_id: null, source_payload_digest: null,
    source_created_at: null, ingested_at: MICROS,
  };

  test("field order matches the Python models exactly", () => {
    // Quoted from target_v1/core.py, not invented.
    expect(PEER_FIELDS).toEqual(["id", "name", "workspace_name", "h_metadata", "internal_metadata", "configuration", "created_at"]);
    expect(SESSION_FIELDS).toEqual(["id", "name", "workspace_name", "is_active", "h_metadata", "internal_metadata", "configuration", "created_at"]);
    expect(SESSION_PEER_FIELDS).toEqual(["workspace_name", "session_name", "peer_name", "configuration", "internal_metadata", "joined_at", "left_at"]);
    expect(Object.keys(encodePeerRow(peerRow))).toEqual([...PEER_FIELDS]);
    expect(Object.keys(encodeSessionRow(sessionRow))).toEqual([...SESSION_FIELDS]);
    expect(Object.keys(encodeSessionPeerRow(sessionPeerRow))).toEqual([...SESSION_PEER_FIELDS]);
    expect(Object.keys(encodeMessageRow(messageRow))).toEqual([...MESSAGE_FIELDS]);
  });

  test("Int64 columns become canonical decimal TEXT, exact past 2^53", () => {
    const beyond = encodeMessageRow({ ...messageRow, id: 9007199254740993n, seq_in_session: 9223372036854775807n });
    // A Number round-trip would print 9007199254740992 here.
    expect(beyond.id).toBe("9007199254740993");
    expect(beyond.seq_in_session).toBe("9223372036854775807");
    expect(encodeMessageRow({ ...messageRow, id: -9n }).id).toBe("-9");
  });

  test("a sub-millisecond remainder fails CLOSED, before any Number conversion", () => {
    const e = publicationErr(() => encodeMessageRow({ ...messageRow, created_at: MICROS + 1n }));
    expect(e.code).toBe("integrity_failure");
    expect(e.path).toBe("");
    expect(e.toJSON().version).toBe("arra-publication-error/v1");
  });

  test("stored-state failures are integrity_failure at ROOT, never request errors", () => {
    expect(publicationErr(() => encodeMessageRow({ ...messageRow, token_count: -1n })).code).toBe("integrity_failure");
    expect(publicationErr(() => encodeMessageRow({ ...messageRow, read: 1 })).code).toBe("integrity_failure");
    expect(publicationErr(() => encodeSessionRow({ ...sessionRow, is_active: "yes" })).code).toBe("integrity_failure");
  });

  test("nullable times and JSON columns are preserved, not normalized", () => {
    // source_created_at is deliberately ABSENT here. The accepted stored-source
    // validator rejects a source time with no source triple -- "source time
    // requires the source triple" -- so pairing them was asserting a state the
    // codec calls invalid. My test was wrong, not the rule.
    const withOptional = encodeMessageRow({
      ...messageRow,
      read: true,
      read_at: MICROS,
      h_metadata: '{"b":1,"a":2}',
    });
    expect(withOptional.read).toBe(true);
    expect(withOptional.read_at).toBe("2020-09-13T12:26:40.000Z");
    // Retained BYTE-FOR-BYTE: this slice does not parse or recanonicalize it.
    expect(withOptional.h_metadata).toBe('{"b":1,"a":2}');
    expect(encodeSessionPeerRow(sessionPeerRow).left_at).toBeNull();
  });
});

describe("whole-input type and format are checked BEFORE queue admission", () => {
  /**
   * Root measured `message.content = 42` being accepted. Section 2 requires
   * whole-input type/format validation before admission; only source MODE,
   * supplied-digest equality and foreign refs are per-item semantics.
   *
   * This matters beyond tidiness: a malformed LATER item must throw before any
   * row is written, not durably accept a prefix and then stop.
   */
  const ok = () => item();

  test("a non-string content is refused by the parser", () => {
    const e = contractErr(() =>
      parseAppendMessages(bytes({
        workspace_name: WS, session_name: "s",
        items: [item({ message: { peer_name: "p", role: null, content: 42, in_reply_to: null } })],
      })),
    );
    expect(e.toJSON().version).toBe("arra-error/v1");
    expect(e.path).toBe("/items/0/message/content");
  });

  test("a malformed LATER item is refused, so no earlier item can be written", () => {
    const e = contractErr(() =>
      parseAppendMessages(bytes({
        workspace_name: WS, session_name: "s",
        items: [
          ok(),
          item({ public_id: id("m2"), message: { peer_name: 7, role: null, content: "c", in_reply_to: null } }),
        ],
      })),
    );
    expect(e.path).toBe("/items/1/message/peer_name");
  });

  test("nested nullable fields carry their real types", () => {
    const bad = (message: Record<string, unknown>, path: string) => {
      expect(contractErr(() =>
        parseAppendMessages(bytes({ workspace_name: WS, session_name: "s", items: [item({ message })] })),
      ).path).toBe(path);
    };
    bad({ peer_name: "p", role: 1, content: "c", in_reply_to: null }, "/items/0/message/role");
    bad({ peer_name: "p", role: null, content: "c", in_reply_to: "short" }, "/items/0/message/in_reply_to");

    const badSource = (source: Record<string, unknown>, path: string) => {
      expect(contractErr(() =>
        parseAppendMessages(bytes({ workspace_name: WS, session_name: "s", items: [item({ source })] })),
      ).path).toBe(path);
    };
    badSource({ source_message_id: 5, source_created_at: null, supplied_digest: null }, "/items/0/source/source_message_id");
    badSource({ source_message_id: "m", source_created_at: "not-a-time", supplied_digest: null }, "/items/0/source/source_created_at");
    badSource({ source_message_id: "m", source_created_at: null, supplied_digest: "NOTHEX" }, "/items/0/source/supplied_digest");
  });

  test("positive controls: empty content and a well-formed source still parse", () => {
    // Content grammar belongs to prepareNewMessage; an empty string is
    // accepted there, so the pre-admission check must not tighten it.
    const empty = parseAppendMessages(bytes({
      workspace_name: WS, session_name: "s",
      items: [item({ message: { peer_name: "p", role: null, content: "", in_reply_to: null } })],
    }));
    expect((empty.items[0]!.message as Record<string, unknown>).content).toBe("");

    const sourced = parseAppendMessages(bytes({
      workspace_name: WS, session_name: "s",
      items: [item({
        source: {
          source_message_id: "m-1",
          source_created_at: "2026-09-21T00:00:00.000Z",
          supplied_digest: "a".repeat(64),
        },
      })],
    }));
    expect((sourced.items[0]!.source as Record<string, unknown>).supplied_digest).toBe("a".repeat(64));
  });
});

describe("stored rows must satisfy the stated grammar, not merely be strings", () => {
  /** The genuine digest for the fixture row below, from the governed codec. */
  const realDigest = (): string =>
    prepareNewMessage(JSON.stringify({
      context: {
        workspace_name: WS, session_name: "s",
        intake_at: "2020-09-13T12:26:40.000Z", source_namespace: "ns",
      },
      message: { peer_name: "p", role: null, content: "hello", in_reply_to: null },
      source: { source_message_id: "m-1", source_created_at: null, supplied_digest: null },
    })).source_payload_digest as string;

  /**
   * Every case here was measured by root against the running parser before the
   * repair: the encoders accepted all of them. `typeof value === "string"` is
   * not the grammar the contract states.
   */
  const MICROS = 1_600_000_000_000_000n;
  const peer = {
    id: id("p1"), name: "peer-a", workspace_name: WS,
    h_metadata: null, internal_metadata: null, configuration: null, created_at: MICROS,
  };
  const message = {
    id: 5n, public_id: id("m1"), workspace_name: WS, session_name: "s", peer_name: "p",
    content: "hello", token_count: 0n, seq_in_session: 1n, h_metadata: null,
    internal_metadata: null, created_at: MICROS, role: null, in_reply_to: null,
    read: null, read_at: null, source_namespace: null, source_message_id: null,
    source_payload_digest: null, source_created_at: null, ingested_at: MICROS,
  };

  test("a stored ID must satisfy the nanoid21 grammar", () => {
    expect(publicationErr(() => encodePeerRow({ ...peer, id: "x" })).code).toBe("integrity_failure");
    expect(publicationErr(() => encodeSessionRow({ ...peer, id: "x", is_active: true })).code).toBe("integrity_failure");
    expect(publicationErr(() => encodeMessageRow({ ...message, public_id: "x" })).code).toBe("integrity_failure");
    // Positive control: a real nanoid21 still passes.
    expect(encodePeerRow(peer).id).toBe(id("p1"));
  });

  test("a stored NAME is bounded at 256 UTF-8 bytes", () => {
    const at256 = "a".repeat(256);
    const at257 = "a".repeat(257);
    expect(encodePeerRow({ ...peer, name: at256 }).name).toBe(at256);
    expect(publicationErr(() => encodePeerRow({ ...peer, name: at257 })).code).toBe("integrity_failure");
  });

  test("optional metadata must be VALID Unicode, and empty stays allowed", () => {
    const lone = "\ud800"; // unpaired high surrogate
    expect(publicationErr(() => encodePeerRow({ ...peer, h_metadata: lone })).code).toBe("integrity_failure");
    expect(publicationErr(() => encodeMessageRow({ ...message, internal_metadata: lone })).code).toBe("integrity_failure");
    // Empty string is a legitimate retained value, NOT corruption.
    expect(encodePeerRow({ ...peer, h_metadata: "" }).h_metadata).toBe("");
    expect(encodePeerRow({ ...peer, configuration: '{"a":1}' }).configuration).toBe('{"a":1}');
  });

  test("a stored sourced digest is RECOMPUTED, not merely shaped", () => {
    // All-or-none plus a hex regex is not verification. A structurally valid
    // but WRONG digest -- 64 zeroes -- passes a shape check while proving
    // nothing about the content it claims to cover.
    const sourced = {
      ...message,
      source_namespace: "ns",
      source_message_id: "m-1",
      source_payload_digest: "0".repeat(64),
    };
    expect(publicationErr(() => encodeMessageRow(sourced)).code).toBe("integrity_failure");
  });

  test("tampered stored content is caught even when the digest is RETAINED", () => {
    // The dangerous direction: the digest still matches what was originally
    // written, so a stale-digest comparison accepts it. Only recomputation
    // from the stored envelope notices the content changed.
    const original = {
      ...message,
      source_namespace: "ns",
      source_message_id: "m-1",
      source_payload_digest: null as string | null,
    };
    // Establish the genuine digest by encoding a valid row first.
    const valid = encodeMessageRow({ ...original, source_payload_digest: realDigest() });
    expect(valid.source_payload_digest).toBe(realDigest());
    // Same retained digest, altered content.
    const tampered = { ...original, content: "TAMPERED", source_payload_digest: realDigest() };
    expect(publicationErr(() => encodeMessageRow(tampered)).code).toBe("integrity_failure");
  });

  test("stored content must be valid Unicode, and may be empty", () => {
    expect(publicationErr(() => encodeMessageRow({ ...message, content: "\ud800" })).code)
      .toBe("integrity_failure");
    // Empty content is accepted grammar, not corruption.
    expect(encodeMessageRow({ ...message, content: "" }).content).toBe("");
  });

  test("timestamps use the SUPPORTED Gregorian range, not the JS Date range", () => {
    // Year 10000. JS Date happily renders +010000-01-01T00:00:00.000Z; the
    // accepted range stops at 9999-12-31T23:59:59.999.
    const year10000 = 253402300800000000n;
    expect(publicationErr(() => encodePeerRow({ ...peer, created_at: year10000 })).code).toBe("integrity_failure");
    // Positive controls at both real edges.
    expect(encodePeerRow({ ...peer, created_at: 253402300799999000n }).created_at).toBe("9999-12-31T23:59:59.999Z");
    expect(encodePeerRow({ ...peer, created_at: -62135596800000000n }).created_at).toBe("0001-01-01T00:00:00.000Z");
  });

  test("the stored source triple is all-or-none, and its digest is checked", () => {
    const digest = "a".repeat(64);
    // A partial triple is corruption: a namespace with no message id cannot
    // identify anything.
    expect(publicationErr(() => encodeMessageRow({ ...message, source_namespace: "ns" })).code)
      .toBe("integrity_failure");
    expect(publicationErr(() => encodeMessageRow({ ...message, source_message_id: "m", source_payload_digest: digest })).code)
      .toBe("integrity_failure");
    // A digest must be lowercase sha256 hex (shape), and must also match
    // (recomputation). Both land as integrity_failure at the root.
    expect(publicationErr(() =>
      encodeMessageRow({ ...message, source_namespace: "ns", source_message_id: "m", source_payload_digest: "NOTHEX" }),
    ).code).toBe("integrity_failure");
    // Positive control: a complete triple whose digest ACTUALLY matches the
    // stored envelope. A made-up 64-hex value is no longer sufficient, which
    // is the whole point of recomputation.
    const genuine = realDigest();
    const full = encodeMessageRow({
      ...message, source_namespace: "ns", source_message_id: "m-1", source_payload_digest: genuine,
    });
    expect(full.source_payload_digest).toBe(genuine);
  });
});

describe("the response wire budget is a real bound", () => {
  test("16 MiB, measured as UTF-8 JSON bytes", () => {
    expect(MAX_RESULT_WIRE_BYTES).toBe(16 * 1024 * 1024);
    const row = { id: "1", content: "ก" };
    // Byte length, not string length: a 3-byte character must count as 3.
    expect(rowWireBytes(row)).toBe(new TextEncoder().encode(JSON.stringify(row)).length);
  });
});

describe("real persistence: registration, shapes and reads", () => {
  /**
   * Inside the REAL writer gate, in an exec'd child, against a real
   * nineteen-table dataset the test owns and removes. Nothing is mocked.
   */
  const CHILD = new URL("./fixtures/context-v1/core/gated-context.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
  const ALPHA = "alpha-workspace";

  const drive = async (
    root: string,
    ops: Array<{ method: string; request: unknown }>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [
      root,
      JSON.stringify({ ops, clockMs: CLOCK, ...extra }),
    ]);
    // A reaped child can still have printed a partial line; its JSON is only
    // evidence if it exited cleanly.
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 600)}`);
    return JSON.parse(line);
  };
  // #87 / R3: message reads take the transport-built authority; these lanes
  // read through the audit:read operator view unless a test says otherwise.
  const op = (method: string, request: unknown, authority: unknown = OPERATOR) => ({ method, request, authority });

  test("the writer bundle has EXACTLY the contracted shape", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [op("registerPeer", peerRequest(ALPHA))]);
      expect(parsed.writerKeys).toEqual(["close", "context", "publication", "taxonomy"]);
      // The writer's context facade spreads the full read-method set in
      // (`{ ...reads, ...writeOnly }`), so this is that union, not just the
      // fourteen write-only methods (overnight R18 added closeSession, K9).
      expect(parsed.contextMethods).toEqual([
        "advanceReadCursor", "appendMessages", "closeSession", "createSessionLink", "createTrace", "embedPendingChunks", "getContext",
        "getMessage", "getPeer", "getReadCursor", "getRecallEligibility", "getSearchFreshness", "getSession", "getTrace",
        "indexRevisionChunks", "joinSession", "listConnections", "listLifecycleHistory", "listMcpCalls", "listMessages", "listPeers", "listSearchChunks",
        "listSessionLinks", "listSessionMembers", "listSessions", "listTraceHits", "reconcileSearchChunks", "registerPeer", "registerSession",
        "retireNode", "supersedeNode", "writeChunkEmbedding",
      ]);
      // Only the BUNDLE closes the owner.
      expect(parsed.publicationKeys).not.toContain("close");
      expect(parsed.taxonomyHasClose).toBe(false);
      expect(parsed.contextHasClose).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a fresh registration writes one row and emits one literal triple", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [op("registerPeer", peerRequest(ALPHA))]);
      expect(parsed.op0.ok).toBe(true);
      expect(parsed.op0.value.outcome).toBe("created");
      expect(parsed.op0.value.row.name).toBe("peer-a");
      expect(parsed.op0.value.row.created_at).toBe("2026-09-21T00:00:00.000Z");
      // New optional fields are null, never inferred.
      expect(parsed.op0.value.row.h_metadata).toBeNull();
      expect(parsed.op0.value.row.configuration).toBeNull();
      expect(parsed.trace).toEqual(["before_write", "after_write", "after_readback"]);
      expect(parsed.persistedPeers).toEqual(["peer-a"]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("an identical re-registration is already_satisfied and emits NO boundary", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("registerPeer", peerRequest(ALPHA)),
        op("registerPeer", peerRequest(ALPHA)),
      ]);
      expect(parsed.op1.value.outcome).toBe("already_satisfied");
      // Still exactly the one triple from the FIRST call.
      expect(parsed.trace).toHaveLength(3);
      expect(parsed.persistedPeers).toEqual(["peer-a"]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("ID and NAME collisions report their own reason, and neither writes", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("registerPeer", peerRequest(ALPHA)),
        // Same ID, different name: ID disagreement takes precedence.
        op("registerPeer", peerRequest(ALPHA, { name: "peer-b" })),
        // Different ID claiming the held name.
        op("registerPeer", peerRequest(ALPHA, { peer_id: contextId("peer2") })),
      ]);
      expect(parsed.op1.value).toEqual({ outcome: "conflict", reason: "id" });
      expect(parsed.op2.value).toEqual({ outcome: "conflict", reason: "name" });
      // A conflict is returned normally, so it is NOT a write and NOT a poison.
      expect(parsed.persistedPeers).toEqual(["peer-a"]);
      expect(parsed.trace).toHaveLength(3);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a missing workspace is an invalid REFERENCE, in the publication envelope", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("registerPeer", peerRequest("no-such-workspace")),
      ]);
      expect(parsed.op0.ok).toBe(false);
      // All four fields, never the code alone.
      expect(parsed.op0.name).toBe("PublicationError");
      expect(parsed.op0.version).toBe("arra-publication-error/v1");
      expect(parsed.op0.code).toBe("invalid_reference");
      expect(parsed.op0.path).toBe("/workspace_name");
      expect(parsed.persistedPeers).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("joinSession requires an active session and a real peer", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("registerPeer", peerRequest(ALPHA)),
        op("registerSession", sessionRequest(ALPHA)),
        op("joinSession", joinRequest(ALPHA)),
        op("joinSession", joinRequest(ALPHA)),
        op("joinSession", joinRequest(ALPHA, { peer_name: "ghost" })),
        op("joinSession", joinRequest(ALPHA, { session_name: "ghost-session" })),
      ]);
      expect(parsed.op2.value.outcome).toBe("created");
      expect(parsed.op2.value.row.left_at).toBeNull();
      expect(parsed.op3.value.outcome).toBe("already_satisfied");
      expect(parsed.op4.code).toBe("invalid_reference");
      expect(parsed.op4.path).toBe("/peer_name");
      expect(parsed.op5.code).toBe("invalid_reference");
      expect(parsed.op5.path).toBe("/session_name");
      expect(parsed.persistedMemberships).toEqual(["peer-a"]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("reads return the row or exactly null, never not_found", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("registerPeer", peerRequest(ALPHA)),
        op("getPeer", { workspace_name: ALPHA, peer_name: "peer-a" }),
        op("getPeer", { workspace_name: ALPHA, peer_name: "absent" }),
        op("getMessage", { workspace_name: ALPHA, public_id: contextId("nothing") }),
        op("listMessages", { workspace_name: ALPHA, session_name: "absent", after_seq: null, limit: 10 }),
      ]);
      expect(parsed.op1.value.name).toBe("peer-a");
      expect(Object.keys(parsed.op1.value)).toEqual([
        "id", "name", "workspace_name", "h_metadata", "internal_metadata", "configuration", "created_at",
      ]);
      // Absent scoped identity is null. `not_found` is excluded by contract.
      expect(parsed.op2.value).toBeNull();
      expect(parsed.op3.value).toBeNull();
      // A missing LIST session is a reference error, not an empty page.
      expect(parsed.op4.ok).toBe(false);
      expect(parsed.op4.code).toBe("invalid_reference");
      expect(parsed.op4.path).toBe("/session_name");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("an empty page has rows:[] and a null cursor", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("registerSession", sessionRequest(ALPHA)),
        op("listMessages", { workspace_name: ALPHA, session_name: "sess-a", after_seq: null, limit: 10 }),
      ]);
      expect(parsed.op1.value).toEqual({ rows: [], next_after_seq: null });
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("listPeers pages by name ascending, keyset resumes past the cursor, and total is opt-in", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("registerPeer", peerRequest(ALPHA, { peer_id: contextId("peer-b"), name: "peer-b" })),
        op("registerPeer", peerRequest(ALPHA, { peer_id: contextId("peer-a"), name: "peer-a" })),
        op("registerPeer", peerRequest(ALPHA, { peer_id: contextId("peer-c"), name: "peer-c" })),
        op("listPeers", { workspace_name: ALPHA, after_name: null, limit: 2, include_total: false }),
        op("listPeers", { workspace_name: ALPHA, after_name: "peer-b", limit: 2, include_total: false }),
        op("listPeers", { workspace_name: ALPHA, after_name: null, limit: 2, include_total: true }),
      ]);
      const page1 = parsed.op3.value;
      expect(page1.rows.map((r: any) => r.name)).toEqual(["peer-a", "peer-b"]);
      expect(page1.next_after_name).toBe("peer-b");
      expect(page1.total).toBeNull();

      const page2 = parsed.op4.value;
      expect(page2.rows.map((r: any) => r.name)).toEqual(["peer-c"]);
      expect(page2.next_after_name).toBeNull();
      expect(page2.total).toBeNull();

      // include_total counts the FULL workspace scope, unaffected by the
      // page's own cursor or limit.
      const withTotal = parsed.op5.value;
      expect(withTotal.rows.map((r: any) => r.name)).toEqual(["peer-a", "peer-b"]);
      expect(withTotal.total).toBe("3");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("listSessions pages by name ascending and stays workspace-scoped", async () => {
    const BETA = "beta-workspace";
    const fixture = await createContextFixture([ALPHA, BETA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("registerSession", sessionRequest(ALPHA, { session_id: contextId("sess-b"), name: "sess-b" })),
        op("registerSession", sessionRequest(ALPHA, { session_id: contextId("sess-a"), name: "sess-a" })),
        // A same-named session in a DIFFERENT workspace must never appear in
        // ALPHA's listing or count.
        op("registerSession", sessionRequest(BETA, { session_id: contextId("sess-a"), name: "sess-a" })),
        op("listSessions", { workspace_name: ALPHA, after_name: null, limit: 100, include_total: true }),
      ]);
      const page = parsed.op3.value;
      expect(page.rows.map((r: any) => r.name)).toEqual(["sess-a", "sess-b"]);
      expect(page.rows.every((r: any) => r.workspace_name === ALPHA)).toBe(true);
      expect(page.next_after_name).toBeNull();
      expect(page.total).toBe("2");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a second writer on the same root is refused while the first holds it", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [op("registerPeer", peerRequest(ALPHA))],
        { contendSameRoot: true },
      );
      // The context factory must claim the SAME canonical-root registry entry.
      expect(parsed.contention.ok).toBe(false);
      expect(parsed.contention.code).toBe("writer_unavailable");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("reads after RELEASE are refused with the full envelope", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [op("registerPeer", peerRequest(ALPHA))],
        { readAfterRelease: true },
      );
      expect(parsed.readAfterRelease.ok).toBe(false);
      expect(parsed.readAfterRelease.name).toBe("PublicationError");
      expect(parsed.readAfterRelease.version).toBe("arra-publication-error/v1");
      expect(parsed.readAfterRelease.code).toBe("recovery_required");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});

describe("real persistence: ordered batch ingestion", () => {
  const CHILD = new URL("./fixtures/context-v1/core/gated-context.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
  const ALPHA = "alpha-workspace";

  const drive = async (
    root: string,
    ops: Array<{ method: string; request: unknown }>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 600)}`);
    return JSON.parse(line);
  };
  // #87 / R3: message reads take the transport-built authority; these lanes
  // read through the audit:read operator view unless a test says otherwise.
  const op = (method: string, request: unknown, authority: unknown = OPERATOR) => ({ method, request, authority });

  /** Peer, session and membership, so messages have somewhere to land. */
  const setup = () => [
    op("registerPeer", peerRequest(ALPHA)),
    op("registerSession", sessionRequest(ALPHA)),
    op("joinSession", joinRequest(ALPHA)),
  ];

  test("a batch allocates ascending ids and sequences, and reads back in order", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const items = [
        messageItem({ public_id: contextId("m1"), message: { content: "one" } }),
        messageItem({ public_id: contextId("m2"), message: { content: "two" } }),
        messageItem({ public_id: contextId("m3"), message: { content: "three" } }),
      ];
      const parsed = await drive(fixture.datasetRoot, [
        ...setup(),
        op("appendMessages", appendRequest(ALPHA, "sess-a", items)),
        op("listMessages", { workspace_name: ALPHA, session_name: "sess-a", after_seq: null, limit: 2 }),
      ]);

      const batch = parsed.op3.value;
      expect(batch.outcome).toBe("complete");
      expect(batch.stop).toBeNull();
      expect(batch.results.map((r: any) => r.outcome)).toEqual(["accepted", "accepted", "accepted"]);
      // Int64 columns arrive as canonical decimal TEXT, never numbers.
      expect(batch.results.map((r: any) => r.row.id)).toEqual(["1", "2", "3"]);
      expect(batch.results.map((r: any) => r.row.seq_in_session)).toEqual(["1", "2", "3"]);
      // token_count 0 means NOT MEASURED.
      expect(batch.results[0].row.token_count).toBe("0");
      expect(batch.results[0].row.source_namespace).toBeNull();

      // Three rows, three triples each.
      expect(parsed.trace.filter((b: string) => b === "before_write")).toHaveLength(6); // 3 setup + 3 messages
      expect(parsed.persistedMessages.sort()).toEqual([contextId("m1"), contextId("m2"), contextId("m3")].sort());

      // Keyset page of 2 with a continuation cursor.
      const page = parsed.op4.value;
      expect(page.rows.map((r: any) => r.seq_in_session)).toEqual(["1", "2"]);
      expect(page.next_after_seq).toBe("2");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("an identical local replay is idempotent and allocates nothing new", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const items = [messageItem({ public_id: contextId("m1"), message: { content: "one" } })];
      const parsed = await drive(fixture.datasetRoot, [
        ...setup(),
        op("appendMessages", appendRequest(ALPHA, "sess-a", items)),
        op("appendMessages", appendRequest(ALPHA, "sess-a", items)),
      ]);
      expect(parsed.op3.value.results[0].outcome).toBe("accepted");
      const replay = parsed.op4.value;
      expect(replay.outcome).toBe("complete");
      expect(replay.results[0].outcome).toBe("idempotent");
      // The ORIGINAL allocated state, not a fresh allocation or a new clock.
      expect(replay.results[0].row.id).toBe("1");
      expect(replay.results[0].row.seq_in_session).toBe("1");
      expect(replay.results[0].row.ingested_at).toBe(parsed.op3.value.results[0].row.ingested_at);
      // Exactly one durable row, and no extra boundary for the replay.
      expect(parsed.persistedMessages).toEqual([contextId("m1")]);
      expect(parsed.trace.filter((b: string) => b === "before_write")).toHaveLength(4);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("item 0 is durable, item 1 stops the batch, item 2 is NEVER attempted", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const items = [
        messageItem({ public_id: contextId("ok1"), message: { content: "one" } }),
        // Unknown peer: a reference failure, raised per item so it can produce
        // a durable prefix rather than rejecting the whole request.
        messageItem({ public_id: contextId("bad"), message: { peer_name: "ghost", content: "two" } }),
        messageItem({ public_id: contextId("never"), message: { content: "three" } }),
      ];
      const parsed = await drive(fixture.datasetRoot, [
        ...setup(),
        op("appendMessages", appendRequest(ALPHA, "sess-a", items)),
      ]);
      const batch = parsed.op3.value;
      expect(batch.outcome).toBe("stopped");
      // The prefix is KEPT: a durable write is not discarded because a later
      // item failed.
      expect(batch.results).toHaveLength(1);
      expect(batch.results[0].index).toBe(0);
      expect(batch.stop.index).toBe(1);
      // stop.error is the EXACT safe wire envelope: four keys, and no `name`.
      expect(Object.keys(batch.stop.error).sort()).toEqual(["code", "message", "path", "version"]);
      expect(batch.stop.error.version).toBe("arra-publication-error/v1");
      expect(batch.stop.error.code).toBe("invalid_reference");
      expect(batch.stop.error.path).toBe("/items/1/message/peer_name");
      // Item 2 was never attempted.
      expect(parsed.persistedMessages).toEqual([contextId("ok1")]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a changed payload under the same public_id is a CONFLICT, not an error", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const first = [messageItem({ public_id: contextId("m1"), message: { content: "one" } })];
      const changed = [messageItem({ public_id: contextId("m1"), message: { content: "DIFFERENT" } })];
      const parsed = await drive(fixture.datasetRoot, [
        ...setup(),
        op("appendMessages", appendRequest(ALPHA, "sess-a", first)),
        op("appendMessages", appendRequest(ALPHA, "sess-a", changed)),
      ]);
      const batch = parsed.op4.value;
      expect(batch.outcome).toBe("stopped");
      // The stop union is CLOSED: a conflict variant carries no error.
      expect(batch.stop).toEqual({ index: 0, conflict: "public_id" });
      expect(batch.results).toEqual([]);
      // A returned conflict is not an ambiguous write, so the owner stays
      // usable and nothing was overwritten.
      expect(parsed.persistedMessages).toEqual([contextId("m1")]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a self reply is refused, and a reply to an earlier item resolves", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const good = [
        messageItem({ public_id: contextId("p1"), message: { content: "parent" } }),
        messageItem({ public_id: contextId("c1"), message: { content: "child", in_reply_to: contextId("p1") } }),
      ];
      const selfLink = [
        messageItem({ public_id: contextId("s1"), message: { content: "x", in_reply_to: contextId("s1") } }),
      ];
      const parsed = await drive(fixture.datasetRoot, [
        ...setup(),
        op("appendMessages", appendRequest(ALPHA, "sess-a", good)),
        op("appendMessages", appendRequest(ALPHA, "sess-a", selfLink)),
      ]);
      // An earlier DURABLY accepted item may be referenced within the batch.
      expect(parsed.op3.value.outcome).toBe("complete");
      expect(parsed.op3.value.results[1].row.in_reply_to).toBe(contextId("p1"));

      const selfBatch = parsed.op4.value;
      expect(selfBatch.outcome).toBe("stopped");
      expect(selfBatch.stop.error.code).toBe("invalid_request");
      expect(selfBatch.stop.error.path).toBe("/items/0/message/in_reply_to");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});

describe("core: the sourced path and the reader bundle", () => {
  /**
   * Deliberately NOT the ownership lane's collision oracle or the recovery
   * lane's durability oracle. These are the core semantics that belong to the
   * kernel itself: namespace configuration, sourced replay identity, governed
   * scope_mismatch, and the read-only bundle shape.
   */
  const CHILD = new URL("./fixtures/context-v1/core/gated-context.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
  const ALPHA = "alpha-workspace";

  const drive = async (
    root: string,
    ops: Array<{ method: string; request: unknown }>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 600)}`);
    return JSON.parse(line);
  };
  // #87 / R3: message reads take the transport-built authority; these lanes
  // read through the audit:read operator view unless a test says otherwise.
  const op = (method: string, request: unknown, authority: unknown = OPERATOR) => ({ method, request, authority });
  const setup = () => [
    op("registerPeer", peerRequest(ALPHA)),
    op("registerSession", sessionRequest(ALPHA)),
    op("joinSession", joinRequest(ALPHA)),
  ];

  test("a configured namespace produces a sourced row with a recomputed digest", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const items = [sourcedItem("src-1", { public_id: contextId("m1") })];
      const parsed = await drive(
        fixture.datasetRoot,
        [...setup(), op("appendMessages", appendRequest(ALPHA, "sess-a", items))],
        { sourceNamespace: "ns-a" },
      );
      const row = parsed.op3.value.results[0].row;
      expect(parsed.op3.value.outcome).toBe("complete");
      // The namespace comes from trusted CONFIGURATION, never from the request.
      expect(row.source_namespace).toBe("ns-a");
      expect(row.source_message_id).toBe("src-1");
      // The digest is RECOMPUTED by the governed boundary, not supplied.
      expect(row.source_payload_digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a sourced replay returns the ORIGINAL identity and allocates nothing", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const first = [sourcedItem("src-1", { public_id: contextId("m1") })];
      // A DIFFERENT, unoccupied proposal on replay is ignored: the source
      // tuple is the anchor, not the proposed public_id.
      const replay = [sourcedItem("src-1", { public_id: contextId("other") })];
      const parsed = await drive(
        fixture.datasetRoot,
        [
          ...setup(),
          op("appendMessages", appendRequest(ALPHA, "sess-a", first)),
          op("appendMessages", appendRequest(ALPHA, "sess-a", replay)),
        ],
        { sourceNamespace: "ns-a" },
      );
      const replayed = parsed.op4.value;
      expect(replayed.outcome).toBe("complete");
      expect(replayed.results[0].outcome).toBe("idempotent");
      expect(replayed.results[0].row.public_id).toBe(contextId("m1"));
      expect(replayed.results[0].row.id).toBe("1");
      // One durable row, and the alternate proposal never became one.
      expect(parsed.persistedMessages).toEqual([contextId("m1")]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a replay into the WRONG session is a governed scope_mismatch", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [
          ...setup(),
          op("registerSession", sessionRequest(ALPHA, { session_id: contextId("sess2"), name: "sess-b" })),
          op("joinSession", joinRequest(ALPHA, { session_name: "sess-b" })),
          op("appendMessages", appendRequest(ALPHA, "sess-a", [sourcedItem("src-1", { public_id: contextId("m1") })])),
          // Same source tuple, different destination.
          op("appendMessages", appendRequest(ALPHA, "sess-b", [sourcedItem("src-1", { public_id: contextId("m1") })])),
        ],
        { sourceNamespace: "ns-a" },
      );
      const wrong = parsed.op6.value;
      expect(wrong.outcome).toBe("stopped");
      // Destination outranks payload, and it keeps the GOVERNED envelope:
      // scope_mismatch is an accepted replay outcome, not a persistence error.
      expect(wrong.stop.error.version).toBe("arra-error/v1");
      expect(wrong.stop.error.code).toBe("scope_mismatch");
      expect(wrong.stop.error.path).toBe("/items/0/existing/session_name");
      // The MESSAGE is part of the envelope too. Asserting only
      // version/code/path is how an invented message survived here: the
      // accepted codec's literal must be preserved, not paraphrased.
      expect(wrong.stop.error.message).toBe("existing message is in a different session");
      // The stop union is closed: four wire keys, and no `name`.
      expect(Object.keys(wrong.stop.error).sort()).toEqual(["code", "message", "path", "version"]);
      expect(parsed.persistedMessages).toEqual([contextId("m1")]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a LOCAL replay into the wrong session carries the SAME governed envelope", async () => {
    // Local and sourced wrong-destination share semantics, so they must share
    // the exact error -- including its message.
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ...setup(),
        op("registerSession", sessionRequest(ALPHA, { session_id: contextId("sess2"), name: "sess-b" })),
        op("joinSession", joinRequest(ALPHA, { session_name: "sess-b" })),
        op("appendMessages", appendRequest(ALPHA, "sess-a", [messageItem({ public_id: contextId("m1") })])),
        // Same public_id, different destination session.
        op("appendMessages", appendRequest(ALPHA, "sess-b", [messageItem({ public_id: contextId("m1") })])),
      ]);
      const wrong = parsed.op6.value;
      expect(wrong.outcome).toBe("stopped");
      expect(Object.keys(wrong.stop.error).sort()).toEqual(["code", "message", "path", "version"]);
      expect(wrong.stop.error.version).toBe("arra-error/v1");
      expect(wrong.stop.error.code).toBe("scope_mismatch");
      expect(wrong.stop.error.path).toBe("/items/0/existing/session_name");
      expect(wrong.stop.error.message).toBe("existing message is in a different session");
      expect(parsed.persistedMessages).toEqual([contextId("m1")]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("the READER bundle has exactly three facades and twenty context methods", async () => {
    const fixture = await createContextFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [op("registerPeer", peerRequest(ALPHA))],
        { freshReader: true },
      );
      expect(parsed.readerKeys).toEqual(["context", "publication", "taxonomy"]);
      // Exactly the twenty READ methods (#30's two searches and, from
      // search-embed R7/R8, getSearchFreshness included; overnight R18's
      // listSessionMembers too); no mutator -- embedPendingChunks and
      // closeSession included -- reachable from a reader.
      expect(parsed.readerContextMethods).toEqual([
        "getContext", "getMessage", "getPeer", "getReadCursor", "getRecallEligibility", "getSearchFreshness", "getSession", "getTrace",
        "listConnections", "listLifecycleHistory", "listMcpCalls", "listMessages", "listPeers", "listSearchChunks", "listSessionLinks", "listSessionMembers", "listSessions",
        "listTraceHits", "searchKnowledgeKeyword", "searchKnowledgeSemantic",
      ]);
      // A gateless reader works AFTER the writer released its gate.
      expect(parsed.freshReaderPeer.name).toBe("peer-a");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});
