import type { JcsObject, JcsValue } from "./jcs";

export const get = (o: JcsObject, key: string): JcsValue => o.get(key) as JcsValue;
