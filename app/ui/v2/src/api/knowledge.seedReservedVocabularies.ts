import { type Bank } from "./memory";
import { type TaxonomyIds } from "./knowledge";
import { call } from "./knowledge.call";

export const seedReservedVocabularies = (b: Bank, ids: TaxonomyIds) =>
  call(b, "seedReservedVocabularies", { workspace_name: b.workspace, ...ids });
