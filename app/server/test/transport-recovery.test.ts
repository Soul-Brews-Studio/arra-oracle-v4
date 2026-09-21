// #31 transport recovery evidence — the writer-ownership and write-gate
// properties, proven at the HTTP boundary rather than at the facade.
//
// Every request in this file goes through a REAL `createApp` wired to the
// REAL `createKnowledgeAccess` (src/knowledge/transport.ts), which itself
// opens the REAL `openEvidenceWriter`/`openEvidenceReader` from
// `src/publication/service.ts` against a REAL LanceDB dataset. Nothing here
// is a store mock. The child processes run inside the REAL writer gate
// (`arra_migrate.writer_gate.exec_with_gate`, fd 42, cooperative flock), the
// same harness `test/read-cursor-ownership.test.ts` and friends use.
//
// What this file proves, and how:
//
//   * Owner/poison semantics survive the boundary — a write that genuinely
//     fails at the SDK (a locked LanceDB table directory, not a commanded
//     hook) poisons the shared writer core, and a LATER transport request on
//     the SAME `KnowledgeAccess` — even a write on an unrelated facade — is
//     refused with `recovery_required`, while a READ on that same owner still
//     answers. This is the transport's OWN `createKnowledgeAccess`, which
//     caches one writer for the PROCESS lifetime (see the file header of
//     `src/knowledge/transport.ts`): the transport does NOT open a fresh
//     owner per request, so "the same owner" here really is the same process,
//     and the recovery lane below proves what DOES converge — a fresh
//     process — not a fresh owner within one.
//   * The writer gate serializes concurrent transport writers — twelve
//     concurrent HTTP write requests through one `KnowledgeAccess` all land,
//     none is lost or corrupted, and every one reads back exactly what it
//     wrote.
//
// Bounded claims, same as every other gated fixture in this package: a
// cooperative local flock, disposable fixtures, pinned Bun and Python on
// Darwin. Not power loss, not NFS, not a hostile same-UID process.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextFixture } from "./helpers/context-fixture";
import { PYTHON, runGated } from "./helpers/publication-fixture";

const TEST_DIR = import.meta.dir;
const CHILD = join(TEST_DIR, "fixtures", "transport-v1", "recovery", "transport-child.ts");
const TEST_TIMEOUT_MS = 120_000;
const WORKSPACE = "alpha-workspace";

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/transport-v1/recovery/transport-child.ts");
const PENDING = MISSING.length > 0;

test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});

