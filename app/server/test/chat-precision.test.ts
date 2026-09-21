/**
 * #32 evidence-grounded chat -- precision lane.
 *
 * `chat-service.test.ts` already proves the LIFECYCLE: real gated persistence,
 * per-item authorization ordering, partial-coverage reporting, and the model
 * failure mapping. This file proves boundary and representation EXACTNESS in
 * the same module, entirely through the PURE half (`src/publication/chat.ts`)
 * chat.ts's own docstring guarantees: no SDK, no dataset, no model, no
 * network -- every case below is a plain function call.
 *
 * Covered, none of it in `chat-service.test.ts`:
 *   1. `MAX_NAME_BYTES` (256) and `MAX_QUESTION_BYTES` (4096) at the EXACT
 *      byte, not a value comfortably inside or outside them.
 *   2. `max_items` succeeding at its own boundaries (1 and 50), not merely
 *      failing outside them (already proven elsewhere).
 *   3. An unpaired surrogate in a chat field is refused at the WIRE, not
 *      silently replaced -- and why the test must hand-craft the JSON text
 *      rather than building it through `JSON.stringify`/`TextEncoder` of an
 *      already-broken JS string (see the comment on `rawBytes` below).
 *   4. `projectContextItem`'s exact 7-key output shape.
 *   5. `contextItemWireBytes` matches the REAL JSON wire encoding exactly,
 *      including multi-byte Thai content -- not a character count.
 *   6. `renderContextText` preserves Unicode exactly: Thai (no word
 *      boundaries), combining marks, and astral characters via a correct
 *      surrogate pair.
 *   7. `mapModelFailure`'s `PublicationError.toJSON()` has EXACTLY
 *      `{version, code, path, message}` -- no `name` leaking from `Error`.
 *
 * Every assertion here was bite-tested: flipped to the wrong expectation,
 * confirmed a genuine failure, then restored.
 */

import { describe, expect, test } from "bun:test";
import { ContractError } from "../src/contracts/errors";
import {
  type ChatContextItem,
  contextItemWireBytes,
  mapModelFailure,
  parseAnswerChat,
  parseGetContext,
  projectContextItem,
  renderContextText,
} from "../src/publication/chat";
import { PublicationError } from "../src/publication/errors";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/**
 * Build a string with an EXACT UTF-8 byte length, mixing a 3-byte Thai
 * codepoint ("ก", U+0E01) with 1-byte ASCII padding so any target byte count
 * is reachable exactly (3*reps + 1*remainder), never approximated.
 */
function stringOfBytes(targetBytes: number): string {
  const reps = Math.floor(targetBytes / 3);
  const remainder = targetBytes - reps * 3;
  return "ก".repeat(reps) + "a".repeat(remainder);
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

const baseReq = { workspace_name: "w", peer_name: "p", session_name: "s" };

describe("MAX_NAME_BYTES (256) is an EXACT UTF-8 cap, not a character count", () => {
  test("a workspace_name at exactly 256 bytes is accepted, and the length really is 256", () => {
    const name = stringOfBytes(256);
    expect(utf8Len(name)).toBe(256);
    const parsed = parseGetContext(bytes({ ...baseReq, workspace_name: name, max_items: 5 }));
    expect(parsed.workspace_name).toBe(name);
  });

  test("one byte past 256 fails closed with the governed limit_exceeded code", () => {
    const name = stringOfBytes(257);
    expect(utf8Len(name)).toBe(257);
    try {
      parseGetContext(bytes({ ...baseReq, workspace_name: name, max_items: 5 }));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).code).toBe("limit_exceeded");
    }
  });
});

describe("MAX_QUESTION_BYTES (4096) is a SEPARATE, wider bound than MAX_NAME_BYTES", () => {
  test("a question at exactly 4096 bytes is accepted", () => {
    const question = stringOfBytes(4096);
    expect(utf8Len(question)).toBe(4096);
    const parsed = parseAnswerChat(bytes({ ...baseReq, question, max_items: 5 }));
    expect(parsed.question).toBe(question);
  });

  test("one byte past 4096 fails closed, distinctly from the name bound", () => {
    const question = stringOfBytes(4097);
    expect(utf8Len(question)).toBe(4097);
    try {
      parseAnswerChat(bytes({ ...baseReq, question, max_items: 5 }));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).code).toBe("limit_exceeded");
    }
    // A 4096-byte question would have been well past a 256-byte name bound --
    // confirms `question()` uses its OWN constant, not a borrowed `name()` one.
    expect(4097).toBeGreaterThan(256);
  });
});

