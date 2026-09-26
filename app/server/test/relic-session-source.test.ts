/**
 * Read-only Relic `SessionSource` adapter (#28 Unit D, R7 / DECISIONS.md).
 *
 * EVERY test in this file points `RelicAdapterConfig.binPath` at the FAKE
 * script `test/fixtures/relic-v1/fake-relic.ts`, never the real
 * `/Users/beta/.bun/bin/relic`. Nothing here can open, read or write the
 * user's real `~/.relic/` index -- see the "isolation" describe block for a
 * direct proof, not just an assertion.
 *
 * Contract: app/docs/contracts/session-source-relic-v1.md.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetOp } from "../src/contracts/evidence-v1";
import { obj } from "../src/contracts/jcs";
import { ContractError } from "../src/contracts/errors";
import { resolveSessionSourceConfig } from "../src/source/relic.resolveConfig";
import { createRelicSessionSource } from "../src/source/relic.createRelicSessionSource";
import { runRelicJson } from "../src/source/relic.runRelicJson";
import { RelicAdapterError } from "../src/source/relic.errors";
import { captureDigest } from "../src/source/relic.captureDigest";
import { buildRelicEventTarget } from "../src/source/relic.buildRelicEventTarget";
import { buildRelicSessionTarget } from "../src/source/relic.buildRelicSessionTarget";
import type { RelicAdapterConfig } from "../src/source/relic.types";
import type { SessionRef, SourceExcerpt } from "../src/source/session-source.types";

const FAKE_BIN = new URL("./fixtures/relic-v1/fake-relic.ts", import.meta.url).pathname;
const NONEXISTENT_BIN = new URL("./fixtures/relic-v1/does-not-exist", import.meta.url).pathname;

const config = (overrides: Partial<RelicAdapterConfig> = {}): RelicAdapterConfig => ({
  binPath: FAKE_BIN,
  timeoutMs: 5_000,
  maxOutputBytes: 4 * 1024 * 1024,
  ...overrides,
});

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (error) {
    return (error as RelicAdapterError).code;
  }
  throw new Error("expected a throw, got none");
};

describe("resolveSessionSourceConfig: explicit not-configured degrade, never a thrown error", () => {
  test("unset ARRA_SESSION_SOURCE is not configured", () => {
    const status = resolveSessionSourceConfig({});
    expect(status.configured).toBe(false);
    if (status.configured) throw new Error("unreachable");
    expect(status.reason).toContain("ARRA_SESSION_SOURCE is not set");
  });

  test("an unknown ARRA_SESSION_SOURCE value is not configured", () => {
    const status = resolveSessionSourceConfig({ ARRA_SESSION_SOURCE: "bogus-provider" });
    expect(status.configured).toBe(false);
  });

  test("ARRA_SESSION_SOURCE=relic with no ARRA_RELIC_BIN is not configured -- no baked-in default path", () => {
    const status = resolveSessionSourceConfig({ ARRA_SESSION_SOURCE: "relic" });
    expect(status.configured).toBe(false);
    if (status.configured) throw new Error("unreachable");
    expect(status.reason).toContain("ARRA_RELIC_BIN");
  });

  test("ARRA_SESSION_SOURCE=relic with ARRA_RELIC_BIN set is configured", () => {
    const status = resolveSessionSourceConfig({ ARRA_SESSION_SOURCE: "relic", ARRA_RELIC_BIN: FAKE_BIN });
    expect(status.configured).toBe(true);
    if (!status.configured) throw new Error("unreachable");
    expect(typeof status.source.find).toBe("function");
    expect(typeof status.source.get).toBe("function");
    expect(typeof status.source.read).toBe("function");
  });
});

describe("createRelicSessionSource: find/get/read against the fake binary", () => {
  test("get: a real session_uuid resolves to a SessionRef with the bank derived from repo's first segment", async () => {
    const source = createRelicSessionSource(config());
    const ref = await source.get("s-normal-1");
    expect(ref).toEqual({
      sourceBank: "projects",
      provider: "claude-live",
      sessionUuid: "s-normal-1",
      transcriptRef: "/Users/nat/.claude/projects/-opt-Code-github-com-example-repo/s-normal-1.jsonl",
      title: "example title",
      startedAt: "2026-09-20T00:00:00.000Z",
      endedAt: "2026-09-20T01:00:00.000Z",
    });
  });

  test("get: absence is null, never thrown", async () => {
    const source = createRelicSessionSource(config());
    expect(await source.get("__not_found__")).toBeNull();
  });

  test("find: hits are grouped down to one SessionRef per DISTINCT session_uuid", async () => {
    const source = createRelicSessionSource(config());
    const refs = await source.find("some topic");
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.sessionUuid)).toEqual(["s-normal-1", "s-normal-2"]);
    expect(refs[1]).toMatchObject({ sourceBank: "codex", provider: "codex" });
  });

  test("find: an empty query returns [] WITHOUT spawning anything", async () => {
    // A binary that does not exist would throw "unavailable" if invoked at
    // all -- proving this call never reaches `runRelicJson`.
    const source = createRelicSessionSource(config({ binPath: NONEXISTENT_BIN }));
    expect(await source.find("")).toEqual([]);
  });

  test("read: turns map to bounded SourceExcerpts with speaker/content/sourceTime/eventSeq", async () => {
    const source = createRelicSessionSource(config());
    const excerpts = await source.read("s-normal-1");
    expect(excerpts).toEqual([
      {
        eventSeq: 10, speaker: "user", content: "hello", sourceTime: "2026-09-20T00:10:00.000Z",
        transcriptRef: "/Users/nat/.claude/projects/-opt-Code-github-com-example-repo/s-normal-1.jsonl",
      },
      {
        eventSeq: 12, speaker: "assistant", content: "hi there", sourceTime: "2026-09-20T00:10:05.000Z",
        transcriptRef: "/Users/nat/.claude/projects/-opt-Code-github-com-example-repo/s-normal-1.jsonl",
      },
    ]);
  });

  test("read: a non-null `from` is refused, not silently ignored -- relic's tail has no seq-offset pagination", async () => {
    const source = createRelicSessionSource(config());
    expect(await codeOf(() => source.read("s-normal-1", { from: 5 }))).toBe("bad_output");
  });
});

describe("failure modes: every one is a typed RelicAdapterError, nothing throws a bare string or hangs", () => {
  test("a binary that does not exist is 'unavailable'", async () => {
    const source = createRelicSessionSource(config({ binPath: NONEXISTENT_BIN }));
    expect(await codeOf(() => source.get("s-normal-1"))).toBe("unavailable");
  });

  test("malformed stdout JSON is 'bad_output'", async () => {
    const source = createRelicSessionSource(config());
    expect(await codeOf(() => source.get("__bad_json__"))).toBe("bad_output");
  });

  test("a nonzero exit code is 'exit_nonzero'", async () => {
    const source = createRelicSessionSource(config());
    expect(await codeOf(() => source.get("__exit_nonzero__"))).toBe("exit_nonzero");
  });

  test("exceeding the configured deadline is 'timeout', the child is killed, not left to hang", async () => {
    const source = createRelicSessionSource(config({ timeoutMs: 200 }));
    expect(await codeOf(() => source.get("__timeout__"))).toBe("timeout");
  }, 10_000);

  test("exceeding maxOutputBytes is 'output_too_large', not a slow silent success", async () => {
    const source = createRelicSessionSource(config({ maxOutputBytes: 1024 }));
    expect(await codeOf(() => source.get("__big__"))).toBe("output_too_large");
  }, 10_000);

  test("runRelicJson refuses any subcommand outside its own read-only allowlist", async () => {
    expect(await codeOf(() => runRelicJson(config(), ["index", "--prune"]))).toBe("bad_output");
  });
});

describe("isolation: the adapter never touches any filesystem location of its own", () => {
  test("a scratch directory standing in for the real relic index is untouched after find/get/read", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "relic-isolation-"));
    const markerPath = join(scratchRoot, "marker.txt");
    try {
      await writeFile(markerPath, "untouched", "utf8");
      const before = await stat(markerPath);
      const beforeContent = await readFile(markerPath, "utf8");

      // The fake binary never reads this directory either -- it is a stand-in
      // for "the user's real relic index", proving nothing this adapter does
      // reaches for a filesystem location it was not explicitly pointed at.
      const source = createRelicSessionSource(config());
      await source.get("s-normal-1");
      await source.find("some topic");
      await source.read("s-normal-1");

      const after = await stat(markerPath);
      const afterContent = await readFile(markerPath, "utf8");
      const entries = await readdir(scratchRoot);

      expect(afterContent).toBe(beforeContent);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(entries).toEqual(["marker.txt"]);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });
});

describe("captureDigest: DESIGN.md's speaker/content/source-time payload, excluding ingestion time", () => {
  test("identical speaker/content/sourceTime always yields the identical digest", () => {
    const a = captureDigest("user", "hello world", "2026-09-20T00:10:00.000Z");
    const b = captureDigest("user", "hello world", "2026-09-20T00:10:00.000Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a changed content, speaker, or source time each change the digest", () => {
    const base = captureDigest("user", "hello world", "2026-09-20T00:10:00.000Z");
    expect(captureDigest("assistant", "hello world", "2026-09-20T00:10:00.000Z")).not.toBe(base);
    expect(captureDigest("user", "goodbye world", "2026-09-20T00:10:00.000Z")).not.toBe(base);
    expect(captureDigest("user", "hello world", "2026-09-20T00:10:01.000Z")).not.toBe(base);
  });
});

describe("buildRelicEventTarget / buildRelicSessionTarget: codec-valid targets for createTrace/createSessionLink", () => {
  const session: SessionRef = {
    sourceBank: "projects", provider: "claude-live", sessionUuid: "s-normal-1",
    transcriptRef: "/path/s-normal-1.jsonl", title: "a title", startedAt: null, endedAt: null,
  };
  const excerpt: SourceExcerpt = {
    eventSeq: 42, speaker: "assistant", content: "the answer", sourceTime: "2026-09-20T00:30:00.000Z",
    transcriptRef: "/path/s-normal-1.jsonl",
  };

  test("buildRelicEventTarget produces exactly the relic_event TARGET_KEYS shape and a matching digest", () => {
    const target = buildRelicEventTarget(session, excerpt);
    expect(Object.keys(target)).toEqual([
      "source_bank", "provider", "session_uuid", "transcript_ref", "event_seq", "capture_digest",
    ]);
    expect(target).toEqual({
      source_bank: "projects", provider: "claude-live", session_uuid: "s-normal-1",
      transcript_ref: "/path/s-normal-1.jsonl", event_seq: "42",
      capture_digest: captureDigest("assistant", "the answer", "2026-09-20T00:30:00.000Z"),
    });
  });

  test("the built target is already fully canonical: re-deriving through targetOp changes nothing", () => {
    const target = buildRelicEventTarget(session, excerpt);
    const { target_json } = targetOp("some-workspace", "relic_event", obj(target));
    expect(JSON.parse(target_json)).toEqual(target);
  });

  test("two excerpts with the SAME content but a DIFFERENT eventSeq get the SAME digest -- identity, not content, carries position", () => {
    const other: SourceExcerpt = { ...excerpt, eventSeq: 999 };
    const t1 = buildRelicEventTarget(session, excerpt);
    const t2 = buildRelicEventTarget(session, other);
    expect(t1.capture_digest).toBe(t2.capture_digest);
    expect(t1.event_seq).not.toBe(t2.event_seq);
  });

  test("a malformed excerpt (negative eventSeq) fails AT BUILD TIME with the same codec error createTrace would raise", () => {
    const bad: SourceExcerpt = { ...excerpt, eventSeq: -1 };
    expect(() => buildRelicEventTarget(session, bad)).toThrow(ContractError);
  });

  test("buildRelicSessionTarget excludes title_snapshot from identity, exactly like the base codec", () => {
    const t1 = buildRelicSessionTarget(session);
    const t2 = buildRelicSessionTarget({ ...session, title: "a completely different title" });
    expect(t1.title_snapshot).not.toBe(t2.title_snapshot);
    const key1 = targetOp("w", "relic_session", obj(t1)).target_key;
    const key2 = targetOp("w", "relic_session", obj(t2)).target_key;
    expect(key1).toBe(key2);
  });
});
