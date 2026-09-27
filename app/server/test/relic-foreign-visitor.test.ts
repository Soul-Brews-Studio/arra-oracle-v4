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
 * So a visitor is excluded by never letting a shared directory decide
 * anything: not a session's identity, not which sessions are "the same", not
 * a lineage edge, not a session's fields. There is deliberately NO visitor
 * classifier here -- relic's rows carry nothing but cwd-derived fields to
 * classify on, and inferring ownership is out of #28's scope.
 *
 * Every Relic call goes to the FAKE binary (test/fixtures/relic-v1/fake-relic.ts);
 * the real relic index is never opened. No dataset is touched.
 *
 * Contract: app/docs/contracts/session-source-relic-v1.md, amendment 2026-09-26.
 */

import { describe, expect, test } from "bun:test";
import { ContractError } from "../src/contracts/errors";
import { parseRegisterSession } from "../src/publication/context.parseRegisterSession";
import { parseCreateSessionLink } from "../src/publication/session-link";
import { buildRelicSessionTarget } from "../src/source/relic.buildRelicSessionTarget";
import { createRelicSessionSource } from "../src/source/relic.createRelicSessionSource";
import type { RelicAdapterConfig } from "../src/source/relic.types";

const FAKE_BIN = new URL("./fixtures/relic-v1/fake-relic.ts", import.meta.url).pathname;
const config: RelicAdapterConfig = { binPath: FAKE_BIN, timeoutMs: 5_000, maxOutputBytes: 4 * 1024 * 1024 };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
/** The directory both fake sessions ran in, as relic's cwd-derived repo key. */
const SHARED_REPO_KEY = "github.com/example/neo-oracle";
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

describe("#28 cwd-only foreign visitor: the Relic adapter never uses the shared directory", () => {
  test("an owner and a visitor that ran in one directory stay two sessions -- never merged on the cwd key", async () => {
    const refs = await createRelicSessionSource(config).find("__shared_cwd__", 10);
    expect(refs.map((ref) => ref.sessionUuid)).toEqual(["s-owner", "s-visitor"]);
    const [owner, visitor] = refs.map(buildRelicSessionTarget);
    expect(owner).not.toEqual(visitor);
  });

  test("the cwd-derived repo key is not part of a SessionRef or of its relic_session identity", async () => {
    const [owner, visitor] = await createRelicSessionSource(config).find("__shared_cwd__", 10);
    for (const ref of [owner!, visitor!]) {
      // Exactly these fields: no repo, cwd, worktree or project field exists
      // for a later caller to group, scope or chain sessions on.
      expect(Object.keys(ref).sort()).toEqual(
        ["endedAt", "provider", "sessionUuid", "sourceBank", "startedAt", "title", "transcriptRef"],
      );
      // The bank is the source root only (`projects`), not `<bank>/<repo_key>`.
      expect(ref.sourceBank).toBe("projects");
      const identity = JSON.stringify(buildRelicSessionTarget(ref));
      expect(identity).not.toContain(SHARED_REPO_KEY);
    }
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
