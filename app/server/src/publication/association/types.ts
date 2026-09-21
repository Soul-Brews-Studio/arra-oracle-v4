import type { RevisionMode } from "./constants";

/** Shared by parseCursor (return type) and ScanDependentsRequest (cursor field). */
export type ScanCursor = {
  workspace_name: string;
  target_kind: string;
  target_key: string;
  revision_mode: RevisionMode;
  nodes_version: string;
  node_id: string;
  revision_no: string | null;
  position: string | null;
};
