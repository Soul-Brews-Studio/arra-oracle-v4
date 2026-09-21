/**
 * A child that takes the gate and then says nothing, ever.
 *
 * Copied verbatim from `read-cursor-v1/recovery/silent-child.ts`: it holds no
 * cursor-specific logic at all. It exists so the parent's deadline can be
 * shown to fire. A harness whose timeouts never trip is indistinguishable
 * from one whose timeouts do not work, and every other case in this suite
 * depends on those timeouts being real. The parent is expected to give up,
 * SIGKILL this exact pid and reap it.
 */
export {};

// Hold the process open with no output and no exit. The parent owns the end.
await new Promise<never>(() => {});
