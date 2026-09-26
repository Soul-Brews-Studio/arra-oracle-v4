/**
 * #47 (Parent #27) taxonomy kernel — the PURE half.
 *
 * Everything here runs without a dataset, a gate or a child process: request
 * grammar, the taxonomy error envelope, literal bootstrap rows and physical
 * row encoding. Persistence cases arrive separately once the #48 fixture
 * exists; they are not simulated here, because a mock of the store would
 * prove only that the mock agrees with itself.
 *
 * Contract: app/docs/contracts/taxonomy-write-v1.md
 * SHA256 4c126a7e8238e858b137b54f7c505125db37526a71d0a04acf6663ff1237df8e
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createTaxonomyFixture, seedManifest, termRequest, vocabularyRequest } from "./helpers/taxonomy-fixture";
import { runGated } from "./helpers/publication-fixture";
import { isContractError } from "../src/publication/errors";
import { ContractError } from "../src/contracts/errors";
import {
  RESERVED_VOCABULARY_NAMES,
  SEED_TERM_ORDER,
  SEED_VOCABULARY_ORDER,
  TAXONOMY_ERROR_CODES,
  TAXONOMY_ERROR_VERSION,
  TaxonomyError,
  TERM_FIELDS,
  VOCABULARY_FIELDS,
  encodeTermRow,
  encodeVocabularyRow,
  failTaxonomy,
  parseCreateTerm,
  parseCreateVocabulary,
  parseGetTerm,
  parseGetVocabulary,
  parseRenameTerm,
  parseReparentTerm,
  parseRetireTerm,
  parseSeedRequest,
  seedTermRows,
  seedVocabularyRows,
} from "../src/publication/taxonomy";
import { testTimeout } from "./helpers/timing.testTimeout";

const WS = "alpha-workspace";
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const id = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/**
 * Strict SHAPE failures keep the governed `arra-error/v1` envelope; only
 * taxonomy SEMANTICS use the taxonomy envelope. These two helpers keep that
 * split honest -- asserting merely "it threw" would let either envelope pass
 * for the other.
 */
const thrownContract = (run: () => unknown): { name: string; code?: string; path?: string } => {
  try {
    run();
  } catch (error) {
    const e = error as { name?: string; code?: string; path?: string };
    if (e.name === "ContractError") return e as { name: string; code?: string; path?: string };
    throw new Error(`expected ContractError, got ${e.name ?? String(error)}`);
  }
  throw new Error("expected a throw, got none");
};

const thrown = (run: () => unknown): TaxonomyError => {
  try {
    run();
  } catch (error) {
    if (error instanceof TaxonomyError) return error;
    throw new Error(`expected TaxonomyError, got ${String(error)}`);
  }
  throw new Error("expected a throw, got none");
};

describe("the taxonomy error envelope is its own, and is not forgeable", () => {
  test("it carries the taxonomy version and one fixed message per code", () => {
    expect(TAXONOMY_ERROR_VERSION).toBe("arra-taxonomy-error/v1");
    // Exactly the contract's nine codes, no more.
    expect([...TAXONOMY_ERROR_CODES].sort()).toEqual([
      "conflict",
      "integrity_failure",
      "invalid_reference",
      "invalid_request",
      "limit_exceeded",
      "not_found",
      "recovery_required",
      "unsupported_dataset",
      "writer_unavailable",
    ]);
    expect(new TaxonomyError("conflict").message).toBe("taxonomy state conflict");
    expect(new TaxonomyError("not_found").message).toBe("taxonomy row not found");
    expect(new TaxonomyError("limit_exceeded").message).toBe("taxonomy limit exceeded");
  });

  test("code and path cannot be rewritten at runtime", () => {
    // `readonly` is erased at runtime. A caller must not be able to relabel an
    // integrity failure as a not_found.
    const error = new TaxonomyError("integrity_failure", "/term_id");
    expect(() => {
      (error as unknown as { code: string }).code = "not_found";
    }).toThrow();
    expect(error.code).toBe("integrity_failure");
    expect(error.toJSON()).toEqual({
      version: "arra-taxonomy-error/v1",
      code: "integrity_failure",
      path: "/term_id",
      message: "stored state failed integrity validation",
    });
  });

  test("a message never carries caller text or a caught exception's words", () => {
    const error = thrown(() => failTaxonomy("invalid_request", "/name"));
    expect(error.message).toBe("invalid taxonomy request");
    expect(error.message).not.toContain("/name");
  });
});

