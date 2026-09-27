/** JSON-schema micro-builder for a `catalogue.ts` `inputSchema` string-array field. */
export const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
