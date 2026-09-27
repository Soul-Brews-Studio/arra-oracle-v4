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
 *
 * Round 4 (verifier, nonblocking): the name blacklist alone let
 * `nodes.recall_score float64` + `nodes.last_recalled_at` through, and the
 * `columns === undefined` skip was dead code (it now throws, so a vanished
 * table can never make the scan vacuous). The three tables eligibility is
 * decided from get a stricter pin: no float column at all (a decaying score
 * needs one; today they hold only utf8/int64/bool/timestamp[us]) and a wider
 * name list for recall-scoring shapes. Wider names are NOT applied to the
 * other tables, which legitimately carry e.g. `terms.weight`,
 * `traces.friction_score` and `connections.last_seen`.
 */

import { describe, expect, test } from "bun:test";
import { TARGET_SCHEMA, TARGET_TABLES } from "../src/publication/storage";

/** All 19 reviewed target tables -- a decay/heat/tier column is forbidden
 *  anywhere in the schema, not only on the tables the lifecycle/eligibility
 *  kernel itself reads today. */
const LIFECYCLE_ELIGIBILITY_TABLES = TARGET_TABLES;

const FORBIDDEN_NAME = /decay|heat|tier/i;

/** The tables eligibility is decided from (DESIGN.md §9). */
const ELIGIBILITY_TABLES = ["nodes", "node_revisions", "supersede_log"] as const;
const FORBIDDEN_ELIGIBILITY_NAME = /decay|heat|tier|recall|score|rank|weight|strength|fade|half_life|ttl|access|hit|last_/i;
const FORBIDDEN_ELIGIBILITY_TYPE = /float|double|decimal/i;

type Schema = Readonly<Record<string, ReadonlyArray<readonly [string, string, boolean]>>>;

function forbiddenColumns(schema: Schema, tables: readonly string[], name = FORBIDDEN_NAME, type: RegExp | null = null): string[] {
  const hits: string[] = [];
  for (const table of tables) {
    const columns = schema[table];
    if (columns === undefined) throw new Error(`table ${table} is not in the schema: the scan would be vacuous`);
    for (const [column, columnType] of columns) {
      if (name.test(column) || (type !== null && type.test(columnType))) hits.push(`${table}.${column}`);
    }
  }
  return hits;
}
const eligibilityHits = (schema: Schema) =>
  forbiddenColumns(schema, ELIGIBILITY_TABLES, FORBIDDEN_ELIGIBILITY_NAME, FORBIDDEN_ELIGIBILITY_TYPE);

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

  test("the eligibility tables declare no float column and no recall-scoring name", () => {
    expect(eligibilityHits(TARGET_SCHEMA)).toEqual([]);
  });

  test("mutation proof: the stricter predicate flags what the blacklist lets through", () => {
    const poisoned: Record<string, ReadonlyArray<readonly [string, string, boolean]>> = {
      ...TARGET_SCHEMA,
      nodes: [...TARGET_SCHEMA.nodes, ["recall_score", "float64", true], ["last_recalled_at", "timestamp[us]", true]],
      node_revisions: [...TARGET_SCHEMA.node_revisions, ["salience", "float32", true]],
    };
    // The plain blacklist misses all three...
    expect(forbiddenColumns(poisoned, LIFECYCLE_ELIGIBILITY_TABLES)).toEqual([]);
    // ...the eligibility-table pin catches each, by name or by type.
    expect(eligibilityHits(poisoned)).toEqual(["nodes.recall_score", "nodes.last_recalled_at", "node_revisions.salience"]);
    expect(() => forbiddenColumns({}, ["nodes"])).toThrow("vacuous");
  });
});
