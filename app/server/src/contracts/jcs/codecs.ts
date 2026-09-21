/**
 * Shared codec instances. `TextEncoder`/`TextDecoder` are stateless (no
 * per-call mutable state affects output), so sharing one instance per
 * process across every function in this directory is just avoiding
 * needless allocation, not a correctness concern — unlike the auth
 * registry split, there is no identity semantic to preserve here.
 */

export const utf8 = new TextEncoder();
export const utf8Fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
