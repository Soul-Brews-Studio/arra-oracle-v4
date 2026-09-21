// Fast-first test ordering: precision/service/unit files (no real fd-42
// writer gate) run BEFORE ownership/recovery files (real gate, real
// SIGKILL, multi-process). A regression in a pure codec then fails in
// seconds instead of waiting behind ~400s of gate-serialized recovery
// tests. Regenerate with `bun run test:order`.
//
// The scan is RECURSIVE (`readdirSync(..., { recursive: true })`): test
// files can live under test/fixtures/<kernel>-v1/*.test.ts as well as flat
// in test/, and a non-recursive scan silently drops them from `bun run
// test` while `bun run test:full` (which passes the whole `test` directory
// to `bun test`) still finds them — a green fast run then means nothing for
// those files. See test/fixtures/context-v1/precision.test.ts and the three
// test/fixtures/publication-v1/*.test.ts files, found missing 2026-09-21.
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const testDir = join(import.meta.dir, "test");
const files = (readdirSync(testDir, { recursive: true }) as string[]).filter((f) =>
  f.endsWith(".test.ts"),
);

// Independent cross-check: walk the tree by hand, without the `{ recursive:
// true }` option, and compare counts. Two different scan implementations
// agreeing is real evidence; the same call checked against itself is not.
// This is what would have caught the original non-recursive readdirSync bug
// — it fails loudly instead of silently shipping a partial `test.order.txt`.
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name)));
    else if (entry.name.endsWith(".test.ts")) out.push(join(dir, entry.name));
  }
  return out;
}
const walked = walk(testDir).length;
if (files.length !== walked) {
  throw new Error(
    `test.order.ts: readdirSync({recursive:true}) found ${files.length} .test.ts files but an independent manual walk finds ${walked} — scan methods diverged, do not trust test.order.txt`,
  );
}

const isSlow = (name: string) => /recovery|ownership/.test(name);
files.sort((a, b) => {
  const bucketA = isSlow(a) ? 1 : 0;
  const bucketB = isSlow(b) ? 1 : 0;
  return bucketA - bucketB || a.localeCompare(b);
});

const lines = files.map((f) => `test/${f}`);
writeFileSync(join(import.meta.dir, "test.order.txt"), lines.join("\n") + "\n");
console.log(`${lines.length} files ordered: ${files.filter((f) => !isSlow(f)).length} fast, ${files.filter(isSlow).length} slow`);