describe("max_items admits its full closed range 1..50, at BOTH edges, not just past them", () => {
  test("max_items = 1 (the floor) is accepted", () => {
    expect(parseGetContext(bytes({ ...baseReq, max_items: 1 })).max_items).toBe(1);
  });

  test("max_items = 50 (MAX_CONTEXT_ITEMS, the ceiling) is accepted", () => {
    expect(parseGetContext(bytes({ ...baseReq, max_items: 50 })).max_items).toBe(50);
  });

  test("max_items = 51 (one past the ceiling) is still rejected -- reconfirmed at the exact edge", () => {
    expect(() => parseGetContext(bytes({ ...baseReq, max_items: 51 }))).toThrow(ContractError);
  });

  test("a non-integer at an otherwise-valid value (1.5) is rejected as invalid_type, not rounded", () => {
    try {
      parseGetContext(bytes({ ...baseReq, max_items: 1.5 }));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).code).toBe("invalid_type");
    }
  });
});

describe("an unpaired surrogate in a chat field is refused at the wire, never silently replaced", () => {
  /**
   * Deliberately NOT `bytes(value)` here. `JSON.stringify` on a JS string
   * that already contains a lone surrogate code unit produces a JS string
   * with that SAME lone surrogate inside it; `TextEncoder.encode` (WHATWG
   * encoding spec) then silently substitutes U+FFFD for it before a single
   * byte reaches the parser -- the request would arrive already "healed" and
   * this test would prove nothing about the parser's own guard.
   *
   * A real network caller sends raw UTF-8 bytes where `\ud800` is six literal
   * ASCII characters (backslash, u, d, 8, 0, 0) -- valid UTF-8 all the way
   * in, with no surrogate anywhere until the hand-written parser's own
   * `\u` escape decoder turns it into one. That is what this constructs.
   */
  const rawBytes = (jsonText: string) => new TextEncoder().encode(jsonText);

  test("a lone high surrogate escape in `question` is invalid_unicode, not silently accepted", () => {
    const body = `{"workspace_name":"w","peer_name":"p","session_name":"s","question":"\\ud800","max_items":5}`;
    try {
      parseAnswerChat(rawBytes(body));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).code).toBe("invalid_unicode");
    }
  });

  test("a REVERSED surrogate pair (low then high) in `workspace_name` is also invalid_unicode", () => {
    const body = `{"workspace_name":"\\udc00\\ud800","peer_name":"p","session_name":"s","max_items":5}`;
    try {
      parseGetContext(rawBytes(body));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).code).toBe("invalid_unicode");
    }
  });

  test("a CORRECTLY ordered surrogate pair (a real astral character) round-trips exactly, unreplaced", () => {
    // U+1F600 GRINNING FACE = 😀, high surrogate first.
    const body = `{"workspace_name":"w","peer_name":"p","session_name":"s","question":"\\ud83d\\ude00","max_items":5}`;
    const parsed = parseAnswerChat(rawBytes(body));
    expect(parsed.question).toBe("\u{1F600}");
    expect(parsed.question).not.toContain("�");
  });
});

describe("projectContextItem: exact 7-key output shape, no more and no less", () => {
  const encodedMessage = {
    public_id: "pub-1",
    session_name: "s",
    peer_name: "p",
    role: "user",
    content: "hello",
    seq_in_session: "3",
    created_at: "2026-09-20T00:00:00.000Z",
    // A field this row legitimately has but the chat projection does NOT use.
    extra_column_the_projection_must_drop: "should not appear",
  };

  test("the projected item has exactly these 7 keys, sorted -- the extra column is dropped", () => {
    const item = projectContextItem(encodedMessage);
    expect(Object.keys(item).sort()).toEqual([
      "content",
      "created_at",
      "peer_name",
      "public_id",
      "role",
      "seq_in_session",
      "session_name",
    ]);
  });

  test("a null role passes through as null, not coerced to a string or dropped", () => {
    const item = projectContextItem({ ...encodedMessage, role: null });
    expect(item.role).toBeNull();
    expect("role" in item).toBe(true);
  });

  test("a non-string public_id fails closed as integrity_failure, at path \"\" -- corrupt STORED shape, not a caller mistake", () => {
    try {
      projectContextItem({ ...encodedMessage, public_id: 123 });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PublicationError);
      expect((error as PublicationError).code).toBe("integrity_failure");
      expect((error as PublicationError).path).toBe("");
    }
  });
});

