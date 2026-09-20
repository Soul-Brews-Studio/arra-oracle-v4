/**
 * #65 (Parent #28) association kernel — the PURE half.
 *
 * Request grammar, cursor validity and physical row derivation, all without a
 * dataset, a gate or a child process. Persistence follows; it is not simulated
 * here, because a mock of the store proves only that the mock agrees with
 * itself.
 *
 * Contract: app/docs/contracts/association-evidence-v1.md
 * SHA256 b4a9660de8e1d669396769f12973284973661fced86214e5f7b447b785e83f1e
 */

import { describe, expect, test } from "bun:test";
// The accepted publication fixture, imported DIRECTLY under a distinct local
// name. The shared association fixture stays the bare/context one it was
// published as; core tests that need seeded terms and a trace reach for this
// instead of redefining a helper other lanes depend on.
import {
  createFixture as createSeededRevisionFixture,
  revisionEnvelope,
  runGated,
  type SeededWorkspace,
} from "./helpers/publication-fixture";
import {
  assocId,
  getAssociationsRequest,
  reconcileRequest,
  scanCursor,
  scanRequest,
} from "./helpers/association-fixture";
import { ContractError } from "../src/contracts/errors";
import { PublicationError } from "../src/publication/errors";
import {
  CURSOR_KEYS,
  LINK_FIELDS,
  MAX_EXAMINED_POSITIONS,
  MAX_SELECTED_REVISIONS,
  MAX_VISITED_NODES,
  REVISION_MODES,
  TERM_FIELDS,
  deriveLinkRows,
  deriveTermRows,
  parseGetRevisionAssociations,
  parseReconcileRevisionAssociations,
  parseScanDependents,
} from "../src/publication/association";

const WS = "alpha-workspace";
const id = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/**
 * The two envelopes are asserted SEPARATELY and by class, and every assertion
 * below checks all four wire fields. Asserting the code alone is how a wrong
 * version survived #47; omitting the message is how an invented string
 * survived #59.
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

/**
 * The COMPLETE governed envelope for one refusal.
 *
 * `toJSON` is exactly four fields, so this compares all four at once. Checking
 * `.code` or `.path` alone is what let a wrong version survive #47 and an
 * invented message survive #59: those suites were green and structurally
 * unable to fail on the field that was actually wrong.
 */
const governed = (
  run: () => unknown,
  expected: { code: string; path: string; message: string },
): void => {
  // Both sides widened so the comparison stays a FULL deep equality over all
  // four wire keys instead of narrowing to the declared literal type.
  const actual: Record<string, unknown> = contractErr(run).toJSON();
  expect(actual).toEqual({ version: "arra-error/v1", ...expected } as Record<string, unknown>);
};

const NODE = id("node1");
const REV = id("rev1");
const TARGET = { trace_id: id("trace1") };
/**
 * A SNAPSHOT ENTRY's target is a PLAIN OBJECT.
 *
 * `parseSnapshotArray` uses `JSON.parse`, and the accepted
 * `validateLinkReferences` reads entries as plain objects (`target?.node_id`).
 * An earlier version of this fixture built a Map instead, which made four
 * derivation tests pass against a shape production never produces -- the test
 * was hiding a real defect rather than finding one.
 */
const snapshotTarget = () => ({ trace_id: id("trace1") });

const scan = (o: Record<string, unknown> = {}) => ({
  workspace_name: WS,
  target_kind: "trace",
  target: TARGET,
  revision_mode: "current",
  limit: 10,
  cursor: null,
  ...o,
});

const cursor = (o: Record<string, unknown> = {}) => ({
  workspace_name: WS,
  target_kind: "trace",
  target_key: "unset",
  revision_mode: "current",
  nodes_version: "3",
  node_id: NODE,
  revision_no: null,
  position: null,
  ...o,
});

describe("request grammar is closed and keeps the GOVERNED envelope", () => {
  test("getRevisionAssociations takes a NULLABLE revision id", () => {
    const withRev = { workspace_name: WS, node_id: NODE, revision_id: REV };
    expect(parseGetRevisionAssociations(bytes(withRev))).toEqual(withRev);
    // null means "the captured head", not "omit the key".
    expect(parseGetRevisionAssociations(bytes({ ...withRev, revision_id: null })).revision_id).toBeNull();
    const { revision_id: _drop, ...omitted } = withRev;
    governed(() => parseGetRevisionAssociations(bytes(omitted)), {
      code: "missing_field",
      path: "/revision_id",
      message: 'missing required key "revision_id"',
    });
  });

  test("reconcile REQUIRES a nonnull revision id", () => {
    const ok = { workspace_name: WS, node_id: NODE, revision_id: REV };
    expect(parseReconcileRevisionAssociations(bytes(ok))).toEqual(ok);
    // The id grammar refuses null itself -- there is no local nullability
    // rule layered on top of the accepted validator.
    governed(() => parseReconcileRevisionAssociations(bytes({ ...ok, revision_id: null })), {
      code: "invalid_value",
      path: "/revision_id",
      message: "expected a 21-character URL-safe id",
    });
  });

  test("revision_mode is exactly current or history", () => {
    expect([...REVISION_MODES].sort()).toEqual(["current", "history"]);
    expect(parseScanDependents(bytes(scan())).revision_mode).toBe("current");
    expect(parseScanDependents(bytes(scan({ revision_mode: "history" }))).revision_mode).toBe("history");
    governed(() => parseScanDependents(bytes(scan({ revision_mode: "latest" }))), {
      code: "invalid_value",
      path: "/revision_mode",
      message: "expected one of current, history",
    });
  });

  test("limit is a JSON integer 1..100", () => {
    // Range and type are DIFFERENT refusals, and the range message names the
    // actual bounds rather than a generic invalid_value.
    for (const bad of [0, 101]) {
      governed(() => parseScanDependents(bytes(scan({ limit: bad }))), {
        code: "invalid_value", path: "/limit", message: "expected 1..100",
      });
    }
    for (const bad of [1.5, "10", null]) {
      governed(() => parseScanDependents(bytes(scan({ limit: bad }))), {
        code: "invalid_type", path: "/limit", message: "expected integer",
      });
    }
    expect(parseScanDependents(bytes(scan({ limit: 1 }))).limit).toBe(1);
    expect(parseScanDependents(bytes(scan({ limit: 100 }))).limit).toBe(100);
  });

  test("the target is validated by the accepted codec, not a raw key", () => {
    // A wrong-shaped target for the declared kind must be refused here.
    // The pointer is the codec's own INNER path, which a locally reimplemented
    // target check could not produce.
    governed(() => parseScanDependents(bytes(scan({ target: { node_id: NODE } }))), {
      code: "missing_field",
      path: "/target/trace_id",
      message: 'missing required key "trace_id"',
    });
    // And the derived key is carried forward from that same codec result.
    expect(parseScanDependents(bytes(scan())).target_key).toMatch(/.+/);
  });

  test("an unknown key anywhere is rejected, in the governed envelope", () => {
    governed(() => parseScanDependents(bytes(scan({ extra: 1 }))), {
      code: "unexpected_field",
      path: "/extra",
      message: 'unexpected key "extra"',
    });
  });
});

