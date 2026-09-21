import { quote } from "./storage";
import { VOCABULARIES, scopeOf } from "./service.constants";
import { scopedOne } from "./service.scopedOne";
import { type DatasetAdapter } from "./service.types";

export function lookupVocabularyById(writer: DatasetAdapter, workspace: string, id: string) {
return scopedOne(writer, VOCABULARIES, `${scopeOf(workspace)} AND id = ${quote(id)}`);
}
