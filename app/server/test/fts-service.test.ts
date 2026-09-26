/**
 * #10 / R14: the legacy `memories` keyword path finds Thai inside a word.
 *
 * v3 shipped `porter unicode61`, which cannot see Thai from inside a word; v4
 * shipped LanceDB `icu`, which segments whole words and is blind to the same
 * case (measured 0/2 on ลืม and หลง inside หลงลืม). R14 moves the index to a
 * faithful character trigram -- ngram(3,3), no stemming, no stop-word removal
 * -- and adds the two things a bare trigram index gets wrong:
 *
 *   - under 3 code points it silently returns nothing, so short queries fall
 *     back to a bounded, escaped substring scan and the response SAYS so;
 *   - it over-matches (หลงทาง -> the หลงลืม row), so every candidate is
 *     re-checked as a literal, case-folded substring before it is returned.
 *
 * Every test drives the REAL product path (`db.ts`, the startup index work,
 * `GET /api/search`, MCP `recall`) in a child process on a fresh mktemp
 * dataset; see the child's header for why it is a child. Nothing here opens
 * an existing dataset or calls a model.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createScratch, TOKENS, type Scratch } from "./helpers/auth-fixture";
import { runOwnedChild } from "./helpers/publication-fixture";

const CHILD = new URL("./fixtures/fts-v1/core/fts-child.ts", import.meta.url).pathname;
const TIMEOUT_MS = 120_000;

/** The index R14 requires, as `listIndices().indexDetails` reports it. */
const TRIGRAM_DETAILS = {
  base_tokenizer: "ngram",
  min_ngram_length: 3,
  max_ngram_length: 3,
  prefix_only: false,
  stem: false,
  remove_stop_words: false,
};
/** What an existing deployment built before R14: `Index.fts({baseTokenizer:"icu"})`. */
const ICU_OPTIONS = { baseTokenizer: "icu" };

let scratch: Scratch | null = null;
afterEach(async () => {
  await scratch?.cleanup();
  scratch = null;
});

