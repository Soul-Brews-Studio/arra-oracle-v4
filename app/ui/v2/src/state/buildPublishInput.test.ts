/** Failing-first: wave 5 hardening (#33) found NO test drove PublishForm's
 *  submit and read the payload, so mutant M4 (PublishForm.tsx:50 `links:
 *  built.entries` -> `links: []`) left every test green. `buildPublishInput`
 *  is the extracted, directly-callable payload builder PublishForm's submit
 *  now delegates to (see PublishForm.tsx); this test pins that the built
 *  link entries actually reach the outgoing draft. */
import { describe, expect, test } from "bun:test";
import { buildPublishInput, type PublishFormFields } from "./buildPublishInput";

const FIELDS: PublishFormFields = {
  title: "port note",
  body: "the port is 47778",
  bodyFormat: "text",
  typeTerm: "note",
  horizon: "none",
  changeReason: "",
};

const LINK = {
  position: "0",
  relation: "supports" as const,
  target_kind: "url" as const,
  target: { url: "https://example.com" },
  excerpt: null,
  content_hash: null,
  captured_at: null,
  capture_status: "locator_only" as const,
  note: null,
};

describe("buildPublishInput", () => {
  test("carries the link editor's built entries into the publish payload", () => {
    const draft = buildPublishInput(FIELDS, [LINK]);
    expect(draft.links).toEqual([LINK]);
  });

  test("an empty link set stays empty (no link editor rows drafted)", () => {
    const draft = buildPublishInput(FIELDS, []);
    expect(draft.links).toEqual([]);
  });

  test("horizon 'none' and an empty change reason map to null, not the sentinel string", () => {
    const draft = buildPublishInput(FIELDS, []);
    expect(draft.horizon).toBeNull();
    expect(draft.change_reason).toBeNull();
  });
});
