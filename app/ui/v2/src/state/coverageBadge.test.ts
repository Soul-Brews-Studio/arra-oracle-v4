/** Failing-first tests for `coverageBadge` (#85 / R4 badge mapping, #33 peer
 *  chat surface). Pure, no DOM: `bun test src/state/coverageBadge.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { coverageBadge } from "./coverageBadge";

describe("coverageBadge", () => {
  test("full coverage reads as full, with the completeness explanation", () => {
    const view = coverageBadge("full");
    expect(view.full).toBe(true);
    expect(view.label).toBe("full coverage");
    expect(view.title).toMatch(/nothing was excluded/i);
  });

  test("partial coverage reads as partial, pointing at the excluded list", () => {
    const view = coverageBadge("partial");
    expect(view.full).toBe(false);
    expect(view.label).toBe("partial coverage");
    expect(view.title).toMatch(/something was left out/i);
  });
});
