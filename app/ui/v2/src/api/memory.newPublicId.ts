/** 21-char nanoid, the alphabet `parseAppendMessages` accepts. Generated
 *  client-side because `public_id` is caller-supplied: the server refuses a
 *  duplicate rather than minting one for you. */
export function newPublicId(): string {
  const alphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict";
  const bytes = new Uint8Array(21);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
