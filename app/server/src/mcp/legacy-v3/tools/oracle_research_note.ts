import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { cleanNames } from "../names";
import { normalizeProject } from "../project";
import { publish } from "../publish";
import { renderResearchNote } from "../research-note-render";
import { ensureSpeaker } from "../speaker";

/**
 * `oracle_research_note` (V3-PARITY.md §4.3; v3 src/tools/oracle.ts:40-63,
 * :89-99). The same write as `oracle_learn`, type `learning` for parity (D4),
 * with the body rendered from the finding and evidence turned into links.
 * v3 added `thor-oracle` and `stormforge` tags from a hardcoded profile; v4
 * keeps only `dev-research` and says so in a warning.
 */
export async function oracle_research_note(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const note = renderResearchNote(args);
  if (note.title === "") {
    throw new CompatError(context.tool, "unsupported_argument", "oracle_research_note requires title", "v3's own rule: a nonblank title", { path: "/title" });
  }
  const author = await ensureSpeaker(context, args);
  const done = await publish(context, {
    title: Array.from(note.title).slice(0, 80).join(""),
    body: note.body,
    fields: { source: typeof args.source === "string" && args.source.trim() !== "" ? args.source : "research note" },
    terms: {
      type: "learning",
      concepts: cleanNames(["dev-research", ...(Array.isArray(args.concepts) ? args.concepts : [])]),
      project: normalizeProject(args.project ?? note.repo),
    },
    links: note.links,
    author,
    sessionName: null,
    changeReason: null,
    idempotencyKey: args.idempotency_key,
  });
  return {
    success: true,
    file: null,
    id: done.node_id,
    embedding: done.embedding,
    ...(done.embeddingError === undefined ? {} : { embeddingError: done.embeddingError }),
    message: `Research note saved as v4 node ${done.node_id}`,
    compat_warnings: [
      { code: "field_unavailable", field: "file", detail: "v4 writes no file; the note is a node in LanceDB" },
      { code: "semantic_change", field: "concepts", detail: "v3's persona tags thor-oracle and stormforge are not added; v4 has no profile registry" },
    ],
    v4: { node_id: done.node_id, revision_id: done.revision_id },
  };
}
