/** #33 AC2/R12 (a11y fix-round): the message a listing panel (`ListPanel`,
 *  via `useListing`) shows for one cursor-paginated page.
 *
 * Pulled out of `useListing.ts` as a pure function because the decision it
 * makes is exactly the bug a verifier found: `api/listing.ts`'s `toPage`
 * used to report a 401/403 as `{rows:[], supported:true}` -- indistinguishable
 * from a genuinely empty page -- so this always returned `null` for a real
 * auth failure and `ListPanel` rendered "no peers / nothing on this page
 * matches" over a server that never got to answer. `Page.error` (see
 * `api/listing.ts`) now carries that failure separately from `supported`;
 * this is where it turns into the sentence a human reads.
 */
import { authErrorHint } from "./authErrorHint";

export function listingErrorMessage(page: { supported: boolean; error: string | null }): string | null {
  if (!page.supported) return "this server does not have listing endpoints yet";
  if (page.error === null) return null;
  return authErrorHint(page.error) ?? `request failed: ${page.error}`;
}
