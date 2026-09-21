/**
 * #25 first slice: pure policy validation and admission (`authorization-v1.md` §7).
 *
 * Isolated on purpose. Nothing here reads a file, an environment variable, a
 * clock, a route, the store or a model; the caller supplies the raw bytes and
 * the one epoch-millisecond value a request is decided against. This module is
 * NOT a secured service — integration owns unforgeable context construction and
 * entrypoint wiring, and none of that is claimed by these two functions.
 *
 * Every rejection is an Error carrying one closed `code` and a fixed generic
 * message for that code. The shared contract helpers are reused for strict
 * JSON, Unicode and timestamp grammar, but their diagnostic paths and messages
 * are deliberately swallowed: a policy diagnostic must never echo a token, a
 * digest, a workspace name or a fragment of the document.
 *
 * This file is a thin barrel: the implementation lives in `./policy/`, split
 * one function per file. Nothing here changes behaviour — see `./policy/`
 * for the actual logic.
 */

export { admit } from "./policy/admit";
export { parsePolicy } from "./policy/parse-policy";
export type {
  Admission,
  AdmissionInput,
  AdmissionTarget,
  AuthErrorCode,
  GlobalAction,
  Policy,
  PolicyVersion,
  WorkspaceAction,
} from "./policy/types";
