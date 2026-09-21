import { quote } from "./storage";
import { VOCABULARIES, scopeOf } from "./service.constants";
import { scopedOne } from "./service.scopedOne";
import { type DatasetAdapter } from "./service.types";

export function lookupVocabularyByName(writer: DatasetAdapter, workspace: string, name: string) {
return scopedOne(writer, VOCABULARIES, `${scopeOf(workspace)} AND name = ${quote(name)}`);
}
