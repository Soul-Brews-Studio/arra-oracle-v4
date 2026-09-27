// Browser teardown for app/just/ui-e2e.sh's EXIT trap: clear THIS origin's
// storage (never the profile -- see the ego-browser skill's
// clearing-state.md), prove it is empty, and close the TaskSpace. Safe to
// call when the driver never started (no space file: nothing to do).
export async function teardown(configPath) {
  const { readFile } = await import("node:fs/promises");
  const cfg = JSON.parse(await readFile(configPath, "utf8"));
  let spaceId;
  try {
    spaceId = Number((await readFile(cfg.spaceFile, "utf8")).trim());
  } catch {
    console.log("TEARDOWN no browser space was opened");
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
  console.log(`TEARDOWN origin ${cfg.origin} storage keys before=${before} after=${after}`);
  await page.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
  const receipt = await task.finish({ keep: [] });
  console.log(`TEARDOWN space ${spaceId} finished ${JSON.stringify(receipt).slice(0, 120)}`);
}
