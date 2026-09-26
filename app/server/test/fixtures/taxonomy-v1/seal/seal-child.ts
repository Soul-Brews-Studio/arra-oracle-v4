// #27 / R6 seal child — one gated program, selected by mode.
//
// Runs inside a process that genuinely holds the writer gate (`runGated`,
// fd 42), against a disposable nineteen-table dataset built by the #48
// exporter. It never asserts: it prints one `EVENT <label> <json>` line per
// step, and `taxonomy-seal.test.ts` owns every expectation. Modes:
//
//   operator-rules
//               trusted setup: the operator creates the sealed `house-rules`
//               vocabulary, which an ordinary caller can no longer create.
//   kernel      the ordinary writer factory, opened with NO operator
//               configuration: every refusal, its precedence, and the open
//               vocabulary controls that prove the owner stays usable.
//   operator    the same factory opened with trusted `taxonomyOperator: true`
//               (the only way to extend a sealed vocabulary; R6).
//   ordinary-after-operator
//               an ordinary owner over the operator's dataset: terms the
//               operator added are sealed exactly like the seeded ones.
//   opener:*    each writer factory refuses by DEFAULT (one process each).
//   transport   the REAL `createApp` + `createKnowledgeAccess` + MCP adapter,
//               driven only through `Request` objects, HTTP and MCP both.
//   operator-rename, reseed-kernel, reseed-transport, operator-reseed
//               the re-seed hole: once a reserved term is renamed, its
//               literal name is free, and a seed naming a NEW id for it would
//               append a sixth term to the sealed `type` vocabulary.
//
// See docs/overnight/DECISIONS.md R6 and taxonomy-write-v1.md's R6 amendment.

import { connect } from "@lancedb/lancedb";
import { openContextWriter, openEvidenceWriter, openKnowledgeWriter } from "../../../../src/publication/service";
import { encodeRequest, seedManifest, termRequest, vocabularyRequest } from "../../../helpers/taxonomy-fixture";
import { openSealWire } from "./openSealWire";

const [, , mode, root, workDir] = process.argv as [string, string, string, string, string];

const WORKSPACE = "alpha-workspace";
const CLOCK_MS = 1_789_905_600_000;
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

// The helper's default manifest ids, named here so the requests read plainly.
const IDS = {
  type: pad("typevoc"),
  horizon: pad("horvoc"),
  note: pad("tnote"),
  learning: pad("tlearn"),
  discussion: pad("tdisc"),
  rules: pad("rulesvoc"),
  open: pad("openvoc"),
  gate: pad("gatevoc"),
  newLearning: pad("newlearn"),
};

const say = (label: string, value: unknown) => console.log(`EVENT ${label} ${JSON.stringify(value)}`);
const envelope = (error: unknown) =>
  typeof (error as { toJSON?: unknown })?.toJSON === "function"
    ? (error as { toJSON(): unknown }).toJSON()
    : { thrown: String(error) };
async function settle(label: string, promise: Promise<unknown>): Promise<void> {
  try {
    say(label, { ok: true, value: await promise });
  } catch (error) {
    say(label, { ok: false, error: envelope(error) });
  }
}

const invented = (slug: string) =>
  termRequest(WORKSPACE, { term_id: pad(slug), vocabulary_id: IDS.type, name: "invented_type" });
const midTerm = (slug: string) =>
  termRequest(WORKSPACE, { term_id: pad(slug), vocabulary_id: IDS.horizon, name: "mid_term" });
const userSealedVocabulary = vocabularyRequest(WORKSPACE, {
  vocabulary_id: IDS.rules,
  name: "house-rules",
  label: "House rules",
  term_policy: "sealed",
  hierarchy: "tree",
});
// The verifier's B1 shape: sealed AND required. Created by an ordinary caller
// it could never hold a term, so every later publish in the workspace would
// fail its required-vocabulary check.
const gateVocabulary = vocabularyRequest(WORKSPACE, {
  vocabulary_id: IDS.gate,
  name: "gate",
  label: "Gate",
  kind: "categories",
  term_policy: "sealed",
  cardinality: "one",
  required: true,
});
const openVocabulary = vocabularyRequest(WORKSPACE, { vocabulary_id: IDS.open, name: "topics", hierarchy: "tree" });
const rename = (termId: string, expected: string, name: string) => ({
  workspace_name: WORKSPACE,
  term_id: termId,
  expected_name: expected,
  name,
});
const reparent = (termId: string, expected: string | null, parent: string | null) => ({
  workspace_name: WORKSPACE,
  term_id: termId,
  expected_parent_id: expected,
  parent_id: parent,
});
const byId = (termId: string) => ({ workspace_name: WORKSPACE, term_id: termId });
const vocabularyById = (vocabularyId: string) => ({ workspace_name: WORKSPACE, vocabulary_id: vocabularyId });
// The re-seed hole: the literal manifest, except `learning` under a new id.
const reseedManifest = (ids: Record<string, string> = {}) => seedManifest(WORKSPACE, { learning: IDS.newLearning, ...ids });