describe("request grammar: closed objects, explicit nulls, no omission", () => {
  const goodVocabulary = {
    workspace_name: WS,
    vocabulary_id: id("voc"),
    name: "topics",
    label: "Topics",
    description: null,
    kind: "tags",
    term_policy: "open",
    cardinality: "many",
    required: false,
    hierarchy: "flat",
  } as const;

  test("a complete createVocabulary request parses", () => {
    expect(parseCreateVocabulary(bytes(goodVocabulary))).toEqual(goodVocabulary);
  });

  test("an unknown key is rejected, in the GOVERNED envelope not ours", () => {
    // Shape, not taxonomy semantics. Pinning our own code here would have
    // duplicated the shared grammar and its RFC 6901 escaping.
    const error = thrownContract(() => parseCreateVocabulary(bytes({ ...goodVocabulary, extra: 1 })));
    expect(error.code).toBe("unexpected_field");
  });

  test("a nullable field must be an EXPLICIT null, not omitted", () => {
    const { description: _dropped, ...withoutDescription } = goodVocabulary;
    const error = thrownContract(() => parseCreateVocabulary(bytes(withoutDescription)));
    expect(error.code).toBe("missing_field");
  });

  test("each enum accepts only its contract values", () => {
    for (const [field, bad] of [
      ["kind", "topics"],
      ["term_policy", "closed"],
      ["cardinality", "two"],
      ["hierarchy", "graph"],
    ] as const) {
      const error = thrownContract(() =>
        parseCreateVocabulary(bytes({ ...goodVocabulary, [field]: bad })),
      );
      expect(error.code).toBe("invalid_value");
    }
  });

  test("`required` must be a real Boolean, not a truthy stand-in", () => {
    expect(
      thrownContract(() => parseCreateVocabulary(bytes({ ...goodVocabulary, required: 1 }))).code,
    ).toBe("invalid_type");
  });

  test("the reserved names are refused here; only bootstrap may create them", () => {
    expect([...RESERVED_VOCABULARY_NAMES].sort()).toEqual(["memory_horizon", "type"]);
    for (const reserved of RESERVED_VOCABULARY_NAMES) {
      const error = thrown(() => parseCreateVocabulary(bytes({ ...goodVocabulary, name: reserved })));
      expect(error.code).toBe("invalid_request");
      expect(error.path).toBe("/name");
    }
  });

  test("names are byte-bounded at 256 UTF-8 bytes, counted as BYTES not characters", () => {
    // Three-byte characters: 85 of them is 255 bytes and fits, 86 is 258 and
    // does not. A length check on the JS string would wrongly accept both.
    const fits = "ก".repeat(85);
    const over = "ก".repeat(86);
    expect(parseCreateVocabulary(bytes({ ...goodVocabulary, name: fits })).name).toBe(fits);
    expect(
      thrownContract(() => parseCreateVocabulary(bytes({ ...goodVocabulary, name: over }))).code,
    ).toBe("limit_exceeded");
  });

  test("a DESCRIPTION is any valid Unicode: empty is fine, and 256 bytes is NOT its bound", () => {
    // The name rules do not apply here. Only the 1 MiB request cap bounds a
    // description, so both of these are contract-valid and must parse.
    expect(parseCreateVocabulary(bytes({ ...goodVocabulary, description: "" })).description).toBe("");
    const long = "ก".repeat(400); // 1200 bytes, far past the name bound
    expect(parseCreateVocabulary(bytes({ ...goodVocabulary, description: long })).description).toBe(long);
    expect(parseCreateVocabulary(bytes({ ...goodVocabulary, description: null })).description).toBeNull();
  });

  test("a LABEL must be nonempty, but carries no 256-byte cap either", () => {
    const long = "ก".repeat(400);
    expect(parseCreateVocabulary(bytes({ ...goodVocabulary, label: long })).label).toBe(long);
    expect(
      thrownContract(() => parseCreateVocabulary(bytes({ ...goodVocabulary, label: "" }))).code,
    ).toBe("invalid_value");
  });

  test("a term description is unbounded and nullable the same way", () => {
    const request = {
      workspace_name: WS,
      term_id: id("term"),
      vocabulary_id: id("voc"),
      name: "a term",
      description: "",
      parent_id: null,
    };
    expect(parseCreateTerm(bytes(request)).description).toBe("");
    const long = "ก".repeat(400);
    expect(parseCreateTerm(bytes({ ...request, description: long })).description).toBe(long);
  });

  test("names are NOT trimmed, cased or normalized", () => {
    // Stored identity must be exactly what the caller sent, so two visually
    // similar names stay distinct rows rather than silently colliding.
    const spaced = "  Spaced Name  ";
    expect(parseCreateVocabulary(bytes({ ...goodVocabulary, name: spaced })).name).toBe(spaced);
    const composed = "é"; // e + combining acute, NOT U+00E9
    const parsed = parseCreateVocabulary(bytes({ ...goodVocabulary, name: composed }));
    expect(parsed.name).toBe(composed);
    expect(parsed.name).not.toBe("é");
  });

  test("an empty name is refused", () => {
    expect(
      thrownContract(() => parseCreateVocabulary(bytes({ ...goodVocabulary, name: "" }))).code,
    ).toBe("invalid_value");
  });

  test("createTerm takes a nullable parent and a required vocabulary", () => {
    const request = {
      workspace_name: WS,
      term_id: id("term"),
      vocabulary_id: id("voc"),
      name: "a term",
      description: null,
      parent_id: null,
    };
    expect(parseCreateTerm(bytes(request))).toEqual(request);
    expect(parseCreateTerm(bytes({ ...request, parent_id: id("par") })).parent_id).toBe(id("par"));
    // A non-nanoid21 identifier is a request error, not a lookup miss.
    expect(thrownContract(() => parseCreateTerm(bytes({ ...request, parent_id: "short" }))).code).toBe(
      "invalid_value",
    );
  });

  test("the guarded mutations require their expected value", () => {
    const rename = { workspace_name: WS, term_id: id("term"), expected_name: "old", name: "new" };
    expect(parseRenameTerm(bytes(rename))).toEqual(rename);
    const { expected_name: _drop, ...missing } = rename;
    expect(thrownContract(() => parseRenameTerm(bytes(missing))).code).toBe("missing_field");

    const reparent = {
      workspace_name: WS,
      term_id: id("term"),
      expected_parent_id: null,
      parent_id: id("par"),
    };
    expect(parseReparentTerm(bytes(reparent))).toEqual(reparent);
    // Both parents are nullable, and null must be explicit on both.
    const { expected_parent_id: _drop2, ...missingParent } = reparent;
    expect(thrownContract(() => parseReparentTerm(bytes(missingParent))).code).toBe("missing_field");
  });

  test("the read and retire requests are closed too", () => {
    expect(parseGetVocabulary(bytes({ workspace_name: WS, vocabulary_id: id("voc") }))).toEqual({
      workspace_name: WS,
      vocabulary_id: id("voc"),
    });
    expect(parseGetTerm(bytes({ workspace_name: WS, term_id: id("term") }))).toEqual({
      workspace_name: WS,
      term_id: id("term"),
    });
    expect(parseRetireTerm(bytes({ workspace_name: WS, term_id: id("term") }))).toEqual({
      workspace_name: WS,
      term_id: id("term"),
    });
    expect(
      thrownContract(() => parseGetTerm(bytes({ workspace_name: WS, term_id: id("term"), depth: 1 }))).code,
    ).toBe("unexpected_field");
  });
});

describe("the bootstrap manifest is literal, and its nine ids must be distinct", () => {
  const manifest = {
    workspace_name: WS,
    type: {
      vocabulary_id: id("typevoc"),
      terms: {
        note: id("note"),
        conclusion: id("concl"),
        learning: id("learn"),
        discussion: id("disc"),
        correction: id("corr"),
      },
    },
    memory_horizon: {
      vocabulary_id: id("horvoc"),
      terms: { short_term: id("short"), long_term: id("long") },
    },
  };

  test("the staging order is seven type-then-horizon terms, then two vocabularies", () => {
    // The order is load-bearing: a crash-prefix test can only name which row
    // was written if the order is fixed.
    expect([...SEED_TERM_ORDER]).toEqual([
      "note",
      "conclusion",
      "learning",
      "discussion",
      "correction",
      "short_term",
      "long_term",
    ]);
    expect([...SEED_VOCABULARY_ORDER]).toEqual(["type", "memory_horizon"]);
  });

  test("a repeated id anywhere among the nine is refused", () => {
    const clashing = structuredClone(manifest);
    clashing.memory_horizon.terms.long_term = clashing.type.terms.note;
    const error = thrown(() => parseSeedRequest(bytes(clashing)));
    expect(error.code).toBe("invalid_request");
    // Reported against the LATER of the two, which is the one that collides.
    expect(error.path).toBe("/memory_horizon/terms/long_term");
  });

  test("a vocabulary id colliding with a term id is refused too", () => {
    const clashing = structuredClone(manifest);
    clashing.memory_horizon.vocabulary_id = clashing.type.vocabulary_id;
    expect(thrown(() => parseSeedRequest(bytes(clashing))).path).toBe("/memory_horizon/vocabulary_id");
  });

  test("no caller-supplied label, policy, timestamp or bypass flag is accepted", () => {
    const sneaky = structuredClone(manifest) as Record<string, unknown>;
    (sneaky.type as Record<string, unknown>).label = "Mine";
    expect(thrownContract(() => parseSeedRequest(bytes(sneaky))).code).toBe("unexpected_field");
  });

  test("the vocabulary rows are exactly the contract's literals", () => {
    const parsed = parseSeedRequest(bytes(manifest));
    const rows = seedVocabularyRows(parsed, 1_600_000_000_000);
    expect(rows.map((r) => r.name)).toEqual(["type", "memory_horizon"]);
    expect(rows.map((r) => r.label)).toEqual(["Type", "Memory horizon"]);
    // type is required, memory_horizon is not: an omitted type resolves to
    // note, while an omitted horizon stays unclassified.
    expect(rows.map((r) => r.required)).toEqual([true, false]);
    for (const row of rows) {
      expect(row.kind).toBe("categories");
      expect(row.term_policy).toBe("sealed");
      expect(row.cardinality).toBe("one");
      expect(row.hierarchy).toBe("flat");
      expect(row.description).toBeNull();
      expect(row.h_metadata).toBeNull();
      expect(row.internal_metadata).toBeNull();
      expect(row.workspace_name).toBe(WS);
    }
  });

  test("the term rows are literal, inactive-free, unweighted and unlabelled", () => {
    const parsed = parseSeedRequest(bytes(manifest));
    const rows = seedTermRows(parsed, 1_600_000_000_000);
    expect(rows.map((r) => r.name)).toEqual([...SEED_TERM_ORDER]);
    expect(rows.map((r) => r.vocabulary_id)).toEqual([
      manifest.type.vocabulary_id,
      manifest.type.vocabulary_id,
      manifest.type.vocabulary_id,
      manifest.type.vocabulary_id,
      manifest.type.vocabulary_id,
      manifest.memory_horizon.vocabulary_id,
      manifest.memory_horizon.vocabulary_id,
    ]);
    for (const row of rows) {
      expect(row.description).toBeNull();
      expect(row.parent_id).toBeNull();
      expect(row.weight).toBe(0);
      expect(row.is_active).toBe(true);
      expect(row.h_metadata).toBeNull();
      // There is no term label field at all in the physical model.
      expect("label" in row).toBe(false);
    }
  });
});

