// A 21-character id in the alphabet the server's id grammar accepts, for the
// rows this test writes through the HTTP API rather than the UI.
export function nid() {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  return Array.from({ length: 21 }, () => a[Math.floor(Math.random() * a.length)]).join("");
}
