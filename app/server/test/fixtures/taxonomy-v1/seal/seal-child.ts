// #27 / R6 seal child — one gated program, selected by mode.
//
// Runs inside a process that genuinely holds the writer gate (`runGated`,
// fd 42), against a disposable nineteen-table dataset built by the #48
// exporter. It never asserts: it prints one `EVENT <label> <json>` line per
// step, and `taxonomy-seal.test.ts` owns every expectation. Modes:
//
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
//
// See docs/overnight/DECISIONS.md R6 and taxonomy-write-v1.md's R6 amendment.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@lancedb/lancedb";
import { createApp } from "../../../../src/app";
import { createOperationService, type StoreDependencies } from "../../../../src/auth/service";
import { createKnowledgeAccess } from "../../../../src/knowledge/transport";
import { configureKnowledgeAccess, createMcpAdapter } from "../../../../src/mcp";
import { openContextWriter, openEvidenceWriter, openKnowledgeWriter } from "../../../../src/publication/service";
import { encodeRequest, seedManifest, termRequest, vocabularyRequest } from "../../../helpers/taxonomy-fixture";

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

const baseOptions = { newRevisionId: () => "r".repeat(21), clock: () => CLOCK_MS };

type Taxonomy = Awaited<ReturnType<typeof openKnowledgeWriter>>["taxonomy"];
type TaxonomyMethod = keyof Taxonomy;
const call = (taxonomy: Taxonomy, method: TaxonomyMethod, body: unknown) =>
  (taxonomy[method] as (bytes: Uint8Array) => Promise<unknown>)(encodeRequest(body));

if (mode === "kernel") {
  const bundle = await openKnowledgeWriter(root, baseOptions);
  const t = bundle.taxonomy;
  try {
    await settle("seed", call(t, "seedReservedVocabularies", seedManifest(WORKSPACE)));

    // The four refused operations on the two reserved sealed vocabularies.
    await settle("create:type", call(t, "createTerm", invented("invented")));
    await settle("get:invented", call(t, "getTerm", byId(pad("invented"))));
    await settle("create:horizon", call(t, "createTerm", midTerm("midterm")));
    await settle("rename:reserved", call(t, "renameTerm", rename(IDS.discussion, "discussion", "debate")));
    await settle("retire:reserved", call(t, "retireTerm", byId(IDS.note)));
    await settle("reparent:reserved", call(t, "reparentTerm", reparent(IDS.learning, null, null)));

    // A caller-created sealed vocabulary is sealed the same way.
    await settle("sealed:vocabulary", call(t, "createVocabulary", userSealedVocabulary));
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

    // Nothing moved.
    await settle("get:discussion", call(t, "getTerm", byId(IDS.discussion)));
    await settle("get:note", call(t, "getTerm", byId(IDS.note)));
    await settle("get:learning", call(t, "getTerm", byId(IDS.learning)));
    await settle("get:type-vocabulary", call(t, "getVocabulary", { workspace_name: WORKSPACE, vocabulary_id: IDS.type }));

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
  } finally {
    await bundle.close();
  }
}

if (mode === "operator") {
  // Trusted in-process configuration, never request bytes: the operator path
  // taxonomy-write-v1.md describes stays available here, and only here.
  const bundle = await openKnowledgeWriter(root, { ...baseOptions, taxonomyOperator: true });
  const t = bundle.taxonomy;
  try {
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
  } finally {
    await bundle.close();
  }
}

if (mode === "ordinary-after-operator") {
  const bundle = await openKnowledgeWriter(root, baseOptions);
  const t = bundle.taxonomy;
  try {
    await settle("rename:operator-term", call(t, "renameTerm", rename(pad("invented"), "invented_type", "x")));
    await settle("retire:operator-term", call(t, "retireTerm", byId(pad("invented"))));
    await settle("reparent:sealed-tree", call(t, "reparentTerm", reparent(pad("rule2"), pad("rule1"), null)));
    await settle("retire:sealed-tree", call(t, "retireTerm", byId(pad("rule1"))));
    await settle("get:rule2", call(t, "getTerm", byId(pad("rule2"))));
  } finally {
    await bundle.close();
  }
}

// One factory per process: a closed owner releases the gate descriptor with
// it, so a same-process reopen is refused by design (the ownership lanes pin
// "reopen:after-close writer_unavailable"). The parent runs each of these on
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

const ORIGIN = "http://127.0.0.1:3939";
const HOST = "127.0.0.1:3939";
const WRITER_TOKEN = "a".repeat(64);
const READER_TOKEN = "b".repeat(64);
const sha256 = (token: string) => createHash("sha256").update(token, "ascii").digest("hex");

