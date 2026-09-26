#!/usr/bin/env bun
/**
 * Fake `relic` binary for `relic-session-source.test.ts`. Tests inject THIS
 * FILE's path as `RelicAdapterConfig.binPath` -- `runRelicJson` never knows
 * or cares that it is not the real executable, and the real relic index at
 * `~/.relic/` is never opened, read or touched by anything in this test file.
 *
 * Every scenario is selected by a MAGIC id/query in argv, not by an
 * environment variable: the real adapter never sets one, and a magic-argv
 * design keeps each spawned child fully self-contained, so parallel test
 * files can never interfere with each other through shared process state.
 *
 * Real relic ALWAYS appends `--json` itself was already stripped/ignored
 * here on purpose: this fake looks only at the subcommand and the first
 * positional argument, exactly like the measurements in
 * `session-source-relic-v1.md`'s "what is read" section.
 */

const args = process.argv.slice(2);
const subcommand = args[0];
const first = args[1];

function printAndExit(body: string, code = 0): never {
  process.stdout.write(body);
  process.exit(code);
}

switch (first) {
  case "__not_found__":
    printAndExit(JSON.stringify({ sessions: [], hits: [] }));
    break;
  case "__bad_json__":
    printAndExit("{ this is not json");
    break;
  case "__exit_nonzero__":
    printAndExit("", 3);
    break;
  case "__timeout__": {
    // Sleep well past any test's configured timeoutMs; the parent SIGKILLs
    // this process, which is exactly the behavior under test.
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      /* busy-wait: no timers, no I/O, nothing this fake needs to clean up */
    }
    printAndExit(JSON.stringify({ sessions: [] }));
    break;
  }
  case "__big__":
    // 32 MiB of padding inside a structurally valid JSON string, to exercise
    // the output byte cap without needing a real large transcript.
    printAndExit(JSON.stringify({ sessions: [], padding: "x".repeat(32 * 1024 * 1024) }));
    break;
}

if (subcommand === "session") {
  printAndExit(
    JSON.stringify({
      sessions: [
        {
          session_uuid: "s-normal-1",
          file_path: "/Users/nat/.claude/projects/-opt-Code-github-com-example-repo/s-normal-1.jsonl",
          repo: "projects/github.com/example/repo",
          source: "claude-live",
          title: "example title",
          started_at: "2026-09-20T00:00:00.000Z",
          ended_at: "2026-09-20T01:00:00.000Z",
        },
      ],
    }),
  );
}

if (subcommand === "search") {
  printAndExit(
    JSON.stringify({
      query: first,
      hits: [
        {
          session_uuid: "s-normal-1",
          file_path: "/Users/nat/.claude/projects/-opt-Code-github-com-example-repo/s-normal-1.jsonl",
          repo: "projects/github.com/example/repo",
          source: "claude-live",
          seq: 42,
          role: "assistant",
          ts: "2026-09-20T00:30:00.000Z",
          text: "first hit, session 1",
        },
        {
          // A SECOND hit in the SAME session -- must be deduplicated by
          // findSessions, keeping only the first (higher-ranked) one.
          session_uuid: "s-normal-1",
          file_path: "/Users/nat/.claude/projects/-opt-Code-github-com-example-repo/s-normal-1.jsonl",
          repo: "projects/github.com/example/repo",
          source: "claude-live",
          seq: 45,
          role: "user",
          ts: "2026-09-20T00:31:00.000Z",
          text: "second hit, still session 1",
        },
        {
          session_uuid: "s-normal-2",
          file_path: "/Users/beta/.codex/sessions/2026/09/25/s-normal-2.jsonl",
          repo: "codex/github.com/example/repo",
          source: "codex",
          seq: 7,
          role: "assistant",
          ts: "2026-09-21T00:00:00.000Z",
          text: "hit in session 2",
        },
      ],
    }),
  );
}

if (subcommand === "tail") {
  printAndExit(
    JSON.stringify({
      file: "/Users/nat/.claude/projects/-opt-Code-github-com-example-repo/s-normal-1.jsonl",
      title: "example title",
      turns: [
        { seq: 10, role: "user", ts: "2026-09-20T00:10:00.000Z", text: "hello" },
        { seq: 12, role: "assistant", ts: "2026-09-20T00:10:05.000Z", text: "hi there" },
      ],
    }),
  );
}

printAndExit(JSON.stringify({ error: `fake-relic: unhandled subcommand ${String(subcommand)}` }), 1);