// A minimal typed revision: exactly one `type` term, nothing else.
const typed = (termId: string, name: string) => ({
  term_id: termId,
  vocabulary_id: IDS.type,
  vocabulary_name_snapshot: "type",
  term_name_snapshot: name,
  label_snapshot: null,
  position: "0",
});
const publish = (slug: string, terms: unknown[]) => ({
  operation_id: pad(`op${slug}`),
  content: {
    workspace_name: WORKSPACE,
    node_id: pad(`node${slug}`),
    base_revision_id: null,
    title: "t",
    body: "b",
    body_format: "markdown",
    fields: "{}",
    author_peer_name: null,
    observer_peer_name: null,
    subject_peer_name: null,
    session_name: null,
    is_active: true,
    valid_from: null,
    valid_to: null,
    change_reason: null,
    schema_version: "1",
    canonical_version: "arra-revision/v1",
    term_snapshot_json: JSON.stringify(terms),
    link_snapshot_json: "[]",
    h_metadata: null,
    internal_metadata: null,
  },
});

const baseOptions = { newRevisionId: () => "r".repeat(21), clock: () => CLOCK_MS };
const operatorOptions = { ...baseOptions, taxonomyOperator: true };

type Taxonomy = Awaited<ReturnType<typeof openKnowledgeWriter>>["taxonomy"];
type TaxonomyMethod = keyof Taxonomy;
const call = (taxonomy: Taxonomy, method: TaxonomyMethod, body: unknown) =>
  (taxonomy[method] as (bytes: Uint8Array) => Promise<unknown>)(encodeRequest(body));

/** One owner per process: a closed owner releases the gate descriptor with
 *  it, so a same-process reopen is refused by design. */
async function withOwner(options: Parameters<typeof openKnowledgeWriter>[1], steps: (t: Taxonomy) => Promise<void>): Promise<void> {
  const bundle = await openKnowledgeWriter(root, options);
  try {
    await steps(bundle.taxonomy);
  } finally {
    await bundle.close();
  }
}

/** Independent of the service: what the terms table physically holds. */
async function rawTerms(): Promise<Record<string, string[]>> {
  const table = await (await connect(root)).openTable("terms");
  const rows = await table.query().where(`workspace_name = '${WORKSPACE}'`).toArray();
  const namesIn = (vocabularyId: string) =>
    rows
      .filter((row) => row.vocabulary_id === vocabularyId)
      .map((row) => `${row.name}${row.is_active === true ? "" : " (retired)"}`)
      .sort();
  return { type: namesIn(IDS.type), memory_horizon: namesIn(IDS.horizon), rules: namesIn(IDS.rules) };
}

if (mode === "operator-rules") {
  // Trusted setup only. R6 closes sealed-vocabulary creation to ordinary
  // callers, so the caller-policy cases below need the operator to make one.
  await withOwner(operatorOptions, async (t) => {
    await settle("setup:rules", call(t, "createVocabulary", userSealedVocabulary));
  });
}

