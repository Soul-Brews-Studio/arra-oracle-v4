/** Builds the reply tree the transcript view throws away.
 *
 * Sessions are flat -- there is no parent_id or channel column -- so
 * `in_reply_to` is the ONLY nesting this system has. A forum view is just
 * that column rendered as a tree instead of a chronological list.
 *
 * Pure by design: no React, no fetching. `ForumView` owns the data this
 * consumes; this file only ever transforms what it is handed.
 */
import type { MessageRow } from "../api/memory";

export type Thread = {
  root: MessageRow;
  replies: Thread[];
  depth: number;
  orphaned: boolean;
};

/** `created_at`/`public_id` tie-break, ascending -- matches the wire order a
 *  human expects a thread list in, and is deterministic when two rows share
 *  a timestamp (same second, different actor). Never coerce these to
 *  Number: both are STRINGS on the wire (created_at is ISO, public_id is a
 *  nanoid), and ISO-8601 sorts lexically the same as the instants it names. */
function compareRoots(a: MessageRow, b: MessageRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.public_id < b.public_id ? -1 : a.public_id > b.public_id ? 1 : 0;
}

export function buildThreads(messages: MessageRow[]): Thread[] {
  const byId = new Map<string, MessageRow>();
  for (const m of messages) byId.set(m.public_id, m);

  const childrenOf = new Map<string, MessageRow[]>();
  const declaredRoots: MessageRow[] = [];

  for (const m of messages) {
    const parentId = m.in_reply_to;
    // No parent named, or the parent is not in THIS page: both make a root.
    // The second case is a `listMessages` pagination artifact, not a real
    // root -- flagged `orphaned` below so the UI can say so, rather than
    // silently presenting a mid-thread reply as a genuine thread starter.
    if (parentId === null || parentId === undefined || !byId.has(parentId)) {
      declaredRoots.push(m);
      continue;
    }
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(m);
    childrenOf.set(parentId, siblings);
  }

  const visited = new Set<string>();

  // `ancestors` is the chain of the CURRENT walk, not the whole visited set:
  // a node reappearing there means `in_reply_to` closes a loop back onto
  // itself. Cut immediately -- render the repeat once as a marked orphan
  // rather than recursing forever into its own cycle.
  function walk(message: MessageRow, depth: number, ancestors: Set<string>, forceOrphan: boolean): Thread {
    visited.add(message.public_id);
    if (forceOrphan) {
      return { root: message, replies: [], depth, orphaned: true };
    }
    const kids = (childrenOf.get(message.public_id) ?? []).slice().sort(compareRoots);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(message.public_id);
    const replies = kids.map((k) => walk(k, depth + 1, nextAncestors, ancestors.has(k.public_id)));
    return { root: message, replies, depth, orphaned: false };
  }

  const threads = declaredRoots
    .slice()
    .sort(compareRoots)
    .map((m) => walk(m, 0, new Set(), false));

  // Whatever is left unvisited belongs only to cycles that never touch a
  // declared root (e.g. A replies to B, B replies to A, nothing else points
  // at either). Both parents resolve inside `byId`, so neither trips the
  // "missing parent" rule above -- without this pass they'd vanish rather
  // than render. Promote the lowest-sorting unvisited node in each such
  // cluster to an orphan root so the cycle is still shown, once.
  const leftover = messages.filter((m) => !visited.has(m.public_id)).sort(compareRoots);
  for (const m of leftover) {
    if (visited.has(m.public_id)) continue; // consumed by an earlier leftover's walk
    threads.push(walk(m, 0, new Set(), true));
  }

  return threads;
}
