import type { V3ToolSpec } from "./catalogue.types";

/** Freezes a `catalogue.ts` entry (and its `uses`/`requires`/`alsoNeeds` arrays) before it is used. */
export const spec = (s: V3ToolSpec): V3ToolSpec =>
  Object.freeze({
    ...s,
    ...(s.alsoNeeds === undefined ? {} : { alsoNeeds: Object.freeze([...s.alsoNeeds]) }),
    uses: Object.freeze([...s.uses]),
    requires: Object.freeze([...s.requires]),
  });
