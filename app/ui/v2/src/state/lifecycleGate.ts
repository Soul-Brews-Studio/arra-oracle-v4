import { isSupersedeEvent, type LifecycleEventRow } from "../api/evidenceReview";

/** Fix round (2026-09-27): the prior wording said blocking BOTH publish and
 *  correct here was "a UI-side choice, not a server rule" -- true only for
 *  correct. The server itself refuses a PUBLISH onto a superseded/retired
 *  node (`service.publishRevision.ts` returns `outcome: "conflict",
 *  reason: "node_retired"`). Only CORRECT is this client's own choice:
 *  `validateLinkReferences.ts` checks a `corrects` link's target is in the
 *  accepted ancestry and never looks at lifecycle state, so the server
 *  would accept a correction filed directly against this node's old
 *  accepted revision. Applied to BOTH the superseded and retired branches
 *  (the independent verifier found only superseded had been touched). */
const TERMINAL_SCOPE_NOTE =
  "Publishing here would also be refused by the server itself. Blocking a correction here, though, is " +
  "this client's own choice -- the server still accepts a correction filed directly against this node's " +
  "old accepted revision; this gate blocks it here anyway to keep both write paths behind one rule.";

export type LifecycleGate = {
  state: "active" | "loading" | "superseded" | "retired" | "unknown";
  /** True when publish and correct must be disabled. */
  blocked: boolean;
  label: string | null;
  explanation: string | null;
  successor: { node_id: string; revision_id: string | null; title: string | null } | null;
};

export type LifecycleRead = {
  nodeId: string | null;
  loading: boolean;
  error: string | null;
  rows: LifecycleEventRow[];
};

/** Whether the Knowledge view may write to this node, from the SAME
 *  `listLifecycleHistory` read the Evidence tab's Lifecycle panel uses (#29,
 *  #33). A supersede or retire event is terminal (`already_terminal` refuses
 *  a second one), so any event whose `old_id` is this node decides it.
 *
 * A failed read is `unknown`, labelled, and NOT blocking: the UI cannot
 * claim the node is terminal, and a read failure must not quietly look like
 * "active" either. While the read is in flight writes wait, so a quick click
 * cannot publish onto a node the next response would have shown as retired. */
export function lifecycleGate(read: LifecycleRead): LifecycleGate {
  const none = { label: null, explanation: null, successor: null };
  if (read.nodeId === null) return { state: "active", blocked: false, ...none };
  if (read.loading) {
    return {
      state: "loading",
      blocked: true,
      label: null,
      explanation: "Checking whether this node was superseded or retired…",
      successor: null,
    };
  }
  if (read.error !== null) {
    return {
      state: "unknown",
      blocked: false,
      label: "lifecycle unknown",
      explanation: `Lifecycle history could not be read (${read.error}), so this view cannot tell whether the node was superseded or retired.`,
      successor: null,
    };
  }
  const event = [...read.rows].reverse().find((row) => row.old_id === read.nodeId) ?? null;
  if (event === null) return { state: "active", blocked: false, ...none };
  if (isSupersedeEvent(event)) {
    const name = event.new_title ?? event.new_id;
    return {
      state: "superseded",
      blocked: true,
      label: "superseded",
      explanation:
        `This node was superseded by “${name}” (reason: ${event.reason}). Its history stays readable, ` +
        "but publishing or correcting here is disabled: continue on the successor. " +
        TERMINAL_SCOPE_NOTE,
      successor: { node_id: event.new_id!, revision_id: event.new_revision_id, title: event.new_title },
    };
  }
  return {
    state: "retired",
    blocked: true,
    label: "retired",
    explanation:
      `This node was retired (reason: ${event.reason}). Its history stays readable, ` +
      "but publishing or correcting here is disabled. " +
      TERMINAL_SCOPE_NOTE,
    successor: null,
  };
}
