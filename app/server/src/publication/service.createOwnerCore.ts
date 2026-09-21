import { failPublication } from "./errors";
import { type BoundaryHook, type ContextBoundary, type ContextBoundaryHook, type EvidenceBoundary, type EvidenceBoundaryHook, type PublicationBoundary, type TaxonomyBoundary, type TaxonomyBoundaryHook } from "./service.boundaries";
import { isSafeContractError } from "./service.isSafeContractError";
import { releaseInheritedGate } from "./service.releaseInheritedGate";
import { type DatasetAdapter, type OwnerCore } from "./service.types";

export function createOwnerCore(
  writer: DatasetAdapter,
  hooks: {
    onBoundary?: BoundaryHook;
    onTaxonomyBoundary?: TaxonomyBoundaryHook;
    onContextBoundary?: ContextBoundaryHook;
    onEvidenceBoundary?: EvidenceBoundaryHook;
  },
): OwnerCore {
  let queue: Promise<unknown> = Promise.resolve();
  /** Fail-stop: once poisoned, no further queued mutation may run. */
  let poisoned = false;
  /** Set by close(): work queued after it is rejected, not silently run. */
  let closing = false;
  /**
   * The ONE close, cached.
   *
   * A descriptor NUMBER is a reusable integer, not an identity. Once the
   * inherited gate descriptor is released the kernel may hand that same number
   * back for something entirely unrelated, so releasing on every call would
   * eventually close a descriptor this writer never owned. Caching the promise
   * also makes concurrent closes drain the queue once and settle together.
   */
  let closeOnce: Promise<void> | undefined;

  /**
   * Await the fault-test hook at a commanded boundary.
   *
   * `wroteAlready` matters: a hook that throws after any attempted write
   * leaves durable state this owner can no longer reason about, so it takes
   * the same fail-stop path as any other ambiguous post-write failure.
   */
  const runHook = async (
    hook: ((name: string) => Promise<void>) | undefined,
    name: string,
    wroteAlready: boolean,
  ): Promise<void> => {
    if (hook === undefined) return;
    try {
      await hook(name);
    } catch {
      if (wroteAlready) {
        poisoned = true;
        failPublication("recovery_required");
      }
      failPublication("invalid_request");
    }
  };

  const boundary = (name: PublicationBoundary, wroteAlready: boolean): Promise<void> =>
    runHook(hooks.onBoundary as ((n: string) => Promise<void>) | undefined, name, wroteAlready);

  const taxonomyBoundary = (name: TaxonomyBoundary, wroteAlready: boolean): Promise<void> =>
    runHook(hooks.onTaxonomyBoundary as ((n: string) => Promise<void>) | undefined, name, wroteAlready);

  const contextBoundary = (name: ContextBoundary, wroteAlready: boolean): Promise<void> =>
    runHook(hooks.onContextBoundary as ((n: string) => Promise<void>) | undefined, name, wroteAlready);

  const evidenceBoundary = (name: EvidenceBoundary, wroteAlready: boolean): Promise<void> =>
    runHook(hooks.onEvidenceBoundary as ((n: string) => Promise<void>) | undefined, name, wroteAlready);

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(async () => {
      // Both gates checked INSIDE the queued turn, so a request enqueued
      // before close but reached after it is still rejected.
      if (poisoned) failPublication("recovery_required");
      if (closing) failPublication("recovery_required");
      attemptedWrite = false;
      try {
        return await work();
      } catch (error) {
        // THE boundary: if this operation had already attempted persistence,
        // any failure at all leaves durable state we cannot account for.
        // This catches write sites that forgot their own guard, which is
        // precisely how the node append and head update slipped through.
        if (attemptedWrite) {
          poisoned = true;
          // Classify here as well, not only poison. Steps that run after
          // durability but carry no wrapper of their own -- the post-append
          // node re-check at the fresh-publication site is one -- would
          // otherwise hand the caller a raw SDK rejection instead of the
          // ambiguous-window code the contract specifies. Doing it here keeps
          // the guarantee a property of the operation rather than something
          // each future write site has to remember.
          // Preserve DELIBERATELY raised safe contract errors; normalize only
          // genuinely unknown exceptions. Collapsing a thrown
          // integrity_failure into recovery_required would lose the
          // difference between "ambiguous" and "the stored row is
          // structurally invalid" -- different operator problems. This is an
          // exact list of our own error types, NOT a whitelist of any object
          // that happens to carry a name or a code.
          if (!isSafeContractError(error)) failPublication("recovery_required");
        }
        throw error;
      }
    });
    // Keep the chain alive regardless of this request's outcome.
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<T>;
  };

  /**
   * Whether the CURRENT serialized operation has attempted any persistence.
   *
   * One flag per operation, set immediately before each append or update,
   * rather than a catch around every call site. Scattered catches were how
   * the node append and the head update ended up unguarded while the
   * revision readback was covered: the guarantee has to be a property of the
   * operation, not something each new write site remembers to opt into.
   */
  let attemptedWrite = false;

  /** Mark persistence as attempted. Call IMMEDIATELY before any write. */
  const markAttemptedWrite = (): void => {
    attemptedWrite = true;
  };

  /**
   * Run post-write work, poisoning the owner if anything goes wrong.
   *
   * Once anything is durably written, every later step is inside the
   * ambiguous window contract section 7 describes. Deliberately scoped to
   * AFTER an attempted write: pre-write validation errors leave nothing
   * behind and must keep the owner usable.
   */
  const afterWrite = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      poisoned = true;
      if (isSafeContractError(error)) throw error;
      return failPublication("recovery_required");
    }
  };

  return {
    serial,
    boundary,
    taxonomyBoundary,
    contextBoundary,
    evidenceBoundary,
    markAttemptedWrite,
    afterWrite,
    poison: () => {
      poisoned = true;
    },
    /**
     * Close: stop accepting work, drain what is in flight, then RELEASE the
     * gate -- including the inherited descriptor. Deleting the in-process
     * registry entry is not enough: the flock lives on fd 42.
     *
     * One-shot (#46): a descriptor NUMBER is reusable, so a second release
     * would close a descriptor this owner never held.
     */
    close: () => {
      closeOnce ??= (async () => {
        closing = true;
        await queue.catch(() => undefined);
        writer.release();
        releaseInheritedGate();
      })();
      return closeOnce;
    },
  };
}
