import { PublicationError, type PublicationErrorShape } from "./errors";

/**
 * `embedding_profile_mismatch` with the two digests R20 requires it to
 * NAME. Still a real `PublicationError` (so `isSafeContractError`,
 * `safeErrorEnvelope` and every transport treat it as the closed
 * `arra-publication-error/v1` envelope), with the fixed literal message
 * `errors.ts` owns; the digests travel as two extra envelope fields, never
 * interpolated into the message. Both are 64-hex values that already passed
 * `MODEL_DIGEST_PATTERN` (a stored pin is validated on read, a measurement
 * on probe), so neither can carry caller text, a path or an SDK internal.
 */
class EmbeddingProfileMismatchError extends PublicationError {
  readonly pinnedDigest!: string;
  readonly measuredDigest!: string;

  constructor(pinnedDigest: string, measuredDigest: string) {
    super("embedding_profile_mismatch", "");
    Object.defineProperty(this, "pinnedDigest", { value: pinnedDigest, writable: false, enumerable: true });
    Object.defineProperty(this, "measuredDigest", { value: measuredDigest, writable: false, enumerable: true });
  }

  override toJSON(): PublicationErrorShape & { pinned_digest: string; measured_digest: string } {
    return { ...super.toJSON(), pinned_digest: this.pinnedDigest, measured_digest: this.measuredDigest };
  }
}

export function failEmbeddingProfileMismatch(pinnedDigest: string, measuredDigest: string): never {
  throw new EmbeddingProfileMismatchError(pinnedDigest, measuredDigest);
}
