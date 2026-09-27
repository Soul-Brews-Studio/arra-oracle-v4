// Keyboard-only navigation helpers for the #33 AC2 keyboard segment
// (keys.mjs). The ONLY inputs used are ego-browser's `page.keyboard` calls:
// press (Tab, Shift+Tab, arrows, Home/End, Enter, Space, Control+Enter) and
// type. The page is only ever READ here (`page.evaluate` of a describer),
// never clicked, focused or value-set -- ui-e2e.test.ts checks this file and
// keys.mjs for that statically.
//
// `tabTo` is the focus-order proof: it presses Tab (or Shift+Tab) one key at
// a time, reads `document.activeElement` after every press, and fails with
// the whole path when the target is not reached within `max` presses. The
// path length is reported, so a run that suddenly needs many more Tabs to
// reach the same control says so.

// Page-side: a small, serialisable description of the focused element.
function describeActive() {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: "BODY" };
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    tag: el.tagName,
    id: el.id || null,
    role: el.getAttribute("role"),
    label: el.getAttribute("aria-label"),
    placeholder: el.getAttribute("placeholder"),
    selected: el.getAttribute("aria-selected"),
    current: el.getAttribute("aria-current"),
    row: el.getAttribute("data-row"),
    tabindex: el.getAttribute("tabindex"),
    disabled: el.disabled === true,
    inMain: el.closest("main") !== null,
    text,
    value: "value" in el ? String(el.value).slice(0, 80) : null,
    optionText: el.tagName === "SELECT" ? (el.selectedOptions[0]?.textContent ?? "").trim().slice(0, 80) : null,
  };
}

const matches = (d, m) =>
  Object.entries(m).every(([k, v]) =>
    k === "textStarts" ? (d.text ?? "").startsWith(v)
    : k === "textHas" ? (d.text ?? "").includes(v)
    : k === "idStarts" ? (d.id ?? "").startsWith(v)
    : d[k] === v);

const short = (d) => d.id ? `#${d.id}` : `${d.tag}${d.role ? `[${d.role}]` : ""}:${d.label ?? d.placeholder ?? d.row ?? (d.text ?? "").slice(0, 24)}`;

export function keyNav(h) {
  const kb = h.page.keyboard;
  const active = () => h.page.evaluate(describeActive);

  async function press(chord) {
    h.check();
    await kb.press(chord);
    await h.sleep(90);
    return active();
  }

  async function type(text) {
    h.check();
    await kb.type(text, { delay: 15 });
    await h.sleep(120);
    return active();
  }

  // Press Tab (or Shift+Tab) until the focused element matches `m`.
  async function tabTo(m, { back = false, max = 60 } = {}) {
    const path = [];
    for (let i = 1; i <= max; i++) {
      const d = await press(back ? "Shift+Tab" : "Tab");
      path.push(short(d));
      if (matches(d, m)) return { d, presses: i, path };
    }
    throw new Error(`${back ? "Shift+Tab" : "Tab"} x${max} never focused ${JSON.stringify(m)}; path: ${path.join(" > ").slice(-700)}`);
  }

  // Assert the focused element, now.
  async function expectFocus(m, why) {
    const d = await active();
    if (!matches(d, m)) throw new Error(`${why}: focus is ${JSON.stringify(d)}, expected ${JSON.stringify(m)}`);
    return d;
  }

  return { active, press, type, tabTo, expectFocus, describeActive };
}
