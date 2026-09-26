// #49 ownership child — scoped references, tree bounds, retirement and the
// documented expected-value ABA hazard.
//
// Every case runs inside one gated process against a disposable dataset. The
// child reports `code path` pairs; the parent holds the expected values, which
// are authored from `taxonomy-write-v1.md`, never read back from this code.

// Computed-path imports: the kernel and helper land in other lanes, so a static
// import would turn "not built yet" into a project-wide typecheck failure rather
// than a loud runtime error here.
const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const helperPath = new URL("../../../helpers/taxonomy-fixture.ts", import.meta.url).pathname;
type Json = Record<string, unknown>;
type Facade = Record<string, (bytes: Uint8Array) => Promise<unknown>>;
type Bundle = { publication: Facade; taxonomy: Facade; close(): Promise<void> };
type HelperApi = {
  encodeRequest: (value: unknown) => Uint8Array;
  seedManifest: (workspace: string, ids?: Record<string, string>) => Json;
  termRequest: (workspace: string, overrides?: Json) => Json;
  vocabularyRequest: (workspace: string, overrides?: Json) => Json;
};

const { openKnowledgeWriter } = (await import(servicePath)) as {
  openKnowledgeWriter: (root: string, options: Json) => Promise<Bundle>;
};
const { encodeRequest, seedManifest, termRequest, vocabularyRequest } = (await import(helperPath)) as HelperApi;

const [, , mode, root, payloadPath] = process.argv;
const FIXED_CLOCK_MS = 1_789_905_600_000;

const say = (event: string) => console.log(`EVENT ${event}`);
const shape = (error: unknown) => {
  const e = error as { code?: string; path?: string };
  return `${e.code ?? "no-code"} ${e.path ?? "no-path"}`;
};
const outcome = (label: string, promise: Promise<unknown>) =>
  promise.then(
    (value) => say(`${label} ${(value as { outcome?: string })?.outcome ?? "no-outcome"}`),
    (error: unknown) => say(`${label} ${shape(error)}`),
  );

const payload = JSON.parse(await Bun.file(payloadPath!).text());
const workspace: string = payload.workspace;
const other: string = payload.other_workspace;
const ids = payload.seed_ids;

const bundle = await openKnowledgeWriter(root!, {
  newRevisionId: () => "r".repeat(21),
  clock: () => FIXED_CLOCK_MS,
  // R6 (#27, docs/overnight/DECISIONS.md): `type` is sealed. Retirement and the
  // documented ABA rename exercise the OPERATOR lifecycle this contract
  // specifies, so those two modes open as the trusted in-process operator.
  // "references" and "tree-boundary" stay ordinary owners: their expected
  // codes are unchanged because structure and references outrank the seal
  // (taxonomy-write-v1.md, R6 amendment; taxonomy-seal.test.ts).
  taxonomyOperator: mode === "retirement" || mode === "aba",
});
const taxonomy = bundle.taxonomy;
const send = (method: string, body: Json) => taxonomy[method]!(encodeRequest(body));

try {
  if (mode === "references") {
    await outcome("seed", send("seedReservedVocabularies", seedManifest(workspace, ids)));

    // A vocabulary that exists, in the WRONG workspace.
    await outcome(
      "cross-workspace-vocabulary",
      send("createTerm", termRequest(workspace, { term_id: payload.spare_term_ids[0], vocabulary_id: payload.other_type_vocabulary, name: "x-1" })),
    );
    // A workspace that does not exist at all.
    await outcome(
      "absent-workspace",
      send("createTerm", termRequest("no-such-workspace", { term_id: payload.spare_term_ids[1], vocabulary_id: ids.typeVocabulary, name: "x-2" })),
    );
    // A reserved name may only come from bootstrap.
    await outcome(
      "reserved-name-create",
      send("createVocabulary", vocabularyRequest(workspace, { vocabulary_id: payload.spare_vocabulary_ids[0], name: "type" })),
    );
    // Reserved vocabularies are flat, so a nonnull parent is a policy refusal.
    await outcome(
      "flat-parent",
      send("createTerm", termRequest(workspace, { term_id: payload.spare_term_ids[2], vocabulary_id: ids.typeVocabulary, name: "x-3", parent_id: ids.note })),
    );
    // A mutation target that is simply absent.
    await outcome(
      "absent-rename-target",
      send("renameTerm", { workspace_name: workspace, term_id: payload.spare_term_ids[3], expected_name: "a", name: "b" }),
    );
    // Cross-workspace target: the row exists, but not in this workspace.
    await outcome(
      "cross-workspace-rename-target",
      send("renameTerm", { workspace_name: other, term_id: ids.note, expected_name: "note", name: "renamed" }),
    );
  }

  if (mode === "tree-boundary") {
    // The chain is staged directly by the parent's setup script; only the
    // boundary decision below is the kernel's behaviour under test.
    await outcome(
      "reparent-at-limit",
      send("reparentTerm", {
        workspace_name: workspace,
        term_id: payload.mover_id,
        expected_parent_id: null,
        parent_id: payload.tip_id,
      }),
    );
  }

  if (mode === "retirement") {
    await outcome("seed", send("seedReservedVocabularies", seedManifest(workspace, ids)));
    const typeTerms = [ids.note, ids.conclusion, ids.learning, ids.discussion, ids.correction];
    for (const [index, termId] of typeTerms.slice(0, 4).entries()) {
      await outcome(`retire-${index}`, send("retireTerm", { workspace_name: workspace, term_id: termId }));
    }
    // The fifth is the last active term of a REQUIRED vocabulary.
    await outcome("retire-last-required", send("retireTerm", { workspace_name: workspace, term_id: typeTerms[4]! }));
    // A retired term cannot be renamed, and its name stays occupied.
    await outcome(
      "rename-retired",
      send("renameTerm", { workspace_name: workspace, term_id: typeTerms[0]!, expected_name: "note", name: "note-2" }),
    );
    await outcome(
      "reuse-retired-name",
      send("createTerm", termRequest(workspace, { term_id: payload.spare_term_ids[0], vocabulary_id: ids.typeVocabulary, name: "note" })),
    );
    // Retiring twice is already satisfied, never a second mutation.
    await outcome("retire-again", send("retireTerm", { workspace_name: workspace, term_id: typeTerms[0]! }));
  }

  if (mode === "aba") {
    await outcome("seed", send("seedReservedVocabularies", seedManifest(workspace, ids)));
    const forward = { workspace_name: workspace, term_id: ids.conclusion, expected_name: "conclusion", name: "conclusion-b" };
    const backward = { workspace_name: workspace, term_id: ids.conclusion, expected_name: "conclusion-b", name: "conclusion" };
    await outcome("aba-forward", send("renameTerm", forward));
    await outcome("aba-backward", send("renameTerm", backward));
    // DOCUMENTED HAZARD, not a defect: expected-value guards carry no version, so
    // replaying the stale first request after the revert applies it a second time.
    await outcome("aba-stale-replay", send("renameTerm", forward));
    // A guard that does not match the current value still conflicts.
    await outcome(
      "expected-mismatch",
      send("renameTerm", { workspace_name: workspace, term_id: ids.learning, expected_name: "not-the-current-name", name: "learning-b" }),
    );
  }
} finally {
  await bundle.close();
}

say("done");
