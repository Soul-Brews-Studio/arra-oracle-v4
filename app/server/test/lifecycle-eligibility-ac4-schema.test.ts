/**
 * #29 AC4 (AC-MATRIX row, ac-guards slice): "the #2 binary decision is kept:
 * no decay columns." `evaluateNodeEligibility`/`getRecallEligibility`/
 * `listNodes` decide eligibility from `supersede_log` plus `node_revisions`'
 * `is_active`/`valid_from`/`valid_to` -- a fixed binary/window state, never a
 * time-decaying score, heat counter or tier label. Nothing in the codebase
 * asserted the SCHEMA has no such column; this file is that schema-negative
 * pin, run directly against `TARGET_SCHEMA` (no dataset needed -- a column
 * either is or isn't declared).
 *
 * The second test proves the pin mechanism itself would catch a real
 * regression: it runs the identical predicate against a deliberately
 * poisoned copy of the schema and expects it to report the poison.
 *
 * Fix round (verifier finding, nonblocking): the AC-MATRIX row asks for "no
 * decay/heat/tier column in TARGET_SCHEMA" -- the WHOLE schema, not the three
 * tables `getRecallEligibility`/`listNodes` happen to read. Narrowing to
 * three also made the `if (columns === undefined) continue` guard below able
 * to go silently vacuous if one of those three were ever renamed. Scanning
 * every `TARGET_TABLES` entry returns the same `[]` today (confirmed), so the
 * narrowing bought nothing and cost real coverage.
 */

import { describe, expect, test } from "bun:test";
import { TARGET_SCHEMA, TARGET_TABLES } from "../src/publication/storage";

/** All 19 reviewed target tables -- a decay/heat/tier column is forbidden
 *  anywhere in the schema, not only on the tables the lifecycle/eligibility
 *  kernel itself reads today. */
const LIFECYCLE_ELIGIBILITY_TABLES = TARGET_TABLES;

const FORBIDDEN_NAME = /decay|heat|tier/i;

function forbiddenColumns(
  schema: Readonly<Record<string, ReadonlyArray<readonly [string, string, boolean]>>>,
  tables: readonly string[],
): string[] {
  const hits: string[] = [];
  for (const table of tables) {
    const columns = schema[table];
    if (columns === undefined) continue;
    for (const [name] of columns) {
      if (FORBIDDEN_NAME.test(name)) hits.push(`${table}.${name}`);
    }
  }
  return hits;
}

describe("#29 AC4: no decay, heat or tier column anywhere in TARGET_SCHEMA (all 19 tables)", () => {
  test("every TARGET_TABLES entry declares no decay/heat/tier column", () => {
    expect(forbiddenColumns(TARGET_SCHEMA, LIFECYCLE_ELIGIBILITY_TABLES)).toEqual([]);
  });

  test("mutation proof: the same predicate flags a poisoned schema", () => {
    const poisoned: Record<string, ReadonlyArray<readonly [string, string, boolean]>> = {
      ...TARGET_SCHEMA,
      nodes: [...TARGET_SCHEMA.nodes, ["decay_score", "float64", true]],
      supersede_log: [...TARGET_SCHEMA.supersede_log, ["heat_tier", "utf8", true]],
    };
    expect(forbiddenColumns(poisoned, LIFECYCLE_ELIGIBILITY_TABLES)).toEqual([
      "nodes.decay_score",
      "supersede_log.heat_tier",
    ]);
  });
});