if (mode === "kernel") {
  await withOwner(baseOptions, async (t) => {
    await settle("seed", call(t, "seedReservedVocabularies", seedManifest(WORKSPACE)));

    // The four refused operations on the two reserved sealed vocabularies.
    await settle("create:type", call(t, "createTerm", invented("invented")));
    await settle("get:invented", call(t, "getTerm", byId(pad("invented"))));
    await settle("create:horizon", call(t, "createTerm", midTerm("midterm")));
    await settle("rename:reserved", call(t, "renameTerm", rename(IDS.discussion, "discussion", "debate")));
    await settle("retire:reserved", call(t, "retireTerm", byId(IDS.note)));
    await settle("reparent:reserved", call(t, "reparentTerm", reparent(IDS.learning, null, null)));

    // B1: an ordinary caller cannot create a sealed vocabulary at all,
    // required or not. It could never hold a term.
    await settle("sealed:vocabulary", call(t, "createVocabulary", gateVocabulary));
    await settle(
      "sealed:vocabulary-optional",
      call(t, "createVocabulary", { ...gateVocabulary, vocabulary_id: pad("optvoc"), name: "optional", required: false }),
    );
    await settle("get:gate", call(t, "getVocabulary", vocabularyById(IDS.gate)));
    // The operator-made `house-rules` is sealed the same way as `type`.
    await settle(
      "sealed:create",
      call(t, "createTerm", termRequest(WORKSPACE, { term_id: pad("rule1"), vocabulary_id: IDS.rules, name: "rule-1" })),
    );

    // Precedence, earlier steps first. Each request is otherwise a sealed
    // write, so each line says which check outranks the seal.
    await settle("precedence:request", call(t, "createTerm", { ...invented("pre1"), taxonomyOperator: true }));
    await settle("precedence:workspace", call(t, "createTerm", { ...invented("pre2"), workspace_name: "no-such-workspace" }));
    await settle("precedence:vocabulary-ref", call(t, "createTerm", { ...invented("pre3"), vocabulary_id: pad("novoc") }));
    await settle("precedence:parent", call(t, "createTerm", { ...invented("pre4"), parent_id: IDS.note }));
    await settle("precedence:name-collision", call(t, "createTerm", { ...invented("pre5"), name: "note" }));
    await settle(
      "precedence:replay",
      call(t, "createTerm", termRequest(WORKSPACE, { term_id: IDS.note, vocabulary_id: IDS.type, name: "note" })),
    );
    await settle("precedence:rename-absent", call(t, "renameTerm", rename(pad("ghost"), "a", "b")));
    await settle("precedence:rename-collision", call(t, "renameTerm", rename(IDS.discussion, "discussion", "note")));
    await settle("precedence:rename-stale", call(t, "renameTerm", rename(IDS.discussion, "wrong", "debate")));
    await settle("precedence:rename-satisfied", call(t, "renameTerm", rename(IDS.discussion, "x", "discussion")));
    await settle("precedence:retire-absent", call(t, "retireTerm", byId(pad("ghost"))));
    await settle("precedence:reparent-flat-parent", call(t, "reparentTerm", reparent(IDS.learning, null, IDS.note)));
    // createVocabulary: request validity (a reserved name) and the workspace
    // outrank the seal; the seal outranks every collision and the
    // already_satisfied replay of the operator's own sealed vocabulary.
    await settle("precedence:vocabulary-reserved", call(t, "createVocabulary", { ...gateVocabulary, name: "type" }));
    await settle(
      "precedence:vocabulary-workspace",
      call(t, "createVocabulary", { ...gateVocabulary, workspace_name: "no-such-workspace" }),
    );
    await settle("precedence:vocabulary-id-collision", call(t, "createVocabulary", { ...gateVocabulary, vocabulary_id: IDS.type }));
    await settle("precedence:vocabulary-name-collision", call(t, "createVocabulary", { ...gateVocabulary, name: "house-rules" }));
    await settle("precedence:vocabulary-replay", call(t, "createVocabulary", userSealedVocabulary));

    // Nothing moved.
    await settle("get:discussion", call(t, "getTerm", byId(IDS.discussion)));
    await settle("get:note", call(t, "getTerm", byId(IDS.note)));
    await settle("get:learning", call(t, "getTerm", byId(IDS.learning)));
    await settle("get:type-vocabulary", call(t, "getVocabulary", vocabularyById(IDS.type)));

    // Controls: an OPEN vocabulary still takes all four, on the same owner
    // that just refused everything above (a pre-write refusal never poisons).
    await settle("open:vocabulary", call(t, "createVocabulary", openVocabulary));
    await settle(
      "open:create-a",
      call(t, "createTerm", termRequest(WORKSPACE, { term_id: pad("opena"), vocabulary_id: IDS.open, name: "a" })),
    );
    await settle(
      "open:create-b",
      call(t, "createTerm", termRequest(WORKSPACE, { term_id: pad("openb"), vocabulary_id: IDS.open, name: "b" })),
    );
    await settle("open:rename", call(t, "renameTerm", rename(pad("opena"), "a", "a2")));
    await settle("open:reparent", call(t, "reparentTerm", reparent(pad("openb"), null, pad("opena"))));
    await settle("open:retire", call(t, "retireTerm", byId(pad("openb"))));
  });
}