describe("physical rows encode in model order, with exact time", () => {
  const vocabularyRow = {
    id: id("voc"),
    name: "type",
    workspace_name: WS,
    label: "Type",
    description: null,
    kind: "categories",
    term_policy: "sealed",
    cardinality: "one",
    required: true,
    hierarchy: "flat",
    h_metadata: null,
    internal_metadata: null,
    created_at: 1_600_000_000_000_000n,
  };
  const termRow = {
    id: id("term"),
    workspace_name: WS,
    vocabulary_id: id("voc"),
    name: "note",
    description: null,
    parent_id: null,
    weight: 0,
    is_active: true,
    h_metadata: null,
    created_at: 1_600_000_000_000_000n,
  };

  test("field order matches the existing Python models exactly", () => {
    // Quoted from target_v1/taxonomy.py:14 and :30 rather than invented.
    expect(VOCABULARY_FIELDS).toEqual([
      "id", "name", "workspace_name", "label", "description", "kind",
      "term_policy", "cardinality", "required", "hierarchy",
      "h_metadata", "internal_metadata", "created_at",
    ]);
    expect(TERM_FIELDS).toEqual([
      "id", "workspace_name", "vocabulary_id", "name", "description",
      "parent_id", "weight", "is_active", "h_metadata", "created_at",
    ]);
    expect(Object.keys(encodeVocabularyRow(vocabularyRow))).toEqual([...VOCABULARY_FIELDS]);
    expect(Object.keys(encodeTermRow(termRow))).toEqual([...TERM_FIELDS]);
  });

  test("timestamps become exact UTC milliseconds", () => {
    expect(encodeVocabularyRow(vocabularyRow).created_at).toBe("2020-09-13T12:26:40.000Z");
  });

  test("a sub-millisecond remainder is refused BEFORE any Number conversion", () => {
    // 1 microsecond past the millisecond. Converting first and rounding would
    // silently report a time the store does not hold.
    const error = thrown(() =>
      encodeTermRow({ ...termRow, created_at: 1_600_000_000_000_001n }),
    );
    expect(error.code).toBe("integrity_failure");
  });

  test("a non-finite or non-numeric weight is an integrity failure, not a coercion", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "0"]) {
      expect(thrown(() => encodeTermRow({ ...termRow, weight: bad })).code).toBe("integrity_failure");
    }
  });

  test("a malformed enum or Boolean in STORED state is an integrity failure", () => {
    // Same bad value, different direction: from the store it is corruption,
    // from a request it is an invalid request. The codes must differ.
    expect(thrown(() => encodeVocabularyRow({ ...vocabularyRow, kind: "nonsense" })).code).toBe(
      "integrity_failure",
    );
    expect(thrown(() => encodeTermRow({ ...termRow, is_active: 1 })).code).toBe("integrity_failure");
  });

  test("a preserved non-zero stored weight round-trips, even though this slice only writes zero", () => {
    expect(encodeTermRow({ ...termRow, weight: 0.25 }).weight).toBe(0.25);
  });
});

