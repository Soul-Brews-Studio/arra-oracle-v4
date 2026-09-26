import { CompatError } from "../compat-error";
import { ensureSpeaker } from "../ensureSpeaker";
import type { V3ToolContext } from "../handlers";
import { resolveNodeId } from "../ids.resolveNodeId";
import { typeLabelOf } from "../typeLabelOf";

/** Local, structural shapes for the kernel calls this tool makes. A1
 *  forbids importing anything from `publication/*`, so these are copied
 *  field lists, not the real `LifecycleWriteOutcome`/`getAcceptedHead` types. */
type LifecycleLabel = { kind: "retired" | "superseded"; new_id: string | null; reason: string; superseded_at: string } | null;
type AcceptedHead = { node: Record<string, unknown>; revision: Record<string, unknown>; lifecycle: LifecycleLabel };
type SupersedeLogRow = { new_id: string | null; reason: string; superseded_at: string };
type SupersedeOutcome =
  | { outcome: "accepted" | "idempotent"; row: SupersedeLogRow }
  | { outcome: "conflict"; reason: "operation_digest" | "stale_pin" | "already_terminal" | "successor_terminal"; row: SupersedeLogRow | null };

function requiredId(args: Record<string, unknown>, key: string, tool: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CompatError(tool, "unsupported_argument", `Invalid input at /${key}: ${key} is required`, `${key} must be a nonblank string`, { path: `/${key}` });
  }
  return value;
}

/** "already superseded"/"already retired" text for a node's existing
 *  terminal event, shared by the pre-check (from `getAcceptedHead`'s label)
 *  and the race-condition fallback (from a returned `already_terminal`
 *  conflict row). */
function terminalText(oldId: string, kind: "retired" | "superseded", newId: string | null): string {
  return kind === "retired" || newId === null ? `${oldId} is already retired` : `${oldId} is already superseded by ${newId}`;
}

/**
 * `oracle_supersede` (V3-PARITY.md §4.3 slice V2; v3 src/tools/supersede.ts).
 *
 * D1/D9: `oldId` and `newId` both go through `resolveNodeId` (nanoid21 direct,
 * else the legacy derivation, else `legacy_id_unknown`; both matching is the
 * ambiguity refusal) -- real v3 clients sent v3-corpus `learning_...` ids to
 * this exact tool (V3-PARITY.md §3 A3), so it needs the same resolution
 * `oracle_read` does, not a raw nanoid21 pass-through.
 *
 * Pre-check via the label `getAcceptedHead` already carries (#29 slice B): the
 * SAME successor -> v3's `unchanged:true`; a different one, or a retirement ->
 * `semantic_refusal`. Only once neither holds does this call `supersedeNode`,
 * retrying once on `stale_pin` (the pin is the CURRENT head, which can move
 * between the pre-check read and the write).
 */
export async function oracle_supersede(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const { tool, kb } = context;
  const oldIdArg = requiredId(args, "oldId", tool);
  const newIdArg = requiredId(args, "newId", tool);
  const reason = typeof args.reason === "string" && args.reason.trim() !== "" ? args.reason : "v3 adapter: reason not recorded";

  const oldResolved = await resolveNodeId(kb, context.bank, oldIdArg, tool, "/oldId");
  if (oldResolved === null) throw new CompatError(tool, "no_results", `Document not found: ${oldIdArg}`, "oldId has no matching node in this bank", { path: "/oldId" });
  const newResolved = await resolveNodeId(kb, context.bank, newIdArg, tool, "/newId");
  if (newResolved === null) throw new CompatError(tool, "no_results", `Document not found: ${newIdArg}`, "newId has no matching node in this bank", { path: "/newId" });

  const oldId = oldResolved.node_id;
  const newId = newResolved.node_id;
  const oldHead = oldResolved.head as AcceptedHead;
  const newHead = newResolved.head as AcceptedHead;

  if (oldId === newId) {
    throw new CompatError(tool, "semantic_refusal", "cannot supersede a document with itself", "oldId and newId resolve to the same node", { path: "/newId" });
  }

  const oldType = typeLabelOf(oldHead.revision);
  const newType = typeLabelOf(newHead.revision);

  if (oldHead.lifecycle !== null) {
    const lifecycle = oldHead.lifecycle;
    if (lifecycle.kind === "superseded" && lifecycle.new_id === newId) {
      return {
        success: true,
        unchanged: true,
        old_id: oldId,
        old_type: oldType,
        new_id: newId,
        new_type: newType,
        reason: lifecycle.reason,
        superseded_at: lifecycle.superseded_at,
        message: `${oldId} was already superseded by ${newId}; no change`,
      };
    }
    throw new CompatError(tool, "semantic_refusal", terminalText(oldId, lifecycle.kind, lifecycle.new_id), "a node may carry only one terminal lifecycle event", { path: "/oldId" });
  }

  const author = await ensureSpeaker(context, args);
  const attempt = (expectedRevisionId: string) =>
    kb("supersedeNode", {
      node_id: oldId,
      expected_revision_id: expectedRevisionId,
      new_node_id: newId,
      new_revision_id: newHead.revision.id,
      reason,
      peer_name: author,
      operation_id: `v3-supersede:${oldId}:${expectedRevisionId}:${newId}`,
    }) as Promise<SupersedeOutcome>;

  let outcome: SupersedeOutcome;
  try {
    outcome = await attempt(oldHead.revision.id as string);
  } catch (error) {
    if (isInvalidNewNode(error)) {
      throw new CompatError(tool, "semantic_refusal", "cannot supersede into a node that already descends from this entry (cycle)", "v4 refuses a cyclic replacement chain", { path: "/newId" });
    }
    throw error;
  }

  if (outcome.outcome === "conflict" && outcome.reason === "stale_pin") {
    const fresh = (await kb("getAcceptedHead", { node_id: oldId })) as AcceptedHead | null;
    if (fresh === null) throw new CompatError(tool, "no_results", `Document not found: ${oldId}`, "oldId no longer resolves", { path: "/oldId" });
    outcome = await attempt(fresh.revision.id as string);
  }

  if (outcome.outcome === "conflict") {
    if (outcome.reason === "successor_terminal") {
      throw new CompatError(tool, "semantic_refusal", `${newId} is already retired or superseded and cannot be a successor`, "a supersede target must not itself carry a terminal lifecycle event", { path: "/newId" });
    }
    if (outcome.reason === "already_terminal" && outcome.row !== null) {
      const row = outcome.row;
      throw new CompatError(tool, "semantic_refusal", terminalText(oldId, row.new_id === null ? "retired" : "superseded", row.new_id), "a node may carry only one terminal lifecycle event", { path: "/oldId" });
    }
    throw new CompatError(tool, "semantic_refusal", `${oldId} changed underfoot; retry`, `v4 returned conflict: ${outcome.reason}`, { path: "/oldId" });
  }

  const row = outcome.row;
  return {
    success: true,
    old_id: oldId,
    old_type: oldType,
    new_id: newId,
    new_type: newType,
    reason: row.reason,
    superseded_at: row.superseded_at,
    message: "excluded from recall; still readable by id and history",
  };
}

function isInvalidNewNode(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "invalid_request" && (error as { path?: unknown }).path === "/new_node_id";
}