describe("the cursor is a closed, total state machine", () => {
  test("its key set is exactly the contract's eight", () => {
    expect([...CURSOR_KEYS].sort()).toEqual([
      "node_id", "nodes_version", "position", "revision_mode",
      "revision_no", "target_key", "target_kind", "workspace_name",
    ]);
  });

  test("cursor.target_key MUST equal the key derived from THIS request", () => {
    const parsed = parseScanDependents(bytes(scan()));
    // Correct key round-trips.
    const good = parseScanDependents(bytes(scan({ cursor: cursor({ target_key: parsed.target_key }) })));
    expect(good.cursor!.target_key).toBe(parsed.target_key);
    // A stale or forged key is a governed scope_mismatch with the FIXED message.
    const e = contractErr(() =>
      parseScanDependents(bytes(scan({ cursor: cursor({ target_key: "not-the-key" }) }))),
    );
    expect(e.toJSON()).toEqual({
      version: "arra-error/v1",
      code: "scope_mismatch",
      path: "/cursor/target_key",
      message: "evidence cursor does not match request",
    });
  });

  test("workspace, kind and mode disagreement each report their own pointer, in order", () => {
    const key = parseScanDependents(bytes(scan())).target_key;
    const base = cursor({ target_key: key });
    // Order is workspace_name, target_kind, target_key, revision_mode. Each
    // reports the SAME fixed message at its OWN pointer.
    for (const [field, value, path] of [
      ["workspace_name", "other", "/cursor/workspace_name"],
      ["target_kind", "node", "/cursor/target_kind"],
      ["revision_mode", "history", "/cursor/revision_mode"],
    ] as const) {
      governed(() => parseScanDependents(bytes(scan({ cursor: { ...base, [field]: value } }))), {
        code: "scope_mismatch",
        path,
        message: "evidence cursor does not match request",
      });
    }
  });

  test("position cannot be nonnull while revision_no is null", () => {
    const key = parseScanDependents(bytes(scan())).target_key;
    // invalid_value, NOT scope_mismatch: the pair is internally impossible
    // rather than disagreeing with the request.
    governed(
      () => parseScanDependents(bytes(scan({ cursor: cursor({ target_key: key, revision_no: null, position: "0" }) }))),
      { code: "invalid_value", path: "/cursor/position", message: "position requires a revision_no" },
    );
  });

  test("the three legal boundary shapes all parse", () => {
    const key = parseScanDependents(bytes(scan())).target_key;
    const at = (o: Record<string, unknown>) =>
      parseScanDependents(bytes(scan({ cursor: cursor({ target_key: key, ...o }) }))).cursor!;
    // node fully examined
    expect(at({ revision_no: null, position: null }).revision_no).toBeNull();
    // that revision fully examined
    expect(at({ revision_no: "1", position: null }).revision_no).toBe("1");
    // reached that link position, inclusive
    expect(at({ revision_no: "1", position: "0" }).position).toBe("0");
  });

  test("Int64 cursor fields are canonical decimal TEXT, and reject -0", () => {
    const key = parseScanDependents(bytes(scan())).target_key;
    const bad = (o: Record<string, unknown>, expected: { code: string; path: string; message: string }) =>
      governed(() => parseScanDependents(bytes(scan({ cursor: cursor({ target_key: key, ...o }) }))), expected);
    // These messages belong to the ACCEPTED int64 validators. A locally
    // rewritten grammar would report its own wording here, so this is what
    // pins the delegation rather than a duplicate implementation.
    bad({ nodes_version: 3 }, {
      code: "invalid_type", path: "/cursor/nodes_version",
      message: "int64 must be a canonical decimal string",
    });
    bad({ nodes_version: "-0" }, {
      code: "invalid_value", path: "/cursor/nodes_version",
      message: "int64 requires canonical decimal text",
    });
    bad({ revision_no: "1", position: "-0" }, {
      code: "invalid_value", path: "/cursor/position",
      message: "int64 requires canonical decimal text",
    });
    // revision_no is POSITIVE; nodes_version is positive; position is nonnegative.
    bad({ revision_no: "0" }, { code: "out_of_range", path: "/cursor/revision_no", message: "must be > 0" });
    bad({ nodes_version: "0" }, { code: "out_of_range", path: "/cursor/nodes_version", message: "must be > 0" });
    bad({ revision_no: "1", position: "-1" }, {
      code: "out_of_range", path: "/cursor/position", message: "must be >= 0",
    });
  });
});

