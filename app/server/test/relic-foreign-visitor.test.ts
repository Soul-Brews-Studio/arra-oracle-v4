/**
 * #28 TODO "exclude cwd-only foreign visitors" -- the NEGATIVE invariant the
 * design text defines, pinned where it could break.
 *
 * Defining text (quoted in full in docs/overnight/FOREIGN-VISITOR.md):
 *  - discussion #20 section 10: "A visitor session sharing cwd does not become
 *    part of the worktree's original lineage."
 *  - discussion #36 / DESIGN.md: "A cwd move does not transfer session
 *    ownership. External references must not silently import a foreign
 *    session or bridge workspaces." ... "shared cwd does not justify importing
 *    Ansible."
 *  - issue #28 Boundaries: "No ... automatic session ownership inference."
 *
 * So a visitor is excluded by never letting a shared directory DECIDE
 * anything: not which sessions are "the same", not a relic_session identity,
 * not a lineage edge, not ownership, not an import. There is deliberately NO
 * visitor classifier here -- relic's rows carry nothing but cwd-derived
 * fields to classify on, and inferring ownership is out of #28's scope.
 *
 * The directory is NOT erased, though. `transcriptRef` is relic's
 * `file_path`, whose parent folder is the cwd-derived project folder, and
 * `buildRelicEventTarget` copies it into `relic_event.transcript_ref` -- an
 * IDENTITY key (evidence-v1.ts TARGET_KEYS; DISPLAY_ONLY exempts only
 * relic_session.title_snapshot). The last describe block pins that too, so
 * the contract cannot again claim "the directory is dropped".
 *
 * Every Relic call goes to the FAKE binary (test/fixtures/relic-v1/fake-relic.ts);
 * the real relic index is never opened. No dataset is touched.
 *
 * Contract: app/docs/contracts/session-source-relic-v1.md, amendment 2026-09-26.
 */

import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { ContractError } from "../src/contracts/errors";
import { targetOp } from "../src/contracts/evidence-v1";
import { obj } from "../src/contracts/jcs";
import { parseRegisterSession } from "../src/publication/context.parseRegisterSession";
import { parseCreateSessionLink } from "../src/publication/session-link";
import { buildRelicEventTarget } from "../src/source/relic.buildRelicEventTarget";
import { buildRelicSessionTarget } from "../src/source/relic.buildRelicSessionTarget";
import { createRelicSessionSource } from "../src/source/relic.createRelicSessionSource";
import type { RelicAdapterConfig } from "../src/source/relic.types";
import type { SessionRef, SourceExcerpt } from "../src/source/session-source.types";

const FAKE_BIN = new URL("./fixtures/relic-v1/fake-relic.ts", import.meta.url).pathname;
const config: RelicAdapterConfig = { binPath: FAKE_BIN, timeoutMs: 5_000, maxOutputBytes: 4 * 1024 * 1024 };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
/** The directory both fake sessions ran in, as relic's cwd-derived repo key. */
const SHARED_REPO_KEY = "github.com/example/neo-oracle";
/** The same directory as it appears in relic's `file_path`: the dash-encoded
 *  project folder. `SHARED_REPO_KEY` alone cannot see this form. */
const SHARED_FOLDER = "-opt-Code-github-com-example-neo-oracle";
/** The exact SessionRef key set, on BOTH the find() and the get() path. */
const SESSION_REF_KEYS = ["endedAt", "provider", "sessionUuid", "sourceBank", "startedAt", "title", "transcriptRef"];
const CWD = "/opt/Code/github.com/example/neo-oracle";
/** The pointer a refusal names -- so a test cannot pass on some OTHER field's error. */
const refusalPath = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContractError) return error.path;
    throw error;
  }
  throw new Error("expected a ContractError, got none");
};

