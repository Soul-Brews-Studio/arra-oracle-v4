/** A hand-built fake DOM, just enough surface for `react-dom/client` to
 *  mount a tree, commit host-component updates and run effects -- no jsdom,
 *  no new dependency. Test-only: nothing under `src/` outside a `*.test.tsx`
 *  imports this, so it never reaches the Vite bundle.
 *
 * Moved here verbatim from `ExploreView.liveWiring.test.tsx` (round 4) when
 * a second test file (`ExploreView.writeBack.test.tsx`) needed the same
 * harness: one copy, not two drifting ones, and neither test file over the
 * 500-line limit. Verified against a plain counter-effect component before
 * first use (drives itself to a fixed point across several renders).
 *
 * Also owns React's `IS_REACT_ACT_ENVIRONMENT` flag (round-4 verifier
 * finding: the tests set it globally and never put it back). The returned
 * `uninstall` restores it together with every DOM global it replaced, so a
 * later test file in the same `bun test` process sees the globals it started
 * with.
 */
class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  nodeType = 1;
  appendChild(child: FakeNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: FakeNode, ref: FakeNode | null) {
    child.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i === -1) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    return child;
  }
  removeChild(child: FakeNode) {
    const i = this.childNodes.indexOf(child);
    if (i !== -1) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  contains(): boolean {
    return true;
  }
  get ownerDocument() {
    return (globalThis as unknown as { document: unknown }).document;
  }
}
class FakeText extends FakeNode {
  nodeType = 3;
  constructor(public data: string) {
    super();
  }
  set textContent(v: string) {
    this.data = v;
  }
  get textContent() {
    return this.data;
  }
}
class FakeElement extends FakeNode {
  tagName: string;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<(e: unknown) => void>>();
  style: Record<string, string> = {};
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  // A real accessor pair, not an instance field: react-dom's controlled-
  // input value tracker (`inputValueTracking.js`) reads
  // `Object.getOwnPropertyDescriptor` off the node to install its own
  // wrapping descriptor, and only finds one for a property declared on the
  // PROTOTYPE (what `get`/`set` in a class body produce) -- a plain
  // `value = ""` field is an own-property with no descriptor to find,
  // silently defeating the tracker and leaving `.value` always "".
  #value = "";
  get value() {
    return this.#value;
  }
  set value(v: string) {
    this.#value = v;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  // Focus model (ui-keys fix round, #33 AC2): `focus()` makes this the
  // document's `activeElement` -- all that `rovingKey` and `NodeHead`'s
  // focus effect read -- and `closest` walks `parentNode` for a bare tag
  // name (`main`) or one attribute selector (`[role="tab"]`), the two
  // shapes the components use. Anything else throws, so a component that
  // starts relying on a richer selector fails loudly here, not silently.
  focus() {
    (this.ownerDocument as { activeElement: unknown }).activeElement = this;
  }
  closest(sel: string): FakeElement | null {
    const attr = sel.match(/^\[([\w-]+)="([^"]*)"\]$/);
    if (attr === null && !/^[a-z][a-z0-9]*$/.test(sel)) throw new Error(`fake closest(): unsupported selector ${sel}`);
    const hit = (el: FakeElement) => (attr ? el.getAttribute(attr[1]!) === attr[2] : el.tagName === sel.toUpperCase());
    for (let n: FakeNode | null = this; n !== null; n = n.parentNode) {
      if (n instanceof FakeElement && hit(n)) return n;
    }
    return null;
  }
  // `<select>` controlled-value reconciliation reads `.options` (an
  // `HTMLOptionElement` collection) to set each option's `.selected`.
  get options(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement && c.tagName === "OPTION");
  }
  selected = false;
  multiple = false;
  get textContent(): string {
    return this.childNodes.map((c) => (c as { textContent?: string }).textContent ?? "").join("");
  }
  set textContent(v: string) {
    // Matches native `Node.textContent = ""`: replaces ALL children, so an
    // empty string means NO children, not a child text node holding "".
    // React DOM's `clearContainer` sets this to "" before the first mount --
    // getting this wrong left a stray empty text node ahead of the real
    // render output.
    this.childNodes = v === "" ? [] : [new FakeText(v)];
  }
}
class FakeDocument extends FakeElement {
  body: FakeElement;
  activeElement: FakeElement | null = null;
  constructor() {
    super("#document");
    this.nodeType = 9;
    this.body = new FakeElement("body");
  }
  createElement(tag: string) {
    return new FakeElement(tag);
  }
  createTextNode(data: string) {
    return new FakeText(data);
  }
  createElementNS(_ns: string, tag: string) {
    return new FakeElement(tag);
  }
  createComment(data: string) {
    return new FakeText(data);
  }
}

const REPLACED = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLOptionElement",
  "HTMLIFrameElement",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

/** Installs the fake DOM on `globalThis` and returns a fresh container to
 *  `createRoot` into, plus the `uninstall` that puts every replaced global
 *  (including `IS_REACT_ACT_ENVIRONMENT`) back exactly as it was. */
export function installFakeDom(): { container: Element; uninstall: () => void } {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, { had: boolean; value: unknown }>();
  for (const key of REPLACED) saved.set(key, { had: key in g, value: g[key] });
  g.document = new FakeDocument();
  g.window = globalThis;
  g.navigator = { userAgent: "fake-dom-for-effects" };
  g.HTMLElement = FakeElement;
  g.HTMLInputElement = class extends FakeElement {};
  g.HTMLTextAreaElement = class extends FakeElement {};
  g.HTMLSelectElement = class extends FakeElement {};
  g.HTMLOptionElement = class extends FakeElement {};
  g.HTMLIFrameElement = class extends FakeElement {};
  g.Node = FakeNode;
  // React 18 only lets `act()` flush without warning when this is set.
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    container: new FakeElement("div") as unknown as Element,
    uninstall: () => {
      for (const [key, { had, value }] of saved) {
        if (had) g[key] = value;
        else delete g[key];
      }
    },
  };
}