if (mode === "operator") {
  // Trusted in-process configuration, never request bytes: the operator path
  // taxonomy-write-v1.md describes stays available here, and only here.
  await withOwner(operatorOptions, async (t) => {
    await settle("seed", call(t, "seedReservedVocabularies", seedManifest(WORKSPACE)));
    await settle("create:type", call(t, "createTerm", invented("invented")));
    await settle("rename:reserved", call(t, "renameTerm", rename(IDS.discussion, "discussion", "debate")));
    await settle("sealed:vocabulary", call(t, "createVocabulary", userSealedVocabulary));
    await settle(
      "sealed:create-1",
      call(t, "createTerm", termRequest(WORKSPACE, { term_id: pad("rule1"), vocabulary_id: IDS.rules, name: "rule-1" })),
    );
    await settle(
      "sealed:create-2",
      call(t, "createTerm", termRequest(WORKSPACE, { term_id: pad("rule2"), vocabulary_id: IDS.rules, name: "rule-2" })),
    );
    await settle("sealed:reparent", call(t, "reparentTerm", reparent(pad("rule2"), null, pad("rule1"))));
  });
}

if (mode === "ordinary-after-operator") {
  await withOwner(baseOptions, async (t) => {
    await settle("rename:operator-term", call(t, "renameTerm", rename(pad("invented"), "invented_type", "x")));
    await settle("retire:operator-term", call(t, "retireTerm", byId(pad("invented"))));
    await settle("reparent:sealed-tree", call(t, "reparentTerm", reparent(pad("rule2"), pad("rule1"), null)));
    await settle("retire:sealed-tree", call(t, "retireTerm", byId(pad("rule1"))));
    await settle("get:rule2", call(t, "getTerm", byId(pad("rule2"))));
  });
}

// One factory per process (see withOwner). The parent runs each of these on
// one dataset in turn; the seed is idempotent, so each can repeat it.
const OPENERS: Record<string, () => Promise<{ taxonomy: Taxonomy; close(): Promise<void> }>> = {
  "opener:knowledge": () => openKnowledgeWriter(root, baseOptions),
  "opener:context": () => openContextWriter(root, { ...baseOptions, sourceNamespace: null }),
  "opener:evidence": () => openEvidenceWriter(root, { ...baseOptions, sourceNamespace: null }),
  // The transport's own factory, opened by trusted code WITH the flag: the
  // configuration plumbs through, while the transport itself never sets it.
  "opener:evidence-operator": () =>
    openEvidenceWriter(root, { ...baseOptions, sourceNamespace: null, taxonomyOperator: true }),
};

const opener = OPENERS[mode];
if (opener !== undefined) {
  const bundle = await opener();
  try {
    await settle("seed", call(bundle.taxonomy, "seedReservedVocabularies", seedManifest(WORKSPACE)));
    await settle("create:type", call(bundle.taxonomy, "createTerm", invented(mode.replace(/[^a-z]/g, "").slice(0, 21))));
  } finally {
    await bundle.close();
  }
}

// ── transport: real HTTP + MCP through createApp ────────────────────────────

