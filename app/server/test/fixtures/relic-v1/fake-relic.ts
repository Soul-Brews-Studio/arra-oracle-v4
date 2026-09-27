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
 * The ONE exception is `RELIC_FAKE_RECORD` below -- a test-only, opt-in
 * side channel for recording exactly what argv/env a call received, never
 * consulted to pick a response.
 *
 * This fake also REFUSES to behave like real relic would if the adapter
 * regressed on isolation: no `RELIC_NO_TRACE=1` (real relic's `cmdSearch`
 * appends a trace-log line otherwise), a `session` lookup without
 * `--no-index` (real relic would import a matching on-disk file into the
 * user's live index on a cache miss), or a `tail` target that is a bare id
 * rather than a file path (real relic resolves a bare id through the SAME
 * import-on-miss path `session` uses -- a target containing `/` is read
 * directly with no index lookup at all). Each of these exits nonzero so a
 * regression surfaces as a loud, specific test failure, not a silent pass.
 */

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const subcommand = args[0];
const first = args[1];

function printAndExit(body: string, code = 0): never {
  process.stdout.write(body);
  process.exit(code);
}

function refuse(reason: string): never {
  process.stderr.write(`fake-relic: refusing -- ${reason}\n`);
  process.exit(9);
}

// Opt-in recording, for tests that need to inspect the EXACT argv/env a call
// produced (not just its JSON response) -- see the "argv/env delivered to
// the real spawn" describe block in relic-session-source.test.ts.
const recordPath = process.env.RELIC_FAKE_RECORD;
if (recordPath) {
  appendFileSync(recordPath, JSON.stringify({ argv: args, env_no_trace: process.env.RELIC_NO_TRACE ?? null }) + "\n");
}

// Global isolation invariant: every real invocation must disable relic's own
// query trace log, regardless of subcommand -- checked before anything else,
// including the magic-id short circuits below.
if (process.env.RELIC_NO_TRACE !== "1") {
  refuse("RELIC_NO_TRACE=1 was not set -- real relic's `search` would append a trace.jsonl line");
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
  // Isolation invariant: a read-only `session` lookup must never risk
  // relic's import-on-miss fallback. See the file header.
  if (!args.includes("--no-index")) refuse("`session` was called without --no-index");

  if (first === "__name_mismatch__") {
    // Simulates relic's NAME fallback: the row it returns is a real
    // session, but its `session_uuid` is NOT the one that was asked for.
    printAndExit(
      JSON.stringify({
        sessions: [
          {
            session_uuid: "some-other-session-entirely",
            tier: "session",
            file_path: "/Users/nat/.claude/projects/-other/some-other-session-entirely.jsonl",
            repo: "projects/github.com/example/other-repo",
            source: "claude-live",
            title: "an unrelated session that happens to match by name",
            started_at: "2026-08-01T00:00:00.000Z",
            ended_at: "2026-08-01T01:00:00.000Z",
          },
        ],
      }),
    );
  }

  if (first === "__subagent_only__") {
    // The requested uuid matches, but the ONLY row sharing it is a
    // subagent transcript, never the top-level session.
    printAndExit(
      JSON.stringify({
        sessions: [
          {
            session_uuid: "__subagent_only__",
            tier: "subagent",
            file_path: "/Users/nat/.claude/projects/-x/__subagent_only__/subagents/child.jsonl",
            repo: "projects/github.com/example/repo",
            source: "claude-live",
            started_at: "2026-09-20T00:00:00.000Z",
            ended_at: "2026-09-20T00:05:00.000Z",
          },
        ],
      }),
    );
  }

  if (first === "__tree__") {
    // A whole tree sharing one session_uuid: the subagent row is listed
    // FIRST, to prove the adapter picks tier:"session" and never `[0]`.
    printAndExit(
      JSON.stringify({
        sessions: [
          {
            session_uuid: "__tree__",
            tier: "subagent",
            file_path: "/Users/nat/.claude/projects/-x/__tree__/subagents/child.jsonl",
            repo: "projects/github.com/example/repo",
            source: "claude-live",
            started_at: "2026-09-20T00:01:00.000Z",
            ended_at: "2026-09-20T00:02:00.000Z",
          },
          {
            session_uuid: "__tree__",
            tier: "session",
            file_path: "/Users/nat/.claude/projects/-x/__tree__.jsonl",
            repo: "projects/github.com/example/repo",
            source: "claude-live",
            title: "tree parent",
            started_at: "2026-09-20T00:00:00.000Z",
            ended_at: "2026-09-20T00:10:00.000Z",
          },
        ],
      }),
    );
  }

  if (first === "__malformed_turn__") {
    printAndExit(
      JSON.stringify({
        sessions: [
          {
            session_uuid: "__malformed_turn__",
            tier: "session",
            file_path: "/Users/nat/.claude/projects/-x/__malformed_turn__.jsonl",
            repo: "projects/github.com/example/repo",
            source: "claude-live",
            started_at: "2026-09-20T00:00:00.000Z",
            ended_at: "2026-09-20T00:10:00.000Z",
          },
        ],
      }),
    );
  }

  printAndExit(
    JSON.stringify({
      sessions: [
        {
          session_uuid: "s-normal-1",
          tier: "session",
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
  if (first === "__missing_repo_hit__") {
    printAndExit(
      JSON.stringify({
        hits: [
          {
            session_uuid: "s-bad-hit",
            file_path: "/x/s-bad-hit.jsonl",
            source: "claude-live",
            seq: 1,
            role: "user",
            ts: "2026-09-20T00:00:00.000Z",
            text: "no repo field on this hit",
          },
        ],
      }),
    );
  }

  if (first === "__shared_cwd__") {
    // #28 "cwd-only foreign visitor" (docs/overnight/FOREIGN-VISITOR.md): an
    // owner session and a visitor from another oracle's corpus that RAN IN
    // THE SAME DIRECTORY. relic files both under one cwd-derived `repo` key
    // and one project folder; nothing in the row says whose corpus a session
    // belongs to. The owner's hit ranks first on purpose.
    const folder = "/Users/nat/.claude/projects/-opt-Code-github-com-example-neo-oracle";
    printAndExit(
      JSON.stringify({
        query: first,
        hits: [
          { session_uuid: "s-owner", file_path: `${folder}/s-owner.jsonl`, repo: "projects/github.com/example/neo-oracle",
            source: "claude-live", seq: 3, role: "assistant", ts: "2026-09-16T10:00:00.000Z", text: "owner hit" },
          { session_uuid: "s-visitor", file_path: `${folder}/s-visitor.jsonl`, repo: "projects/github.com/example/neo-oracle",
            source: "claude-live", seq: 9, role: "assistant", ts: "2026-09-16T10:05:00.000Z", text: "visitor hit, same cwd" },
        ],
      }),
    );
  }

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
  // Isolation invariant: the target must be a resolved file path, never a
  // bare id. See the file header.
  if (!String(first).includes("/")) refuse(`\`tail\` was called with a bare id ("${String(first)}"), not a file path`);

  if (first === "/Users/nat/.claude/projects/-x/__malformed_turn__.jsonl") {
    printAndExit(
      JSON.stringify({
        file: first,
        title: null,
        turns: [{ seq: "not-a-number", role: "user" }],
      }),
    );
  }

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
