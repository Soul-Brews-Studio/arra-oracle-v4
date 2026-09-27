import { KNOWLEDGE_METHODS, KNOWLEDGE_METHOD_NAMES } from "../server/src/knowledge/registry";

/**
 * Render `kb --help` (no `method`) or `kb <method> --help`.
 *
 * The method list is READ from `KNOWLEDGE_METHOD_NAMES`/`KNOWLEDGE_METHODS`
 * every time this runs -- never hand-copied -- so a method another agent
 * adds to `knowledge/registry.ts` appears here with no edit to this file.
 * `KnowledgeMethod` names an action and a scope path, not a per-field
 * request schema, so a single method's help below says where to find the
 * shape instead of fabricating a field list the registry does not carry.
 */
export function kbHelpText(method?: string): string {
  if (method === undefined) {
    const names = [...KNOWLEDGE_METHOD_NAMES].sort();
    const rows = names.map((name) => {
      const entry = KNOWLEDGE_METHODS[name]!;
      const scope = entry.scopePath.length > 0 ? ` (workspace_name at ${entry.scopePath.join(".")}.workspace_name)` : "";
      return `  ${name.padEnd(28)} ${entry.action}${scope}`;
    });
    return [
      "arra-v4 kb — every method in app/server/src/knowledge/registry.ts",
      "",
      "Usage: bun app/cli.ts kb <method> --bank WORKSPACE [--json JSON | --file PATH | --stdin] [--pretty]",
      "       bun app/cli.ts kb <method> --help     show that method's action and scope",
      "       bun app/cli.ts kb --help              this list",
      "",
      "The request body is forwarded byte-exact (never re-serialized); it must",
      "carry workspace_name at the scope shown below, equal to --bank.",
      "",
      `Methods (${names.length} total):`,
      ...rows,
    ].join("\n");
  }
  const entry = KNOWLEDGE_METHODS[method];
  if (entry === undefined) throw new Error(`unknown kb method '${method}'\n\n${kbHelpText()}`);
  const where = entry.scopePath.length === 0 ? "the request root" : `${entry.scopePath.join(".")}.workspace_name`;
  const persistence = entry.action === "content:write" ? "Persists a durable write." : "Read-only.";
  return [
    `kb ${method} — ${entry.action}`,
    "",
    `Endpoint: POST /api/knowledge/<bank>/${method}`,
    `Scope check: the body's workspace_name (at ${where}) must equal --bank.`,
    persistence,
    "",
    "The registry names the action and the scope path, not a per-field",
    "request schema, so this command does not print a field list. See the",
    "method's parser under app/server/src/publication/ (or a frozen contract",
    "under app/docs/contracts/) for the exact JSON shape, then pass it with",
    "--json/--file/--stdin.",
  ].join("\n");
}