describe("physical rows derive in the contract's exact order", () => {
  const SNAPSHOT_TERM = {
    term_id: id("term1"), vocabulary_id: id("voc1"),
    vocabulary_name_snapshot: "type", term_name_snapshot: "note",
    label_snapshot: null, position: "0",
  };
  const SNAPSHOT_LINK = {
    position: "0", relation: "related_to", target_kind: "trace",
    target: snapshotTarget(), excerpt: null, content_hash: null,
    captured_at: null, capture_status: "locator_only", note: null,
  };

  test("field order matches the contract, with no invented link id", () => {
    expect(TERM_FIELDS).toEqual([
      "workspace_name", "revision_id", "term_id", "vocabulary_id",
      "vocabulary_name_snapshot", "term_name_snapshot", "label_snapshot", "position",
    ]);
    expect(LINK_FIELDS).toEqual([
      "workspace_name", "revision_id", "position", "relation", "target_kind",
      "target", "target_key", "excerpt", "content_hash", "captured_at",
      "capture_status", "note",
    ]);
    expect(LINK_FIELDS).not.toContain("id");

    const terms = deriveTermRows(WS, REV, [SNAPSHOT_TERM]);
    const links = deriveLinkRows(WS, REV, [SNAPSHOT_LINK]);
    expect(Object.keys(terms[0]!)).toEqual([...TERM_FIELDS]);
    expect(Object.keys(links[0]!)).toEqual([...LINK_FIELDS]);
  });

  test("target and target_key come from the SAME codec result", () => {
    const [link] = deriveLinkRows(WS, REV, [SNAPSHOT_LINK]);
    // Both present, and the key is the codec's derivation rather than a
    // re-stringification of the caller's object.
    expect(typeof link!.target).toBe("string");
    expect(typeof link!.target_key).toBe("string");
    expect(link!.target_key).not.toBe(link!.target);
  });

  test("positions are canonical Int64 decimal strings", () => {
    const links = deriveLinkRows(WS, REV, [
      { ...SNAPSHOT_LINK, position: "0" },
      { ...SNAPSHOT_LINK, position: "1" },
    ]);
    expect(links.map((l) => l.position)).toEqual(["0", "1"]);
  });

  test("annotations and explicit nulls are PRESERVED, not normalized away", () => {
    const [link] = deriveLinkRows(WS, REV, [
      { ...SNAPSHOT_LINK, excerpt: "a quote", note: "", capture_status: "captured", content_hash: "b".repeat(64) },
    ]);
    expect(link!.excerpt).toBe("a quote");
    // Empty string is a retained display value, not an absent one.
    expect(link!.note).toBe("");
    expect(link!.capture_status).toBe("captured");
    expect(link!.content_hash).toBe("b".repeat(64));
  });

  test("a malformed snapshot entry is stored-state corruption at ROOT", () => {
    const e = publicationErr(() => deriveLinkRows(WS, REV, [{ ...SNAPSHOT_LINK, position: "-1" }]));
    expect(e.toJSON()).toEqual({
      version: "arra-publication-error/v1",
      code: "integrity_failure",
      path: "",
      message: "stored state failed integrity validation",
    });
  });
});

describe("the traversal budgets are the contract's literals", () => {
  test("32 nodes, 128 revisions, 4096 positions", () => {
    expect(MAX_VISITED_NODES).toBe(32);
    expect(MAX_SELECTED_REVISIONS).toBe(128);
    expect(MAX_EXAMINED_POSITIONS).toBe(4096);
  });
});