const runIt = PENDING ? test.skip : test;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  const failures: string[] = [];
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch((error: unknown) => failures.push(String(error)));
  }
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join(" | ")}`);
});

async function freshDataset(): Promise<string> {
  const fixture = await createContextFixture([WORKSPACE, "beta-workspace"]);
  cleanups.push(fixture.cleanup);
  return fixture.datasetRoot;
}

const eventsOf = (stdout: string): { name: string; value: unknown }[] =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("EVENT "))
    .map((line) => {
      const rest = line.slice("EVENT ".length);
      const sp = rest.indexOf(" ");
      const name = sp === -1 ? rest : rest.slice(0, sp);
      const value = sp === -1 ? null : JSON.parse(rest.slice(sp + 1));
      return { name, value };
    });

/** Same recursive unlock the child uses: the child normally restores the
 *  table permissions itself, but a failing run may exit before that line. */
function unlockTree(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) unlockTree(join(dir, entry.name));
  }
}

function eventValue(events: { name: string; value: unknown }[], name: string): unknown {
  const found = events.find((e) => e.name === name);
  if (found === undefined) throw new Error(`no event ${name}; saw ${JSON.stringify(events.map((e) => e.name))}`);
  return found.value;
}

runIt(
  "a real SDK write failure poisons the shared owner across facades, and a read on the same owner still answers",
  async () => {
    const root = await freshDataset();
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-transport-recovery-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const result = await runGated(root, CHILD, ["poison", root, workDir], { deadlineMs: 60_000 });
    // A locked table left un-restored would make this assertion itself wrong,
    // so cleanup and the load-bearing check are the same fact.
    if (result.code !== 0) unlockTree(join(root, "peers.lance"));
    expect({ code: result.code, stderr: result.stderr.slice(-500) }).toEqual({ code: 0, stderr: "" });

    const events = eventsOf(result.stdout);

    // 1. The plain write, before anything is locked, succeeds over HTTP.
    const first = eventValue(events, "write:first") as { status: number; body: { outcome?: string; row?: { name?: string } } };
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("created");
    expect(first.body.row?.name).toBe("peer-first");

    // 2. The write that hits the locked table is refused as `recovery_required`
    //    at ITS OWN mapped status (503) -- not laundered into a generic 500,
    //    and not silently succeeding because the transport swallowed the
    //    SDK failure.
    const second = eventValue(events, "write:second-locked-table") as { status: number; body: Record<string, unknown> };
    expect(second.status).toBe(503);
    expect(second.body).toEqual({
      version: "arra-publication-error/v1",
      code: "recovery_required",
      path: "",
      message: "writer recovery required",
    });

    // 3. A DIFFERENT facade (registerSession, not registerPeer) on the SAME
    //    owner is ALSO refused -- poison is a property of the shared writer
    //    core (service.ts's `OwnerCore`), not of the table that failed.
    const third = eventValue(events, "write:third-different-facade") as { status: number; body: Record<string, unknown> };
    expect(third.status).toBe(503);
    expect(third.body).toEqual({
      version: "arra-publication-error/v1",
      code: "recovery_required",
      path: "",
      message: "writer recovery required",
    });

    // 4. A READ on the SAME owner still answers with the row from step 1 --
    //    reads bypass the write queue, so poison never blocks them.
    const read = eventValue(events, "read:after-poison") as { status: number; body: { name?: string } };
    expect(read.status).toBe(200);
    expect(read.body.name).toBe("peer-first");
  },
  TEST_TIMEOUT_MS,
);

runIt(
  "a fresh process (a fresh owner, not a fresh request within one) converges after the prior owner poisoned",
  async () => {
    // A SEPARATE dataset and a SEPARATE gated process: this is the honest
    // shape of "fresh owner" for THIS transport, since `createKnowledgeAccess`
    // caches one writer for the process lifetime rather than reopening per
    // request (see file header). The prior test proves the poisoned case on
    // one process; this one proves a brand-new process starts clean.
    const root = await freshDataset();
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-transport-recovery-fresh-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const result = await runGated(root, CHILD, ["fresh", root, workDir], { deadlineMs: 30_000 });
    expect({ code: result.code, stderr: result.stderr.slice(-500) }).toEqual({ code: 0, stderr: "" });
    const events = eventsOf(result.stdout);
    const write = eventValue(events, "write:fresh-owner") as { status: number; body: { outcome?: string; row?: { name?: string } } };
    expect(write.status).toBe(200);
    expect(write.body.outcome).toBe("created");
    expect(write.body.row?.name).toBe("peer-fresh");
  },
  TEST_TIMEOUT_MS,
);

runIt(
  "twelve concurrent transport writers through one writer gate all land, none lost or corrupted",
  async () => {
    const root = await freshDataset();
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-transport-recovery-serialize-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const result = await runGated(root, CHILD, ["serialize", root, workDir], { deadlineMs: 60_000 });
    expect({ code: result.code, stderr: result.stderr.slice(-500) }).toEqual({ code: 0, stderr: "" });
    const events = eventsOf(result.stdout);

    const writes = eventValue(events, "write:concurrent") as { status: number; body: { outcome?: string; row?: { name?: string } } }[];
    expect(writes.length).toBe(12);
    // BITE-relevant: this is a status check on EVERY one of the twelve, not a
    // count -- a queue bug that corrupted one row while leaving eleven fine
    // would still show status 200 everywhere unless the row content is
    // checked too, which the read pass below does.
    for (const write of writes) expect(write.status).toBe(200);

    const reads = eventValue(events, "read:concurrent") as { status: number; body: { name?: string } }[];
    expect(reads.length).toBe(12);
    const names = reads.map((r) => r.body.name).sort();
    const expected = Array.from({ length: 12 }, (_, i) => `peer-serial-${i}`).sort();
    // Every peer that was written is readable back under its OWN name: a
    // corrupted or interleaved write would show up here as a missing or
    // duplicated name, which a bare length check would not catch.
    expect(names).toEqual(expected);
    for (const read of reads) expect(read.status).toBe(200);
  },
  TEST_TIMEOUT_MS,
);
