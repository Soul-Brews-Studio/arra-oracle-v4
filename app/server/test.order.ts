// Fast-first test ordering: precision/service/unit files (no real fd-42
// writer gate) run BEFORE ownership/recovery files (real gate, real
// SIGKILL, multi-process). A regression in a pure codec then fails in
// seconds instead of waiting behind ~400s of gate-serialized recovery
// tests. Regenerate with `bun run test:order`.
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const testDir = join(import.meta.dir, "test");
const files = readdirSync(testDir).filter((f) => f.endsWith(".test.ts"));

const isSlow = (name: string) => /recovery|ownership/.test(name);
files.sort((a, b) => {
  const bucketA = isSlow(a) ? 1 : 0;
  const bucketB = isSlow(b) ? 1 : 0;
  return bucketA - bucketB || a.localeCompare(b);
});

const lines = files.map((f) => `test/${f}`);
writeFileSync(join(import.meta.dir, "test.order.txt"), lines.join("\n") + "\n");
console.log(`${lines.length} files ordered: ${files.filter((f) => !isSlow(f)).length} fast, ${files.filter(isSlow).length} slow`);
