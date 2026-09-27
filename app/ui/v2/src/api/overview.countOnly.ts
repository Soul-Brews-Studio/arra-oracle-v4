import { type Page } from "./listing";
import { type Count } from "./overview";
import { countWithSample } from "./overview.countWithSample";

type Fetch<T> = (limit: number, includeTotal: boolean) => Promise<Page<T>>;

/** A counting probe asks for ONE row: `total` is a native COUNT over the whole
 *  scope and does not grow with `limit`, so paging for it is wasted bytes. */
const COUNT_LIMIT = 1;

export async function countOnly<T>(method: string, fetch: Fetch<T>): Promise<Count> {
  return (await countWithSample(method, fetch, COUNT_LIMIT)).count;
}