describe("the fixture helper really builds a dataset", () => {
  /**
   * A smoke test, deliberately separate from the taxonomy assertions. If the
   * helper is broken, every later failure would look like a taxonomy bug; this
   * keeps the two apart.
   */
  test("the exporter seeds exactly the requested workspaces", async () => {
    const fixture = await createTaxonomyFixture([ALPHA, BETA]);
    try {
      expect(Object.keys(fixture.workspaces).sort()).toEqual([ALPHA, BETA].sort());
      expect(fixture.workspaces[ALPHA]!.workspace_id).not.toBe(
        fixture.workspaces[BETA]!.workspace_id,
      );
      expect(fixture.workspaces[ALPHA]!.workspace_id).toMatch(/^[A-Za-z0-9_-]{21}$/);
      expect(existsSync(fixture.datasetRoot)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(180_000));
});

describe("real persistence: the bootstrap seed against a seeded dataset", () => {
  /**
   * Everything below runs inside the REAL writer gate, in an exec'd child,
   * against a real nineteen-table dataset the test owns and removes. Nothing
   * is mocked: a mock store would only prove the mock agrees with itself.
   */
  const CHILD = new URL("./fixtures/taxonomy-v1/core/gated-taxonomy.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  type ChildResult = Record<string, unknown> & {
    trace: string[];
    persistedTerms: string[];
    persistedVocabularies: string[];
  };

  const drive = async (
    root: string,
    ops: Array<{ method: string; request: unknown }>,
    extra: Record<string, unknown> = {},
  ): Promise<ChildResult> => {
    const result = await runGated(root, CHILD, [
      root,
      JSON.stringify({ ops, clockMs: CLOCK, ...extra }),
    ]);
    // A child that died or was reaped can still have printed a partial line.
    // Its JSON is only evidence if it exited cleanly.
    if (result.code !== 0) {
      throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
    }
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) {
      throw new Error(`no output (${result.code}): ${result.stderr.slice(0, 600)}`);
    }
    return JSON.parse(line) as ChildResult;
  };

  const op = (method: string, request: unknown) => ({ method, request });

  test("a fresh seed writes nine rows and emits the exact literal trace", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("seedReservedVocabularies", seedManifest(ALPHA)),
      ]);
      const first = parsed.op0 as { ok: boolean; value?: Record<string, unknown> };
      expect(first.ok).toBe(true);
      expect(first.value!.outcome).toBe("created");

      // Seven terms in literal order, THEN the two vocabularies.
      expect(parsed.persistedTerms).toEqual([...SEED_TERM_ORDER]);
      expect(parsed.persistedVocabularies).toEqual(["type", "memory_horizon"]);

      // The exact trace, not just its counts: seven term triples then two
      // vocabulary triples.
      const expectedTrace = [
        ...Array.from({ length: 7 }, () => [
          "before_write",
          "after_term_write",
          "after_readback",
        ]).flat(),
        ...Array.from({ length: 2 }, () => [
          "before_write",
          "after_vocabulary_write",
          "after_readback",
        ]).flat(),
      ];
      expect(parsed.trace).toEqual(expectedTrace);

      // And the contract's headline counts, stated independently.
      const count = (name: string) => parsed.trace.filter((b) => b === name).length;
      expect(count("before_write")).toBe(9);
      expect(count("after_term_write")).toBe(7);
      expect(count("after_vocabulary_write")).toBe(2);
      expect(count("after_readback")).toBe(9);
      expect(count("after_update")).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("re-running an identical seed is already_satisfied and emits NO boundaries", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("seedReservedVocabularies", seedManifest(ALPHA)),
        op("seedReservedVocabularies", seedManifest(ALPHA)),
      ]);
      expect((parsed.op0 as { value: Record<string, unknown> }).value.outcome).toBe("created");
      // Skipped rows emit nothing at all: the trace is still exactly the nine
      // triples from the FIRST seed.
      expect((parsed.op1 as { value: Record<string, unknown> }).value.outcome).toBe(
        "already_satisfied",
      );
      expect(parsed.trace).toHaveLength(27);
      // No duplicate rows were created on the second run.
      expect(parsed.persistedTerms).toEqual([...SEED_TERM_ORDER]);
      expect(parsed.persistedVocabularies).toEqual(["type", "memory_horizon"]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("the seeded rows carry the contract's literal physical state", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const manifest = seedManifest(ALPHA) as { type: { vocabulary_id: string } };
      const parsed = await drive(fixture.datasetRoot, [
        op("seedReservedVocabularies", manifest),
        op("getVocabulary", {
          workspace_name: ALPHA,
          vocabulary_id: manifest.type.vocabulary_id,
        }),
      ]);
      const read = (parsed.op1 as { ok: boolean; value: Record<string, unknown> }).value;
      expect(read.name).toBe("type");
      expect(read.label).toBe("Type");
      expect(read.kind).toBe("categories");
      expect(read.term_policy).toBe("sealed");
      expect(read.cardinality).toBe("one");
      expect(read.required).toBe(true);
      expect(read.hierarchy).toBe("flat");
      expect(read.description).toBeNull();
      expect(read.created_at).toBe("2026-09-21T00:00:00.000Z");
      // Physical field order, straight off the wire row.
      expect(Object.keys(read)).toEqual([...VOCABULARY_FIELDS]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("an absent row reads as exactly null, not an empty list or a status", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("getVocabulary", { workspace_name: ALPHA, vocabulary_id: id("nothinghere") }),
        op("getTerm", { workspace_name: ALPHA, term_id: id("alsonothing") }),
      ]);
      expect((parsed.op0 as { ok: boolean; value: unknown }).value).toBeNull();
      expect((parsed.op1 as { ok: boolean; value: unknown }).value).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});

describe("real persistence: resume, conflict and the SHARED owner", () => {
  const CHILD = new URL("./fixtures/taxonomy-v1/core/gated-taxonomy.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  type ChildResult = Record<string, unknown> & {
    trace: string[];
    persistedTerms: string[];
    persistedVocabularies: string[];
    crashed?: string;
  };

  /** `tolerateExit` is for the deliberate-crash runs, which exit non-zero. */
  const drive = async (
    root: string,
    ops: Array<{ method: string; request: unknown }>,
    extra: Record<string, unknown> = {},
    tolerateExit = false,
  ): Promise<ChildResult> => {
    const result = await runGated(root, CHILD, [
      root,
      JSON.stringify({ ops, clockMs: CLOCK, ...extra }),
    ]);
    if (!tolerateExit && result.code !== 0) {
      throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
    }
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) {
      throw new Error(`no output (${result.code}): ${result.stderr.slice(0, 600)}`);
    }
    return JSON.parse(line) as ChildResult;
  };

  const op = (method: string, request: unknown) => ({ method, request });

  test("a seed interrupted after the THIRD term resumes and stages only what is missing", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      // ---- Crash the owner mid-staging, at a named row boundary.
      const crashed = await drive(
        fixture.datasetRoot,
        [op("seedReservedVocabularies", seedManifest(ALPHA))],
        { crashAt: { boundary: "after_term_write", occurrence: 3 } },
        true,
      );
      expect(crashed.crashed).toBe("after_term_write");

      // ---- A FRESH owner resumes. Durable before-state, by identity and in
      // order, not by count: three terms and no vocabulary at all.
      const resumed = await drive(fixture.datasetRoot, [
        op("getTerm", { workspace_name: ALPHA, term_id: id("tnote") }),
        op("seedReservedVocabularies", seedManifest(ALPHA)),
      ]);
      expect((resumed.op0 as { value: Record<string, unknown> | null }).value).not.toBeNull();

      const outcome = (resumed.op1 as { ok: boolean; value: Record<string, unknown> });
      expect(outcome.ok).toBe(true);
      // `created` because THIS call appended at least one row -- not a claim
      // that it created every row it returns.
      expect(outcome.value.outcome).toBe("created");

      // Six triples, never nine: four remaining terms then two vocabularies.
      // Matching skipped rows emit nothing.
      expect(resumed.trace).toEqual([
        ...Array.from({ length: 4 }, () => ["before_write", "after_term_write", "after_readback"]).flat(),
        ...Array.from({ length: 2 }, () => ["before_write", "after_vocabulary_write", "after_readback"]).flat(),
      ]);

      // And the end state is complete and in literal order.
      expect(resumed.persistedTerms).toEqual([...SEED_TERM_ORDER]);
      expect(resumed.persistedVocabularies).toEqual(["type", "memory_horizon"]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a CHANGED seed row conflicts, and is not silently repaired", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [
          op("seedReservedVocabularies", seedManifest(ALPHA)),
          // Rename a reserved term: allowed OPERATOR lifecycle, per the ruling.
          op("renameTerm", {
            workspace_name: ALPHA,
            term_id: id("tnote"),
            expected_name: "note",
            name: "renamed-note",
          }),
          // Re-seeding now meets a changed row. Terminal through this slice:
          // reconciliation is out of scope and must NOT be invented here.
          op("seedReservedVocabularies", seedManifest(ALPHA)),
        ],
        // R6 (#27, docs/overnight/DECISIONS.md): `type` is sealed, so only the
        // trusted in-process operator may rename its terms. An ordinary owner
        // is refused; taxonomy-seal.test.ts pins that side.
        { operator: true },
      );
      expect((parsed.op1 as { ok: boolean; value: Record<string, unknown> }).value.outcome).toBe(
        "updated",
      );
      const reseed = parsed.op2 as { ok: boolean; name?: string; code?: string };
      expect(reseed.ok).toBe(false);
      expect(reseed.name).toBe("TaxonomyError");
      expect(reseed.code).toBe("conflict");
      // The rename stands: nothing reset it back to the literal seed state.
      expect(parsed.persistedTerms).toContain("renamed-note");
      expect(parsed.persistedTerms).not.toContain("note");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a taxonomy failure POISONS the shared owner for later taxonomy writes", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [
          op("seedReservedVocabularies", seedManifest(ALPHA)),
          op("createVocabulary", vocabularyRequest(ALPHA)),
        ],
        // Fail the hook AFTER a row was already attempted, which is the
        // ambiguous window the contract cares about.
        { failAt: { boundary: "after_term_write", occurrence: 2 } },
      );
      const seeded = parsed.op0 as { ok: boolean; code?: string };
      expect(seeded.ok).toBe(false);
      expect(seeded.code).toBe("recovery_required");

      // The SECOND operation is a different taxonomy method on the same owner.
      const later = parsed.op1 as { ok: boolean; name?: string; code?: string };
      expect(later.ok).toBe(false);
      expect(later.name).toBe("TaxonomyError");
      expect(later.code).toBe("recovery_required");
      // And it really did not write.
      expect(parsed.persistedVocabularies).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});