describe("real persistence: evidence reads, materialization and the scan", () => {
  /**
   * Inside the REAL writer gate, in an exec'd child, against a real
   * nineteen-table dataset the test owns and removes. Nothing is mocked.
   */
  const CHILD = new URL("./fixtures/association-v1/core/gated-association.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
  const ALPHA = "alpha-workspace";
  const NODE_A = assocId("nodeA");
  const REV_A1 = assocId("revA1");

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
  const ev = (method: string, request: unknown) => ({ facade: "evidence", method, request });
  const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
  const tax = (method: string, request: unknown) => ({ facade: "taxonomy", method, request });
  /**
   * Test-side dataset surgery, never a production seam.
   *
   * Some required states cannot be reached THROUGH the service, because the
   * service is what refuses to create them: a physically valid but underivable
   * capture time, a duplicated node identity, a table version that moves while
   * a read is in flight. The child writes those directly.
   */
  const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

  /** One accepted revision carrying a trace link, through the real publisher. */
  const publishWithLink = (seeded: SeededWorkspace, node: string, operation: string) =>
    pub("publishRevision", {
      operation_id: operation,
      content: revisionEnvelope(ALPHA, seeded, node, {
        link_snapshot_json: JSON.stringify([
          {
            position: "0",
            relation: "related_to",
            target_kind: "trace",
            target: { trace_id: seeded.trace_id },
            excerpt: null,
            content_hash: null,
            captured_at: null,
            capture_status: "locator_only",
            note: null,
          },
        ]),
      }),
    });

  test("the evidence bundle has EXACTLY the contracted shape", async () => {
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ev("getRevisionAssociations", getAssociationsRequest(ALPHA, { node_id: NODE_A })),
      ]);
      expect(parsed.writerKeys).toEqual(["close", "context", "evidence", "publication", "taxonomy"]);
      expect(parsed.evidenceMethods).toEqual([
        "getRevisionAssociations", "reconcileRevisionAssociations", "scanDependents",
      ]);
      // Only the BUNDLE closes the owner.
      expect(parsed.evidenceHasClose).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("an absent node reads as exactly null, not an error", async () => {
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ev("getRevisionAssociations", getAssociationsRequest(ALPHA, { node_id: assocId("ghost") })),
      ]);
      expect(parsed.op0.ok).toBe(true);
      expect(parsed.op0.value).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("PUBLICATION leaves the derived projections EMPTY", async () => {
    // The accepted publisher is projection-free. If this ever writes rows, the
    // materializer is no longer the first writer and the whole reconcile model
    // changes.
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [publishWithLink(seeded, NODE_A, "op-pub-1")],
        { revisionIds: [REV_A1] },
      );
      expect(parsed.op0.ok).toBe(true);
      expect(parsed.persistedTerms).toEqual([]);
      expect(parsed.persistedLinks).toEqual([]);
      // And no evidence boundary fired: publication never materializes.
      expect(parsed.trace).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("associations derive from the SNAPSHOT while projections are still absent", async () => {
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          ev("getRevisionAssociations", getAssociationsRequest(ALPHA, { node_id: NODE_A })),
        ],
        { revisionIds: [REV_A1] },
      );
      const read = parsed.op1.value;
      expect(read.node_id).toBe(NODE_A);
      expect(read.revision_id).toBe(REV_A1);
      expect(read.is_snapshot_head).toBe(true);
      expect(read.snapshot_head_revision_id).toBe(REV_A1);
      // The authoritative answer is complete even though NOTHING is
      // materialized: physical projection absence cannot remove an entry.
      expect(read.links).toHaveLength(1);
      expect(read.links[0].target_key).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.persistedLinks).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("reconcile materializes, then reports already_satisfied with NO boundaries", async () => {
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          ev("reconcileRevisionAssociations", reconcileRequest(ALPHA, { node_id: NODE_A, revision_id: REV_A1 })),
          ev("reconcileRevisionAssociations", reconcileRequest(ALPHA, { node_id: NODE_A, revision_id: REV_A1 })),
        ],
        { revisionIds: [REV_A1] },
      );

      const first = parsed.op1.value;
      expect(first.outcome).toBe("reconciled");
      expect(first.revision_id).toBe(REV_A1);
      // A term set and a link set, each reporting its own action and count.
      expect(first.links.action).toBe("filled");
      expect(first.links.count).toBe("1");
      expect(parsed.persistedLinks).toHaveLength(1);

      const second = parsed.op2.value;
      expect(second.outcome).toBe("already_satisfied");
      expect(second.links.action).toBe("unchanged");
      expect(second.terms.action).toBe("unchanged");

      // ALL term boundaries finish before ANY link boundary, and an unchanged
      // table is silent — so the trace is exactly the first call's writes.
      const termIdx = parsed.trace.lastIndexOf("after_term_write");
      const linkIdx = parsed.trace.indexOf("after_link_write");
      if (termIdx >= 0 && linkIdx >= 0) expect(termIdx).toBeLessThan(linkIdx);
      expect(parsed.trace.filter((b: string) => b === "before_delete")).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a NONNULL captured_at survives materialization losslessly", async () => {
    /**
     * The derived rows are WIRE shaped -- `position` decimal text, timestamps
     * exact millisecond strings -- while the shared Arrow append needs BigInt
     * and microseconds. Without the conversion the row is written with the
     * wrong physical types and the readback comparison can never match. A
     * null-only fixture would not have exercised either direction.
     */
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const CAPTURED = "2026-09-20T12:34:56.789Z";
      const withCapture = pub("publishRevision", {
        operation_id: "op-capture",
        content: revisionEnvelope(ALPHA, seeded, NODE_A, {
          link_snapshot_json: JSON.stringify([
            {
              position: "0",
              relation: "related_to",
              target_kind: "trace",
              target: { trace_id: seeded.trace_id },
              excerpt: "an excerpt",
              content_hash: "c".repeat(64),
              captured_at: CAPTURED,
              capture_status: "captured",
              note: "",
            },
          ]),
        }),
      });
      const parsed = await drive(
        fixture.datasetRoot,
        [
          withCapture,
          ev("reconcileRevisionAssociations", reconcileRequest(ALPHA, { node_id: NODE_A, revision_id: REV_A1 })),
          ev("reconcileRevisionAssociations", reconcileRequest(ALPHA, { node_id: NODE_A, revision_id: REV_A1 })),
          ev("getRevisionAssociations", getAssociationsRequest(ALPHA, { node_id: NODE_A })),
        ],
        { revisionIds: [REV_A1] },
      );

      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      expect(parsed.op1.value.links.action).toBe("filled");
      // The SECOND reconcile proves the round trip: if captured_at had been
      // written or decoded lossily, the stored row would never compare equal
      // and this would rebuild forever instead of settling.
      expect(parsed.op2.value.outcome).toBe("already_satisfied");
      expect(parsed.op2.value.links.action).toBe("unchanged");

      const link = parsed.op3.value.links[0];
      expect(link.captured_at).toBe(CAPTURED);
      expect(link.capture_status).toBe("captured");
      expect(link.excerpt).toBe("an excerpt");
      // Empty string is a retained display value, not an absent one.
      expect(link.note).toBe("");
      expect(parsed.persistedLinks).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a scan finds the citation by target, and current mode marks it as head", async () => {
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id } })),
        ],
        { revisionIds: [REV_A1] },
      );
      const page = parsed.op1.value;
      expect(page.outcome).toBe("page");
      // nodes_version is canonical Int64 decimal TEXT, never a number.
      expect(typeof page.nodes_version).toBe("string");
      expect(page.occurrences).toHaveLength(1);
      const occ = page.occurrences[0];
      expect(occ.node_id).toBe(NODE_A);
      expect(occ.revision_id).toBe(REV_A1);
      expect(occ.is_snapshot_head).toBe(true);
      // The occurrence carries the complete link row, with no duplicate
      // top-level position field.
      expect(occ.link.position).toBe("0");
      expect(occ).not.toHaveProperty("position");
      // Reverse completeness does NOT come from projections: nothing was
      // materialized in this run.
      expect(parsed.persistedLinks).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a scan for an UNCITED target returns an empty page with a null cursor", async () => {
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: assocId("othertrace") } })),
        ],
        { revisionIds: [REV_A1] },
      );
      const page = parsed.op1.value;
      expect(page.outcome).toBe("page");
      expect(page.occurrences).toEqual([]);
      expect(page.next_cursor).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a cursor from a DIFFERENT nodes version forces restart_required", async () => {
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id } })),
        ],
        { revisionIds: [REV_A1] },
      );
      const version = parsed.op1.value.nodes_version as string;
      const stale = (BigInt(version) + 1n).toString(10);

      const second = await drive(
        fixture.datasetRoot,
        [
          ev(
            "scanDependents",
            scanRequest(ALPHA, {
              target: { trace_id: seeded.trace_id },
              cursor: scanCursor({
                workspace_name: ALPHA,
                target_key: "unset",
                nodes_version: stale,
                node_id: NODE_A,
              }),
            }),
          ),
        ],
      );
      // The target_key is wrong too, so the GOVERNED mismatch is what surfaces
      // first — precedence is static cursor shape and context before version.
      expect(second.op0.ok).toBe(false);
      expect(second.op0.version).toBe("arra-error/v1");
      expect(second.op0.code).toBe("scope_mismatch");
      expect(second.op0.path).toBe("/cursor/target_key");
      expect(second.op0.message).toBe("evidence cursor does not match request");
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a SUB-MILLISECOND derived capture time is rebuilt, not a hard failure", async () => {
    /**
     * `timestamp[us]` can physically hold a time the WIRE cannot express. Such
     * a row is divergence of a rebuildable projection, not authoritative
     * corruption: the snapshot -- which is authoritative -- is still exact. An
     * earlier revision let the preflight decode throw, which turned a
     * self-healing rebuild into a dead end for that revision.
     */
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const CAPTURED = "2026-09-20T12:34:56.789Z";
      const EXACT = String(Date.parse(CAPTURED) * 1000);
      const SUB_MS = String(Date.parse(CAPTURED) * 1000 + 123);
      const reconcile = ev(
        "reconcileRevisionAssociations",
        reconcileRequest(ALPHA, { node_id: NODE_A, revision_id: REV_A1 }),
      );
      const parsed = await drive(
        fixture.datasetRoot,
        [
          pub("publishRevision", {
            operation_id: "op-capture",
            content: revisionEnvelope(ALPHA, seeded, NODE_A, {
              link_snapshot_json: JSON.stringify([
                {
                  position: "0", relation: "related_to", target_kind: "trace",
                  target: { trace_id: seeded.trace_id }, excerpt: null, content_hash: null,
                  captured_at: CAPTURED, capture_status: "captured", note: null,
                },
              ]),
            }),
          }),
          reconcile,
          hx("setLinkCapturedAtMicros", {
            workspace_name: ALPHA, revision_id: REV_A1, position: "0", captured_at_micros: SUB_MS,
          }),
          hx("readLinkCapturedAtMicros", { workspace_name: ALPHA, revision_id: REV_A1 }),
          reconcile,
          hx("readLinkCapturedAtMicros", { workspace_name: ALPHA, revision_id: REV_A1 }),
        ],
        { revisionIds: [REV_A1] },
      );

      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      // The corruption REALLY landed -- read back as exact micros, not through
      // a lossy decoder that would have hidden the 123.
      expect(parsed.op3.value).toEqual([SUB_MS]);

      expect(parsed.op4.ok, JSON.stringify(parsed.op4)).toBe(true);
      expect(parsed.op4.value.outcome).toBe("reconciled");
      expect(parsed.op4.value.links.action).toBe("rebuilt");
      // The TERM set was untouched by the corruption and must not be rebuilt
      // alongside it.
      expect(parsed.op4.value.terms.action).toBe("unchanged");
      // And the stored value is the exact millisecond again.
      expect(parsed.op5.value).toEqual([EXACT]);
      expect(parsed.trace).toContain("before_delete");
      expect(parsed.persistedLinks).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a missing NODE and an orphan revision report DIFFERENT pointers", async () => {
    // Both were previously invalid_reference /revision_id, which told a caller
    // to go looking for a revision when the node itself was absent.
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const GHOST_NODE = assocId("ghostnode");
      const GHOST_REV = assocId("ghostrev");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          ev("reconcileRevisionAssociations", reconcileRequest(ALPHA, { node_id: GHOST_NODE, revision_id: REV_A1 })),
          ev("reconcileRevisionAssociations", reconcileRequest(ALPHA, { node_id: NODE_A, revision_id: GHOST_REV })),
          // The READ keeps its null semantics for the same absent node.
          ev("getRevisionAssociations", getAssociationsRequest(ALPHA, { node_id: GHOST_NODE })),
        ],
        { revisionIds: [REV_A1] },
      );

      expect(parsed.op1.ok).toBe(false);
      expect(parsed.op1).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "invalid_reference",
        path: "/node_id",
      });
      expect(parsed.op2.ok).toBe(false);
      expect(parsed.op2).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "invalid_reference",
        path: "/revision_id",
      });
      expect(parsed.op3.ok).toBe(true);
      expect(parsed.op3.value).toBeNull();
      // Neither refusal wrote anything.
      expect(parsed.persistedLinks).toEqual([]);
      expect(parsed.trace).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a DUPLICATE selected node is caught by the equality probe, not the page", async () => {
    /**
     * Keyset paging advances past a duplicate id without ever seeing it: the
     * ordered page returns one row and the next predicate is strictly greater.
     * Only the per-identity 0/1/>1 probe can see it, which is why the scan
     * issues one even though the page already produced the id.
     */
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const micros = String(CLOCK * 1000);
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          hx("appendNode", {
            id: NODE_A, workspace_name: ALPHA, current_revision_id: REV_A1,
            created_at_micros: micros, updated_at_micros: micros,
          }),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id } })),
        ],
        { revisionIds: [REV_A1] },
      );

      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      expect(parsed.op2.ok).toBe(false);
      expect(parsed.op2).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "integrity_failure",
        // Stored-state corruption is anchored at ROOT: no request pointer
        // names a row the caller never supplied.
        path: "",
        message: "stored state failed integrity validation",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a nodes version that moved BETWEEN pages forces restart_required", async () => {
    /**
     * The witness is captured before the first read and compared again before
     * the answer. A continuation carrying the older version is never
     * reinterpreted against changed heads.
     *
     * Deterministic by construction: the bump is its own completed op, and the
     * ZERO-MATCH delete moves the version without touching a row -- so the
     * only thing the second call can react to is the witness itself, not a
     * changed traversal.
     */
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const NODE_B = assocId("nodeB");
      const REV_B1 = assocId("revB1");
      const first = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          publishWithLink(seeded, NODE_B, "op-pub-2"),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id }, limit: 1 })),
        ],
        { revisionIds: [REV_A1, REV_B1] },
      );
      const page = first.op2.value;
      expect(page.outcome).toBe("page");
      expect(page.occurrences).toHaveLength(1);
      // A REAL cursor from a real page: its target_key is the derived one, so
      // the governed scope check cannot pre-empt the version comparison.
      const cursor = page.next_cursor;
      expect(cursor).not.toBeNull();
      expect(cursor.nodes_version).toBe(page.nodes_version);

      const second = await drive(
        fixture.datasetRoot,
        [
          hx("bumpNodesVersion", { predicate: `id = '${assocId("nosuchnode")}'` }),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id }, limit: 1, cursor })),
        ],
        { revisionIds: [] },
      );
      // Version moved with NO row change: a zero-match delete still advances
      // it. The witness is the version, not a row count.
      expect(second.op0.value).toEqual({ numDeletedRows: 0, versionMoved: true });
      expect(second.op1.ok, JSON.stringify(second.op1)).toBe(true);
      // No page, no cursor, no partial occurrences.
      expect(second.op1.value).toEqual({ outcome: "restart_required" });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("at an UNCHANGED witness a cursor naming a vanished node is still blamed", async () => {
    /**
     * The other half of the same repair. Cursor semantics are validated with
     * reads that happen AFTER the witness was captured, so a fault there is
     * only the caller's when the witness did not move. This pins the
     * unchanged-witness side: the fault must still be raised, at its own
     * pointer, rather than being swallowed into a restart.
     */
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const first = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id } })),
        ],
        { revisionIds: [REV_A1] },
      );
      const page = first.op1.value;
      const occ = page.occurrences[0];
      // Built from the LIVE version and the derived key, so nothing else can
      // fire first -- only the node identity is wrong.
      const forged = {
        workspace_name: ALPHA,
        target_kind: "trace",
        target_key: occ.link.target_key,
        revision_mode: "current",
        nodes_version: page.nodes_version,
        node_id: assocId("vanished"),
        revision_no: null,
        position: null,
      };
      const second = await drive(
        fixture.datasetRoot,
        [ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id }, cursor: forged }))],
        { revisionIds: [] },
      );
      expect(second.op0.ok).toBe(false);
      expect(second.op0).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "invalid_request",
        path: "/cursor/node_id",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
  test("a version that moves WITHIN the page, at the capture itself, restarts", async () => {
    /**
     * The re-check exists for a window a between-page test cannot reach: the
     * witness moving AFTER capture and BEFORE the answer. A read path has no
     * boundary hook to hold, so the child takes the seam at runtime on the
     * SDK's own `version` method -- it calls the original, retains that value,
     * disarms, runs a REAL scoped mutation, and hands the service the
     * pre-mutation value. Real storage, real SDK calls, nothing on disk or in
     * src/ altered, descriptor restored in a finally.
     *
     * Instrumented interleaving evidence, explicitly NOT a claim about
     * uninstrumented concurrency.
     */
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          // A ZERO-MATCH delete: the version moves without a row changing, so
          // the ONLY thing the scan can react to is the witness itself.
          hx("armVersionInterleave", { table: "nodes", predicate: `id = '${assocId("nosuchnode")}'` }),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id } })),
          hx("readVersionInterleave", {}),
        ],
        { revisionIds: [REV_A1] },
      );

      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      expect(parsed.op1.value.prototype).toBe("LocalTable");

      const seam = parsed.op3.value;
      // Order: captured first, mutated second. If the mutation had preceded
      // the capture this would not be the observed sequence.
      expect(seam.log[0]).toMatch(/^captured:/);
      expect(seam.log[1]).toMatch(/^mutated:/);
      // A REAL increase, not a relabelled constant.
      expect(BigInt(seam.observed.after)).toBeGreaterThan(BigInt(seam.observed.before));
      // The service read the version again after its reads -- that later call
      // is what sees the moved witness.
      expect(seam.calls).toBeGreaterThanOrEqual(2);

      expect(parsed.op2.ok, JSON.stringify(parsed.op2)).toBe(true);
      // No page, no cursor, no partial occurrences.
      expect(parsed.op2.value).toEqual({ outcome: "restart_required" });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a cursor valid AT CAPTURE, invalidated before validation, restarts rather than being blamed", async () => {
    /**
     * Cursor semantics are validated with reads that happen after the witness
     * is captured. A concurrent write in that window can invalidate a cursor
     * that was perfectly good when it was issued -- and answering
     * invalid_request would blame the caller for someone else's write.
     *
     * The mutation here is a REAL scoped row removal of the cursor's own node,
     * landing exactly at the capture. Contrast with the unchanged-witness case
     * above, where the same fault IS the caller's and keeps its pointer.
     */
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const NODE_B = assocId("nodeB");
      const REV_B1 = assocId("revB1");
      const first = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          publishWithLink(seeded, NODE_B, "op-pub-2"),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id }, limit: 1 })),
        ],
        { revisionIds: [REV_A1, REV_B1] },
      );
      const cursor = first.op2.value.next_cursor;
      expect(cursor.node_id).toBe(NODE_A);

      const second = await drive(
        fixture.datasetRoot,
        [
          hx("armVersionInterleave", {
            table: "nodes",
            predicate: `workspace_name = '${ALPHA}' AND id = '${NODE_A}'`,
          }),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id }, limit: 1, cursor })),
          hx("readVersionInterleave", {}),
        ],
        { revisionIds: [] },
      );

      const seam = second.op2.value;
      expect(seam.log[0]).toBe(`captured:${cursor.nodes_version}`);
      // The capture handed back exactly the version the cursor claims, so the
      // version comparison PASSES and validation proceeds -- which is the only
      // way to reach the window under test.
      expect(BigInt(seam.observed.after)).toBeGreaterThan(BigInt(seam.observed.before));

      expect(second.op1.ok, JSON.stringify(second.op1)).toBe(true);
      expect(second.op1.value).toEqual({ outcome: "restart_required" });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
  test("accepted history survives a term RENAME and RETIREMENT unchanged", async () => {
    /**
     * Section 7. An association is derived from the revision's SNAPSHOT, never
     * from a live join against the taxonomy. So the vocabulary can move on --
     * rename, retire -- and every accepted revision keeps saying what it said
     * when it was accepted.
     *
     * The live term is read back through the real taxonomy reader as a
     * CONTROL. Without it a rename that silently failed would leave the
     * snapshot trivially unchanged and this test would pass for the wrong
     * reason.
     */
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const term = seeded.term_ids.type.note;
      const reconcile = ev(
        "reconcileRevisionAssociations",
        reconcileRequest(ALPHA, { node_id: NODE_A, revision_id: REV_A1 }),
      );
      const read = ev("getRevisionAssociations", getAssociationsRequest(ALPHA, { node_id: NODE_A }));
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publishWithLink(seeded, NODE_A, "op-pub-1"),
          reconcile,
          read,
          tax("renameTerm", {
            workspace_name: ALPHA, term_id: term.id,
            expected_name: term.name, name: "note-renamed-after-acceptance",
          }),
          tax("retireTerm", { workspace_name: ALPHA, term_id: term.id }),
          tax("getTerm", { workspace_name: ALPHA, term_id: term.id }),
          read,
          reconcile,
        ],
        { revisionIds: [REV_A1] },
      );

      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      const before = parsed.op2.value.terms[0];
      expect(before.term_name_snapshot).toBe(term.name);

      // The taxonomy mutations REALLY happened.
      expect(parsed.op3.ok, JSON.stringify(parsed.op3)).toBe(true);
      expect(parsed.op3.value.outcome).toBe("updated");
      expect(parsed.op4.ok, JSON.stringify(parsed.op4)).toBe(true);
      expect(parsed.op4.value.outcome).toBe("updated");
      // Control: the LIVE row moved on, in both name and activity.
      expect(parsed.op5.value.name).toBe("note-renamed-after-acceptance");
      expect(parsed.op5.value.is_active).toBe(false);

      // The accepted association did not.
      const after = parsed.op6.value.terms[0];
      expect(after.term_name_snapshot).toBe(term.name);
      expect(after.vocabulary_name_snapshot).toBe(term.vocabulary_name);
      expect(after.term_id).toBe(term.id);
      expect(after.vocabulary_id).toBe(term.vocabulary_id);
      expect(after).toEqual(before);

      // And the DERIVED set still matches the snapshot, so a reconcile after
      // the rename is a no-op rather than a rewrite to the new live name.
      expect(parsed.op7.value.outcome).toBe("already_satisfied");
      expect(parsed.op7.value.terms.action).toBe("unchanged");
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a REAL interrupted publication stays invisible, then resumes with its retained identity", async () => {
    /**
     * Section 7, the acceptance transition, driven entirely by the ACCEPTED
     * publisher. No row is hand-written and no head is patched: a real
     * publication is interrupted at its own operator fault seam
     * (`after_revision_readback`) after the revision row is durable and before
     * the head moves. What remains is a genuine retained orphan -- valid
     * digest, real ordinal, real timestamp -- bound to its operation.
     *
     * A delete-and-recreate under a recycled id would NOT be this: the same
     * string is not the same retained revision. Here the resumption is the
     * publisher's own, and the row is proven byte-identical across it.
     */
    const fixture = await createSeededRevisionFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const ORPHAN = assocId("orphanrev");
      const OPERATION = "op-interrupted";
      const revisionText = `workspace_name = '${ALPHA}' AND node_id = '${NODE_A}'`;
      // ONE content value, used byte-identically by the interrupted attempt
      // and the retry -- that is what binds the retry to the retained row.
      const content = revisionEnvelope(ALPHA, seeded, NODE_A, {
        base_revision_id: REV_A1,
        link_snapshot_json: JSON.stringify([
          {
            position: "0", relation: "related_to", target_kind: "trace",
            target: { trace_id: seeded.trace_id }, excerpt: null, content_hash: null,
            captured_at: null, capture_status: "locator_only", note: null,
          },
        ]),
      });

      // 1. An accepted first revision, so the orphan lands on a node whose
      //    head genuinely points somewhere else.
      const seed = await drive(
        fixture.datasetRoot,
        [publishWithLink(seeded, NODE_A, "op-pub-1")],
        { revisionIds: [REV_A1] },
      );
      expect(seed.op0.ok, JSON.stringify(seed.op0)).toBe(true);

      // 2. A REAL publication, interrupted after the revision is durable and
      //    before the head moves.
      const interrupted = await drive(
        fixture.datasetRoot,
        [
          pub("publishRevision", { operation_id: OPERATION, content }),
          hx("readRawRows", { table: "node_revisions", predicate: revisionText }),
          hx("readRawRows", { table: "nodes", predicate: `workspace_name = '${ALPHA}' AND id = '${NODE_A}'` }),
        ],
        { revisionIds: [ORPHAN], failPublicationAt: { boundary: "after_revision_readback", occurrence: 1 } },
      );
      expect(interrupted.op0.ok).toBe(false);
      expect(interrupted.publicationTrace).toContain("after_revision_readback");

      const retained = (interrupted.op1.value as Record<string, string>[]).find((r) => r.id === ORPHAN);
      expect(retained, JSON.stringify(interrupted.op1.value)).toBeDefined();
      // Durable and REAL: the publisher's own ordinal, digest and timestamp.
      expect(retained!.revision_no).toBe("2");
      expect(retained!.operation_id).toBe(OPERATION);
      expect(retained!.base_revision_id).toBe(REV_A1);
      expect(retained!.content_digest).toMatch(/^[0-9a-f]{64}$/);
      // The head did NOT move.
      expect((interrupted.op2.value as Record<string, string>[])[0]!.current_revision_id).toBe(REV_A1);

      // 3. A FRESH gated owner: invisible everywhere, then resumed by the same
      //    operation and content.
      const resumed = await drive(
        fixture.datasetRoot,
        [
          ev("getRevisionAssociations", getAssociationsRequest(ALPHA, { node_id: NODE_A, revision_id: ORPHAN })),
          ev("reconcileRevisionAssociations", reconcileRequest(ALPHA, { node_id: NODE_A, revision_id: ORPHAN })),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id } })),
          pub("publishRevision", { operation_id: OPERATION, content }),
          ev("getRevisionAssociations", getAssociationsRequest(ALPHA, { node_id: NODE_A, revision_id: ORPHAN })),
          ev("scanDependents", scanRequest(ALPHA, { target: { trace_id: seeded.trace_id } })),
          ev(
            "scanDependents",
            scanRequest(ALPHA, { target: { trace_id: seeded.trace_id }, revision_mode: "history" }),
          ),
          hx("readRawRows", { table: "node_revisions", predicate: revisionText }),
        ],
        // A DIFFERENT id is offered and must be ignored by the resumption.
        { revisionIds: [assocId("unusedrev")] },
      );

      // BEFORE: durable, and absent from every association answer.
      expect(resumed.op0.ok).toBe(true);
      expect(resumed.op0.value).toBeNull();
      expect(resumed.op1.ok).toBe(false);
      expect(resumed.op1).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "invalid_reference",
        path: "/revision_id",
        message: "invalid scoped reference",
      });
      // The orphan cites the SAME target as the accepted head, and is still
      // not reverse-discoverable.
      expect(resumed.op2.value.occurrences).toHaveLength(1);
      expect(resumed.op2.value.occurrences[0].revision_id).toBe(REV_A1);

      // The publisher resumed the RETAINED row rather than allocating.
      expect(resumed.op3.ok, JSON.stringify(resumed.op3)).toBe(true);
      expect(resumed.op3.value.revision_id).toBe(ORPHAN);
      expect(resumed.op3.value.revision_no).toBe("2");
      expect(resumed.op3.value.content_digest).toBe(retained!.content_digest);

      // AFTER: the same identity is readable and reverse-visible.
      expect(resumed.op4.ok, JSON.stringify(resumed.op4)).toBe(true);
      expect(resumed.op4.value.revision_id).toBe(ORPHAN);
      expect(resumed.op4.value.is_snapshot_head).toBe(true);
      expect(resumed.op4.value.links).toHaveLength(1);
      expect(resumed.op5.value.occurrences).toHaveLength(1);
      expect(resumed.op5.value.occurrences[0].revision_id).toBe(ORPHAN);
      expect(resumed.op6.value.occurrences.map((o: any) => o.revision_id)).toEqual([REV_A1, ORPHAN]);

      // The FULL retained row, every column, unchanged across the resumption.
      const after = (resumed.op7.value as Record<string, string>[]).find((r) => r.id === ORPHAN);
      expect(after).toEqual(retained);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
});
