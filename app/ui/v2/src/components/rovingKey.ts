/** The arrow-key half of a roving-focus widget (#33 AC2, ui-keys slice):
 *  given the key pressed on item `index` of `items`, move focus to the item
 *  the WAI-ARIA tabs/list pattern names and report whether the key was
 *  handled (so the caller knows `preventDefault` already ran -- an unhandled
 *  ArrowDown must still scroll the page).
 *
 *  Horizontal (tab strips): ArrowLeft/ArrowRight, wrapping. Vertical (list
 *  panels): ArrowUp/ArrowDown, wrapping. Both: Home/End jump to the ends.
 *  Enter, Space and Tab are deliberately NOT handled: activation is the
 *  native <button>'s own Enter/Space (manual activation -- arrowing through
 *  the Explore tabs must not push a history entry per key), and Tab keeps
 *  the browser's order. Pure, so a render test can pin it without a DOM. */
export function rovingKey(
  e: { key: string; preventDefault: () => void },
  index: number,
  items: readonly ({ focus: () => void } | null | undefined)[],
  orientation: "horizontal" | "vertical" = "horizontal",
): boolean {
  const n = items.length;
  if (n === 0) return false;
  const [prev, next] = orientation === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const to =
    e.key === next ? (index + 1) % n
    : e.key === prev ? (index - 1 + n) % n
    : e.key === "Home" ? 0
    : e.key === "End" ? n - 1
    : null;
  if (to === null) return false;
  e.preventDefault();
  items[to]?.focus();
  return true;
}
