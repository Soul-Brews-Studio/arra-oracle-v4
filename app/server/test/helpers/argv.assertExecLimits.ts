import { LINUX_MAX_ARG_STRING_BYTES } from "./argv.constants";

/**
 * Refuse, on every platform, a spawn Linux would fail with E2BIG: any single
 * argv string, or any `KEY=VALUE` environment string, over
 * `LINUX_MAX_ARG_STRING_BYTES`. macOS would run it, so without this check the
 * failure only ever shows up on the CI runner. `argv[0]` is the command.
 */
export function assertExecLimits(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const reason = `Linux refuses any single argv/env string over ${LINUX_MAX_ARG_STRING_BYTES} bytes (MAX_ARG_STRLEN) with E2BIG and macOS does not, so this spawn would pass here and fail on CI; pass large payloads through runGated/spawnGatedChild, which spill them to a file`;
  for (const [index, arg] of [command, ...args].entries()) {
    const bytes = Buffer.byteLength(arg, "utf8");
    if (bytes > LINUX_MAX_ARG_STRING_BYTES) throw new Error(`argv[${index}] is ${bytes} bytes: ${reason}`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const bytes = Buffer.byteLength(`${key}=${value}`, "utf8");
    if (bytes > LINUX_MAX_ARG_STRING_BYTES) throw new Error(`env ${key} is ${bytes} bytes: ${reason}`);
  }
}
