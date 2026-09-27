// The ego-browser harness for app/just/ui-e2e.sh (#33 AC1/AC3/AC4): step
// verdicts, BOUNDED retries around the flaky browser plumbing, DOM polling,
// in-page form actions and screenshots.
//
// Retry discipline (the brief's hard rule): a retry only ever re-runs the
// browser PLUMBING -- a Page.captureScreenshot timeout, a near-blank PNG, the
// viewport glitch that briefly reports innerWidth 184. It never re-runs an
// assertion until it happens to pass: `waitDom` polls ONE condition until a
// deadline and fails at the deadline, and a step's verdict is decided once.
// Every retry prints a `RETRY ...` line, so a run that needed one says so.
//
// Output and lifetime: `ego-browser nodejs` hands the script's stdout back
// only when the script exits (measured, 0.5.1.13), and killing that client
// does not stop the script inside the ego service. So every line goes
// through `say`, which appends it to the transcript file itself (the shell
// streams and judges that file), and two checks bound the run from inside:
// - `cfg.deadline` (epoch ms): past it, the current and every later step is
//   a STEP_FAIL, so a slow run is a visible failure, never a silent kill;
// - `cfg.lease` (a file the shell removes when it stops waiting): once it is
//   gone the driver stops writing and aborts (`e.abort`), so a straggler can
//   never add lines, or verdicts, after the shell has judged the run.
//
// Runs inside `ego-browser nodejs` (Node ESM, the ego SDK's globals), never in
// the page; page-side code is passed to `page.evaluate` as self-contained
// functions, because they cannot close over anything here.

import { appendFileSync, existsSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 400);

