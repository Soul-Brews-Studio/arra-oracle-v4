// Entry point for the browser half of app/just/ui-e2e.sh. The shell script
// calls it through `ego-browser nodejs -e`, passing only the path of a JSON
// config it wrote (the ego runtime does not inherit the shell's environment).
//
// One TaskSpace per run, and one run per invocation: nothing here is ever
// restarted (a new TaskSpace is not a recovery, per the ego-browser skill).
// Its id is written next to the config so the shell's EXIT trap
// (`teardown.mjs`) can close it and clear the origin's storage even when
// this process dies half-way. Every line goes to the transcript file through
// `h.say` (harness.mjs explains why stdout cannot be the transcript).
import { appendFileSync, existsSync } from "node:fs";
import { chain } from "./chain.mjs";
import { harness } from "./harness.mjs";
import { historicLabels } from "./historicLabels.mjs";
import { keys } from "./keys.mjs";
import { keysStaleTab } from "./keysStaleTab.mjs";
import { verify } from "./verify.mjs";

export async function drive(configPath) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const cfg = JSON.parse(await readFile(configPath, "utf8"));
  appendFileSync(cfg.transcript, "E2E_START\n");
  const task = await taskSpace(`arra ui-e2e ${cfg.port}`);
  // The shell may have stopped waiting while taskSpace() was slow: close the
  // space straight away and say nothing.
  if (!existsSync(cfg.lease)) {
    await task.finish({ keep: [] });
    return;
  }
  await writeFile(cfg.spaceFile, String(task.spaceId));
  const page = task.page("p1");
  const h = harness({ page, cfg });
  h.say(`E2E_SPACE ${task.spaceId}`);

  try {
    // The token goes straight into localStorage (the key useToken reads),
    // never into a URL, so it is in no history entry of the imported profile.
    await h.step("ui-open", async () => {
      await page.goto(`${cfg.origin}/v2/`, { waitUntil: "load", timeout: 30000 });
      await page.evaluate((t) => { localStorage.setItem("arra-ui-v2-token", t); }, cfg.token);
      await page.evaluate(() => { location.hash = "#/overview"; });
      await page.reload({ waitUntil: "load", timeout: 30000 });
      await h.ensureViewport();
      await h.waitDom("app shell", () => document.querySelectorAll("nav button").length >= 5 && localStorage.getItem("arra-ui-v2-token") !== null && !location.href.includes("token="));
      return `${cfg.origin}/v2/ (token set in localStorage, never in a URL)`;
    });

    // `cfg.segment` (UI_E2E_SEGMENT): "all" (default) runs the form-driven
    // chain and then the keyboard-only segment; "keys" runs only the latter
    // (app/just/ui-e2e-keys.sh), "chain" only the former.
    const segment = cfg.segment ?? "all";
    if (segment !== "keys") {
      const ctx = {};
      await chain(h, ctx);
      await verify(h, ctx, cfg);
      await historicLabels(h, ctx);
    }
    if (segment !== "chain") {
      // A fresh document, so the keyboard segment starts with focus on
      // <body> rather than wherever the chain left it.
      await h.step("keys-start", async () => {
        await h.go("#/overview");
        await page.reload({ waitUntil: "load", timeout: 30000 });
        await h.ensureViewport();
        await h.waitDom("app shell", () => document.querySelectorAll('[role="tab"]').length >= 5 && document.activeElement === document.body);
        return "#/overview reloaded, focus on <body>";
      });
      await keys(h, cfg);
      await keysStaleTab(h, cfg);
    }
    h.say(`E2E_SUMMARY failures=${h.failures.length} screenshots=${h.shots.length}${h.failures.length ? ` failed=[${h.failures.join(",")}]` : ""}`);
    h.say("E2E_DRIVER_DONE");
  } catch (e) {
    // Only an aborted run gets here (the lease is gone): close the space
    // ourselves in case the shell's teardown has already come and gone.
    if (!e.abort) throw e;
    await task.finish({ keep: [] }).catch(() => {});
  }
}
