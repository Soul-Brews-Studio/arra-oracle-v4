import { type Bank } from "./memory";
import { call } from "./knowledge.call";

export const getVocabulary = (b: Bank, vocabulary_id: string) =>
  call(b, "getVocabulary", { workspace_name: b.workspace, vocabulary_id });