// Page-side form driver. Sets values through the native setters and fires
// the same `input`/`change` events React listens to, one op at a time with a
// tick between them (a click that adds a link row must render before the next
// op can find that row). Every selector must match EXACTLY one element inside
// its root, and a disabled button is an error, never a silent no-op.
async function pageOps(ops) {
  const heading = (tag, text) => {
    const h = [...document.querySelectorAll(tag)].find((x) => x.textContent.trim() === text);
    if (!h) throw new Error(`no <${tag}> "${text}" on screen`);
    return h.parentElement;
  };
  const roots = {
    doc: () => document,
    publish: () => {
      const t = document.querySelector('input[placeholder="title…"]');
      if (!t) throw new Error("publish form not on screen");
      return t.parentElement;
    },
    correct: () => heading("h3", "Correct"),
    lifecycle: () => heading("h3", "Lifecycle actions"),
    ask: () => heading("h2", "Ask as peer"),
    diff: () => {
      const label = [...document.querySelectorAll("main span")].find((x) => x.textContent.trim() === "diff");
      if (!label) throw new Error("no revision diff picker on screen");
      return label.parentElement;
    },
  };
  const one = (root, sel) => {
    const els = root.querySelectorAll(sel);
    if (els.length !== 1) throw new Error(`${sel}: ${els.length} matches, expected 1`);
    return els[0];
  };
  const setVal = (el, v) => {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  for (const op of ops) {
    const root = roots[op.root ?? "doc"]();
    if (op.fill !== undefined) {
      setVal(one(root, op.fill), op.value);
    } else if (op.select !== undefined) {
      const el = one(root, op.select);
      let value = op.value;
      if (op.optionText !== undefined) {
        const o = [...el.options].find((x) => x.textContent.includes(op.optionText));
        if (!o) throw new Error(`${op.select}: no option containing "${op.optionText}" (have: ${[...el.options].map((x) => x.textContent).join(" | ")})`);
        value = o.value;
      }
      setVal(el, value);
    } else if (op.click !== undefined) {
      const hits = [...root.querySelectorAll("button, a")].filter((b) => b.textContent.trim() === op.click);
      if (hits.length !== 1) throw new Error(`button "${op.click}": ${hits.length} matches, expected 1`);
      if (hits[0].disabled) throw new Error(`button "${op.click}" is disabled`);
      hits[0].click();
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return true;
}

export function harness({ page, cfg }) {
  const outDir = cfg.outDir;
  const failures = [];
  const shots = [];

  const alive = () => existsSync(cfg.lease);
  function say(line) {
    if (!alive()) return;
    appendFileSync(cfg.transcript, `${line}\n`);
    console.log(line);
  }
  // Lease gone: abort (not a verdict). Deadline passed: an ordinary error,
  // so it lands as the current step's STEP_FAIL.
  function check() {
    if (!alive()) throw Object.assign(new Error("lease revoked: the shell stopped waiting"), { abort: true });
    if (Date.now() > cfg.deadline) throw new Error(`driver deadline passed (${new Date(cfg.deadline).toISOString()})`);
  }

  // After one screenshot has timed out on every attempt, the browser is not
  // producing frames at all (measured: even a data: URL in a fresh space
  // times out, while requestAnimationFrame and printToPDF still work), so
  // later screenshots get ONE attempt. Each still fails on its own verdict;
  // this only stops 13 x 47s of retries from eating the driver's budget.
  let captureDead = false;

  async function retry(label, fn, attempts = 3) {
    let last;
    for (let i = 1; i <= attempts; i++) {
      check();
      try {
        return await fn();
      } catch (e) {
        last = e;
        say(`RETRY ${label} attempt ${i}/${attempts}: ${msg(e)}`);
        await sleep(400 * i);
      }
    }
    throw last;
  }

  // The viewport glitch: the page briefly reports innerWidth 184, which
  // collapses the layout (and would make every screenshot a sliver). Pin a
  // desktop metric and re-check; bounded, and a stuck-narrow page is an error.
  // The floor is 900 CSS px, not the override's 1600: ego keeps a per-origin
  // zoom (measured 150% on 127.0.0.1, so 1440 -> innerWidth 960), and the
  // point is "a desktop layout", not an exact width.
  async function ensureViewport() {
    const seen = [];
    for (let i = 0; i < 8; i++) {
      const w = await page.evaluate(() => window.innerWidth);
      seen.push(w);
      if (w >= 900) return w;
      await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
      await sleep(300 * (i + 1));
    }
    throw new Error(`viewport stayed narrower than 900px after 8 resets (innerWidth seen: ${seen.join(",")})`);
  }

  // Poll one page-side condition until it returns a truthy value or the
  // deadline passes. A thrown evaluate (a transient CDP error) counts as
  // "not yet", never as a pass; the deadline is the only way out besides
  // the condition itself.
  async function waitDom(label, fn, arg, timeout = 20000) {
    const until = Date.now() + timeout;
    let last = null;
    while (Date.now() < until) {
      check();
      try {
        last = arg === undefined ? await page.evaluate(fn) : await page.evaluate(fn, arg);
        if (last && last.ok !== false) return last;
      } catch (e) {
        last = { evaluateError: msg(e) };
      }
      await sleep(250);
    }
    throw new Error(`${label}: not reached within ${timeout}ms; last=${JSON.stringify(last).slice(0, 600)}`);
  }

  // No retry here: re-running a half-applied form fill could double-submit.
  const act = (ops) => page.evaluate(pageOps, ops);

  async function go(hashOrUrl) {
    await retry(`goto ${hashOrUrl}`, async () => {
      const current = await page.url();
      const base = current.split("#")[0];
      if (hashOrUrl.startsWith("#")) {
        await page.evaluate((h) => { window.location.hash = h; }, hashOrUrl);
      } else {
        await page.goto(hashOrUrl, { waitUntil: "load", timeout: 20000 });
      }
      return base;
    });
    await ensureViewport();
  }

  // A screenshot is evidence (AC4), so a missing or near-blank one is a
  // failure of its own `screenshot-*` verdict -- it never hides behind the
  // step it illustrates, and the step's DOM verdict never depends on it.
  //
  // `focus` names a heading to scroll into view first: the Evidence tab
  // stacks trace and session-link panels above the evidence, so an
  // unscrolled capture shows the same top half for every node.
  async function shot(name, focus = null) {
    const { stat, writeFile } = await import("node:fs/promises");
    const path = `${outDir}/e2e-${name}.png`;
    try {
      await retry(`screenshot ${name}`, async () => {
        if (captureDead) say(`NOTE screenshot ${name}: one attempt only, an earlier capture timed out on every attempt`);
        await ensureViewport();
        if (focus !== null) {
          const found = await page.evaluate((t) => {
            const el = [...document.querySelectorAll("h2, h3, span")].find((x) => x.textContent.trim() === t);
            el?.scrollIntoView({ block: "start" });
            return el !== undefined;
          }, focus);
          if (!found) throw new Error(`nothing titled "${focus}" to scroll to`);
          await sleep(200);
        }
        // Raw CDP capture, not `page.screenshot()`: under ego's per-origin
        // zoom (150% on 127.0.0.1) the SDK call returned only the top-left
        // 1/1.5 of the viewport (measured 711x445 of a 1067x667 CSS
        // viewport), which cut off every right-hand panel. The CDP call
        // returns the whole 1600x1000 frame.
        const shotData = await page.cdp("Page.captureScreenshot", { format: "png" }, { timeout: 15000 });
        await writeFile(path, Buffer.from(shotData.data, "base64"));
        const { size } = await stat(path);
        if (size < 12000) throw new Error(`near-blank screenshot (${size} bytes)`);
      }, captureDead ? 1 : 3);
      shots.push(path);
      say(`SHOT ${path}`);
    } catch (e) {
      if (e.abort) throw e;
      if (/timed out/.test(msg(e))) captureDead = true;
      failures.push(`screenshot-${name}`);
      say(`STEP_FAIL screenshot-${name}: ${msg(e)}`);
    }
  }

  async function step(name, fn) {
    try {
      check();
      const detail = await fn();
      if (detail && detail.skip) {
        say(`STEP_SKIP ${name} (${detail.skip})`);
        return;
      }
      say(`STEP_OK ${name}${detail ? ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
    } catch (e) {
      if (e.abort) throw e;
      failures.push(name);
      say(`STEP_FAIL ${name}: ${msg(e)}`);
    }
  }

  return { page, act, go, shot, step, waitDom, ensureViewport, say, check, failures, shots, sleep };
}
