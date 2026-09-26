/**
 * The work-order shape the Python orchestrator writes (`plan.json`,
 * `arra-migrate-copy/plan-v1`) and the JSONL lines this worker prints back.
 *
 * Python owns POLICY and IDS (R11 type mapping, R17 backfills, every nanoid21);
 * this worker owns the revision bytes, which only the kernel builds.
 */

export type PlannedTerm = {
  term_id: string;
  vocabulary_id: string;
  vocabulary_name: string;
  term_name: string;
};

export type PlannedMemory = {
  legacy_id: string;
  node_id: string;
  revision_id: string;
  operation_id: string;
  created_at_ms: number;
  title: string;
  body: string;
  is_active: boolean;
  subject_peer_name: string | null;
  session_name: string | null;
  valid_from: string | null;
  valid_to: string | null;
  h_metadata: string | null;
  internal_metadata: Record<string, unknown>;
  type_term: string;
  legacy_type_tag: string | null;
  terms: PlannedTerm[];
  links: Array<{ trace_id: string }>;
};

export type PlannedLifecycleEvent = {
  legacy_key: string;
  table: string;
  workspace: string;
  kind: "supersede" | "retire";
  node_legacy_id: string;
  node_id: string;
  expected_revision_id: string;
  new_node_id: string | null;
  new_revision_id: string | null;
  reason: string;
  peer_name: string | null;
  at_ms: number;
  operation_id: string;
};

export type SeedIds = { vocabulary_id: string; terms: Record<string, string> };

export type PlannedWorkspace = {
  workspace_name: string;
  seed: { type: SeedIds; memory_horizon: SeedIds };
  legacy_type_vocabulary: { vocabulary_id: string; name: string } | null;
  legacy_type_terms: Array<{ term_id: string; name: string }>;
  memories: PlannedMemory[];
  lifecycle: PlannedLifecycleEvent[];
};

export type MigrationPlan = {
  version: "arra-migrate-copy/plan-v1";
  candidate_root: string;
  intake_at_ms: number;
  workspaces: PlannedWorkspace[];
};

/**
 * The injected clock and id source. The kernel samples `clock()` for every
 * created_at it writes, so the worker sets `now` to the LEGACY time before
 * each call; `nextRevisionId` is consumed exactly once per publish.
 */
export type WorkerControls = { now: number; nextRevisionId: string | null };

export type WorkerLine = Record<string, unknown> & { kind: string };

export type Emit = (line: WorkerLine) => void;
