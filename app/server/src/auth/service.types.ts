/**
 * Types of the admission facade (`service.ts`), split out so that file stays
 * under the line cap. Types only: no value here can mint or check a context.
 */

import type { RequestAuthority } from "../knowledge/registry";
import type { AuthFailure } from "./service.createOperationService";

/**
 * A keyword search answer: the rows, and how they were found (R14). `ngram` is
 * the trigram index; `substring_scan` is the bounded scan a query under 3 code
 * points falls back to. Declared here, structurally, so the facade does not
 * import the store module; composition's assignment checks the two agree.
 */
export type TextSearchResult = { match: "ngram" | "substring_scan"; rows: unknown[] };

export type StoreDependencies = {
  insert(row: {
    workspace_name: string;
    name: string;
    content: string;
    type?: string;
    session_name?: string;
    peer_name?: string;
    subject_peer_name?: string;
  }): Promise<{ id: string; embedded: boolean }>;
  list(bank: string, limit: number, filters?: Record<string, unknown>): Promise<unknown[]>;
  searchText(q: string, bank: string, limit: number): Promise<TextSearchResult>;
  searchVector(q: string, bank: string, limit: number): Promise<unknown[]>;
  getById(bank: string, id: string): Promise<unknown>;
  stats(bank: string): Promise<Record<string, unknown>>;
  backfill(batch: number): Promise<unknown>;
  ensureFtsIndex(replace?: boolean): Promise<string[]>;
  embedHealth(): Promise<{ ok: boolean; model: string; dims: number; detail: string }>;
  recentCalls(bank: string, limit: number, status?: string): Promise<unknown[]>;
  aggregateCalls(bank: string): Promise<unknown>;
  logCall(record: Record<string, unknown>): Promise<void>;
  /**
   * #31 maint-audit (Nat 2026-09-28 D4b): the SEPARATE instance-level audit
   * sink for the two global maintenance routes -- never `mcp_calls`, whose
   * `workspace_name` is NOT NULL. Optional: every fixture that does not wire
   * one (nearly every existing test, `helpers/auth-fixture.ts` included)
   * gets a no-op rather than a real filesystem write to whatever
   * `ARRA_DATA_DIR` defaults to when a test never overrides it -- writing to
   * REAL storage from a stub-backed test was the actual bug this optional
   * field replaces (a `app/data/instance_audit.lance` appeared from
   * `auth-integration.test.ts`, which never sets `ARRA_DATA_DIR`). Only
   * `composition.ts` wires the real one.
   */
  logInstanceAudit?(record: Record<string, unknown>): Promise<void>;
};

/** What an MCP adapter may ask the service to do, once projection succeeded. */
export type McpEnvelope = {
  readonly method: string;
  readonly id: string | number | null;
  readonly params: Record<string, unknown>;
};

export type McpResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "tool_error"; readonly message: string }
  | { readonly kind: "denied"; readonly code: AuthFailure }
  | { readonly kind: "tools"; readonly names: readonly string[] }
  | { readonly kind: "method_not_found" };

/**
 * Scope-bound operations handed to a tool dispatcher.
 *
 * These ARE authority — a callable operation can reach the store. It is bounded
 * two ways: each method re-checks the admitted action, and the whole set is
 * invalidated when the request that produced it ends.
 */
export type ToolOperations = {
  readonly bank: string;
  /** #87 / R3: data, not a capability -- what the admitted caller may do
   *  beyond each tool's action, for the knowledge dispatcher to pass on. */
  readonly authority: RequestAuthority;
  /** A7/D8 (R18): the X-Arra-Peer speaker, already checked against the grant's
   *  `peers` binding; null when the connection asserted none. Data, not authority. */
  readonly assertedPeer: string | null;
  insert(row: {
    name: string;
    content: string;
    type?: string;
    session_name?: string;
    peer_name?: string;
    subject_peer_name?: string;
  }): Promise<{ id: string; embedded: boolean }>;
  list(limit: number, filters: Record<string, unknown>): Promise<unknown[]>;
  searchText(q: string, limit: number): Promise<TextSearchResult>;
  searchVector(q: string, limit: number): Promise<unknown[]>;
  getById(id: string): Promise<unknown>;
  stats(): Promise<Record<string, unknown>>;
  embedReadiness(): Promise<{ ok: boolean; dims: number }>;
  recentCalls(limit: number, status?: string): Promise<unknown[]>;
  aggregateCalls(): Promise<unknown>;
};

/**
 * #31 legacy-audit: what a legacy HTTP route tells the facade about the call,
 * for its audit row. `input` is the call in its MCP twin's argument shape;
 * absent, the facade records the arguments it was given.
 */
export type HttpAudit = { readonly userAgent?: string; readonly input?: unknown };
