/**
 * Shared harness for the #47 taxonomy tests.
 *
 * Thin by design. The dataset itself is built by the #48 exporter, which
 * recovery owns and root verifies separately; this file only creates the
 * scratch root, runs that exporter through the EXISTING bounded child helper,
 * and hands back a cleanup. It deliberately adds no schema knowledge of its
 * own: a second description of the nineteen tables here would become a rival
 * oracle the moment the real one changed.
 *
 * The publication helper is imported unchanged, never edited.
 *
 * Bounded-claim reminder, same as publication: the gate is a cooperative
 * operator protocol, SDK readback is not power-loss proof, and nothing here
 * defends against same-UID code that takes the SDK and declines the gate.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PYTHON, runOwnedChild } from "./publication-fixture";

/**
 * Derived here rather than imported: the publication helper keeps `MIGRATE_DIR`
 * private, and the contract says that file is imported UNCHANGED. Exporting a
 * constant from it to save four lines would be editing a frozen file.
 */
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const MIGRATE_DIR = join(REPO_ROOT, "app", "migrate-py");

export type SeededTaxonomyWorkspace = { workspace_id: string };

export type TaxonomyFixture = {
  datasetRoot: string;
  workspaces: Record<string, SeededTaxonomyWorkspace>;
  cleanup: () => Promise<void>;
};

/**
 * Build a fresh nineteen-table dataset seeded with `workspaces` only.
 *
 * The exporter requires ROOT to be an EXISTING local directory and prints one
 * JSON line of `{workspace_name: {workspace_id}}` — it does not echo the root
 * back, so the caller's scratch directory IS the dataset root.
 */
export async function createTaxonomyFixture(
  workspaces: string[] = ["alpha-workspace", "beta-workspace"],
): Promise<TaxonomyFixture> {
  const root = await mkdtemp(join(tmpdir(), "arra-tax27-"));
  const result = await runOwnedChild(
    PYTHON,
    [join("tests", "export_taxonomy_fixture.py"), root, ...workspaces],
    { cwd: MIGRATE_DIR },
  );
  if (result.code !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`taxonomy fixture exporter failed (${result.code}): ${result.stderr.slice(0, 400)}`);
  }

  let payload: Record<string, SeededTaxonomyWorkspace>;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    await rm(root, { recursive: true, force: true });
    throw new Error(`taxonomy fixture exporter did not print JSON: ${result.stdout.slice(0, 400)}`);
  }

  // Every requested workspace must actually be there. A silently missing one
  // would surface later as an unrelated "row not found" in a taxonomy test.
  for (const name of workspaces) {
    if (typeof payload[name]?.workspace_id !== "string") {
      await rm(root, { recursive: true, force: true });
      throw new Error(`exporter omitted workspace ${JSON.stringify(name)}`);
    }
  }

  return {
    datasetRoot: root,
    workspaces: payload,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Strict JSON request bytes, the only entrypoint shape the kernel accepts. */
export function encodeRequest(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

/** Nine distinct, caller-stable bootstrap identifiers. */
export function seedManifest(
  workspace: string,
  ids: Partial<Record<
    "typeVocabulary" | "horizonVocabulary" | "note" | "conclusion" | "learning"
    | "discussion" | "correction" | "short_term" | "long_term", string>> = {},
): Record<string, unknown> {
  return {
    workspace_name: workspace,
    type: {
      vocabulary_id: ids.typeVocabulary ?? pad("typevoc"),
      terms: {
        note: ids.note ?? pad("tnote"),
        conclusion: ids.conclusion ?? pad("tconcl"),
        learning: ids.learning ?? pad("tlearn"),
        discussion: ids.discussion ?? pad("tdisc"),
        correction: ids.correction ?? pad("tcorr"),
      },
    },
    memory_horizon: {
      vocabulary_id: ids.horizonVocabulary ?? pad("horvoc"),
      terms: {
        short_term: ids.short_term ?? pad("hshort"),
        long_term: ids.long_term ?? pad("hlong"),
      },
    },
  };
}

/** createVocabulary request. Overrides spread LAST, so any field can be forced. */
export function vocabularyRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspace_name: workspace,
    vocabulary_id: pad("voc"),
    name: "topics",
    label: "Topics",
    description: null,
    kind: "tags",
    term_policy: "open",
    cardinality: "many",
    required: false,
    hierarchy: "flat",
    ...overrides,
  };
}

/** createTerm request. Overrides spread LAST, so any field can be forced. */
export function termRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspace_name: workspace,
    term_id: pad("term"),
    vocabulary_id: pad("voc"),
    name: "a term",
    description: null,
    parent_id: null,
    ...overrides,
  };
}
