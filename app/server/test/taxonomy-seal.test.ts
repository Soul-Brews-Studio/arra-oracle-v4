// #27 / R6: a sealed vocabulary is sealed on every transport.
//
// The reopen comment on #27 showed `createTerm` minting `invented_type` inside
// the sealed, reserved `type` vocabulary over a live server. This file pins
// the ruling (docs/overnight/DECISIONS.md R6) at both layers that matter:
//
//   * the kernel: every writer factory, opened WITHOUT trusted operator
//     configuration, refuses `createTerm`, `renameTerm`, `retireTerm` and
//     `reparentTerm` on a sealed vocabulary with
//     `arra-taxonomy-error/v1 invalid_request` (at `/vocabulary_id` for
//     creation, `/term_id` for the three lifecycle mutations), and the
//     operator path (`taxonomyOperator: true`) still works in-process;
//   * the wire: the REAL `createApp` + `createKnowledgeAccess` + MCP adapter
//     refuse the same four for a `content:write` principal, over HTTP and MCP.
//
// And the two ways around the seal an independent verifier found in the
// first cut, both reachable by any `content:write` caller:
//
//   * B1: `createVocabulary` with `term_policy: sealed`. Nobody but the
//     operator can add a term to it, so a sealed AND required one made every
//     later publish in the workspace fail, with no transport able to undo it.
//     Ordinary callers can no longer create a sealed vocabulary at all.
//   * B2: `seedReservedVocabularies` naming a NEW id for a reserved name that
//     a rename had freed. The seed appended a sixth term to the sealed `type`
//     vocabulary. A seed may no longer append a term to a sealed vocabulary
//     that already exists, except under trusted operator configuration.
//
// It also pins the refusal PRECEDENCE recorded in taxonomy-write-v1.md's R6
// amendment, so a later reordering shows up here rather than in production.
//
// Real gated children and real persistence, the same harness every other
// taxonomy lane uses. Expected values are authored from the ruling and the
// contract, never read back from the kernel.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PYTHON, runGated } from "./helpers/publication-fixture";
import { createTaxonomyFixture } from "./helpers/taxonomy-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";
import { scaledMs } from "./helpers/timing.scaledMs";

const CHILD = join(import.meta.dir, "fixtures", "taxonomy-v1", "seal", "seal-child.ts");
const TEST_TIMEOUT_MS = testTimeout(180_000);

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/taxonomy-v1/seal/seal-child.ts");

test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});

