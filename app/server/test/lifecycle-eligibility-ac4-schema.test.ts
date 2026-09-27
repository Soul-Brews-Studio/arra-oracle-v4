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
 */

import { describe, expect, test } from "bun:test";
import { TARGET_SCHEMA } from "../src/publication/storage";

/** The tables `getRecallEligibility`/`listNodes`'s `eligible_only` view and
 *  `evaluateNodeEligibility` actually read (service.evaluateNodeEligibility.ts,
 *  service.getRecallEligibility.ts, service.listNodes.ts). */
const LIFECYCLE_ELIGIBILITY_TABLES = ["nodes", "node_revisions", "supersede_log"] as const;

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

describe("#29 AC4: no decay, heat or tier column on the lifecycle/eligibility tables", () => {
  test("nodes, node_revisions and supersede_log declare no decay/heat/tier column", () => {
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
