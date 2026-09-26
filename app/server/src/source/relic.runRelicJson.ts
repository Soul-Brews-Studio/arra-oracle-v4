import { spawn } from "node:child_process";
import type { RelicAdapterConfig } from "./relic.types";
import { failRelic } from "./relic.errors";

/**
 * The ONLY subcommands this adapter will ever invoke. `relic index`,
 * `relic prune` and `relic embed` are mutating (per `relic --help`); this
 * allowlist exists so a bug in a future caller of `runRelicJson` cannot turn
 * a read into a write against the user's real index -- the check runs
 * BEFORE `spawn`, not as documentation only.
 */
const ALLOWED_SUBCOMMANDS = ["search", "session", "sessions", "tail"] as const;

/**
 * Spawn the configured `relic` binary (or a test's fake script) with
 * `--json` always appended, capture bounded stdout, parse it, and return the
 * parsed value. Never touches stdin; stderr is drained (never left to fill a
 * pipe and hang the child) but discarded, matching `RelicAdapterError`'s
 * "no caller text in the message" posture -- a subprocess's stderr could
 * carry a filesystem path or another operator's data.
 *
 * `config.binPath` is ALWAYS the caller's own configuration, injected --
 * never resolved from `$PATH`, never read from the request. A test points it
 * at a fake script; nothing here can reach the real relic index unless the
 * caller's OWN config names it.
 *
 * `RELIC_NO_TRACE=1` is set on EVERY spawn, regardless of subcommand: real
 * relic's `search` subcommand (`agents-relic/src/cli.ts` `cmdSearch` ->
 * `trace.ts`) appends one line to `<data-root>/trace.jsonl` on every call
 * unless this env var is set, and this adapter's contract is read-only --
 * appending to relic's own query log is a write this module must never make.
 */
export async function runRelicJson(config: RelicAdapterConfig, args: readonly string[]): Promise<unknown> {
  const subcommand = args[0];
  if (subcommand === undefined || !(ALLOWED_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    failRelic("bad_output", `refusing unlisted relic subcommand "${String(subcommand)}"`);
  }
  const fullArgs = [...args, "--json"];

  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let truncated = false;

  const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
    const child = spawn(config.binPath, fullArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RELIC_NO_TRACE: "1" },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, config.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > config.maxOutputBytes) {
        // Stop buffering and stop the child outright -- there is no reason
        // to hold or wait out megabytes of output this call will refuse.
        if (!truncated) child.kill("SIGKILL");
        truncated = true;
        return;
      }
      stdoutChunks.push(chunk);
    });
    // Drained, never accumulated into the thrown error message (see header).
    child.stderr?.on("data", () => {});

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A SIGKILL this module itself sent (deadline OR the overflow kill
      // above) always yields code:null, signal:"SIGKILL" -- `truncated` is
      // what tells the two apart, checked outside this promise once it
      // settles, so this path just resolves and lets the caller classify it.
      if (signal === "SIGKILL" && code === null && !truncated) {
        reject(new Error("relic subprocess timed out"));
        return;
      }
      resolvePromise(code);
    });
  }).catch((error: Error) => {
    if (error.message === "relic subprocess timed out") failRelic("timeout", error.message);
    failRelic("unavailable", `relic binary could not be run: ${error.message}`);
  });

  if (truncated) failRelic("output_too_large", `relic output exceeded ${config.maxOutputBytes} bytes`);
  if (exitCode !== 0) failRelic("exit_nonzero", `relic exited ${exitCode}`);

  const text = Buffer.concat(stdoutChunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    failRelic("bad_output", "relic stdout was not valid JSON");
  }
}