const runIt = MISSING.length > 0 ? test.skip : test;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  const failures: string[] = [];
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch((error: unknown) => failures.push(String(error)));
  }
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join(" | ")}`);
});

async function freshDataset(): Promise<string> {
  const fixture = await createTaxonomyFixture(["alpha-workspace", "beta-workspace"]);
  cleanups.push(fixture.cleanup);
  return fixture.datasetRoot;
}

type Events = Map<string, any>;

async function drive(root: string, mode: string): Promise<Events> {
  const workDir = await mkdtemp(join(tmpdir(), "arra-v4-taxonomy-seal-"));
  cleanups.push(() => rm(workDir, { recursive: true, force: true }));
  const result = await runGated(root, CHILD, [mode, root, workDir], { deadlineMs: scaledMs(120_000) });
  expect({ mode, code: result.code, stderr: result.stderr.slice(-800) }).toEqual({ mode, code: 0, stderr: "" });
  const events: Events = new Map();
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("EVENT ")) continue;
    const rest = line.slice("EVENT ".length);
    const space = rest.indexOf(" ");
    events.set(rest.slice(0, space), JSON.parse(rest.slice(space + 1)));
  }
  expect(events.has("done")).toBe(true);
  return events;
}

/** One child run per mode, shared by the tests that read it: each run is a
 *  fresh dataset and a gated process, and several tests only read different
 *  lines of the same run. The operator first creates the sealed
 *  `house-rules` vocabulary, since an ordinary caller no longer can (B1). */
const runs = new Map<string, Promise<Events>>();
const shared = (mode: string): Promise<Events> => {
  let run = runs.get(mode);
  if (run === undefined) {
    run = freshDataset().then(async (root) => {
      const setup = await drive(root, "operator-rules");
      expect(setup.get("setup:rules")?.value?.outcome).toBe("created");
      return drive(root, mode);
    });
    runs.set(mode, run);
  }
  return run;
};

const at = (events: Events, label: string) => {
  if (!events.has(label)) throw new Error(`no event ${label}; saw ${[...events.keys()].join(", ")}`);
  return events.get(label);
};

/** The one seal refusal: fixed code, fixed message, and the pointer R6 names:
 *  `/vocabulary_id` or `/term_id` for the four term mutators, `/term_policy`
 *  for createVocabulary, and the manifest pointer for the seed. */
const SEALED = (path: string) => ({
  version: "arra-taxonomy-error/v1",
  code: "invalid_request",
  path,
  message: "invalid taxonomy request",
});
const taxonomyError = (code: string, path: string) => ({
  version: "arra-taxonomy-error/v1",
  code,
  path,
  message: expect.any(String),
});

const refused = (events: Events, label: string, error: unknown) =>
  expect({ label, event: at(events, label) }).toEqual({ label, event: { ok: false, error } });
const outcome = (events: Events, label: string, expected: string) =>
  expect({ label, outcome: at(events, label)?.value?.outcome }).toEqual({ label, outcome: expected });

// ── kernel ───────────────────────────────────────────────────────────────────

describe("kernel: an ordinary writer cannot change a sealed vocabulary", () => {
  runIt(
    "createTerm, renameTerm, retireTerm and reparentTerm on a sealed vocabulary are refused, and nothing moves",
    async () => {
      const events = await shared("kernel");
      outcome(events, "seed", "created");

      // The #27 reopen case, and its memory_horizon twin.
      refused(events, "create:type", SEALED("/vocabulary_id"));
      expect(at(events, "get:invented")).toEqual({ ok: true, value: null });
      refused(events, "create:horizon", SEALED("/vocabulary_id"));

      // Reserved lifecycle is sealed too (the reopen's R1 and R6 repro lines).
      refused(events, "rename:reserved", SEALED("/term_id"));
      refused(events, "retire:reserved", SEALED("/term_id"));
      refused(events, "reparent:reserved", SEALED("/term_id"));

      // term_policy is the rule, not the reserved names: the operator's
      // `house-rules` vocabulary is sealed as well.
      refused(events, "sealed:create", SEALED("/vocabulary_id"));

      // Nothing moved: names, activity and the vocabulary policy are as seeded.
      expect(at(events, "get:discussion").value).toMatchObject({ name: "discussion", is_active: true });
      expect(at(events, "get:note").value).toMatchObject({ name: "note", is_active: true });
      expect(at(events, "get:learning").value).toMatchObject({ name: "learning", is_active: true, parent_id: null });
      expect(at(events, "get:type-vocabulary").value).toMatchObject({ name: "type", term_policy: "sealed" });
    },
    TEST_TIMEOUT_MS,
  );

  runIt(
    "B1: an ordinary caller cannot create a sealed vocabulary, required or not, so it cannot wedge publication",
    async () => {
      const events = await shared("kernel");
      refused(events, "sealed:vocabulary", SEALED("/term_policy"));
      refused(events, "sealed:vocabulary-optional", SEALED("/term_policy"));
      expect(at(events, "get:gate")).toEqual({ ok: true, value: null });
      // An open vocabulary is still the caller's to create (the control below).
      outcome(events, "open:vocabulary", "created");
    },
    TEST_TIMEOUT_MS,
  );

  runIt(
    "an open vocabulary still accepts all four on the same owner, so a seal refusal never poisons it",
    async () => {
      const events = await shared("kernel");
      outcome(events, "open:vocabulary", "created");
      outcome(events, "open:create-a", "created");
      outcome(events, "open:create-b", "created");
      outcome(events, "open:rename", "updated");
      outcome(events, "open:reparent", "updated");
      outcome(events, "open:retire", "updated");
    },
    TEST_TIMEOUT_MS,
  );

  runIt(
    "refusal precedence: request, workspace, target, references and structure outrank the seal; the seal outranks collisions and already_satisfied",
    async () => {
      const events = await shared("kernel");
      // 1. Request validity: the closed shape rejects an operator flag in the
      //    bytes before anything else. Request data can never select the operator.
      refused(events, "precedence:request", {
        version: "arra-error/v1",
        code: "unexpected_field",
        path: "/taxonomyOperator",
        message: expect.any(String),
      });
      // 2. Workspace, then 3. the scoped target (the vocabulary for creation,
      //    the term for lifecycle), both before the seal.
      refused(events, "precedence:workspace", taxonomyError("invalid_reference", "/workspace_name"));
      refused(events, "precedence:vocabulary-ref", taxonomyError("invalid_reference", "/vocabulary_id"));
      refused(events, "precedence:rename-absent", taxonomyError("not_found", "/term_id"));
      refused(events, "precedence:retire-absent", taxonomyError("not_found", "/term_id"));
      // 4. Requested parent structure outranks the seal (the flat reserved
      //    vocabularies take no parent). taxonomy-ownership's "flat-parent"
      //    case pins the same order for an ordinary owner.
      refused(events, "precedence:parent", taxonomyError("invalid_request", "/parent_id"));
      refused(events, "precedence:reparent-flat-parent", taxonomyError("invalid_request", "/parent_id"));
      // 5. The seal outranks every collision, expected-value guard and
      //    already_satisfied shortcut: a sealed vocabulary answers "sealed",
      //    never "that name is taken" or "already done".
      refused(events, "precedence:name-collision", SEALED("/vocabulary_id"));
      refused(events, "precedence:replay", SEALED("/vocabulary_id"));
      refused(events, "precedence:rename-collision", SEALED("/term_id"));
      refused(events, "precedence:rename-stale", SEALED("/term_id"));
      refused(events, "precedence:rename-satisfied", SEALED("/term_id"));
      // createVocabulary: request validity (a reserved name is refused by the
      // parser) and the workspace outrank the seal; the seal outranks both
      // collisions and the already_satisfied replay of an operator-made
      // sealed vocabulary.
      refused(events, "precedence:vocabulary-reserved", SEALED("/name"));
      refused(events, "precedence:vocabulary-workspace", taxonomyError("invalid_reference", "/workspace_name"));
      refused(events, "precedence:vocabulary-id-collision", SEALED("/term_policy"));
      refused(events, "precedence:vocabulary-name-collision", SEALED("/term_policy"));
      refused(events, "precedence:vocabulary-replay", SEALED("/term_policy"));
    },
    TEST_TIMEOUT_MS,
  );

  runIt(
    "every writer factory refuses by default; only trusted configuration opens the operator path",
    async () => {
      const root = await freshDataset();
      const knowledge = await drive(root, "opener:knowledge");
      outcome(knowledge, "seed", "created");
      refused(knowledge, "create:type", SEALED("/vocabulary_id"));
      refused(await drive(root, "opener:context"), "create:type", SEALED("/vocabulary_id"));
      // The transport's own factory (createKnowledgeAccess opens this one).
      refused(await drive(root, "opener:evidence"), "create:type", SEALED("/vocabulary_id"));
      outcome(await drive(root, "opener:evidence-operator"), "create:type", "created");
    },
    TEST_TIMEOUT_MS,
  );

  runIt(
    "the in-process operator can still extend and administer a sealed vocabulary, and what it adds is sealed for everyone else",
    async () => {
      const root = await freshDataset();
      const operator = await drive(root, "operator");
      outcome(operator, "seed", "created");
      outcome(operator, "create:type", "created");
      outcome(operator, "rename:reserved", "updated");
      outcome(operator, "sealed:vocabulary", "created");
      outcome(operator, "sealed:create-1", "created");
      outcome(operator, "sealed:create-2", "created");
      outcome(operator, "sealed:reparent", "updated");

      const ordinary = await drive(root, "ordinary-after-operator");
      refused(ordinary, "rename:operator-term", SEALED("/term_id"));
      refused(ordinary, "retire:operator-term", SEALED("/term_id"));
      refused(ordinary, "reparent:sealed-tree", SEALED("/term_id"));
      refused(ordinary, "retire:sealed-tree", SEALED("/term_id"));
      expect(at(ordinary, "get:rule2").value).toMatchObject({ name: "rule-2", is_active: true });
    },
    TEST_TIMEOUT_MS,
  );
});

// ── the wire ─────────────────────────────────────────────────────────────────

describe("transport: HTTP and MCP refuse a content:write principal", () => {
  runIt(
    "the #27 reopen repro over the real app: sealed writes refused on HTTP and MCP, open writes accepted, nothing persisted",
    async () => {
      const events = await shared("transport");
      expect(at(events, "http:seed")).toMatchObject({ status: 200, body: { outcome: "created" } });

      // HTTP: 400 with the exact taxonomy envelope, never 200 created.
      expect(at(events, "http:create:type")).toEqual({ status: 400, body: SEALED("/vocabulary_id") });
      expect(at(events, "http:create:horizon")).toEqual({ status: 400, body: SEALED("/vocabulary_id") });
      expect(at(events, "http:rename:reserved")).toEqual({ status: 400, body: SEALED("/term_id") });
      expect(at(events, "http:retire:reserved")).toEqual({ status: 400, body: SEALED("/term_id") });
      expect(at(events, "http:reparent:reserved")).toEqual({ status: 400, body: SEALED("/term_id") });
      expect(at(events, "http:sealed:create")).toEqual({ status: 400, body: SEALED("/vocabulary_id") });
      expect(at(events, "http:get:invented")).toEqual({ status: 200, body: null });
      expect(at(events, "http:get:discussion").body).toMatchObject({ name: "discussion", is_active: true });
      expect(at(events, "http:get:note").body).toMatchObject({ name: "note", is_active: true });

      // MCP: the same envelope, carried as a tool error.
      for (const [label, path] of [
        ["mcp:create:type", "/vocabulary_id"],
        ["mcp:create:horizon", "/vocabulary_id"],
        ["mcp:rename:reserved", "/term_id"],
        ["mcp:retire:reserved", "/term_id"],
        ["mcp:reparent:reserved", "/term_id"],
        ["mcp:sealed:create", "/vocabulary_id"],
        ["mcp:sealed:vocabulary", "/term_policy"],
      ] as const) {
        expect({ label, event: at(events, label) }).toEqual({
          label,
          event: { status: 200, isError: true, value: SEALED(path) },
        });
      }

      // Positive controls on both transports: an open vocabulary still works.
      expect(at(events, "http:open:vocabulary")).toMatchObject({ status: 200, body: { outcome: "created" } });
      expect(at(events, "http:open:create")).toMatchObject({ status: 200, body: { outcome: "created" } });
      expect(at(events, "mcp:open:create")).toMatchObject({ status: 200, isError: false, value: { outcome: "created" } });
      // An admitted MCP call that the seal refuses is an audited operation
      // outcome (status error), not a permission denial.
      expect(at(events, "audit:tools")).toEqual(expect.arrayContaining(["kb_createTerm error", "kb_createTerm ok"]));

      // Independent of the service: the physical terms table holds exactly
      // the literal reserved terms, nothing invented, nothing renamed or retired.
      expect(at(events, "raw:terms")).toEqual({
        type: ["conclusion", "correction", "discussion", "learning", "note"],
        memory_horizon: ["long_term", "short_term"],
        rules: [],
      });
    },
    TEST_TIMEOUT_MS,
  );

  runIt(
    "B1 over the wire: a sealed+required vocabulary is refused and the workspace stays publishable",
    async () => {
      const events = await shared("transport");
      expect(at(events, "http:publish:before")).toMatchObject({ status: 200, body: { outcome: "accepted" } });
      expect(at(events, "http:sealed:vocabulary")).toEqual({ status: 400, body: SEALED("/term_policy") });
      expect(at(events, "http:get:gate")).toEqual({ status: 200, body: null });
      // The verifier's S3: this was 400 invalid_request once the gate existed.
      expect(at(events, "http:publish:after")).toMatchObject({ status: 200, body: { outcome: "accepted" } });
    },
    TEST_TIMEOUT_MS,
  );

  runIt(
    "wire precedence: authentication and authorization outrank the seal, and request bytes cannot select the operator",
    async () => {
      const events = await shared("transport");
      expect(at(events, "http:anonymous:create:type").status).toBe(401);
      expect(at(events, "http:reader:create:type").status).toBe(403);
      expect(at(events, "mcp:reader:create:type").status).toBe(403);
      expect(at(events, "http:request-selects-operator")).toEqual({
        status: 400,
        body: { version: "arra-error/v1", code: "unexpected_field", path: "/taxonomyOperator", message: expect.any(String) },
      });
    },
    TEST_TIMEOUT_MS,
  );

  runIt(
    "the literal bootstrap stays reachable and cannot extend a sealed vocabulary",
    async () => {
      const events = await shared("transport");
      expect(at(events, "http:seed:replay")).toMatchObject({ status: 200, body: { outcome: "already_satisfied" } });
      // Another id for a reserved name is a conflict, never a sixth type term.
      expect(at(events, "http:seed:extend")).toMatchObject({
        status: 409,
        body: { version: "arra-taxonomy-error/v1", code: "conflict" },
      });
    },
    TEST_TIMEOUT_MS,
  );
});

// ── B2: the seed cannot append to a sealed vocabulary that already exists ────

describe("seed: a renamed reserved name cannot be re-seeded under a new id", () => {
  runIt(
    "refused on the kernel, HTTP and MCP; the seed's own conflicts come first; the operator can still resume",
    async () => {
      const root = await freshDataset();
      const setup = await drive(root, "operator-rename");
      outcome(setup, "seed", "created");
      outcome(setup, "rename:learning", "updated");

      // Kernel: the new id for `learning` would be a sixth `type` term.
      const kernel = await drive(root, "reseed-kernel");
      refused(kernel, "reseed:new-id", SEALED("/type/terms/learning"));
      expect(at(kernel, "reseed:get")).toEqual({ ok: true, value: null });
      // Precedence inside the seed: every manifest conflict outranks the seal,
      // even one listed after the row the seal would refuse.
      refused(kernel, "reseed:original", taxonomyError("conflict", "/type/terms/learning"));
      refused(kernel, "reseed:conflict-first", taxonomyError("conflict", "/type/terms/correction"));

      // The wire: the verifier's T2..T4, now refused with nothing persisted.
      const wire = await drive(root, "reseed-transport");
      expect(at(wire, "http:reseed")).toEqual({ status: 400, body: SEALED("/type/terms/learning") });
      expect(at(wire, "mcp:reseed")).toEqual({ status: 200, isError: true, value: SEALED("/type/terms/learning") });
      expect(at(wire, "http:get:new-learning")).toEqual({ status: 200, body: null });
      // A typed revision naming the refused id has nothing to resolve against.
      expect(at(wire, "http:publish:new-learning")).toMatchObject({ status: 400, body: { code: "invalid_reference" } });
      expect(at(wire, "raw:terms")).toEqual({
        type: ["conclusion", "correction", "discussion", "lesson", "note"],
        memory_horizon: ["long_term", "short_term"],
        rules: [],
      });

      // The frozen resume clause survives for trusted configuration only.
      const operator = await drive(root, "operator-reseed");
      outcome(operator, "reseed:new-id", "created");
      expect(at(operator, "reseed:get").value).toMatchObject({ name: "learning", is_active: true, vocabulary_id: expect.any(String) });
    },
    TEST_TIMEOUT_MS,
  );
});
