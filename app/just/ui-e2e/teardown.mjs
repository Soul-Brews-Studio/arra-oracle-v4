// Browser teardown for app/just/ui-e2e.sh's EXIT trap: clear THIS origin's
// storage (never the profile -- see the ego-browser skill's
// clearing-state.md), prove it is empty, and close the TaskSpace. Safe to
// call when the driver never started (no space file: nothing to do).
//
// Lines are appended to `cfg.teardownLog` as they happen, not left to
// stdout: `ego-browser nodejs` hands stdout back only at exit, so an attempt
// the shell gives up on would otherwise have said nothing at all. The shell
// accepts the teardown only on `after=0` plus `TEARDOWN space … finished`.
import { appendFileSync } from "node:fs";

export async function teardown(configPath) {
  const { readFile } = await import("node:fs/promises");
  const cfg = JSON.parse(await readFile(configPath, "utf8"));
  const say = (line) => {
    appendFileSync(cfg.teardownLog, `${line}\n`);
    console.log(line);
  };
  let spaceId;
  try {
    spaceId = Number((await readFile(cfg.spaceFile, "utf8")).trim());
  } catch {
    say("TEARDOWN no browser space was opened");
    return;
  }
  const task = await taskSpace(spaceId);
  const page = task.page("p1");
  let before = null, after = null;
  try {
    before = await page.evaluate((o) => (location.origin === o ? localStorage.length : null), cfg.origin);
  } catch { /* page gone or elsewhere */ }
  await page.cdp("Storage.clearDataForOrigin", { origin: cfg.origin, storageTypes: "local_storage,session_storage" });
  try {
    after = await page.evaluate((o) => (location.origin === o ? localStorage.length + sessionStorage.length : null), cfg.origin);
  } catch { /* page gone */ }
  say(`TEARDOWN origin ${cfg.origin} storage keys before=${before} after=${after}`);
  await page.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
  const receipt = await task.finish({ keep: [] });
  say(`TEARDOWN space ${spaceId} finished ${JSON.stringify(receipt).slice(0, 120)}`);
}