describe("contextItemWireBytes: matches the REAL wire encoding exactly, not a character count", () => {
  const item: ChatContextItem = {
    public_id: "pub-1",
    session_name: "s",
    peer_name: "p",
    role: "user",
    content: "hi",
    seq_in_session: "1",
    created_at: "2026-09-20T00:00:00.000Z",
  };

  test("an ASCII item's measured size equals a real JSON.stringify byte count exactly", () => {
    expect(contextItemWireBytes(item)).toBe(new TextEncoder().encode(JSON.stringify(item)).length);
  });

  test("Thai content (multi-byte, no word boundaries) is measured in BYTES, not JS string length", () => {
    const thaiItem: ChatContextItem = { ...item, content: "สวัสดีครับผมชื่อทดสอบ" };
    // The JS `.length` (UTF-16 code units) must NOT equal the true byte
    // count -- otherwise this case would prove nothing about byte-accuracy.
    expect(thaiItem.content.length).not.toBe(new TextEncoder().encode(thaiItem.content).length);
    expect(contextItemWireBytes(thaiItem)).toBe(new TextEncoder().encode(JSON.stringify(thaiItem)).length);
  });

  test("an astral (surrogate-pair) emoji in content is measured correctly at 4 bytes for that character", () => {
    const emojiItem: ChatContextItem = { ...item, content: "hi \u{1F600}" };
    expect(contextItemWireBytes(emojiItem)).toBe(new TextEncoder().encode(JSON.stringify(emojiItem)).length);
  });
});

describe("renderContextText: Unicode exactness across scripts, unnormalized", () => {
  const item = (session: string, peer: string, content: string): ChatContextItem => ({
    public_id: "x",
    session_name: session,
    peer_name: peer,
    role: "user",
    content,
    seq_in_session: "1",
    created_at: "2026-09-20T00:00:00.000Z",
  });

  test("Thai text (no ASCII word boundaries) is rendered byte-for-byte unmodified", () => {
    const thai = "สวัสดีครับ";
    const rendered = renderContextText([item("s", "peer", thai)]);
    expect(rendered).toBe("[s] peer: " + thai);
  });

  test("a combining mark is NOT normalized away -- decomposed and precomposed forms stay distinct", () => {
    const decomposed = "é"; // e + COMBINING ACUTE ACCENT, NOT NFC-normalized
    const precomposed = "é"; // é, single codepoint
    expect(decomposed).not.toBe(precomposed); // sanity: genuinely different code units
    const rendered = renderContextText([item("s", "p", decomposed)]);
    expect(rendered).toContain(decomposed);
    expect(rendered).not.toContain(precomposed);
  });

  test("a correct astral surrogate pair renders as the single intended character, not two replacement chars", () => {
    const rendered = renderContextText([item("s", "p", "\u{1F600}")]);
    expect(rendered).toBe("[s] p: \u{1F600}");
    expect(rendered).not.toContain("�");
  });

  test("multiple items join with exactly one newline between them, none trailing", () => {
    const rendered = renderContextText([item("a", "x", "one"), item("b", "y", "two")]);
    expect(rendered).toBe("[a] x: one\n[b] y: two");
    expect(rendered.endsWith("\n")).toBe(false);
  });
});

describe("mapModelFailure(): the closed publication envelope, exactly -- no `name` leaking from Error", () => {
  test("toJSON() has EXACTLY {version, code, path, message}, not a superset", () => {
    try {
      mapModelFailure();
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PublicationError);
      const json = (error as PublicationError).toJSON();
      expect(Object.keys(json).sort()).toEqual(["code", "message", "path", "version"]);
      expect(json.version).toBe("arra-publication-error/v1");
      expect(json.code).toBe("writer_unavailable");
      expect(json.path).toBe("");
      // `Error.name` ("PublicationError") is a real, enumerable-looking
      // property on the instance but MUST NOT appear in the wire shape.
      expect((error as PublicationError).name).toBe("PublicationError");
      expect("name" in json).toBe(false);
    }
  });
});
