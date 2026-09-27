/** True for the governed contract errors, which must pass through unchanged. */
export function isContractError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ContractError"
  );
}