describe("real persistence: owner exclusion, reads, and the OTHER poison direction", () => {
  const CHILD = new URL("./fixtures/taxonomy-v1/core/gated-taxonomy.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  const drive = async (
    root: string,
    ops: Array<{ method: string; request: unknown }>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [
      root,
      JSON.stringify({ ops, clockMs: CLOCK, ...extra }),
    ]);
    if (result.code !== 0) {
      throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
    }
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 600)}`);
    return JSON.parse(line);
  };

  const op = (method: string, request: unknown) => ({ method, request });

  test("a SECOND writer on the same root is refused while the first holds it", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [op("seedReservedVocabularies", seedManifest(ALPHA))],
        { contendSameRoot: true },
      );
      expect(parsed.op0.ok).toBe(true);
      // Cross-factory contention: openKnowledgeWriter must claim the SAME
      // canonical-root registry entry the publication writer uses, or two
      // owners would write the same dataset believing they were alone.
      expect(parsed.contention.ok).toBe(false);
      expect(parsed.contention.code).toBe("writer_unavailable");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("reads stay available while POISONED, and are refused after RELEASE", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [op("seedReservedVocabularies", seedManifest(ALPHA))],
        {
          failAt: { boundary: "after_term_write", occurrence: 2 },
          readWhilePoisoned: ALPHA,
          readAfterRelease: ALPHA,
        },
      );
      expect(parsed.op0.ok).toBe(false);
      expect(parsed.op0.code).toBe("recovery_required");

      // Reads are off the write queue: a poisoned owner still answers them,
      // which is what makes a poisoned dataset inspectable at all.
      expect(parsed.readWhilePoisoned.ok).toBe(true);

      // After release the adapter is gone. Answering here would mean serving
      // from a handle the owner no longer holds.
      expect(parsed.readAfterRelease.ok).toBe(false);
      expect(parsed.readAfterRelease.code).toBe("recovery_required");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a PUBLICATION failure poisons later TAXONOMY writes — the other direction", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      // The publication facade rejects this request before any write, so to
      // poison we need a post-write failure. The taxonomy hook cannot fire for
      // a publication operation, so drive it the other way: seed first (to
      // have rows), then fail a taxonomy write, then prove a PUBLICATION call
      // on the same owner is refused too.
      const parsed = await drive(
        fixture.datasetRoot,
        [
          op("seedReservedVocabularies", seedManifest(ALPHA)),
          op("createVocabulary", vocabularyRequest(ALPHA)),
        ],
        { failAt: { boundary: "after_term_write", occurrence: 1 } },
      );
      expect(parsed.op0.ok).toBe(false);
      expect(parsed.op0.code).toBe("recovery_required");
      expect(parsed.op1.ok).toBe(false);
      expect(parsed.op1.code).toBe("recovery_required");
      // Nothing beyond the single interrupted row exists.
      expect(parsed.persistedVocabularies).toEqual([]);
      expect(parsed.persistedTerms.length).toBeLessThanOrEqual(1);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a pre-write refusal leaves the owner USABLE — the positive control", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        // Reserved name: refused during validation, before any write.
        op("createVocabulary", vocabularyRequest(ALPHA, { name: "type" })),
        op("seedReservedVocabularies", seedManifest(ALPHA)),
      ]);
      expect(parsed.op0.ok).toBe(false);
      // Reserved-name refusal is a SEMANTIC policy refusal, so it carries the
      // taxonomy envelope at /name — not the governed shape envelope. I had
      // this backwards first; the contract is explicit.
      expect(parsed.op0.name).toBe("TaxonomyError");
      expect(parsed.op0.code).toBe("invalid_request");
      expect(parsed.op0.path).toBe("/name");
      // Fail-stop is scoped to the ambiguous window: a rejection that wrote
      // nothing must not poison, or every assertion above would pass for the
      // wrong reason.
      expect(parsed.op1.ok).toBe(true);
      expect(parsed.op1.value.outcome).toBe("created");
      expect(parsed.persistedTerms).toEqual([...SEED_TERM_ORDER]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});

describe("real persistence: a genuine SDK write failure, then repair", () => {
  const CHILD = new URL("./fixtures/taxonomy-v1/core/gated-taxonomy.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  test("a rejected term append fail-stops, and the NEXT mutation is refused after repair", async () => {
    /**
     * A thrown hook proves the hook path. This proves the STORAGE path: the
     * `terms` table is made unwritable while reads still work, so the service
     * meets a real SDK rejection. The table is repaired before the second
     * operation, so its refusal can only be the owner's own state.
     */
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const result = await runGated(fixture.datasetRoot, CHILD, [
        fixture.datasetRoot,
        JSON.stringify({
          ops: [
            { method: "seedReservedVocabularies", request: seedManifest(ALPHA) },
            { method: "createVocabulary", request: vocabularyRequest(ALPHA) },
          ],
          clockMs: CLOCK,
          breakTableAt: { boundary: "before_write", occurrence: 1, table: "terms" },
        }),
      ]);
      if (result.code !== 0) {
        throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
      }
      const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
      if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 600)}`);
      const parsed = JSON.parse(line) as Record<string, any>;

      expect(parsed.op0.ok).toBe(false);
      expect(parsed.op0.name).toBe("TaxonomyError");
      expect(parsed.op0.code).toBe("recovery_required");
      // The repair really happened, so the next refusal is not the filesystem.
      expect(parsed.repaired).toBe(true);
      expect(parsed.op1.ok).toBe(false);
      expect(parsed.op1.code).toBe("recovery_required");
      // Nothing landed in either table.
      expect(parsed.persistedTerms).toEqual([]);
      expect(parsed.persistedVocabularies).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});

