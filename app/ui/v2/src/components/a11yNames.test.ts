/** Failing-first RENDER tests (#33 AC2/R12, a11y slice, requirement 2): every
 *  input/select/textarea/button needs an accessible name -- a visible
 *  `<label htmlFor>` (checked here as a `for="x"`/`id="x"` pair in the
 *  rendered markup) or an `aria-label`. `renderToStaticMarkup`, no DOM, per
 *  `evidencePanels.test.ts`'s precedent.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddNameForm } from "./AddNameForm";
import { Composer } from "./Composer";
import { DialecticPanel } from "./DialecticPanel";
import { WorkspaceBar } from "./WorkspaceBar";

/** Every `for="…"` in the markup has a matching `id="…"` -- the pairing a
 *  visible `<label htmlFor>` needs to actually associate with its control.
 *
 * Fix-round finding: the original only inspected the FIRST `for="…"` match
 * (`.match()` with no `/g` flag stops after one), so a component with three
 * labels would pass this check on the strength of just the first pair being
 * correct -- the second and third could point at a missing/wrong `id` and
 * this would still return `true`. `matchAll` + `every` checks all of them. */
function hasLabelPair(html: string): boolean {
  const forMatches = [...html.matchAll(/\sfor="([^"]+)"/g)];
  if (forMatches.length === 0) return false;
  return forMatches.every((m) => html.includes(`id="${m[1]}"`));
}

describe("hasLabelPair checks EVERY for/id pair, not just the first (fix-round finding)", () => {
  test("a correct first pair does not mask a mismatched second/third pair", () => {
    const html = '<label for="a">A</label><input id="a" /><label for="b">B</label><input id="c" />';
    expect(hasLabelPair(html)).toBe(false);
  });

  test("all-correct pairs still pass", () => {
    const html = '<label for="a">A</label><input id="a" /><label for="b">B</label><input id="b" />';
    expect(hasLabelPair(html)).toBe(true);
  });
});

describe("WorkspaceBar: bank/workspace/token inputs are label-associated, not just visually adjacent", () => {
  test("each input has a matching label pair", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceBar, {
        bank: "b",
        workspace: "w",
        token: "t",
        onBank: () => {},
        onWorkspace: () => {},
        onToken: () => {},
        onHealth: () => {},
        healthStatus: null,
      }),
    );
    // Today: three visible <label> siblings with no htmlFor/id at all.
    expect((html.match(/<label/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(hasLabelPair(html)).toBe(true);
  });
});

describe("Composer: peer/role/content controls each carry an accessible name", () => {
  test("all three controls have an aria-label (no visible label exists today)", () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        peerName: "",
        onSend: () => {},
        sending: false,
        disabled: false,
        disabledReason: null,
      }),
    );
    expect((html.match(/aria-label="/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("DialecticPanel: the question textarea has an accessible name", () => {
  test("aria-label is present on the textarea", () => {
    const html = renderToStaticMarkup(
      createElement(DialecticPanel, {
        onAsk: () => {},
        answer: null,
        asking: false,
        error: null,
        disabled: false,
        disabledReason: null,
      }),
    );
    expect(html).toContain("<textarea");
    const textareaTag = html.slice(html.indexOf("<textarea"), html.indexOf(">", html.indexOf("<textarea")) + 1);
    expect(textareaTag).toContain("aria-label=");
  });
});

describe("AddNameForm: the name input has an accessible name derived from its placeholder", () => {
  test("aria-label mirrors the placeholder text", () => {
    const html = renderToStaticMarkup(createElement(AddNameForm, { placeholder: "peer name…", onSubmit: () => {} }));
    expect(html).toContain('aria-label="peer name…"');
  });
});
