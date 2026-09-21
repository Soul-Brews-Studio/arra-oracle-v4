import type { JcsValue } from "../contracts/jcs";
import type { TargetKind } from "../contracts/evidence-v1";

/** No enum is declared in the physical schema for `status`; this module
 *  defines the closed set the request grammar and the stored codec both use. */
export const TRACE_STATUSES = ["open", "complete", "abandoned"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

/**
 * One caller-supplied hit, PRE-write. `position` is deliberately absent from
 * this shape: the physical position of a hit is its index in the `hits`
 * array of the SAME createTrace request, assigned by `parseCreateTrace` in
 * `trace.parseCreateTrace.ts`, so it is contiguous 0..n-1 by construction
 * rather than by a separate check of a caller-supplied number that could
 * disagree with the array order.
 */
export type CreateTraceHitInput = {
  kind: TargetKind;
  /** The RAW target value, not yet normalized. Normalization happens against
   *  the trace's own workspace_name at write time, in `service.ts`, because
   *  the target_key domain includes workspace_name and this kernel has no
   *  authority to assume which workspace a request will finally land in
   *  before the full request is parsed. */
  target: JcsValue;
  /** A caller-supplied OPAQUE locator string: where, within or alongside the
   *  resolved target, this hit points -- e.g. a byte offset spelling, a
   *  search-result rank, a citation label, or a fragment identifier. It is
   *  never dereferenced, never verified and never network-fetched by this
   *  kernel; it is a passive annotation for a later reader to interpret. */
  ref: string;
  line_start: string | null;
  line_end: string | null;
  excerpt: string | null;
  content_hash: string | null;
  /** Exact UTC-ms wire timestamp text, or null. Converted to STORAGE
   *  MICROSECONDS via the accepted `./rows` helper -- this column really is
   *  micros, unlike every timestamp on the trace row itself. */
  captured_at: string | null;
  note: string | null;
};

export type CreateTraceRequest = {
  workspace_name: string;
  id: string;
  name: string;
  session_name: string | null;
  peer_name: string | null;
  query: string;
  mode: string | null;
  session_id: string | null;
  session_from_ts: string | null;
  session_to_ts: string | null;
  friction_score: number | null;
  confidence: string | null;
  parent_id: string | null;
  prev_id: string | null;
  depth: string;
  status: TraceStatus;
  h_metadata: string | null;
  internal_metadata: string | null;
  hits: CreateTraceHitInput[];
};

export type GetTraceRequest = { workspace_name: string; id: string };

export type ListTraceHitsRequest = {
  workspace_name: string;
  trace_id: string;
  after_position: string | null;
  limit: number;
};
