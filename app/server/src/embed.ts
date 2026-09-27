// Barrel: split into embed.embed.ts, embed.embedOne.ts and embed.health.ts
// (Nat style, one exported function per file — docs/overnight/DECISIONS.md,
// slice style-server-split, 2026-09-28). Re-exports only, so importers do not
// churn.
export { DIMS, embed, MODEL, OLLAMA_URL } from "./embed.embed";
export { embedOne } from "./embed.embedOne";
export { health, type EmbedHealth } from "./embed.health";
