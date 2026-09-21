import { quote } from "./storage";
import { TERMS, scopeOf } from "./service.constants";
import { scopedOne } from "./service.scopedOne";
import { type DatasetAdapter } from "./service.types";

export function lookupTermById(writer: DatasetAdapter, workspace: string, id: string) {
return scopedOne(writer, TERMS, `${scopeOf(workspace)} AND id = ${quote(id)}`);
}
