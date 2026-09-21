import { hasOnlyPairedSurrogates, utf8ByteLength } from "../../contracts/jcs";
import { GLOBAL_ACTIONS, MAX_WORKSPACE_NAME_BYTES, WORKSPACE_ACTIONS } from "./constants";
import { ownData } from "./own-data";
import { reject } from "./reject";
import { requireClosedInput } from "./require-closed-input";
import type { AdmissionTarget, GlobalAction, WorkspaceAction } from "./types";

export function parseTarget(value: unknown): AdmissionTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("invalid_request");
  // Read `kind` through its descriptor: a plain property access would INVOKE a
  // getter, letting caller code run (and throw) inside the authorization path
  // before the own-data boundary is enforced. Proxies remain unsupported.
  if (!ownData(value, "kind")) reject("invalid_request");
  const kind = Object.getOwnPropertyDescriptor(value, "kind")!.value as unknown;
  if (kind === "workspace") {
    const o = requireClosedInput(value, ["kind", "workspace", "action"]);
    const workspace = o.workspace;
    if (typeof workspace !== "string" || workspace.trim().length === 0) reject("invalid_request");
    // Same grammar as a policy workspace name, INCLUDING valid Unicode: a lone
    // surrogate is a malformed request, decided before any credential lookup.
    if (!hasOnlyPairedSurrogates(workspace)) reject("invalid_request");
    if (utf8ByteLength(workspace) > MAX_WORKSPACE_NAME_BYTES) reject("invalid_request");
    const action = o.action;
    if (typeof action !== "string" || !(WORKSPACE_ACTIONS as readonly string[]).includes(action)) {
      reject("invalid_request");
    }
    return Object.freeze({ kind: "workspace", workspace, action: action as WorkspaceAction });
  }
  if (kind === "global") {
    const o = requireClosedInput(value, ["kind", "action"]);
    const action = o.action;
    if (typeof action !== "string" || !(GLOBAL_ACTIONS as readonly string[]).includes(action)) {
      reject("invalid_request");
    }
    return Object.freeze({ kind: "global", action: action as GlobalAction });
  }
  return reject("invalid_request");
}