function writePolicy(): string {
  const policyPath = join(workDir, "policy.json");
  const credential = (id: string, principal: string, token: string) => ({
    id,
    principal_id: principal,
    sha256: sha256(token),
    not_before: "2020-01-01T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked: false,
  });
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        {
          id: "writer",
          disabled: false,
          workspaces: [{ name: WORKSPACE, actions: ["content:read", "content:write"] }],
          global_actions: [],
        },
        { id: "reader", disabled: false, workspaces: [{ name: WORKSPACE, actions: ["content:read"] }], global_actions: [] },
      ],
      credentials: [credential("cred-writer", "writer", WRITER_TOKEN), credential("cred-reader", "reader", READER_TOKEN)],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
  return policyPath;
}

if (mode === "transport") {
  const policyPath = writePolicy();
  const access = createKnowledgeAccess({ datasetRoot: root, env: process.env });
  configureKnowledgeAccess(access);
  // The legacy memory store is never reached by a kb_ tool; only the audit
  // append runs, and it is recorded here rather than written anywhere.
  const unused = async (): Promise<never> => {
    throw new Error("legacy store is not used by kb_ tools");
  };
  const audits: Record<string, unknown>[] = [];
  const deps: StoreDependencies = {
    insert: unused,
    list: unused,
    searchText: unused,
    searchVector: unused,
    getById: unused,
    stats: unused,
    backfill: unused,
    ensureFtsIndex: unused,
    embedHealth: unused,
    recentCalls: unused,
    aggregateCalls: unused,
    logCall: async (record) => {
      audits.push(record);
    },
  };
  const service = createOperationService({ policyPath }, deps);
  const app = createApp({ origin: ORIGIN }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });

  const headers = (token: string | null): Record<string, string> => ({
    host: HOST,
    "content-type": "application/json",
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  });
  const http = async (method: string, body: unknown, token: string | null = WRITER_TOKEN) => {
    const res = await app.handle(
      new Request(`${ORIGIN}/api/knowledge/${WORKSPACE}/${method}`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const mcp = async (tool: string, payload: unknown, token: string | null = WRITER_TOKEN) => {
    const res = await app.handle(
      new Request(`${ORIGIN}/mcp/${WORKSPACE}`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { payload } } }),
      }),
    );
    const wire = (await res.json().catch(() => null)) as { result?: { isError?: boolean; content?: { text?: string }[] } } | null;
    const text = wire?.result?.content?.[0]?.text;
    let value: unknown = text ?? null;
    try {
      value = text === undefined ? null : JSON.parse(text);
    } catch {
      // A plain-text tool error stays text.
    }
    return { status: res.status, isError: wire?.result?.isError === true, value };
  };

  say("http:seed", await http("seedReservedVocabularies", seedManifest(WORKSPACE)));
  say("http:create:type", await http("createTerm", invented("httpinvented")));
  say("http:create:horizon", await http("createTerm", midTerm("httpmidterm")));
  say("http:rename:reserved", await http("renameTerm", rename(IDS.discussion, "discussion", "debate")));
  say("http:retire:reserved", await http("retireTerm", byId(IDS.note)));
  say("http:reparent:reserved", await http("reparentTerm", reparent(IDS.learning, null, null)));
  say("http:sealed:vocabulary", await http("createVocabulary", userSealedVocabulary));
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
  say("http:reader:create:type", await http("createTerm", invented("httpreader"), READER_TOKEN));
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
  say(
    "mcp:sealed:create",
    await mcp("kb_createTerm", termRequest(WORKSPACE, { term_id: pad("mcprule"), vocabulary_id: IDS.rules, name: "rule-1" })),
  );
  say("mcp:reader:create:type", await mcp("kb_createTerm", invented("mcpreader"), READER_TOKEN));
  say(
    "mcp:open:create",
    await mcp("kb_createTerm", termRequest(WORKSPACE, { term_id: pad("mcpopen"), vocabulary_id: IDS.open, name: "m" })),
  );

  // Independent of the service: what the terms table physically holds.
  const table = await (await connect(root)).openTable("terms");
  const rows = await table.query().where(`workspace_name = '${WORKSPACE}'`).toArray();
  const namesIn = (vocabularyId: string) =>
    rows
      .filter((row) => row.vocabulary_id === vocabularyId)
      .map((row) => `${row.name}${row.is_active === true ? "" : " (retired)"}`)
      .sort();
  say("raw:terms", { type: namesIn(IDS.type), memory_horizon: namesIn(IDS.horizon), rules: namesIn(IDS.rules) });
  say("audit:tools", audits.map((a) => `${a.tool} ${a.status}`));
}

say("done", null);
