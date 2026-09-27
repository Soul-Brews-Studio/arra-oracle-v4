/** Depth-first search of a tree mounted into `installFakeDom`'s container
 *  for the first element matching `pred`, by duck type (`tagName`,
 *  `childNodes`) so callers never need the fake DOM's private classes.
 *  Test-only, same as `installFakeDom`.
 *
 * `props` is React's own props object for that element -- the one
 * `react-dom` stores on every host node it creates, under a per-build
 * `__reactProps$<random>` key. Calling `props.onChange(...)`/`props.onClick()`
 * runs exactly the handler the component rendered (e.g.
 * `KnowledgeSearchBox`'s `onChange={(e) => onQuery(e.target.value)}`)
 * without routing a synthetic event through React's DOM event plugins,
 * which the fake DOM does not model (they need `nodeName`, `type` and,
 * with no `window` at import time, IE's `attachEvent` polyfill path). */
type FakeLike = {
  tagName?: string;
  childNodes: FakeLike[];
  textContent?: string;
  getAttribute?: (k: string) => string | null;
  value?: string;
};

export function findFakeElement(
  root: unknown,
  pred: (el: { tagName: string; textContent: string; getAttribute: (k: string) => string | null }) => boolean,
): { value: string; textContent: string; props: Record<string, (...args: unknown[]) => void> } | null {
  const walk = (node: FakeLike): FakeLike | null => {
    if (typeof node.tagName === "string" && node.getAttribute && pred(node as never)) return node;
    for (const child of node.childNodes) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  const el = walk(root as FakeLike);
  if (el === null) return null;
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return {
    get value() {
      return el.value ?? "";
    },
    get textContent() {
      return el.textContent ?? "";
    },
    props: (propsKey ? (el as unknown as Record<string, unknown>)[propsKey] : {}) as Record<
      string,
      (...args: unknown[]) => void
    >,
  };
}