const drive = async (ops: Array<Record<string, unknown>>): Promise<Record<string, any>> => {
  scratch ??= await createScratch();
  const result = await runOwnedChild(process.execPath, [CHILD, JSON.stringify({ ops })], {
    env: {
      ARRA_DATA_DIR: scratch.dataDir,
      ARRA_AUTH_POLICY: scratch.policyPath,
      ARRA_KNOWLEDGE_DATASET_ROOT: "",
      OLLAMA_URL: "http://mock-embedder.invalid",
    },
  });
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 900)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 900)}`);
  return JSON.parse(line);
};

const value = (op: any, label: string) => {
  expect(op?.ok, `${label}: ${JSON.stringify(op)}`).toBe(true);
  return op.value;
};
/** Rows of a text search, tolerating the pre-R14 bare-array shape so a red run shows WHICH rows. */
const rowsOf = (op: any, label: string): Array<Record<string, any>> => {
  const v = value(op, label);
  return Array.isArray(v) ? v : v.rows;
};
const ids = (op: any, label: string) => rowsOf(op, label).map((row) => row.id);
const insert = (workspace_name: string, content: string) => ({ op: "insert", workspace_name, content });
const search = (q: string, bank = "alpha", limit?: number) => ({ op: "searchText", q, bank, limit });

describe("the content index is a faithful character trigram", () => {
  test("startup builds exactly one FTS index on content: ngram(3,3), no stemming, no stop-word removal", async () => {
    const parsed = await drive([{ op: "startupIndexWork" }, { op: "ftsIndices" }]);
    value(parsed.op0, "startup index work");
    expect(value(parsed.op1, "indices")).toEqual([{ name: "content_idx", details: TRIGRAM_DETAILS }]);
  }, TIMEOUT_MS);

  test("an existing index that already matches is kept: no rebuild, no new table version", async () => {
    const parsed = await drive([
      { op: "startupIndexWork" },
      { op: "version" },
      { op: "startupIndexWork" },
      { op: "ensureFtsIndex", replace: false },
      { op: "version" },
      { op: "ftsIndices" },
    ]);
    expect(value(parsed.op4, "version after")).toBe(value(parsed.op1, "version before"));
    expect(value(parsed.op5, "indices")).toEqual([{ name: "content_idx", details: TRIGRAM_DETAILS }]);
  }, TIMEOUT_MS);

  test("a stale ICU index from an older deployment is rebuilt ONCE, under the same name", async () => {
    const parsed = await drive([
      insert("alpha", "ฉันหลงลืมกุญแจไว้ที่บ้าน"),
      { op: "rawFtsIndex", options: ICU_OPTIONS },
      { op: "ftsIndices" },
      { op: "version" },
      { op: "startupIndexWork" },
      { op: "version" },
      { op: "startupIndexWork" },
      { op: "version" },
      { op: "ftsIndices" },
      search("ลืม"),
    ]);
    // The planted index really is the pre-R14 shape.
    expect(value(parsed.op2, "planted").map((i: any) => i.details.base_tokenizer)).toEqual(["icu"]);
    const [before, rebuilt, again] = [value(parsed.op3, "v0"), value(parsed.op5, "v1"), value(parsed.op7, "v2")];
    expect(rebuilt).toBeGreaterThan(before);
    expect(again).toBe(rebuilt);
    expect(value(parsed.op8, "indices")).toEqual([{ name: "content_idx", details: TRIGRAM_DETAILS }]);
    expect(ids(parsed.op9, "ลืม after upgrade")).toEqual([value(parsed.op0, "insert").id]);
  }, TIMEOUT_MS);

  test("a second FTS index on content is collapsed, so search cannot quietly keep using ICU", async () => {
    const parsed = await drive([
      { op: "startupIndexWork" },
      { op: "rawFtsIndex", options: ICU_OPTIONS, name: "content_icu" },
      { op: "ftsIndices" },
      { op: "startupIndexWork" },
      { op: "ftsIndices" },
    ]);
    expect(value(parsed.op2, "planted").length).toBe(2);
    const after = value(parsed.op4, "indices");
    expect(after.length).toBe(1);
    expect(after[0].details).toEqual(TRIGRAM_DETAILS);
  }, TIMEOUT_MS);
});

describe("Thai and English retrieval on the product path", () => {
  test("ลืม and หลง are found inside หลงลืม, scoped to the requesting workspace", async () => {
    const parsed = await drive([
      insert("alpha", "ฉันหลงลืมกุญแจไว้ที่บ้าน"),
      insert("beta", "ฉันหลงลืมกุญแจไว้ที่บ้าน"),
      insert("alpha", "the quick brown fox"),
      { op: "ensureFtsIndex", replace: true },
      search("ลืม"),
      search("หลง"),
      search("หลงลืม"),
      search("brown"),
      search("the"),
      search("ทะเล"),
      search("zebra"),
      search("ลืม", "beta"),
    ]);
    const thai = value(parsed.op0, "alpha thai").id;
    const beta = value(parsed.op1, "beta thai").id;
    const fox = value(parsed.op2, "alpha fox").id;
    // FAILED before R14: icu returned [] for both inside-word queries.
    expect(ids(parsed.op4, "ลืม")).toEqual([thai]);
    expect(ids(parsed.op5, "หลง")).toEqual([thai]);
    expect(ids(parsed.op6, "หลงลืม")).toEqual([thai]);
    expect(ids(parsed.op7, "brown")).toEqual([fox]);
    // Stop-word removal runs even in ngram mode unless disabled: `the` must still hit.
    expect(ids(parsed.op8, "the")).toEqual([fox]);
    expect(ids(parsed.op9, "ทะเล")).toEqual([]);
    expect(ids(parsed.op10, "zebra")).toEqual([]);
    expect(ids(parsed.op11, "beta ลืม")).toEqual([beta]);
    for (const key of ["op4", "op5", "op6", "op7", "op8"]) {
      expect(value(parsed[key], key).match).toBe("ngram");
      expect(rowsOf(parsed[key], key).every((row) => row.workspace_name === "alpha")).toBe(true);
    }
  }, TIMEOUT_MS);

  test("trigram over-matches are removed: หลงทาง and ความทรงจำ return only literal substrings", async () => {
    const parsed = await drive([
      insert("alpha", "ฉันหลงลืมกุญแจไว้ที่บ้าน"),
      insert("alpha", "ความทรงจำของเรา"),
      insert("alpha", "ความรัก"),
      insert("alpha", "The Brown Bear"),
      { op: "ensureFtsIndex", replace: true },
      search("หลงทาง"),
      search("ความทรงจำ"),
      search("ROW"),
      search("bear cub"),
    ]);
    // ngram alone returns the หลงลืม row for หลงทาง (shared trigram หลง)...
    expect(ids(parsed.op5, "หลงทาง")).toEqual([]);
    // ...and the ความรัก row for ความทรงจำ (shared trigram ควา/วาม).
    expect(ids(parsed.op6, "ความทรงจำ")).toEqual([value(parsed.op1, "memory row").id]);
    // Case-folded like the index, and still a substring contract: "row" IS inside "Brown".
    expect(ids(parsed.op7, "ROW")).toEqual([value(parsed.op3, "bear row").id]);
    // Sharing trigrams (bea, ear) is not containing the query.
    expect(ids(parsed.op8, "bear cub")).toEqual([]);
  }, TIMEOUT_MS);

  test("a query shorter than three code points is a bounded substring scan, and the response says so", async () => {
    const parsed = await drive([
      insert("alpha", "เราไปทะเลกัน"),
      insert("beta", "ไปไหนมา"),
      insert("alpha", "Go home"),
      insert("alpha", "ab one"),
      insert("alpha", "ab two"),
      insert("alpha", "ab three"),
      { op: "ensureFtsIndex", replace: true },
      search("ไป"),
      search("ไ"),
      search("go"),
      search("ab", "alpha", 2),
    ]);
    const trip = value(parsed.op0, "trip").id;
    // FAILED before R14 on the match field; ngram alone returns [] for ไป.
    expect(value(parsed.op7, "ไป").match).toBe("substring_scan");
    expect(ids(parsed.op7, "ไป")).toEqual([trip]);
    expect(ids(parsed.op8, "ไ")).toEqual([trip]);
    expect(ids(parsed.op9, "go")).toEqual([value(parsed.op2, "go").id]);
    const bounded = rowsOf(parsed.op10, "ab limit 2");
    expect(bounded.length).toBe(2);
    expect(bounded.every((row) => String(row.content).startsWith("ab "))).toBe(true);
  }, TIMEOUT_MS);

  test("LIKE wildcards, quotes, backslashes and FTS phrase quotes in a query are literal text", async () => {
    const parsed = await drive([
      insert("alpha", "50% off"),
      insert("alpha", "5000 off"),
      insert("alpha", "a_b"),
      insert("alpha", "axb"),
      insert("alpha", "O'Brien"),
      insert("alpha", "path\\to"),
      insert("alpha", 'say "quoted" here'),
      { op: "ensureFtsIndex", replace: true },
      search("0%"),
      search("_b"),
      search("O'"),
      search("\\"),
      search('"quoted"'),
      search('"absent"'),
      search("h\\t"),
    ]);
    const id = (i: number) => value(parsed[`op${i}`], `row ${i}`).id;
    expect(ids(parsed.op8, "0%")).toEqual([id(0)]);
    expect(ids(parsed.op9, "_b")).toEqual([id(2)]);
    expect(ids(parsed.op10, "O'")).toEqual([id(4)]);
    expect(ids(parsed.op11, "backslash")).toEqual([id(5)]);
    // A double-quoted string must not turn into a phrase query the index cannot serve.
    expect(ids(parsed.op12, '"quoted"')).toEqual([id(6)]);
    expect(ids(parsed.op13, '"absent"')).toEqual([]);
    expect(ids(parsed.op14, "h\\t")).toEqual([id(5)]);
  }, TIMEOUT_MS);
});

describe("the match mode reaches every transport", () => {
  test("GET /api/search and MCP recall both report match: ngram or substring_scan", async () => {
    const token = TOKENS.alpha.secret;
    const parsed = await drive([
      insert("alpha", "ฉันหลงลืมกุญแจไว้ที่บ้าน"),
      insert("alpha", "เราไปทะเลกัน"),
      { op: "ensureFtsIndex", replace: true },
      { op: "http", token, path: `/api/search?bank=alpha&q=${encodeURIComponent("ลืม")}` },
      { op: "http", token, path: `/api/search?bank=alpha&q=${encodeURIComponent("ไป")}` },
      { op: "mcp", token, bank: "alpha", tool: "recall", args: { query: "ลืม" } },
      { op: "mcp", token, bank: "alpha", tool: "recall", args: { query: "ไป", mode: "text" } },
    ]);
    const forgot = value(parsed.op0, "forgot").id;
    const trip = value(parsed.op1, "trip").id;

    const http3 = value(parsed.op3, "http ลืม");
    expect(http3.status).toBe(200);
    expect(http3.body).toMatchObject({ mode: "text", match: "ngram", count: 1 });
    expect(http3.body.rows.map((row: any) => row.id)).toEqual([forgot]);
    const http4 = value(parsed.op4, "http ไป");
    expect(http4.body).toMatchObject({ mode: "text", match: "substring_scan", count: 1 });
    expect(http4.body.rows.map((row: any) => row.id)).toEqual([trip]);

    const mcp5 = value(parsed.op5, "mcp ลืม");
    expect(mcp5.isError).toBe(false);
    expect(mcp5.value).toMatchObject({ mode: "text", match: "ngram", count: 1 });
    expect(mcp5.value.rows.map((row: any) => row.id)).toEqual([forgot]);
    const mcp6 = value(parsed.op6, "mcp ไป");
    expect(mcp6.value).toMatchObject({ mode: "text", match: "substring_scan", count: 1 });
    expect(mcp6.value.rows.map((row: any) => row.id)).toEqual([trip]);
  }, TIMEOUT_MS);
});
