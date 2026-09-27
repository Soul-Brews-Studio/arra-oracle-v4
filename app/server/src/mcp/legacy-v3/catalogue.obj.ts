/** JSON-schema micro-builder for a `catalogue.ts` `inputSchema` object field. */
export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});
