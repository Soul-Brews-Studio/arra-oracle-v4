// Entry point for the browser half of app/just/ui-e2e.sh. The shell script
// calls it through `ego-browser nodejs -e`, passing only the path of a JSON
// config it wrote (the ego runtime does not inherit the shell's environment).
//
// One TaskSpace per run; its id is written next to the config so the
// shell's EXIT trap (`teardown.mjs`) can close it and clear the origin's
// storage even when this process dies half-way.
import { makeHarness } from "./harness.mjs";
import { runChain } from "./chain.mjs";
import { runVerify } from "./verify.mjs";

export async function drive(configPath) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const cfg = JSON.parse(await readFile(configPath, "utf8"));
  const task = await taskSpace(`arra ui-e2e ${cfg.port}`);
  await writeFile(cfg.spaceFile, String(task.spaceId));
  console.log(`E2E_SPACE ${task.spaceId}`);
  const page = task.page("p1");
  const h = makeHarness({ page, outDir: cfg.outDir });

  // The token rides in the URL once; useToken moves it into localStorage and
  // strips it from the address bar (and so from every screenshot).
  await h.step("ui-open", async () => {
    await page.goto(`${cfg.origin}/v2/?token=${encodeURIComponent(cfg.token)}#/overview`, { waitUntil: "load", timeout: 30000 });
    await h.ensureViewport();
    await h.waitDom("app shell", () => document.querySelectorAll("nav button").length >= 5 && !location.search.includes("token="));
    return `${cfg.origin}/v2/ (token moved to localStorage, stripped from the URL)`;
  });

  const ctx = {};
  await runChain(h, ctx);
  await runVerify(h, ctx, cfg);
  console.log(`E2E_SUMMARY failures=${h.failures.length} screenshots=${h.shots.length}${h.failures.length ? ` failed=[${h.failures.join(",")}]` : ""}`);
  console.log("E2E_DRIVER_DONE");
}
