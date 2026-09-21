import type { JcsObject, JcsValue } from "../../contracts/jcs";

export function field(o: JcsObject, key: string): JcsValue {
  return o.get(key) as JcsValue;
}
