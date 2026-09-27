import type { PublishInput, RevisionRow } from "../api/knowledge";
import type { LifecycleGate } from "../state/lifecycleGate";
import type { CiteTarget } from "../state/linkDraft.types";
import { CorrectForm } from "./CorrectForm";
import { PublishForm } from "./PublishForm";

const SEED_FIRST = "Seed the reserved vocabularies first — a revision needs exactly one type term.";

/** Every write the Knowledge view offers on one node: publish (create or
 *  revise, with evidence links) and, once a revision exists, Correct.
 *
 * The lifecycle gate fences BOTH off at once: a superseded or retired node
 * gets a disabled `<fieldset>` (so every control inside is inert, including
 * the link editors) and each form shows the gate's explanation as its
 * disabled reason. Keeping the gate here, not in `KnowledgeView`, is what
 * lets `citeCorrect.test.ts` pin the wiring without a DOM. */
export function NodeWritePanel({
  gate,
  nodeId,
  head,
  revisions,
  citeTargets,
  publishing,
  taxonomyReady,
  onPublish,
  onCorrect,
  mintId,
}: {
  gate: LifecycleGate;
  nodeId: string;
  head: RevisionRow | null;
  revisions: RevisionRow[];
  citeTargets: CiteTarget[];
  publishing: boolean;
  taxonomyReady: boolean;
  onPublish: (draft: Omit<PublishInput, "node_id" | "base_revision_id">) => void;
  onCorrect: (input: PublishInput) => void;
  mintId: () => string;
}) {
  const disabled = !taxonomyReady || gate.blocked;
  const reason = gate.blocked ? (gate.explanation ?? undefined) : !taxonomyReady ? SEED_FIRST : undefined;
  return (
    <fieldset disabled={gate.blocked} className="m-0 min-w-0 border-0 p-0">
      <PublishForm
        onPublish={onPublish}
        publishing={publishing}
        disabled={disabled}
        disabledReason={reason}
        editingNode={head !== null}
        citeTargets={citeTargets}
      />
      {head !== null && (
        <CorrectForm
          key={nodeId}
          revisions={revisions}
          citeTargets={citeTargets}
          disabled={disabled}
          disabledReason={reason}
          publishing={publishing}
          mintId={mintId}
          onCorrect={onCorrect}
        />
      )}
    </fieldset>
  );
}