if (mode === "transport") {
  const { http, mcp, audits, readerToken } = openSealWire(root, workDir, WORKSPACE);

  say("http:seed", await http("seedReservedVocabularies", seedManifest(WORKSPACE)));
  say("http:publish:before", await http("publishRevision", publish("before", [typed(IDS.note, "note")])));
  say("http:create:type", await http("createTerm", invented("httpinvented")));
  say("http:create:horizon", await http("createTerm", midTerm("httpmidterm")));
  say("http:rename:reserved", await http("renameTerm", rename(IDS.discussion, "discussion", "debate")));
  say("http:retire:reserved", await http("retireTerm", byId(IDS.note)));
  say("http:reparent:reserved", await http("reparentTerm", reparent(IDS.learning, null, null)));
  // B1 over the wire: the sealed+required vocabulary is refused, so the
  // workspace stays publishable.
  say("http:sealed:vocabulary", await http("createVocabulary", gateVocabulary));
  say("http:get:gate", await http("getVocabulary", vocabularyById(IDS.gate)));
  say("http:publish:after", await http("publishRevision", publish("after", [typed(IDS.note, "note")])));
  say(
    "http:sealed:create",
    await http("createTerm", termRequest(WORKSPACE, { term_id: pad("httprule"), vocabulary_id: IDS.rules, name: "rule-1" })),
  );
  say("http:get:invented", await http("getTerm", byId(pad("httpinvented"))));
  say("http:get:discussion", await http("getTerm", byId(IDS.discussion)));
  say("http:get:note", await http("getTerm", byId(IDS.note)));

  // Precedence at the wire: authentication and authorization outrank the
  // seal, and request bytes can never select the operator path.
  say("http:anonymous:create:type", await http("createTerm", invented("httpanon"), null));
  say("http:reader:create:type", await http("createTerm", invented("httpreader"), readerToken));
  say("http:request-selects-operator", await http("createTerm", { ...invented("httpflag"), taxonomyOperator: true }));

  // The literal bootstrap stays reachable, and cannot extend: a replay is
  // satisfied, and any other id for a reserved name is a conflict.
  say("http:seed:replay", await http("seedReservedVocabularies", seedManifest(WORKSPACE)));
  say("http:seed:extend", await http("seedReservedVocabularies", seedManifest(WORKSPACE, { note: pad("othernote") })));

  say("http:open:vocabulary", await http("createVocabulary", openVocabulary));
  say(
    "http:open:create",
    await http("createTerm", termRequest(WORKSPACE, { term_id: pad("httpopen"), vocabulary_id: IDS.open, name: "h" })),
  );

  say("mcp:create:type", await mcp("kb_createTerm", invented("mcpinvented")));
  say("mcp:create:horizon", await mcp("kb_createTerm", midTerm("mcpmidterm")));
  say("mcp:rename:reserved", await mcp("kb_renameTerm", rename(IDS.discussion, "discussion", "debate")));
  say("mcp:retire:reserved", await mcp("kb_retireTerm", byId(IDS.note)));
  say("mcp:reparent:reserved", await mcp("kb_reparentTerm", reparent(IDS.learning, null, null)));
  say("mcp:sealed:vocabulary", await mcp("kb_createVocabulary", gateVocabulary));
  say(
    "mcp:sealed:create",
    await mcp("kb_createTerm", termRequest(WORKSPACE, { term_id: pad("mcprule"), vocabulary_id: IDS.rules, name: "rule-1" })),
  );
  say("mcp:reader:create:type", await mcp("kb_createTerm", invented("mcpreader"), readerToken));
  say(
    "mcp:open:create",
    await mcp("kb_createTerm", termRequest(WORKSPACE, { term_id: pad("mcpopen"), vocabulary_id: IDS.open, name: "m" })),
  );

  say("raw:terms", await rawTerms());
  say("audit:tools", audits.map((a) => `${a.tool} ${a.status}`));
}

// ── the re-seed hole (B2) ───────────────────────────────────────────────────

if (mode === "operator-rename") {
  // The rename is operator-only now; a dataset written before R6 can hold the
  // same state, since ordinary writers could rename reserved terms then.
  await withOwner(operatorOptions, async (t) => {
    await settle("seed", call(t, "seedReservedVocabularies", seedManifest(WORKSPACE)));
    await settle("rename:learning", call(t, "renameTerm", rename(IDS.learning, "learning", "lesson")));
  });
}

if (mode === "reseed-kernel") {
  await withOwner(baseOptions, async (t) => {
    await settle("reseed:new-id", call(t, "seedReservedVocabularies", reseedManifest()));
    await settle("reseed:get", call(t, "getTerm", byId(IDS.newLearning)));
    // The seed's own conflicts outrank the seal: the literal manifest meets
    // the renamed row, and a later-listed occupied name still conflicts.
    await settle("reseed:original", call(t, "seedReservedVocabularies", seedManifest(WORKSPACE)));
    await settle(
      "reseed:conflict-first",
      call(t, "seedReservedVocabularies", reseedManifest({ correction: pad("othercorr") })),
    );
  });
}

if (mode === "reseed-transport") {
  const { http, mcp } = openSealWire(root, workDir, WORKSPACE);
  say("http:reseed", await http("seedReservedVocabularies", reseedManifest()));
  say("mcp:reseed", await mcp("kb_seedReservedVocabularies", reseedManifest()));
  say("http:get:new-learning", await http("getTerm", byId(IDS.newLearning)));
  say("http:publish:new-learning", await http("publishRevision", publish("relearn", [typed(IDS.newLearning, "learning")])));
  say("raw:terms", await rawTerms());
}

if (mode === "operator-reseed") {
  // The frozen resume clause ("a matching vocabulary present with some
  // expected terms absent") still holds, for trusted configuration only.
  await withOwner(operatorOptions, async (t) => {
    await settle("reseed:new-id", call(t, "seedReservedVocabularies", reseedManifest()));
    await settle("reseed:get", call(t, "getTerm", byId(IDS.newLearning)));
  });
}

say("done", null);
