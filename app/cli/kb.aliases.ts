/**
 * Friendly, thin sugar over `kb <method>` for Nat's daily loop (#31 R8). Each
 * entry names exactly one registry method (checked against
 * `KNOWLEDGE_METHOD_NAMES` below, so a rename in the registry fails loudly
 * here instead of quietly 404ing) and a `build` function that maps a few
 * plain flags onto that method's known closed-key request shape. This file
 * does NO validation the server does not already do more strictly -- it only
 * shapes the JSON, exactly like the 13 legacy commands in `app/cli.ts`
 * already shape `remember`/`recall` arguments. Every field the underlying
 * method requires is supplied explicitly (including nulls), matching this
 * codebase's closed-key discipline (`service.parseListNodes.ts`'s own
 * comment on `include_total`) -- the ONE exception is `nodes list`'s
 * `include_inactive`, which `service.parseListNodes.ts` (#29 fix round)
 * makes OPTIONAL specifically so this alias's daily-loop body never has to
 * change: the alias omits the key unless `--history` asks for history mode.
 *
 * Deliberately NOT here: `node create` / `node revise` (`publishRevision`).
 * Its request is a governed revision envelope (operation id, content union,
 * domain references) rather than a flat closed object -- thin flag mapping
 * would either reinvent that codec or accept a shape nobody has exercised.
 * Use `kb publishRevision --json/--file` directly until a slice owns that
 * envelope's CLI shape.
 */

import { KNOWLEDGE_METHOD_NAMES } from "../server/src/knowledge/registry";
import type { CliOptions } from "./parseFlags";
import { positiveInt } from "./positiveInt";
import { randomNanoid21 } from "./randomNanoid21";

type Json = Record<string, unknown>;

export type KbAlias = {
  /** Must be a member of `KNOWLEDGE_METHOD_NAMES` -- asserted below. */
  readonly method: string;
  readonly flags: readonly string[];
  readonly booleanFlags?: readonly string[];
  readonly build: (options: CliOptions, bank: string) => Json;
};

const need = (options: CliOptions, name: string): string => {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
};
const orNull = (options: CliOptions, name: string): string | null => options[name] ?? null;
/** D3b: `--observer` / `--about` become the optional perspective keys, sent
 *  only when given, so a plain `context get` / `chat ask` body is unchanged. */
const perspective = (options: CliOptions): Json => ({
  ...(options.observer ? { observer_peer_name: options.observer } : {}),
  ...(options.about ? { subject_peer_name: options.about } : {}),
  // R24 (Nat D3b, #32): `--author` narrows SELECTION on `getContext` /
  // `answerChat` only -- deliberately absent from `peer context`
  // (`getRepresentation`), whose grammar does not admit it.
  ...(options.author ? { author_peer_name: options.author } : {}),
});

export const KB_ALIASES: Readonly<Record<string, KbAlias>> = Object.freeze({
  "peer add": {
    method: "registerPeer",
    flags: ["name", "peer-id"],
    build: (options, bank) => ({
      workspace_name: bank,
      peer_id: options["peer-id"] ?? randomNanoid21(),
      name: need(options, "name"),
    }),
  },
  "session add": {
    method: "registerSession",
    flags: ["name", "session-id"],
    build: (options, bank) => ({
      workspace_name: bank,
      session_id: options["session-id"] ?? randomNanoid21(),
      name: need(options, "name"),
    }),
  },
  "message append": {
    method: "appendMessages",
    flags: ["session", "peer", "content", "role", "in-reply-to"],
    build: (options, bank) => ({
      workspace_name: bank,
      session_name: need(options, "session"),
      items: [
        {
          public_id: randomNanoid21(),
          message: {
            peer_name: need(options, "peer"),
            role: orNull(options, "role"),
            content: need(options, "content"),
            in_reply_to: orNull(options, "in-reply-to"),
          },
          source: null,
        },
      ],
    }),
  },
  "nodes list": {
    method: "listNodes",
    flags: ["after", "limit", "include-total", "type", "history"],
    booleanFlags: ["include-total", "history"],
    build: (options, bank) => ({
      workspace_name: bank,
      after_id: orNull(options, "after"),
      limit: positiveInt(options.limit, "limit", 20),
      include_total: options["include-total"] === "true",
      type_term: orNull(options, "type"),
      // `include_inactive` is OPTIONAL server-side (#29 fix round: default
      // false, ordinary recall) -- this alias mirrors that by omitting the
      // key entirely unless `--history` asks for it, so the documented
      // daily-loop command (`bun app/cli.ts nodes list --bank example
      // --limit 20`, README.md) keeps sending the EXACT body it always has,
      // byte-for-byte. `--history` is the only way this alias sends the key.
      ...(options["history"] === "true" ? { include_inactive: true } : {}),
    }),
  },
  "context get": {
    method: "getContext",
    flags: ["peer", "session", "max-items", "observer", "about", "author"],
    build: (options, bank) => ({
      workspace_name: bank,
      peer_name: need(options, "peer"),
      session_name: need(options, "session"),
      max_items: positiveInt(options["max-items"], "max-items", 10),
      ...perspective(options),
    }),
  },
  "chat ask": {
    method: "answerChat",
    flags: ["peer", "session", "question", "max-items", "observer", "about", "author"],
    build: (options, bank) => ({
      workspace_name: bank,
      peer_name: need(options, "peer"),
      session_name: need(options, "session"),
      question: need(options, "question"),
      max_items: positiveInt(options["max-items"], "max-items", 10),
      ...perspective(options),
    }),
  },
  // D3b (DESIGN.md §12: `oracle peer context --observer neo --about nat`).
  // `--requester` is optional server-side (#87 / R3): omitted, the server
  // answers only the audit:read operator view.
  "peer context": {
    method: "getRepresentation",
    flags: ["observer", "about", "requester", "max-items"],
    build: (options, bank) => ({
      workspace_name: bank,
      observer_peer_name: need(options, "observer"),
      subject_peer_name: need(options, "about"),
      max_items: positiveInt(options["max-items"], "max-items", 10),
      ...(options.requester ? { requester_peer_name: options.requester } : {}),
    }),
  },
});

for (const [aliasName, alias] of Object.entries(KB_ALIASES)) {
  if (!KNOWLEDGE_METHOD_NAMES.includes(alias.method)) {
    throw new Error(`kb.aliases.ts: '${aliasName}' names unknown registry method '${alias.method}'`);
  }
}