describe("#28 cwd-only foreign visitor: the Relic adapter never groups or identifies sessions by the shared directory", () => {
  test("an owner and a visitor that ran in one directory stay two sessions -- never merged on the cwd key", async () => {
    const refs = await createRelicSessionSource(config).find("__shared_cwd__", 10);
    expect(refs.map((ref) => ref.sessionUuid)).toEqual(["s-owner", "s-visitor"]);
    const [owner, visitor] = refs.map(buildRelicSessionTarget);
    expect(owner).not.toEqual(visitor);
  });

  test("find(): no repo/cwd/worktree key on a SessionRef, and the directory is not in its relic_session identity", async () => {
    const [owner, visitor] = await createRelicSessionSource(config).find("__shared_cwd__", 10);
    for (const ref of [owner!, visitor!]) {
      // Exactly these keys: no repo, cwd or worktree KEY. (`transcriptRef`
      // still carries the project folder as a locator -- see the last block.)
      expect(Object.keys(ref).sort()).toEqual(SESSION_REF_KEYS);
      // The bank is the source root only (`projects`), not `<bank>/<repo_key>`.
      expect(ref.sourceBank).toBe("projects");
      // Both spellings of the directory: relic's repo key and the folder.
      const { key_json } = targetOp("alpha", "relic_session", obj(buildRelicSessionTarget(ref)));
      expect(key_json).not.toContain(SHARED_REPO_KEY);
      expect(key_json).not.toContain(SHARED_FOLDER);
    }
  });

  test("get(): the session-row path builds the same SessionRef key set and the same bank-only sourceBank", async () => {
    // relic.rowToSessionRef.ts is a second, separate mapping from find()'s
    // hitToRef -- a repo key added there must not slip past this file.
    const ref = await createRelicSessionSource(config).get("s-normal-1");
    expect(ref).not.toBeNull();
    expect(Object.keys(ref!).sort()).toEqual(SESSION_REF_KEYS);
    expect(ref!.sourceBank).toBe("projects");
  });
});

describe("#28 cwd-only foreign visitor: no v4 grammar accepts a directory as lineage or ownership", () => {
  const link = {
    id: "L1StGXR8_Z5jdHi6B-myT",
    workspace_name: "alpha",
    from_session_name: "visitor-session",
    to_session_name: "owner-session",
    relation: "continues",
    evidence_ref: null,
    created_by_peer_name: null,
  };

  test("control: the same link without a cwd parses", () => {
    expect(parseCreateSessionLink(bytes(link)).relation).toBe("continues");
  });

  test("createSessionLink refuses a cwd key -- a shared directory is not evidence of continuation", () => {
    expect(refusalPath(() => parseCreateSessionLink(bytes({ ...link, cwd: CWD })))).toBe("/cwd");
  });

  const session = { workspace_name: "alpha", session_id: "V1StGXR8_Z5jdHi6B-myT", name: "visitor-session" };

  test("control: the same session without a cwd parses", () => {
    expect(parseRegisterSession(bytes(session)).name).toBe("visitor-session");
  });

  test("registerSession refuses a cwd key, top level or inside h_metadata -- a session is never filed by directory", () => {
    expect(refusalPath(() => parseRegisterSession(bytes({ ...session, cwd: CWD })))).toBe("/cwd");
    expect(refusalPath(() => parseRegisterSession(bytes({ ...session, h_metadata: { title: "t", cwd: CWD } })))).toBe(
      "/h_metadata/cwd",
    );
  });
});

describe("#28 cwd-only foreign visitor: what the directory still reaches -- the transcript locator", () => {
  const excerptFor = (ref: SessionRef): SourceExcerpt => ({
    eventSeq: 3,
    speaker: "assistant",
    content: "same words, same second",
    sourceTime: "2026-09-16T10:00:00.000Z",
    transcriptRef: ref.transcriptRef,
  });
  const eventKey = (ref: SessionRef, transcriptRef = ref.transcriptRef) =>
    targetOp("alpha", "relic_event", obj({ ...buildRelicEventTarget(ref, excerptFor(ref)), transcript_ref: transcriptRef }));

  test("transcriptRef is relic's file_path, so owner and visitor carry the one cwd-derived project folder", async () => {
    const [owner, visitor] = await createRelicSessionSource(config).find("__shared_cwd__", 10);
    expect(owner!.transcriptRef).toContain(`/${SHARED_FOLDER}/`);
    expect(dirname(owner!.transcriptRef)).toBe(dirname(visitor!.transcriptRef));
  });

  test("relic_event.transcript_ref carries that folder and IS part of relic_event identity (a passive locator, not display-only)", async () => {
    const [owner] = await createRelicSessionSource(config).find("__shared_cwd__", 10);
    expect(buildRelicEventTarget(owner!, excerptFor(owner!)).transcript_ref).toContain(SHARED_FOLDER);
    const here = eventKey(owner!);
    expect(here.key_json).toContain(SHARED_FOLDER);
    // Moving ONLY the folder changes the key: the directory is an identity input.
    const moved = eventKey(owner!, owner!.transcriptRef.replace(SHARED_FOLDER, "-opt-Code-github-com-example-elsewhere"));
    expect(moved.target_key).not.toBe(here.target_key);
  });

  test("the shared folder never merges events: owner and visitor at the same seq, words and second stay two targets", async () => {
    const [owner, visitor] = await createRelicSessionSource(config).find("__shared_cwd__", 10);
    expect(eventKey(owner!).target_key).not.toBe(eventKey(visitor!).target_key);
  });
});
