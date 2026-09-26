export type CliOptions = Record<string, string>;

/**
 * Parse `--flag value` / `--flag=value` pairs, the same grammar `app/cli.ts`
 * has used since #25: `[a-z-]+` flag names, exactly one value each (unless
 * the flag is in `booleanFlags`, which take none), no duplicates, no unknown
 * flags, and no value that itself starts with `--` unless it was attached
 * with `=` (so `--content -- literal` still requires `--content=--literal`).
 * Extracted so the legacy per-command dispatch, the generic `kb <method>`
 * command and the friendly `kb` aliases all reject malformed flags the same
 * way instead of three hand-rolled copies drifting apart.
 */
export function parseFlags(
  args: readonly string[],
  allowed: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
  commandLabel: string,
): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < args.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(args[i]!);
    if (!match || !allowed.has(match[1]!)) throw new Error(`unknown option '${args[i]}' for ${commandLabel}`);
    const [, name, inline] = match;
    if (Object.hasOwn(options, name!)) throw new Error(`duplicate option --${name}`);
    if (booleanFlags.has(name!)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`);
      options[name!] = "true";
    } else {
      const value = inline ?? args[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--")) || !value.trim()) {
        throw new Error(`--${name} requires a non-empty value`);
      }
      options[name!] = value;
    }
  }
  return options;
}
