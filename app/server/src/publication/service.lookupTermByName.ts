import { quote } from "./storage";
import { TERMS, scopeOf } from "./service.constants";
import { scopedOne } from "./service.scopedOne";
import { type DatasetAdapter } from "./service.types";

export function lookupTermByName(writer: DatasetAdapter, workspace: string, vocabularyId: string, name: string) {
return scopedOne(
      writer,
      TERMS,
      `${scopeOf(workspace)} AND vocabulary_id = ${quote(vocabularyId)} AND name = ${quote(name)}`,
    );
}
