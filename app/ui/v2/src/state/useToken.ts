import { useEffect, useState } from "react";

const KEY = "arra-ui-v2-token";

/** Bearer token, unlockable from the URL: `?token=…` or `?key=…`.
 *
 * The token is REMOVED from the address bar the moment it is read, with
 * `history.replaceState`, and that is not decoration. A credential in a URL
 * is the one place a credential should never rest: it goes into browser
 * history, into the `Referer` header of any outbound link, into screenshots
 * and into shoulder-surfing range. Stripping it leaves the convenience --
 * paste one link and the app is unlocked -- without leaving the token parked
 * somewhere it will outlive the session.
 *
 * What this does NOT do is make a URL-borne token safe to SHARE. Anyone who
 * receives the link receives the credential; it is a local unlock for a
 * loopback dev server, not a capability link.
 *
 * `token` wins over `key` when both are present, rather than merging or
 * guessing -- two different credentials in one URL is a mistake worth
 * resolving predictably.
 */
export function useToken(): [string, (v: string) => void] {
  const [token, setToken] = useState<string>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("token") ?? params.get("key");
      if (fromUrl !== null && fromUrl !== "") {
        localStorage.setItem(KEY, fromUrl);
        params.delete("token");
        params.delete("key");
        const query = params.toString();
        window.history.replaceState(
          null,
          "",
          window.location.pathname + (query === "" ? "" : `?${query}`) + window.location.hash,
        );
        return fromUrl;
      }
      return localStorage.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  });

  // Persisted so a reload does not send you back to the dev-stack output to
  // copy it again. Same storage the URL unlock writes to, one source of truth.
  useEffect(() => {
    try {
      if (token === "") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, token);
    } catch {
      /* private mode: the token still works for this tab, just not the next */
    }
  }, [token]);

  return [token, setToken];
}
