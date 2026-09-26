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
 * comment on `include_total`).
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
    flags: ["after", "limit", "include-total", "type"],
    booleanFlags: ["include-total"],
    build: (options, bank) => ({
      workspace_name: bank,
      after_id: orNull(options, "after"),
      limit: positiveInt(options.limit, "limit", 20),
      include_total: options["include-total"] === "true",
      type_term: orNull(options, "type"),
    }),
  },
  "context get": {
    method: "getContext",
    flags: ["peer", "session", "max-items"],
    build: (options, bank) => ({
      workspace_name: bank,
      peer_name: need(options, "peer"),
      session_name: need(options, "session"),
      max_items: positiveInt(options["max-items"], "max-items", 10),
    }),
  },
  "chat ask": {
    method: "answerChat",
    flags: ["peer", "session", "question", "max-items"],
    build: (options, bank) => ({
      workspace_name: bank,
      peer_name: need(options, "peer"),
      session_name: need(options, "session"),
      question: need(options, "question"),
      max_items: positiveInt(options["max-items"], "max-items", 10),
    }),
  },
});

for (const [aliasName, alias] of Object.entries(KB_ALIASES)) {
  if (!KNOWLEDGE_METHOD_NAMES.includes(alias.method)) {
    throw new Error(`kb.aliases.ts: '${aliasName}' names unknown registry method '${alias.method}'`);
  }
}
