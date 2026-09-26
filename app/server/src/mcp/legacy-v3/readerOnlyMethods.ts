/**
 * Registry methods whose facade exists on the READER bundle only. DATA ONLY.
 *
 * The #30 searches run on the reader's context facade, opened with the
 * composed query embedder, and the #32 chat facade is built over the reader;
 * no writer carries either, and the registry's `searches()` / `chat()`
 * backstops refuse a writer bundle for them. Both transports already open
 * the reader for every read. `kb()` (`createKb.ts`) is the one caller that
 * pins a bundle per tool call, opened for the tool's action, so it sends
 * these to a reader instead.
 *
 * Kept here rather than as a registry flag so this adapter never edits the
 * registry entries other slices own (R7). `test/mcp-v3-search-wiring.test.ts`
 * pins this list to exactly the methods whose registry `call` refuses a
 * writer bundle, so the two cannot drift apart silently.
 */
export const READER_ONLY_METHODS: readonly string[] = Object.freeze([
  "answerChat",
  "getChatSettings",
  "searchKnowledgeKeyword",
  "searchKnowledgeSemantic",
]);