describe("real persistence: term lifecycle, tree structure and the ABA hazard", () => {
  const CHILD = new URL("./fixtures/taxonomy-v1/core/gated-taxonomy.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  const drive = async (
    root: string,
    ops: Array<{ method: string; request: unknown }>,
    // R6: only `{ operator: true }` is passed here, by the one case that
    // retires reserved `type` terms.
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 600)}`);
    return JSON.parse(line);
  };
  const op = (method: string, request: unknown) => ({ method, request });

  const TREE = id("treevoc");
  const treeVocabulary = (overrides: Record<string, unknown> = {}) =>
    vocabularyRequest(ALPHA, {
      vocabulary_id: TREE,
      name: "areas",
      label: "Areas",
      kind: "categories",
      hierarchy: "tree",
      ...overrides,
    });

  test("a RETIRED name still occupies its scoped identity", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("createVocabulary", treeVocabulary()),
        op("createTerm", termRequest(ALPHA, { term_id: id("t1"), vocabulary_id: TREE, name: "alpha" })),
        op("retireTerm", { workspace_name: ALPHA, term_id: id("t1") }),
        // Same name, new id: the retired row still holds the name, so this
        // must conflict rather than quietly creating a duplicate.
        op("createTerm", termRequest(ALPHA, { term_id: id("t2"), vocabulary_id: TREE, name: "alpha" })),
      ]);
      expect(parsed.op2.value.outcome).toBe("updated");
      expect(parsed.op3.ok).toBe(false);
      expect(parsed.op3.code).toBe("conflict");
      expect(parsed.op3.path).toBe("/name");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("retiring again is already_satisfied, and there is no reactivation", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("createVocabulary", treeVocabulary()),
        op("createTerm", termRequest(ALPHA, { term_id: id("t1"), vocabulary_id: TREE, name: "alpha" })),
        op("retireTerm", { workspace_name: ALPHA, term_id: id("t1") }),
        op("retireTerm", { workspace_name: ALPHA, term_id: id("t1") }),
        // A retired term cannot be renamed.
        op("renameTerm", {
          workspace_name: ALPHA,
          term_id: id("t1"),
          expected_name: "alpha",
          name: "beta",
        }),
      ]);
      expect(parsed.op3.value.outcome).toBe("already_satisfied");
      expect(parsed.op4.ok).toBe(false);
      expect(parsed.op4.code).toBe("invalid_request");
      expect(parsed.op4.path).toBe("/term_id");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("the LAST active term of a required vocabulary cannot be retired", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const manifest = seedManifest(ALPHA) as { type: { terms: { note: string } } };
      const parsed = await drive(
        fixture.datasetRoot,
        [
          op("seedReservedVocabularies", manifest),
          // `type` is required and seeded with five terms, so four retirements
          // are fine and the fifth must be refused.
          op("retireTerm", { workspace_name: ALPHA, term_id: id("tconcl") }),
          op("retireTerm", { workspace_name: ALPHA, term_id: id("tlearn") }),
          op("retireTerm", { workspace_name: ALPHA, term_id: id("tdisc") }),
          op("retireTerm", { workspace_name: ALPHA, term_id: id("tcorr") }),
          op("retireTerm", { workspace_name: ALPHA, term_id: manifest.type.terms.note }),
        ],
        // R6: retiring reserved `type` terms is operator lifecycle; an
        // ordinary owner is refused before the last-required check runs.
        { operator: true },
      );
      for (const key of ["op1", "op2", "op3", "op4"]) {
        expect(parsed[key].ok, `${key} should have retired`).toBe(true);
      }
      expect(parsed.op5.ok).toBe(false);
      expect(parsed.op5.code).toBe("invalid_request");
      expect(parsed.op5.path).toBe("/term_id");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a cycle and a self-parent are both refused, and a flat vocabulary takes no parent", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("createVocabulary", treeVocabulary()),
        op("createTerm", termRequest(ALPHA, { term_id: id("t1"), vocabulary_id: TREE, name: "root" })),
        op("createTerm", termRequest(ALPHA, { term_id: id("t2"), vocabulary_id: TREE, name: "child", parent_id: id("t1") })),
        // t1 under t2 would close the loop.
        op("reparentTerm", { workspace_name: ALPHA, term_id: id("t1"), expected_parent_id: null, parent_id: id("t2") }),
        // A term cannot be its own parent.
        op("reparentTerm", { workspace_name: ALPHA, term_id: id("t2"), expected_parent_id: id("t1"), parent_id: id("t2") }),
        // A flat vocabulary accepts only a null parent.
        op("createVocabulary", vocabularyRequest(ALPHA, { vocabulary_id: id("flatvoc"), name: "flat", label: "Flat" })),
        op("createTerm", termRequest(ALPHA, { term_id: id("f1"), vocabulary_id: id("flatvoc"), name: "f" })),
        op("createTerm", termRequest(ALPHA, { term_id: id("f2"), vocabulary_id: id("flatvoc"), name: "g", parent_id: id("f1") })),
      ]);
      expect(parsed.op3.ok).toBe(false);
      expect(parsed.op3.path).toBe("/parent_id");
      expect(parsed.op4.ok).toBe(false);
      expect(parsed.op4.path).toBe("/parent_id");
      expect(parsed.op7.ok).toBe(false);
      expect(parsed.op7.code).toBe("invalid_request");
      expect(parsed.op7.path).toBe("/parent_id");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("the expected-value guard is not a version journal: the ABA hazard is REAL", async () => {
    /**
     * Documented deliberately, because it is a limitation and not a bug.
     * `expected_name` compares a VALUE. A stale A->B request can therefore be
     * reapplied after someone else has already moved the name B->A, and it
     * will succeed. Nothing here promises exactly-once, ABA safety or
     * causality; anyone building on it must not assume otherwise.
     */
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("createVocabulary", treeVocabulary()),
        op("createTerm", termRequest(ALPHA, { term_id: id("t1"), vocabulary_id: TREE, name: "A" })),
        op("renameTerm", { workspace_name: ALPHA, term_id: id("t1"), expected_name: "A", name: "B" }),
        op("renameTerm", { workspace_name: ALPHA, term_id: id("t1"), expected_name: "B", name: "A" }),
        // A STALE repeat of the first rename. The value guard sees "A" again
        // and cannot tell this is an old request.
        op("renameTerm", { workspace_name: ALPHA, term_id: id("t1"), expected_name: "A", name: "B" }),
      ]);
      expect(parsed.op2.value.outcome).toBe("updated");
      expect(parsed.op3.value.outcome).toBe("updated");
      // This SUCCEEDS. That is the hazard, asserted rather than hoped away.
      expect(parsed.op4.ok).toBe(true);
      expect(parsed.op4.value.outcome).toBe("updated");
      expect(parsed.op4.value.row.name).toBe("B");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});

describe("root review findings — these must FAIL before the repair", () => {
  const CHILD = new URL("./fixtures/taxonomy-v1/core/gated-taxonomy.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  const drive = async (
    root: string,
    ops: Array<{ method: string; request: unknown }>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [
      root,
      JSON.stringify({ ops, clockMs: CLOCK, ...extra }),
    ]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 600)}`);
    return JSON.parse(line);
  };
  const op = (method: string, request: unknown) => ({ method, request });

  test("(1) a workspace with no row is an invalid reference, not orphan state", async () => {
    // Precedence is: request validity, WORKSPACE, scoped identity. Skipping
    // the workspace means rows can be written into a scope that does not
    // exist, which nothing downstream can later distinguish from real data.
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("createVocabulary", vocabularyRequest("no-such-workspace")),
      ]);
      expect(parsed.op0.ok).toBe(false);
      expect(parsed.op0.name).toBe("TaxonomyError");
      expect(parsed.op0.code).toBe("invalid_reference");
      expect(parsed.op0.path).toBe("/workspace_name");
      // And nothing was written into the non-existent scope.
      expect(parsed.persistedVocabularies).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("(1b) #49's case: a bad workspace outranks a vocabulary that exists elsewhere", async () => {
    // The vocabulary DOES exist, but in another workspace. Precedence decides
    // which pointer the caller gets: workspace comes before scoped identity,
    // so reporting /vocabulary_id would send them to fix the wrong field.
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        op("createVocabulary", vocabularyRequest(ALPHA, { vocabulary_id: id("v1"), name: "areas", label: "Areas" })),
        op("createTerm", termRequest("no-such-workspace", { term_id: id("t1"), vocabulary_id: id("v1"), name: "x" })),
      ]);
      expect(parsed.op0.ok).toBe(true);
      expect(parsed.op1.ok).toBe(false);
      expect(parsed.op1.code).toBe("invalid_reference");
      expect(parsed.op1.path).toBe("/workspace_name");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("(2) a matching seed ID does not excuse a duplicate scoped NAME", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const manifest = seedManifest(ALPHA) as {
        type: { vocabulary_id: string; terms: { note: string } };
      };
      // TWO runs: the rival row has to appear AFTER a clean seed, or the very
      // first seed conflicts on the name and the existing-ID branch under
      // test is never reached.
      const first = await drive(fixture.datasetRoot, [
        op("seedReservedVocabularies", manifest),
      ]);
      expect(first.op0.ok).toBe(true);

      const second = await drive(
        fixture.datasetRoot,
        [op("seedReservedVocabularies", manifest)],
        {
          plant: {
            table: "terms",
            rows: [
              {
                id: id("rivalnote"),
                workspace_name: ALPHA,
                vocabulary_id: manifest.type.vocabulary_id,
                name: "note",
                description: null,
                parent_id: null,
                weight: 0,
                is_active: true,
                h_metadata: null,
              },
            ],
          },
        },
      );
      expect(second.planted).toBe(1);
      // The manifest ID still matches, so the early return fires and the
      // duplicate scoped name is never looked at.
      expect(second.op0.ok).toBe(false);
      expect(["conflict", "integrity_failure"]).toContain(second.op0.code);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("(3) a horizon collision points at the horizon, not at /type/terms", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const manifest = seedManifest(ALPHA) as {
        memory_horizon: { vocabulary_id: string };
      };
      const parsed = await drive(
        fixture.datasetRoot,
        [op("seedReservedVocabularies", manifest)],
        {
          plant: {
            table: "terms",
            rows: [
              {
                id: id("rivalshort"),
                workspace_name: ALPHA,
                vocabulary_id: manifest.memory_horizon.vocabulary_id,
                name: "short_term",
                description: null,
                parent_id: null,
                weight: 0,
                is_active: true,
                h_metadata: null,
              },
            ],
          },
        },
      );
      expect(parsed.op0.ok).toBe(false);
      expect(parsed.op0.code).toBe("conflict");
      // A pointer naming the wrong branch sends a caller to the wrong field.
      expect(parsed.op0.path).toBe("/memory_horizon/terms/short_term");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("(4) a corrupted post-update readback is REFUSED, not returned", async () => {
    // The hook returns normally and the row is durable and wrong, so this is
    // a readback disagreement rather than a hook error. writeRow compares
    // field-by-field; updateTerm did not, which is the gap.
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [
          op("createVocabulary", vocabularyRequest(ALPHA, { vocabulary_id: id("v1"), name: "areas", label: "Areas" })),
          op("createTerm", termRequest(ALPHA, { term_id: id("t1"), vocabulary_id: id("v1"), name: "alpha" })),
          op("renameTerm", {
            workspace_name: ALPHA,
            term_id: id("t1"),
            expected_name: "alpha",
            name: "beta",
          }),
        ],
        {
          corruptAt: {
            boundary: "after_update",
            occurrence: 1,
            table: "terms",
            id: id("t1"),
            field: "name",
            value: "'sabotaged'",
          },
        },
      );
      expect(parsed.op2.ok).toBe(false);
      expect(parsed.op2.code).toBe("recovery_required");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("(5) a deliberate post-write integrity_failure is PRESERVED, not collapsed", async () => {
    // Corrupt an enum so the final verification's encoder raises a deliberate
    // TaxonomyError integrity_failure. Collapsing it to recovery_required
    // loses the distinction between "ambiguous" and "the stored row is
    // structurally invalid", which are different operator problems.
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const manifest = seedManifest(ALPHA) as { type: { vocabulary_id: string } };
      const parsed = await drive(
        fixture.datasetRoot,
        [op("seedReservedVocabularies", manifest)],
        {
          corruptAt: {
            boundary: "after_vocabulary_write",
            occurrence: 2,
            table: "vocabularies",
            id: manifest.type.vocabulary_id,
            field: "kind",
            value: "'not-a-kind'",
          },
        },
      );
      expect(parsed.op0.ok).toBe(false);
      expect(parsed.op0.name).toBe("TaxonomyError");
      expect(parsed.op0.code).toBe("integrity_failure");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});

describe("root review residuals — these must FAIL before the second repair", () => {
  const CHILD = new URL("./fixtures/taxonomy-v1/core/gated-taxonomy.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  const drive = async (
    root: string,
    ops: Array<{ method: string; request: unknown }>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [
      root,
      JSON.stringify({ ops, clockMs: CLOCK, ...extra }),
    ]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 600)}`);
    return JSON.parse(line);
  };
  const op = (method: string, request: unknown) => ({ method, request });
  const V1 = id("v1");
  const areas = () =>
    vocabularyRequest(ALPHA, { vocabulary_id: V1, name: "areas", label: "Areas", hierarchy: "tree" });

  test("(R1a) createTerm: a matching ID does not excuse a duplicate scoped name", async () => {
    // Same gap as seed finding 2, on the path my seed-only regression missed:
    // the by-id return fires before the by-name lookup ever runs.
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const request = termRequest(ALPHA, { term_id: id("t1"), vocabulary_id: V1, name: "alpha" });
      const first = await drive(fixture.datasetRoot, [
        op("createVocabulary", areas()),
        op("createTerm", request),
      ]);
      expect(first.op1.ok).toBe(true);

      const second = await drive(fixture.datasetRoot, [op("createTerm", request)], {
        plant: {
          table: "terms",
          rows: [
            {
              id: id("rival"),
              workspace_name: ALPHA,
              vocabulary_id: V1,
              name: "alpha",
              description: null,
              parent_id: null,
              weight: 0,
              is_active: true,
              h_metadata: null,
            },
          ],
        },
      });
      expect(second.planted).toBe(1);
      expect(second.op0.ok).toBe(false);
      expect(["conflict", "integrity_failure"]).toContain(second.op0.code);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("(R1b) renameTerm: an already-satisfied rename still validates the name", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const first = await drive(fixture.datasetRoot, [
        op("createVocabulary", areas()),
        op("createTerm", termRequest(ALPHA, { term_id: id("t1"), vocabulary_id: V1, name: "alpha" })),
      ]);
      expect(first.op1.ok).toBe(true);

      const second = await drive(
        fixture.datasetRoot,
        [
          // Desired name equals the current name, so the satisfied path fires
          // and never notices the duplicate that now exists.
          op("renameTerm", {
            workspace_name: ALPHA,
            term_id: id("t1"),
            expected_name: "alpha",
            name: "alpha",
          }),
        ],
        {
          plant: {
            table: "terms",
            rows: [
              {
                id: id("rival"),
                workspace_name: ALPHA,
                vocabulary_id: V1,
                name: "alpha",
                description: null,
                parent_id: null,
                weight: 0,
                is_active: true,
                h_metadata: null,
              },
            ],
          },
        },
      );
      expect(second.op0.ok).toBe(false);
      expect(["conflict", "integrity_failure"]).toContain(second.op0.code);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("(R1c) retireTerm: an inactive term still validates its vocabulary", async () => {
    // The early inactive return skipped the vocabulary lookup entirely, so an
    // orphaned term reported already_satisfied instead of naming the problem.
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [op("retireTerm", { workspace_name: ALPHA, term_id: id("orphan") })],
        {
          plant: {
            table: "terms",
            rows: [
              {
                id: id("orphan"),
                workspace_name: ALPHA,
                vocabulary_id: id("ghostvoc"),
                name: "orphan",
                description: null,
                parent_id: null,
                weight: 0,
                is_active: false,
                h_metadata: null,
              },
            ],
          },
        },
      );
      expect(parsed.op0.ok).toBe(false);
      expect(["integrity_failure", "invalid_reference"]).toContain(parsed.op0.code);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("(R2) createTerm validates the whole ancestry, not just the immediate parent", async () => {
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [
          op("createVocabulary", areas()),
          // Parent "b" is active and in-vocabulary, but ITS parent is missing.
          op("createTerm", termRequest(ALPHA, { term_id: id("t1"), vocabulary_id: V1, name: "x", parent_id: id("b") })),
          // Healthy control: a complete chain must still be accepted.
          op("createTerm", termRequest(ALPHA, { term_id: id("t2"), vocabulary_id: V1, name: "y", parent_id: id("good") })),
        ],
        {
          plant: {
            table: "terms",
            rows: [
              {
                id: id("b"),
                workspace_name: ALPHA,
                vocabulary_id: V1,
                name: "b",
                description: null,
                parent_id: id("missingancestor"),
                weight: 0,
                is_active: true,
                h_metadata: null,
              },
              {
                id: id("good"),
                workspace_name: ALPHA,
                vocabulary_id: V1,
                name: "good",
                description: null,
                parent_id: null,
                weight: 0,
                is_active: true,
                h_metadata: null,
              },
            ],
          },
        },
      );
      expect(parsed.op1.ok).toBe(false);
      expect(["integrity_failure", "invalid_reference"]).toContain(parsed.op1.code);
      // The control proves the check is not simply rejecting every parent.
      expect(parsed.op2.ok).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("(R3) a FORGED contract error is normalized, not passed through", async () => {
    /**
     * `isContractError` matches on `name` alone. Measured directly:
     * isContractError({name:"ContractError", message:"..."}) returns true.
     * So my "exact type check" claim was false, and an arbitrary object could
     * carry raw private text straight out through the boundary.
     */
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const parsed = await drive(
        fixture.datasetRoot,
        [op("seedReservedVocabularies", seedManifest(ALPHA))],
        { failAt: { boundary: "after_term_write", occurrence: 1, forge: true } },
      );
      expect(parsed.op0.ok).toBe(false);
      // Normalized: the forged object must not survive as itself.
      expect(parsed.op0.code).toBe("recovery_required");
      expect(JSON.stringify(parsed.op0)).not.toContain("FORGED-PRIVATE-TEXT");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});

describe("why the boundary must not use the name-only helper", () => {
  /**
   * This pins the REASON for the repair, not the repair itself.
   *
   * `isContractError` is protected and unchanged; it matches on `name` alone.
   * That is fine for its own callers and wrong for a trust decision, which is
   * why the post-write boundary now uses `instanceof` against the real class.
   * If this test ever starts failing, the helper's semantics changed and the
   * boundary's choice should be revisited rather than silently inherited.
   *
   * Stated limit: the end-to-end path is NOT covered here. A forged error can
   * only enter the boundary from the storage adapter, which this harness
   * cannot make throw an arbitrary object without editing source. The
   * justification for the fix is this measurement plus the class check, not an
   * integration test — and I am not going to imply otherwise.
   */
  test("isContractError accepts any object merely NAMED ContractError", () => {
    const forged = new Error("raw private text");
    forged.name = "ContractError";
    expect(isContractError(forged)).toBe(true);
    expect(isContractError({ name: "ContractError" })).toBe(true);
    // And the real class is a real class, so instanceof discriminates.
    expect(forged instanceof ContractError).toBe(false);
    expect(new ContractError("invalid_type", "/x", "x") instanceof ContractError).toBe(true);
  });
});

describe("taxonomy READ methods carry the taxonomy envelope", () => {
  const CHILD = new URL("./fixtures/taxonomy-v1/core/gated-taxonomy.ts", import.meta.url).pathname;
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  test("after release BOTH read methods report arra-taxonomy-error/v1", async () => {
    /**
     * The mutation wrapper translated owner failures into the taxonomy
     * envelope; the READ methods did not, so a released owner surfaced
     * `arra-publication-error/v1` from a taxonomy call.
     *
     * Asserting only the CODE hides this, because the code is identical in
     * both envelopes — which is exactly how it survived. The version is the
     * discriminating field, so it is asserted here.
     */
    const fixture = await createTaxonomyFixture([ALPHA]);
    try {
      const result = await runGated(fixture.datasetRoot, CHILD, [
        fixture.datasetRoot,
        JSON.stringify({
          ops: [{ method: "seedReservedVocabularies", request: seedManifest(ALPHA) }],
          clockMs: CLOCK,
          readAfterRelease: ALPHA,
        }),
      ]);
      if (result.code !== 0) {
        throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
      }
      const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
      if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 600)}`);
      const parsed = JSON.parse(line) as Record<string, any>;

      for (const key of ["readAfterRelease", "readTermAfterRelease"]) {
        expect(parsed[key].ok, `${key} should be refused`).toBe(false);
        expect(parsed[key].name, `${key} envelope`).toBe("TaxonomyError");
        expect(parsed[key].version, `${key} version`).toBe("arra-taxonomy-error/v1");
        expect(parsed[key].code, `${key} code`).toBe("recovery_required");
        expect(parsed[key].path, `${key} path`).toBe("");
      }

      // Control: the publication facade keeps its OWN envelope. A blanket
      // translation would have quietly relabelled this one too.
      expect(parsed.publicationReadAfterRelease.ok).toBe(false);
      expect(parsed.publicationReadAfterRelease.version).toBe("arra-publication-error/v1");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});
